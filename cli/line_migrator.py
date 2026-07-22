#!/usr/bin/env python3
"""Read-only inspection and staging tools for an iOS LINE App Container."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
from typing import Any, Iterable


CLI_VERSION = "0.1.0-cli.1"
BACKUP_ROOT_FILES = {".lock", "iTunesArtwork", "iTunesMetadata.plist"}
BACKUP_ROOT_DIRECTORIES = {"Container", "Payload"}


class CliError(RuntimeError):
    """A user-facing, non-traceback CLI error."""


def human_bytes(value: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    amount = float(value)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{value} B"


def resolved_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise CliError(f"{label} 必須是存在的資料夾：{path}")
    return path


def iter_files(source: Path) -> Iterable[Path]:
    for root, directories, filenames in os.walk(source, followlinks=False):
        directories.sort()
        for filename in sorted(filenames):
            yield Path(root) / filename


def is_backup_member(relative_path: str) -> bool:
    parts = relative_path.split("/")
    return (len(parts) == 1 and parts[0] in BACKUP_ROOT_FILES) or (
        bool(parts) and parts[0] in BACKUP_ROOT_DIRECTORIES
    )


def scan_source(source: Path) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    symlinks: list[str] = []
    directory_count = 0
    inaccessible: list[dict[str, str]] = []

    for root, directories, filenames in os.walk(source, followlinks=False):
        directory_count += len(directories)
        for directory in directories:
            candidate = Path(root) / directory
            if candidate.is_symlink():
                symlinks.append(candidate.relative_to(source).as_posix())
        for filename in sorted(filenames):
            path = Path(root) / filename
            relative = path.relative_to(source).as_posix()
            if path.is_symlink():
                symlinks.append(relative)
                continue
            try:
                stat = path.stat()
            except OSError as error:
                inaccessible.append({"path": relative, "error": str(error)})
                continue
            records.append({
                "path": relative,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "backup_member": is_backup_member(relative),
            })

    paths = [record["path"] for record in records]
    path_set = set(paths)

    line_sqlite = next(
        (path for path in paths if Path(path).parts[-2:] == ("Messages", "Line.sqlite")),
        None,
    )
    sqlite_paths = [
        path for path in paths
        if path.lower().endswith((".sqlite", ".sqlite3"))
    ]
    wal_path = f"{line_sqlite}-wal" if line_sqlite else None
    shm_path = f"{line_sqlite}-shm" if line_sqlite else None
    attachment_paths = [
        path for path in paths
        if "/Message Attachments/" in f"/{path}/"
    ]
    thumbnail_paths = [
        path for path in paths
        if "/Message Thumbnails/" in f"/{path}/"
    ]
    has_container = any(Path(path).parts and Path(path).parts[0] == "Container" for path in paths)
    has_payload = any(Path(path).parts and Path(path).parts[0] == "Payload" for path in paths)
    has_lock = ".lock" in path_set
    warnings: list[str] = []
    if not has_container:
        warnings.append("找不到根目錄 Container/，可能不是完整 LINE App Container。")
    if not line_sqlite:
        warnings.append("找不到 Messages/Line.sqlite，無法解析核心聊天資料。")
    if line_sqlite and wal_path in path_set:
        warnings.append("Line.sqlite-wal 存在；解析時必須與主資料庫及 SHM 一起使用 staging snapshot。")
    if line_sqlite and shm_path in path_set:
        warnings.append("Line.sqlite-shm 存在；解析時必須與主資料庫及 WAL 一起使用 staging snapshot。")
    if symlinks:
        warnings.append("來源包含 symbolic link；為避免讀取來源資料夾外的內容，snapshot 會拒絕此來源。")
    if inaccessible:
        warnings.append(f"有 {len(inaccessible)} 個檔案無法讀取 metadata。")

    if has_container and line_sqlite:
        backup_type = "line-ios-app-container"
    elif has_container:
        backup_type = "line-container-incomplete"
    else:
        backup_type = "unknown"

    total_bytes = sum(record["size"] for record in records)
    backup_records = [record for record in records if record["backup_member"]]
    excluded_records = [record for record in records if not record["backup_member"]]
    backup_bytes = sum(record["size"] for record in backup_records)
    return {
        "source": {"path": str(source)},
        "backup_type": backup_type,
        "summary": {
            "file_count": len(records),
            "directory_count": directory_count,
            "total_bytes": total_bytes,
            "total_bytes_human": human_bytes(total_bytes),
            "backup_file_count": len(backup_records),
            "backup_bytes": backup_bytes,
            "backup_bytes_human": human_bytes(backup_bytes),
        },
        "core": {
            "container": has_container,
            "payload": has_payload,
            "lock": has_lock,
            "line_sqlite": line_sqlite,
            "line_sqlite_wal": wal_path if wal_path in path_set else None,
            "line_sqlite_shm": shm_path if shm_path in path_set else None,
            "messages_sqlite_count": sum("/Messages/" in f"/{path}/" for path in sqlite_paths),
            "sqlite_paths": sqlite_paths,
        },
        "attachments": {
            "message_attachments_file_count": len(attachment_paths),
            "message_thumbnails_file_count": len(thumbnail_paths),
            "message_attachments_bytes": sum(record["size"] for record in records if record["path"] in set(attachment_paths)),
            "message_thumbnails_bytes": sum(record["size"] for record in records if record["path"] in set(thumbnail_paths)),
        },
        "warnings": warnings,
        "excluded_non_backup_files": [record["path"] for record in excluded_records],
        "inaccessible": inaccessible,
        "symlinks": symlinks,
        "_records": records,
    }


def public_report(report: dict[str, Any]) -> dict[str, Any]:
    payload = {key: value for key, value in report.items() if not key.startswith("_")}
    return mask_account_ids(payload)


def mask_account_ids(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"P_[^/\\]+", "P_<account-id>", value)
    if isinstance(value, list):
        return [mask_account_ids(item) for item in value]
    if isinstance(value, dict):
        return {
            mask_account_ids(key) if isinstance(key, str) else key: mask_account_ids(item)
            for key, item in value.items()
        }
    return copy.deepcopy(value)


def print_report(report: dict[str, Any], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(public_report(report), ensure_ascii=False, indent=2))
        return
    summary = report["summary"]
    core = report["core"]
    attachments = report["attachments"]
    print(f"backup_type: {report['backup_type']}")
    print(f"source: {report['source']['path']}")
    print(f"files: {summary['file_count']} ({summary['total_bytes_human']})")
    print(f"backup members: {summary['backup_file_count']} ({summary['backup_bytes_human']})")
    print(f"directories: {summary['directory_count']}")
    print(f"Line.sqlite: {core['line_sqlite'] or 'NOT FOUND'}")
    print(f"WAL/SHM: {'yes' if core['line_sqlite_wal'] or core['line_sqlite_shm'] else 'no'}")
    print(f"attachments: {attachments['message_attachments_file_count']} files")
    print(f"thumbnails: {attachments['message_thumbnails_file_count']} files")
    if report["excluded_non_backup_files"]:
        print(f"excluded non-backup files: {len(report['excluded_non_backup_files'])}")
    for warning in report["warnings"]:
        print(f"warning: {warning}")


def sqlite_uri(path: Path, immutable: bool = False) -> str:
    query = "mode=ro" + ("&immutable=1" if immutable else "")
    return f"{path.as_uri()}?{query}"


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def inspect_sqlite(path: Path, use_immutable: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": str(path),
        "relative_path": None,
        "read_only_uri": sqlite_uri(path, immutable=use_immutable),
        "immutable": use_immutable,
        "user_version": None,
        "tables": [],
        "indexes": [],
        "error": None,
    }
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(sqlite_uri(path, immutable=use_immutable), uri=True, timeout=1)
        result["user_version"] = connection.execute("PRAGMA user_version").fetchone()[0]
        objects = connection.execute(
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table', 'index') ORDER BY type, name"
        ).fetchall()
        for name, object_type, sql in objects:
            if object_type == "index":
                result["indexes"].append({"name": name, "sql": sql})
                continue
            columns = connection.execute(
                f"PRAGMA table_info({quote_identifier(name)})"
            ).fetchall()
            result["tables"].append({
                "name": name,
                "sql": sql,
                "columns": [
                    {
                        "cid": row[0],
                        "name": row[1],
                        "type": row[2],
                        "notnull": bool(row[3]),
                        "default": row[4],
                        "primary_key": row[5],
                    }
                    for row in columns
                ],
            })
    except sqlite3.Error as error:
        result["error"] = str(error)
    finally:
        if connection is not None:
            connection.close()
    return result


def sqlite_records(report: dict[str, Any]) -> list[dict[str, Any]]:
    records = report["_records"]
    return [record for record in records if record["path"].lower().endswith((".sqlite", ".sqlite3"))]


def build_schema_report(snapshot: Path, report: dict[str, Any]) -> dict[str, Any]:
    schemas: list[dict[str, Any]] = []
    for record in sqlite_records(report):
        path = snapshot / record["path"]
        wal_exists = Path(f"{path}-wal").exists()
        shm_exists = Path(f"{path}-shm").exists()
        schema = inspect_sqlite(path, use_immutable=not (wal_exists or shm_exists))
        schema.pop("path", None)
        schema.pop("read_only_uri", None)
        schema["relative_path"] = mask_account_ids(record["path"])
        schema["wal_present"] = wal_exists
        schema["shm_present"] = shm_exists
        schemas.append(schema)
    line = mask_account_ids(report["core"]["line_sqlite"])
    return {
        "schema_version": "0.1",
        "parser_version": CLI_VERSION,
        "snapshot": {
            "path": str(snapshot),
            "backup_type": report["backup_type"],
            "line_sqlite": line,
        },
        "databases": schemas,
        "warnings": report["warnings"],
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_output_directory(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise CliError(f"輸出路徑不是資料夾：{path}")
        if any(path.iterdir()):
            raise CliError(f"為避免覆寫既有結果，輸出資料夾必須不存在或為空：{path}")
    else:
        path.mkdir(parents=True)


def ensure_snapshot_destination(source: Path, destination: Path) -> None:
    if destination == source or source in destination.parents:
        raise CliError("snapshot 輸出不得是來源資料夾本身或其子目錄；請將 staging 放到來源外部。")
    if destination.exists():
        raise CliError(f"snapshot 輸出已存在，為避免覆寫請指定新路徑：{destination}")


def copy_backup_members(source: Path, destination: Path, records: list[dict[str, Any]]) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    for record in records:
        if not record["backup_member"]:
            continue
        source_file = source / record["path"]
        destination_file = destination / record["path"]
        destination_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, destination_file)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command_environment() -> dict[str, str]:
    environment = os.environ.copy()
    # Some original iMazing ZIP entries are not valid UTF-8. Keep the external
    # ZIP tools in byte-oriented locale mode and never parse their output as text.
    environment["LC_ALL"] = "C"
    return environment


def require_command(name: str) -> str:
    command = shutil.which(name)
    if command is None:
        raise CliError(f"找不到必要的系統工具 `{name}`；macOS 需要安裝 Info-ZIP。")
    return command


def list_zip_entries(archive: Path) -> list[bytes]:
    unzip = require_command("unzip")
    result = subprocess.run(
        [unzip, "-Z1", str(archive)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=command_environment(),
        check=False,
    )
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise CliError(f"無法讀取 ZIP entry 清單：{archive}；{error}")
    return result.stdout.splitlines()


def test_zip_integrity(archive: Path) -> None:
    unzip = require_command("unzip")
    result = subprocess.run(
        [unzip, "-t", str(archive)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=command_environment(),
        check=False,
    )
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise CliError(f"ZIP CRC／結構驗證失敗：{archive}；{error}")


def display_zip_entry(entry: bytes) -> str:
    return entry.decode("utf-8", errors="replace")


def normalize_zip_entry(value: str) -> bytes:
    if not value or "\x00" in value:
        raise CliError("--entry 不得為空或包含 NUL 字元。")
    if value.startswith("/") or "\\" in value:
        raise CliError("--entry 必須是 ZIP 內的相對路徑，使用 `/` 且不可從根目錄開始。")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or value.endswith("/"):
        raise CliError("--entry 必須是單一檔案的正規相對路徑。")
    return os.fsencode(value)


def validate_slim_entry(entry: bytes, allow_original_attachments: bool) -> None:
    if entry == b".lock" or entry.endswith((b"/Line.sqlite", b"/Line.sqlite-wal", b"/Line.sqlite-shm")):
        raise CliError("安全瘦身測試禁止移除 `.lock` 或 Line.sqlite／WAL／SHM。")
    if entry in {b"iTunesArtwork", b"iTunesMetadata.plist"}:
        raise CliError("安全瘦身測試禁止移除 iMazing 備份根目錄 metadata。")
    path = b"/" + entry + b"/"
    if b"/Message Thumbnails/" in path:
        return
    if b"/Message Attachments/" in path and allow_original_attachments:
        return
    if b"/Message Attachments/" in path:
        raise CliError("原始 Message Attachments 預設禁止刪除；若已完成人工確認，才可加上 --allow-original-attachments。")
    raise CliError("安全瘦身測試預設只允許 Message Thumbnails；請勿把資料庫或其他 ZIP entry 當成附件刪除。")


def unzip_entry_sha256(archive: Path, entry: bytes) -> str:
    unzip = require_command("unzip")
    process = subprocess.Popen(
        [unzip, "-p", str(archive), entry],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=command_environment(),
    )
    assert process.stdout is not None
    digest = hashlib.sha256()
    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
        digest.update(chunk)
    process.stdout.close()
    stderr = process.stderr.read() if process.stderr is not None else b""
    if process.stderr is not None:
        process.stderr.close()
    return_code = process.wait()
    if return_code != 0:
        error = stderr.decode("utf-8", errors="replace").strip()
        raise CliError(f"無法讀取 ZIP entry 內容：{display_zip_entry(entry)}；{error}")
    return digest.hexdigest()


def ensure_candidate_destination(source: Path, output: Path) -> None:
    if not source.is_file():
        raise CliError(f"--source 必須是存在的 `.imazingapp` 檔案：{source}")
    if source.suffix != ".imazingapp":
        raise CliError(f"--source 必須以 `.imazingapp` 結尾：{source}")
    if output == source:
        raise CliError("候選輸出不得覆寫原始 `.imazingapp`。")
    if output.exists():
        raise CliError(f"候選輸出已存在，為避免覆寫請指定新路徑：{output}")
    if not output.name.endswith(".imazingapp.candidate"):
        raise CliError("安全測試輸出必須以 `.imazingapp.candidate` 結尾。")


def slim_test_archive(
    source: Path,
    output: Path,
    requested_entries: list[str],
    allow_original_attachments: bool = False,
) -> dict[str, Any]:
    source = source.expanduser().resolve()
    output = output.expanduser().resolve()
    ensure_candidate_destination(source, output)
    entries = [normalize_zip_entry(value) for value in requested_entries]
    if len(entries) != len(set(entries)):
        raise CliError("--entry 不可重複。")

    for entry in entries:
        validate_slim_entry(entry, allow_original_attachments)

    test_zip_integrity(source)
    before_entries = list_zip_entries(source)
    before_set = set(before_entries)
    missing = [entry for entry in entries if entry not in before_set]
    if missing:
        names = ", ".join(display_zip_entry(entry) for entry in missing)
        raise CliError(f"來源 ZIP 找不到指定 entry：{names}")

    line_sqlite_entry = next(
        (entry for entry in before_entries if entry.endswith(b"/Messages/Line.sqlite")),
        None,
    )
    required_entries = [b".lock", b"Payload/LINE.app/Info.plist"]
    required_entries.append(line_sqlite_entry or b"")
    missing_core = [entry for entry in required_entries if entry and entry not in before_set]
    if missing_core:
        names = ", ".join(display_zip_entry(entry) for entry in missing_core)
        raise CliError(f"來源 ZIP 缺少必要核心 entry，停止測試：{names}")

    source_sha_before = sha256_file(source)
    preserved_before = {
        display_zip_entry(entry): unzip_entry_sha256(source, entry)
        for entry in required_entries
        if entry
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    created_output = False
    try:
        shutil.copy2(source, output)
        created_output = True
        zip_command = require_command("zip")
        result = subprocess.run(
            [zip_command, "-d", str(output), *entries],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=command_environment(),
            check=False,
        )
        if result.returncode != 0:
            error = result.stderr.decode("utf-8", errors="replace").strip()
            raise CliError(f"ZIP entry 移除失敗；{error}")
        test_zip_integrity(output)
        after_entries = list_zip_entries(output)
        after_set = set(after_entries)
        removed_entries = before_set - after_set
        unexpected_removed = removed_entries - set(entries)
        if unexpected_removed:
            names = ", ".join(display_zip_entry(entry) for entry in sorted(unexpected_removed))
            raise CliError(f"候選封裝出現未要求的 entry 移除：{names}")
        still_present = [entry for entry in entries if entry in after_set]
        if still_present:
            names = ", ".join(display_zip_entry(entry) for entry in still_present)
            raise CliError(f"指定 entry 未成功移除：{names}")

        preserved_after = {
            display_zip_entry(entry): unzip_entry_sha256(output, entry)
            for entry in required_entries
            if entry
        }
        if preserved_before != preserved_after:
            raise CliError("候選封裝的核心 entry SHA-256 與來源不同，停止交付。")
        source_sha_after = sha256_file(source)
        if source_sha_before != source_sha_after:
            raise CliError("原始 `.imazingapp` 在測試期間發生變更，停止交付。")
        return {
            "test_type": "imazingapp-slim-test",
            "status": "passed",
            "source": str(source),
            "output": str(output),
            "source_sha256_before": source_sha_before,
            "source_sha256_after": source_sha_after,
            "source_unchanged": True,
            "candidate_sha256": sha256_file(output),
            "entry_count_before": len(before_entries),
            "entry_count_after": len(after_entries),
            "requested_entries": [display_zip_entry(entry) for entry in entries],
            "removed_entries": [display_zip_entry(entry) for entry in sorted(removed_entries)],
            "preserved_core_sha256": preserved_after,
            "zip_integrity": "passed",
            "imazing_restore": "not-tested",
            "warnings": [
                "這是候選 ZIP 封裝測試，不代表 iMazing dry-run 或實體裝置還原已通過。",
            ],
        }
    except Exception:
        if created_output:
            output.unlink(missing_ok=True)
        raise


def command_inspect(args: argparse.Namespace) -> int:
    source = resolved_directory(args.source, "--source")
    report = scan_source(source)
    print_report(report, args.format)
    return 0 if not report["warnings"] or report["core"]["line_sqlite"] else 2


def command_snapshot(args: argparse.Namespace) -> int:
    source = resolved_directory(args.source, "--source")
    destination = Path(args.out).expanduser().resolve()
    report = scan_source(source)
    ensure_snapshot_destination(source, destination)
    if report["symlinks"]:
        raise CliError("來源包含 symbolic link；為安全起見，snapshot 暫不複製此來源。")
    required_bytes = report["summary"]["backup_bytes"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(destination.parent)
    if disk.free < required_bytes:
        raise CliError(f"目的磁碟空間不足：需要約 {human_bytes(required_bytes)}，剩餘 {human_bytes(disk.free)}。")
    copy_backup_members(source, destination, report["_records"])
    result = {
        "snapshot_version": "0.1",
        "parser_version": CLI_VERSION,
        "source": public_report(report),
        "snapshot": {
            "path": str(destination),
            "file_count": report["summary"]["backup_file_count"],
            "total_bytes": required_bytes,
            "total_bytes_human": human_bytes(required_bytes),
        },
        "warnings": report["warnings"],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def command_parse(args: argparse.Namespace) -> int:
    snapshot = resolved_directory(args.snapshot, "--snapshot")
    output = Path(args.out).expanduser().resolve()
    report = scan_source(snapshot)
    if not report["core"]["line_sqlite"]:
        raise CliError("snapshot 找不到 Messages/Line.sqlite，無法執行 schema introspection。")
    ensure_output_directory(output)
    schema = build_schema_report(snapshot, report)
    manifest = {
        "manifest_version": "0.1",
        "parser_version": CLI_VERSION,
        "stage": "CLI-1 schema introspection prototype",
        "source": {
            "backup_type": report["backup_type"],
            "file_count": report["summary"]["file_count"],
            "total_bytes": report["summary"]["total_bytes"],
            "line_sqlite": mask_account_ids(report["core"]["line_sqlite"]),
            "wal": bool(report["core"]["line_sqlite_wal"]),
            "shm": bool(report["core"]["line_sqlite_shm"]),
        },
        "outputs": ["manifest.json", "schema.json"],
        "warnings": report["warnings"],
    }
    write_json(output / "manifest.json", manifest)
    write_json(output / "schema.json", schema)
    print(json.dumps({"output": str(output), "files": ["manifest.json", "schema.json"]}, ensure_ascii=False, indent=2))
    return 0


def command_slim_test(args: argparse.Namespace) -> int:
    result = slim_test_archive(
        Path(args.source),
        Path(args.out),
        args.entry,
        allow_original_attachments=args.allow_original_attachments,
    )
    payload = public_report(result)
    if args.report:
        report_path = Path(args.report).expanduser().resolve()
        if report_path.exists():
            raise CliError(f"測試報告已存在，為避免覆寫請指定新路徑：{report_path}")
        write_json(report_path, payload)
        payload["report"] = str(report_path)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="line-migrator",
        description="唯讀掃描與 staging iOS LINE App Container 備份。",
    )
    parser.add_argument("--version", action="version", version=CLI_VERSION)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="掃描來源結構，不讀取訊息內容。")
    inspect_parser.add_argument("--source", required=True, help="LINE App Container 資料夾。")
    inspect_parser.add_argument("--format", choices=("json", "text"), default="json")
    inspect_parser.set_defaults(function=command_inspect)

    snapshot_parser = subparsers.add_parser("snapshot", help="建立來源的唯讀 staging 副本。")
    snapshot_parser.add_argument("--source", required=True, help="LINE App Container 資料夾。")
    snapshot_parser.add_argument("--out", required=True, help="來源外部的新 staging 資料夾。")
    snapshot_parser.set_defaults(function=command_snapshot)

    parse_parser = subparsers.add_parser("parse", help="建立 SQLite schema introspection 初版輸出。")
    parse_parser.add_argument("--snapshot", required=True, help="已建立的 staging 資料夾。")
    parse_parser.add_argument("--out", required=True, help="不存在或為空的輸出資料夾。")
    parse_parser.set_defaults(function=command_parse)

    slim_parser = subparsers.add_parser(
        "slim-test",
        help="在 `.imazingapp` 副本上移除指定附件並驗證 ZIP 完整性。",
    )
    slim_parser.add_argument("--source", required=True, help="原始 `.imazingapp` 檔案；只讀取，不會覆寫。")
    slim_parser.add_argument(
        "--out",
        required=True,
        help="不存在的新 `.imazingapp.candidate` 輸出檔案。",
    )
    slim_parser.add_argument(
        "--entry",
        action="append",
        required=True,
        help="要從候選副本移除的 ZIP entry；預設只允許 Message Thumbnails，可重複指定。",
    )
    slim_parser.add_argument(
        "--allow-original-attachments",
        action="store_true",
        help="明確允許移除 Message Attachments 原檔；請先確認備份與還原策略。",
    )
    slim_parser.add_argument("--report", help="另寫入 JSON 測試報告；檔案必須不存在。")
    slim_parser.set_defaults(function=command_slim_test)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.function(args))
    except CliError as error:
        print(f"line-migrator: error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
