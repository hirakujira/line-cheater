#!/usr/bin/env python3
"""Read-only inspection and staging tools for an iOS LINE App Container."""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from typing import Any, Iterable


CLI_VERSION = "0.1.0-cli.0"
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
        return {key: mask_account_ids(item) for key, item in value.items()}
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
