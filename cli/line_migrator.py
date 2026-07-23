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
import time
from typing import Any, Iterable


CLI_VERSION = "0.2.0-cli.u0-u8"
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


def timestamp_unit_from_value(value: Any) -> str:
    """Return the likely LINE timestamp unit without changing the raw value."""
    try:
        magnitude = abs(float(value or 0))
    except (TypeError, ValueError):
        return "unknown"
    if magnitude >= 1e14:
        return "microseconds"
    if magnitude >= 1e11:
        return "milliseconds"
    if magnitude >= 1e8:
        return "seconds"
    return "unknown"


def timestamp_to_seconds(value: Any, unit: str | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    selected = unit or timestamp_unit_from_value(number)
    divisor = {"microseconds": 1_000_000, "milliseconds": 1_000, "seconds": 1}.get(selected, 1)
    return number / divisor


def detect_timestamp_unit(path: Path) -> str:
    connection = open_read_only_connection(path)
    try:
        columns = table_columns(connection, "ZMESSAGE")
        if "ZTIMESTAMP" not in columns:
            return "unknown"
        value = connection.execute("SELECT max(abs(ZTIMESTAMP)) FROM ZMESSAGE").fetchone()[0]
        return timestamp_unit_from_value(value)
    except sqlite3.Error:
        return "unknown"
    finally:
        connection.close()


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


def open_read_only_connection(path: Path, immutable: bool = False) -> sqlite3.Connection:
    connection = sqlite3.connect(sqlite_uri(path, immutable=immutable), uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-65536")
    connection.execute("PRAGMA busy_timeout=5000")
    try:
        connection.execute("PRAGMA mmap_size=268435456")
    except sqlite3.Error:
        # mmap is an optimization and is not available on every filesystem.
        pass
    return connection


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table):
        raise CliError(f"不安全的 SQLite table 名稱：{table}")
    return {row[1] for row in connection.execute(f"PRAGMA table_info({quote_identifier(table)})")}


def capability_probe(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "sqlite_version": None,
        "json_functions": "unavailable",
        "fts5": "unavailable",
        "window_functions": "unavailable",
        "dbstat": "unavailable",
        "read_only": True,
        "warnings": [],
    }
    connection: sqlite3.Connection | None = None
    try:
        connection = open_read_only_connection(path)
        result["sqlite_version"] = connection.execute("SELECT sqlite_version()").fetchone()[0]
        try:
            result["json_functions"] = "available" if connection.execute("SELECT json_valid(?)", ("{}",)).fetchone()[0] == 1 else "unavailable"
        except sqlite3.Error as error:
            result["json_functions_error"] = str(error)
        try:
            result["fts5"] = "available" if connection.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone()[0] else "unavailable"
        except sqlite3.Error as error:
            result["fts5_error"] = str(error)
        try:
            value = connection.execute("SELECT row_number() OVER (ORDER BY 1)").fetchone()[0]
            result["window_functions"] = "available" if value == 1 else "unavailable"
        except sqlite3.Error as error:
            result["window_functions_error"] = str(error)
        try:
            connection.execute("SELECT name FROM dbstat LIMIT 1").fetchone()
            result["dbstat"] = "available"
        except sqlite3.Error as error:
            result["dbstat_error"] = str(error)
    except sqlite3.Error as error:
        result["error"] = str(error)
    finally:
        if connection is not None:
            connection.close()
    unavailable = [key for key in ("json_functions", "fts5", "window_functions", "dbstat") if result[key] == "unavailable"]
    if unavailable:
        result["warnings"].append("SQLite 編譯功能不可用：" + ", ".join(unavailable))
    return result


def sqlite_health(path: Path, full_integrity: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": str(path),
        "read_only": True,
        "status": "error",
        "checks": {},
        "warnings": [],
        "started_at": time.time(),
    }
    connection: sqlite3.Connection | None = None
    try:
        connection = open_read_only_connection(path)
        checks = result["checks"]
        checks["file_size"] = path.stat().st_size
        checks["user_version"] = connection.execute("PRAGMA user_version").fetchone()[0]
        checks["page_count"] = connection.execute("PRAGMA page_count").fetchone()[0]
        checks["page_size"] = connection.execute("PRAGMA page_size").fetchone()[0]
        checks["freelist_count"] = connection.execute("PRAGMA freelist_count").fetchone()[0]
        checks["journal_mode"] = connection.execute("PRAGMA journal_mode").fetchone()[0]
        checks["table_count"] = connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        checks["index_count"] = connection.execute("SELECT count(*) FROM sqlite_master WHERE type='index'").fetchone()[0]
        quick = connection.execute("PRAGMA quick_check").fetchall()
        checks["quick_check"] = [row[0] for row in quick]
        if full_integrity:
            integrity = connection.execute("PRAGMA integrity_check").fetchall()
            checks["integrity_check"] = [row[0] for row in integrity]
        else:
            checks["integrity_check"] = "not_checked"
        failures = [value for value in checks["quick_check"] if value != "ok"]
        if full_integrity:
            failures.extend(value for value in checks["integrity_check"] if value != "ok")
        result["status"] = "error" if failures else "pass"
        if failures:
            result["warnings"].append("SQLite integrity check 發現問題。")
    except (sqlite3.Error, OSError) as error:
        result["error"] = str(error)
        result["status"] = "error"
    finally:
        if connection is not None:
            connection.close()
    result["duration_seconds"] = round(time.time() - result.pop("started_at"), 3)
    return result


def database_path_from_source(source: Path) -> Path:
    if source.is_file():
        return source
    report = scan_source(source)
    line_sqlite = report["core"].get("line_sqlite")
    if not line_sqlite:
        raise CliError(f"來源找不到 Messages/Line.sqlite：{source}")
    return source / line_sqlite


def select_column(columns: set[str], name: str, alias: str | None = None) -> str:
    output = alias or name
    return f"{quote_identifier(name)} AS {quote_identifier(output)}" if name in columns else f"NULL AS {quote_identifier(output)}"


def iter_all_message_batches(
    path: Path,
    chat_pk: int | None = None,
    batch_size: int = 500,
    order_by_chat: bool = False,
):
    if batch_size < 1 or batch_size > 5000:
        raise CliError("--batch-size 必須介於 1 到 5000。")
    connection = open_read_only_connection(path)
    try:
        columns = table_columns(connection, "ZMESSAGE")
        selected = [
            select_column(columns, "Z_PK", "pk"),
            select_column(columns, "ZID", "id"),
            select_column(columns, "ZTIMESTAMP", "timestamp_raw"),
            select_column(columns, "ZCHAT", "chat_pk"),
            select_column(columns, "ZSENDER", "sender_pk"),
            select_column(columns, "ZSENDSTATUS", "send_status"),
            select_column(columns, "ZCONTENTTYPE", "content_type"),
            select_column(columns, "ZMESSAGETYPE", "message_type"),
            select_column(columns, "ZTEXT", "text"),
        ]
        where = ""
        params: tuple[Any, ...] = ()
        if chat_pk is not None:
            where = " WHERE ZCHAT = ?"
            params = (chat_pk,)
        order_by = "ZCHAT, COALESCE(ZTIMESTAMP, 0), Z_PK" if order_by_chat else "COALESCE(ZTIMESTAMP, 0), Z_PK"
        cursor = connection.execute(
            "SELECT " + ", ".join(selected) + " FROM ZMESSAGE" + where + " ORDER BY " + order_by,
            params,
        )
        while True:
            rows = cursor.fetchmany(batch_size)
            if not rows:
                break
            yield [dict(row) for row in rows]
        cursor.close()
    finally:
        connection.close()


def schema_explorer_report(path: Path, sample_limit: int = 20) -> dict[str, Any]:
    if sample_limit < 1 or sample_limit > 100:
        raise CliError("--sample-limit 必須介於 1 到 100。")
    connection = open_read_only_connection(path)
    try:
        capability = capability_probe(path)
        tables: list[dict[str, Any]] = []
        objects = connection.execute(
            "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name"
        ).fetchall()
        for name, object_type, sql in objects:
            if object_type != "table" or name.startswith("sqlite_"):
                continue
            columns = table_columns(connection, name)
            column_rows = connection.execute(f"PRAGMA table_info({quote_identifier(name)})").fetchall()
            try:
                row_count = connection.execute(f"SELECT count(*) FROM {quote_identifier(name)}").fetchone()[0]
            except sqlite3.Error:
                row_count = None
            try:
                foreign_keys = [
                    {
                        "id": row[0],
                        "seq": row[1],
                        "table": row[2],
                        "from": row[3],
                        "to": row[4],
                        "on_update": row[5],
                        "on_delete": row[6],
                        "match": row[7],
                    }
                    for row in connection.execute(f"PRAGMA foreign_key_list({quote_identifier(name)})").fetchall()
                ]
            except sqlite3.Error:
                foreign_keys = []
            samples = []
            try:
                for row in connection.execute(f"SELECT * FROM {quote_identifier(name)} LIMIT ?", (sample_limit,)).fetchall():
                    item = {}
                    for index, value in enumerate(row):
                        column = column_rows[index][1]
                        if isinstance(value, bytes):
                            item[column] = {"type": "BLOB", "bytes": len(value)}
                        elif isinstance(value, str) and len(value) > 200:
                            item[column] = value[:200] + "…"
                        else:
                            item[column] = value
                    samples.append(item)
            except sqlite3.Error:
                samples = []
            tables.append({
                "name": name,
                "sql": sql,
                "columns": [
                    {"cid": row[0], "name": row[1], "type": row[2], "notnull": bool(row[3]), "primary_key": row[5]}
                    for row in column_rows
                ],
                "row_count": row_count,
                "samples": samples,
                "declared_foreign_keys": foreign_keys,
                "candidate_relations": [column for column in sorted(columns) if column.endswith("_PK") or column in {"ZCHAT", "ZSENDER", "ZMID", "ZID"}],
            })
        return {
            "schema_version": "0.2",
            "parser_version": CLI_VERSION,
            "database": str(path),
            "capabilities": capability,
            "tables": tables,
            "read_only": True,
        }
    finally:
        connection.close()


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
        connection = open_read_only_connection(path, immutable=use_immutable)
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
                "declared_foreign_keys": [
                    {
                        "id": row[0],
                        "seq": row[1],
                        "table": row[2],
                        "from": row[3],
                        "to": row[4],
                        "on_update": row[5],
                        "on_delete": row[6],
                        "match": row[7],
                    }
                    for row in connection.execute(f"PRAGMA foreign_key_list({quote_identifier(name)})").fetchall()
                ],
            })
    except sqlite3.Error as error:
        result["error"] = str(error)
    finally:
        if connection is not None:
            connection.close()
    return result


def iter_message_batches(
    path: Path,
    chat_pk: int,
    batch_size: int = 500,
    after_timestamp: int = 0,
    after_pk: int = 0,
):
    if batch_size < 1 or batch_size > 5000:
        raise CliError("--batch-size 必須介於 1 到 5000。")
    connection = open_read_only_connection(path)
    timestamp_cursor = int(after_timestamp)
    pk_cursor = int(after_pk)
    try:
        while True:
            cursor = connection.execute(
                "SELECT Z_PK, ZID, ZTIMESTAMP, ZSENDER, ZSENDSTATUS, ZCONTENTTYPE, "
                "ZMESSAGETYPE, ZTEXT, ZLATITUDE, ZLONGITUDE "
                "FROM ZMESSAGE WHERE ZCHAT = ? "
                "AND (COALESCE(ZTIMESTAMP, 0) > ? "
                "OR (COALESCE(ZTIMESTAMP, 0) = ? AND Z_PK > ?)) "
                "ORDER BY COALESCE(ZTIMESTAMP, 0) ASC, Z_PK ASC LIMIT ?",
                (chat_pk, timestamp_cursor, timestamp_cursor, pk_cursor, batch_size),
            )
            rows = cursor.fetchmany(batch_size)
            cursor.close()
            if not rows:
                break
            yield [
                {
                    "pk": row[0],
                    "id": row[1],
                    "timestamp_raw": row[2],
                    "sender_pk": row[3],
                    "send_status": row[4],
                    "content_type": row[5],
                    "message_type": row[6],
                    "text": row[7],
                    "latitude": row[8],
                    "longitude": row[9],
                }
                for row in rows
            ]
            last = rows[-1]
            timestamp_cursor = int(last[2] or 0)
            pk_cursor = int(last[0])
    finally:
        connection.close()


def command_messages(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser().resolve()
    if not database.is_file():
        raise CliError(f"--database 必須是存在的 SQLite 檔案：{database}")
    output = Path(args.out).expanduser().resolve()
    if output.exists():
        raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    row_count = 0
    batch_count = 0
    with output.open("w", encoding="utf-8") as handle:
        for batch in iter_message_batches(
            database,
            chat_pk=args.chat_pk,
            batch_size=args.batch_size,
            after_timestamp=args.after_timestamp,
            after_pk=args.after_pk,
        ):
            for row in batch:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                row_count += 1
            batch_count += 1
    print(json.dumps({
        "database": str(database),
        "chat_pk": args.chat_pk,
        "output": str(output),
        "rows": row_count,
        "batches": batch_count,
        "batch_size": args.batch_size,
        "pagination": "keyset(timestamp_raw, pk)",
        "read_only": True,
    }, ensure_ascii=False, indent=2))
    return 0


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


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def atomic_write_jsonl(path: Path, rows: Iterable[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def database_schema_fingerprint(path: Path) -> str:
    connection = open_read_only_connection(path)
    try:
        rows = connection.execute(
            "SELECT type, name, COALESCE(sql, '') FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY type, name"
        ).fetchall()
        canonical = "\n".join("|".join(str(value) for value in row) for row in rows)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    finally:
        connection.close()


def ensure_output_directory(path: Path, allow_resume: bool = False) -> None:
    if path.exists():
        if not path.is_dir():
            raise CliError(f"輸出路徑不是資料夾：{path}")
        if any(path.iterdir()) and not allow_resume:
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


def index_artifact_metadata(root: Path, relative: str) -> dict[str, Any]:
    """Return integrity metadata for one generated index artifact."""
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise CliError(f"索引 artifact 路徑不得離開輸出資料夾：{relative}")
    if not candidate.is_file():
        raise CliError(f"索引 artifact 不存在：{relative}")
    return {
        "path": relative,
        "bytes": candidate.stat().st_size,
        "sha256": sha256_file(candidate),
    }


def source_database_candidates(source: Path, relative: str) -> list[Path]:
    """Resolve a masked source path without guessing between accounts."""
    if source.is_file():
        return [source.parent / Path(relative).name]
    literal = source / relative
    if literal.is_file():
        return [literal]
    if "P_<account-id>" not in relative:
        return []
    pattern = relative.replace("P_<account-id>", "P_*")
    return sorted(candidate for candidate in source.glob(pattern) if candidate.is_file())


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
    if args.deep:
        if report["core"]["line_sqlite"]:
            database = source / report["core"]["line_sqlite"]
            report["sqlite_health"] = sqlite_health(database, full_integrity=args.full_integrity)
            report["capabilities"] = capability_probe(database)
        else:
            report["sqlite_health"] = {"status": "not_checked", "reason": "Line.sqlite not found"}
    print_report(report, args.format)
    return 0 if not report["warnings"] or report["core"]["line_sqlite"] else 2


def command_health(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser().resolve()
    database = database_path_from_source(source)
    payload = {
        "source": str(source),
        "database": mask_account_ids(str(database)),
        "sqlite_health": sqlite_health(database, full_integrity=args.full_integrity),
        "capabilities": capability_probe(database),
    }
    if source.is_dir():
        report = scan_source(source)
        payload["source_report"] = public_report(report)
        payload["warnings"] = report["warnings"]
    print(json.dumps(mask_account_ids(payload), ensure_ascii=False, indent=2))
    return 0 if payload["sqlite_health"]["status"] == "pass" else 2


def command_capabilities(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser().resolve()
    if not database.is_file():
        raise CliError(f"--database 必須是存在的 SQLite 檔案：{database}")
    print(json.dumps(mask_account_ids(capability_probe(database)), ensure_ascii=False, indent=2))
    return 0


def command_search(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser().resolve()
    if not database.is_file():
        raise CliError(f"--database 必須是存在的 SQLite 檔案：{database}")
    if not args.query.strip():
        raise CliError("--query 不得為空。")
    output = Path(args.out).expanduser().resolve()
    if output.exists():
        raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    query = args.query.casefold()
    count = 0
    batches = 0
    with output.open("w", encoding="utf-8") as handle:
        for batch in iter_all_message_batches(database, chat_pk=args.chat_pk, batch_size=args.batch_size):
            batches += 1
            for row in batch:
                text = str(row.get("text") or "")
                if query not in text.casefold():
                    continue
                timestamp = int(row.get("timestamp_raw") or 0)
                if args.from_timestamp is not None and timestamp < args.from_timestamp:
                    continue
                if args.to_timestamp is not None and timestamp > args.to_timestamp:
                    continue
                if getattr(args, "sender_pk", None) is not None and int(row.get("sender_pk") or -1) != args.sender_pk:
                    continue
                if getattr(args, "content_type", None) is not None and int(row.get("content_type") or -1) != args.content_type:
                    continue
                row["match"] = args.query
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                count += 1
                if count >= args.limit:
                    break
            if count >= args.limit:
                break
    print(json.dumps({
        "database": mask_account_ids(str(database)),
        "query": args.query,
        "rows": count,
        "batches_scanned": batches,
        "limit": args.limit,
        "engine": "streaming-like-fallback",
        "read_only": True,
        "output": str(output),
    }, ensure_ascii=False, indent=2))
    return 0


def command_timeline(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser().resolve()
    if not database.is_file():
        raise CliError(f"--database 必須是存在的 SQLite 檔案：{database}")
    if args.gap_seconds < 1 or args.burst_seconds < 1:
        raise CliError("時間軸門檻必須大於 0。")
    output = Path(args.out).expanduser().resolve()
    if output.exists():
        raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    timestamp_unit = detect_timestamp_unit(database)
    previous: dict[int, tuple[int, float]] = {}
    events: list[dict[str, Any]] = []
    for batch in iter_all_message_batches(database, chat_pk=args.chat_pk, batch_size=args.batch_size):
        for row in batch:
            chat_pk = int(row.get("chat_pk") or 0)
            timestamp_raw = int(row.get("timestamp_raw") or 0)
            timestamp = timestamp_to_seconds(timestamp_raw, timestamp_unit)
            if timestamp is None:
                continue
            before = previous.get(chat_pk)
            if before is not None:
                gap = timestamp - before[1]
                if gap >= args.gap_seconds:
                    events.append({"type": "gap", "chat_pk": chat_pk, "from_timestamp": before[0], "to_timestamp": timestamp_raw, "from_timestamp_seconds": before[1], "to_timestamp_seconds": timestamp, "gap_seconds": gap, "timestamp_unit": timestamp_unit, "confidence": "exact"})
                elif gap <= args.burst_seconds:
                    events.append({"type": "burst", "chat_pk": chat_pk, "from_timestamp": before[0], "to_timestamp": timestamp_raw, "from_timestamp_seconds": before[1], "to_timestamp_seconds": timestamp, "gap_seconds": gap, "timestamp_unit": timestamp_unit, "confidence": "heuristic"})
            previous[chat_pk] = (timestamp_raw, timestamp)
    with output.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({
        "database": mask_account_ids(str(database)),
        "chat_pk": args.chat_pk,
        "events": len(events),
        "gap_seconds": args.gap_seconds,
        "burst_seconds": args.burst_seconds,
        "timestamp_unit": timestamp_unit,
        "chapter_status": "heuristic",
        "read_only": True,
        "output": str(output),
    }, ensure_ascii=False, indent=2))
    return 0


def command_schema(args: argparse.Namespace) -> int:
    database = Path(args.database).expanduser().resolve()
    if not database.is_file():
        raise CliError(f"--database 必須是存在的 SQLite 檔案：{database}")
    payload = schema_explorer_report(database, sample_limit=args.sample_limit)
    if args.out:
        output = Path(args.out).expanduser().resolve()
        if output.exists():
            raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
        write_json(output, mask_account_ids(payload))
        payload["output"] = str(output)
    print(json.dumps(mask_account_ids(payload), ensure_ascii=False, indent=2))
    return 0


def command_duplicates(args: argparse.Namespace) -> int:
    source = resolved_directory(args.source, "--source")
    output = Path(args.out).expanduser().resolve()
    if output.exists():
        raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
    records: dict[tuple[int, str], list[dict[str, Any]]] = {}
    scanned = 0
    for path in iter_files(source):
        relative = path.relative_to(source).as_posix()
        if not is_media_attachment_path(relative):
            continue
        scanned += 1
        stat = path.stat()
        try:
            digest = sha256_file(path)
        except OSError as error:
            records.setdefault((stat.st_size, "hash-error"), []).append({"path": relative, "size": stat.st_size, "thumbnail": "/Message Thumbnails/" in f"/{relative}/", "hash_error": str(error)})
            continue
        records.setdefault((stat.st_size, digest), []).append({"path": relative, "size": stat.st_size, "thumbnail": "/Message Thumbnails/" in f"/{relative}/"})
    groups = []
    for (size, digest), files in records.items():
        if len(files) < 2:
            continue
        if digest == "hash-error":
            continue
        has_thumbnail = any(file.get("thumbnail") for file in files)
        has_original = any(not file.get("thumbnail") for file in files)
        classification = "thumbnail_of_attachment" if has_thumbnail and has_original else "exact_duplicate"
        groups.append({"sha256": digest, "size": size, "files": files, "classification": classification})
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {"source": str(source), "scanned_files": scanned, "duplicate_groups": groups, "duplicate_files": sum(len(group["files"]) for group in groups), "read_only": True}
    write_json(output, mask_account_ids(payload))
    print(json.dumps({"output": str(output), "scanned_files": scanned, "duplicate_groups": len(groups), "read_only": True}, ensure_ascii=False, indent=2))
    return 0


def normalized_message_signature(row: dict[str, Any]) -> str:
    text = str(row.get("text") or "").strip()
    payload = "|".join([
        str(row.get("chat_pk") or ""),
        str(row.get("sender_pk") or ""),
        str(row.get("timestamp_raw") or ""),
        str(row.get("content_type") or ""),
        hashlib.sha256(text.encode("utf-8")).hexdigest(),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def chat_identity_map(path: Path) -> tuple[dict[int, str], dict[int, str]]:
    """Return stable-ish chat and sender identities for cross-backup inference."""
    connection = open_read_only_connection(path)
    chat_identities: dict[int, str] = {}
    sender_identities: dict[int, str] = {}
    try:
        chat_columns = table_columns(connection, "ZCHAT")
        if chat_columns:
            selected = [select_column(chat_columns, "Z_PK", "pk"), select_column(chat_columns, "ZMID", "id"), select_column(chat_columns, "ZTYPE", "type")]
            for row in connection.execute("SELECT " + ", ".join(selected) + " FROM ZCHAT"):
                pk = int(row["pk"] or 0)
                identity = readable_index_value(row["id"])
                if identity:
                    chat_identities[pk] = identity
        user_columns = table_columns(connection, "ZUSER")
        if user_columns:
            selected = [select_column(user_columns, "Z_PK", "pk"), select_column(user_columns, "ZMID", "id")]
            for row in connection.execute("SELECT " + ", ".join(selected) + " FROM ZUSER"):
                if row["pk"] is not None and readable_index_value(row["id"]):
                    sender_identities[int(row["pk"])] = readable_index_value(row["id"])
    finally:
        connection.close()
    return chat_identities, sender_identities


def inferred_message_key(
    row: dict[str, Any],
    chat_identities: dict[int, str] | None = None,
    sender_identities: dict[int, str] | None = None,
    include_text: bool = True,
) -> str:
    """Build a conservative cross-backup key without relying on unstable Z_PK."""
    chat_key = (chat_identities or {}).get(int(row.get("chat_pk") or 0), str(row.get("chat_pk") or ""))
    sender_key = (sender_identities or {}).get(int(row.get("sender_pk") or 0), str(row.get("sender_pk") or ""))
    parts = [
        chat_key,
        sender_key,
        str(row.get("timestamp_raw") or ""),
        str(row.get("content_type") or ""),
    ]
    if include_text:
        parts.append(hashlib.sha256(str(row.get("text") or "").strip().encode("utf-8")).hexdigest())
    return "|".join(parts)


def command_diff(args: argparse.Namespace) -> int:
    left = database_path_from_source(Path(args.left).expanduser().resolve())
    right = database_path_from_source(Path(args.right).expanduser().resolve())
    output = Path(args.out).expanduser().resolve()
    if output.exists():
        raise CliError(f"輸出檔案已存在，為避免覆寫請指定新路徑：{output}")
    def collect(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        rows = {}
        all_rows = []
        for batch in iter_all_message_batches(path, batch_size=args.batch_size):
            for row in batch:
                all_rows.append(row)
                message_id = str(row.get("id") or "").strip()
                if message_id:
                    rows[message_id] = row
        return rows, all_rows
    left_rows, left_all = collect(left)
    right_rows, right_all = collect(right)
    changes = []
    common_ids = set(left_rows) & set(right_rows)
    for key in sorted(common_ids):
        if normalized_message_signature(left_rows[key]) != normalized_message_signature(right_rows[key]):
            changes.append({"status": "changed", "key": key, "left": left_rows[key], "right": right_rows[key], "confidence": "exact"})

    # ZID can be absent or regenerated between backups. First pair identical
    # content conservatively, then pair a unique chat/sender/timestamp/content
    # candidate as an inferred change instead of calling it deleted.
    left_unmatched = [row for row in left_all if not str(row.get("id") or "").strip() or str(row.get("id") or "").strip() not in common_ids]
    right_unmatched = [row for row in right_all if not str(row.get("id") or "").strip() or str(row.get("id") or "").strip() not in common_ids]
    left_chat_ids, left_sender_ids = chat_identity_map(left)
    right_chat_ids, right_sender_ids = chat_identity_map(right)
    for include_text in (True, False):
        left_by_key: dict[str, list[dict[str, Any]]] = {}
        right_by_key: dict[str, list[dict[str, Any]]] = {}
        for row in left_unmatched:
            left_by_key.setdefault(inferred_message_key(row, left_chat_ids, left_sender_ids, include_text), []).append(row)
        for row in right_unmatched:
            right_by_key.setdefault(inferred_message_key(row, right_chat_ids, right_sender_ids, include_text), []).append(row)
        paired_left: set[int] = set()
        paired_right: set[int] = set()
        for key in sorted(set(left_by_key) & set(right_by_key)):
            left_candidates = left_by_key[key]
            right_candidates = right_by_key[key]
            if len(left_candidates) != 1 or len(right_candidates) != 1:
                changes.append({"status": "ambiguous", "key": key, "left": left_candidates, "right": right_candidates, "confidence": "ambiguous"})
                paired_left.update(id(row) for row in left_candidates)
                paired_right.update(id(row) for row in right_candidates)
                continue
            left_row = left_candidates[0]
            right_row = right_candidates[0]
            left_index = id(left_row)
            right_index = id(right_row)
            paired_left.add(left_index)
            paired_right.add(right_index)
            if not include_text:
                changes.append({"status": "changed", "key": key, "left": left_row, "right": right_row, "confidence": "inferred"})
        left_unmatched = [row for row in left_unmatched if id(row) not in paired_left]
        right_unmatched = [row for row in right_unmatched if id(row) not in paired_right]

    for row in right_unmatched:
        changes.append({"status": "added", "key": inferred_message_key(row, right_chat_ids, right_sender_ids), "right": row, "confidence": "unresolved"})
    for row in left_unmatched:
        changes.append({"status": "present_only_in_left", "key": inferred_message_key(row, left_chat_ids, left_sender_ids), "left": row, "confidence": "unresolved"})
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for change in changes:
            handle.write(json.dumps(mask_account_ids(change), ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"left": mask_account_ids(str(left)), "right": mask_account_ids(str(right)), "changes": len(changes), "output": str(output), "read_only": True}, ensure_ascii=False, indent=2))
    return 0


def build_search_sidecar(database: Path, output: Path, batch_size: int) -> dict[str, Any]:
    capability = capability_probe(database)
    sidecar = output / "search.sqlite"
    temporary_sidecar = output / "search.sqlite.part"
    if capability.get("fts5") != "available":
        return {"status": "not_built", "reason": "SQLite FTS5 不可用", "path": None}
    connection: sqlite3.Connection | None = None
    try:
        temporary_sidecar.unlink(missing_ok=True)
        connection = sqlite3.connect(temporary_sidecar)
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("CREATE VIRTUAL TABLE messages_fts USING fts5(message_pk UNINDEXED, message_id UNINDEXED, chat_pk UNINDEXED, timestamp_raw UNINDEXED, text)")
        for batch in iter_all_message_batches(database, batch_size=batch_size):
            connection.executemany(
                "INSERT INTO messages_fts(message_pk, message_id, chat_pk, timestamp_raw, text) VALUES (?, ?, ?, ?, ?)",
                [(row.get("pk"), row.get("id"), row.get("chat_pk"), row.get("timestamp_raw"), row.get("text") or "") for row in batch],
            )
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.close()
        connection = None
        os.replace(temporary_sidecar, sidecar)
        return {"status": "built", "engine": "fts5", "path": "search.sqlite", "sha256": sha256_file(sidecar)}
    except sqlite3.Error as error:
        temporary_sidecar.unlink(missing_ok=True)
        return {"status": "not_built", "reason": str(error), "path": None}
    finally:
        if connection is not None:
            connection.close()


def readable_index_value(value: Any) -> str:
    text = str(value or "").strip()
    return "" if text.lower() in {"", "none", "null"} else text


def attachment_message_id_from_path(relative: str) -> str:
    name = Path(relative).name
    match = re.match(r"(\d{8,})(?:[_.-]|$)", name)
    if match:
        return match.group(1)
    match = re.search(r"(?:^|/)(\d{8,})(?:[_.-]|/|$)", relative)
    return match.group(1) if match else ""


def is_media_attachment_path(relative: str) -> bool:
    """Match LINE media directories while excluding Finder metadata files."""
    path = f"/{relative}/"
    return ("/Message Attachments/" in path or "/Message Thumbnails/" in path) and not Path(relative).name.startswith(".")


def build_index_participants(database: Path, output: Path) -> dict[str, Any]:
    destination = output / "participants.jsonl"
    connection = open_read_only_connection(database)
    rows: list[dict[str, Any]] = []
    try:
        columns = table_columns(connection, "ZUSER")
        if not columns:
            atomic_write_jsonl(destination, [])
            return {"path": "participants.jsonl", "rows": 0, "bytes": destination.stat().st_size, "sha256": sha256_file(destination)}
        selected = [
            select_column(columns, "Z_PK", "pk"),
            select_column(columns, "ZMID", "id"),
            select_column(columns, "ZCUSTOMNAME", "custom_name"),
            select_column(columns, "ZADDRESSBOOKNAME", "address_book_name"),
            select_column(columns, "ZNAME", "name"),
        ]
        for row in connection.execute("SELECT " + ", ".join(selected) + " FROM ZUSER ORDER BY ZMID"):
            participant_id = readable_index_value(row["id"])
            if not participant_id:
                continue
            name = next((readable_index_value(row[key]) for key in ("custom_name", "address_book_name", "name") if readable_index_value(row[key])), participant_id)
            rows.append({
                "pk": int(row["pk"]) if row["pk"] is not None else None,
                "id": participant_id,
                "name": name,
                "titleSource": "user",
                "sourceDatabase": "Messages/Line.sqlite",
                "sourceTable": "ZUSER",
                "confidence": "exact",
            })
    finally:
        connection.close()
    atomic_write_jsonl(destination, (mask_account_ids(row) for row in rows))
    return {"path": "participants.jsonl", "rows": len(rows), "bytes": destination.stat().st_size, "sha256": sha256_file(destination)}


def build_index_attachments(snapshot: Path, database: Path, output: Path, conversations: dict[int, dict[str, Any]]) -> dict[str, Any]:
    destination = output / "attachments.jsonl"
    connection = open_read_only_connection(database)
    total = 0
    unlinked = 0
    try:
        with (destination.with_name(destination.name + ".part")).open("w", encoding="utf-8") as handle:
            batch: list[tuple[Path, str, int]] = []

            def flush() -> None:
                nonlocal total, unlinked
                if not batch:
                    return
                ids = sorted({message_id for _, message_id, _ in batch if message_id})
                message_rows: dict[str, sqlite3.Row] = {}
                if ids:
                    for start in range(0, len(ids), 200):
                        group = ids[start:start + 200]
                        placeholders = ",".join("?" for _ in group)
                        columns = table_columns(connection, "ZMESSAGE")
                        selected = [
                            select_column(columns, "ZID", "id"),
                            select_column(columns, "Z_PK", "pk"),
                            select_column(columns, "ZCHAT", "chat_pk"),
                            select_column(columns, "ZSENDER", "sender_pk"),
                            select_column(columns, "ZTIMESTAMP", "timestamp_raw"),
                            select_column(columns, "ZCONTENTTYPE", "content_type"),
                            select_column(columns, "ZTEXT", "text"),
                        ]
                        for row in connection.execute("SELECT " + ", ".join(selected) + " FROM ZMESSAGE WHERE ZID IN (" + placeholders + ")", group):
                            message_rows[readable_index_value(row["id"])] = row
                for path, message_id, size in batch:
                    relative = path.relative_to(snapshot).as_posix()
                    row = message_rows.get(message_id)
                    chat_pk = int(row["chat_pk"]) if row and row["chat_pk"] is not None else None
                    chat = conversations.get(chat_pk) if chat_pk is not None else None
                    if row is None:
                        unlinked += 1
                    record = {
                        "path": relative,
                        "size": size,
                        "sha256": sha256_file(path),
                        "category": "thumbnail" if "/Message Thumbnails/" in f"/{relative}/" else "attachment",
                        "messageId": message_id,
                        "messagePk": int(row["pk"]) if row and row["pk"] is not None else None,
                        "chatPk": chat_pk,
                        "chatTitle": chat.get("title") if chat else "SQLite 未找到對應聊天室",
                        "scope": ("individual" if chat and chat.get("type") == "direct" else chat.get("type") if chat else "orphan"),
                        "timestampRaw": row["timestamp_raw"] if row else None,
                        "senderPk": row["sender_pk"] if row else None,
                        "contentType": row["content_type"] if row else None,
                        "context": readable_index_value(row["text"]) if row else "沒有可用訊息脈絡",
                        "relation": "SQLite 訊息 ID 對應" if row else "SQLite 未引用／孤兒檔案",
                        "confidence": "exact" if row else "unlinked",
                        "sourceDatabase": "Messages/Line.sqlite",
                        "sourceTable": "ZMESSAGE" if row else None,
                        "sourcePk": int(row["pk"]) if row and row["pk"] is not None else None,
                    }
                    handle.write(json.dumps(mask_account_ids(record), ensure_ascii=False, separators=(",", ":")) + "\n")
                    total += 1
                batch.clear()

            for path in iter_files(snapshot):
                relative = path.relative_to(snapshot).as_posix()
                if not is_media_attachment_path(relative):
                    continue
                batch.append((path, attachment_message_id_from_path(relative), path.stat().st_size))
                if len(batch) >= 128:
                    flush()
            flush()
        temporary = destination.with_name(destination.name + ".part")
        os.replace(temporary, destination)
    finally:
        connection.close()
        destination.with_name(destination.name + ".part").unlink(missing_ok=True)
    return {"path": "attachments.jsonl", "rows": total, "unlinked": unlinked, "bytes": destination.stat().st_size, "sha256": sha256_file(destination), "mediaCopied": False}


def command_index(args: argparse.Namespace) -> int:
    snapshot = resolved_directory(args.snapshot, "--snapshot")
    output = Path(args.out).expanduser().resolve()
    resume = bool(getattr(args, "resume", False))
    ensure_output_directory(output, allow_resume=resume)
    report = scan_source(snapshot)
    database = database_path_from_source(snapshot)
    source_hash = sha256_file(database)
    schema_fingerprint = database_schema_fingerprint(database)
    progress_path = output / ".progress.json"
    progress: dict[str, Any] = {}
    if resume and progress_path.is_file():
        try:
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise CliError(f"無法讀取索引續跑 checkpoint：{error}") from error
        if progress.get("source_sha256") != source_hash or progress.get("schema_fingerprint") != schema_fingerprint:
            raise CliError("來源 Line.sqlite 或 schema 已變更，不能續跑舊索引；請指定新的 --out。")
    elif resume and any(output.iterdir()):
        raise CliError("--resume 需要由本工具留下的 .progress.json；既有資料夾不是可驗證的 checkpoint。")
    messages_dir = output / "messages"
    messages_dir.mkdir(parents=True, exist_ok=True)
    existing_shards = list(progress.get("chat_shards") or [])
    total_rows = int(progress.get("message_rows") or 0)
    shard_count = len(existing_shards)
    conversations: dict[int, dict[str, Any]] = {}
    chat_shards: list[dict[str, Any]] = existing_shards
    shard_sequence = 0
    completed_by_path = {str(item.get("path")): item for item in existing_shards}
    unified_group_names: dict[str, dict[str, Any]] = {}
    unified_group_database = database.parent / "UnifiedGroup.sqlite"
    if unified_group_database.is_file():
        companion_connection: sqlite3.Connection | None = None
        try:
            companion_connection = open_read_only_connection(unified_group_database)
            companion_columns = table_columns(companion_connection, "ZUNIFIEDGROUP")
            companion_select = [
                select_column(companion_columns, "Z_PK", "group_pk"),
                select_column(companion_columns, "ZID", "group_id"),
                select_column(companion_columns, "ZNAME", "name"),
            ]
            for row in companion_connection.execute("SELECT " + ", ".join(companion_select) + " FROM ZUNIFIEDGROUP"):
                group_id = str(row["group_id"] or "").strip()
                name = str(row["name"] or "").strip()
                if group_id and name:
                    unified_group_names[group_id] = {"name": name, "pk": row["group_pk"] if "group_pk" in row.keys() else None}
        except sqlite3.Error:
            unified_group_names = {}
        finally:
            if companion_connection is not None:
                companion_connection.close()
    connection = open_read_only_connection(database)
    try:
        def readable_name(*values: Any) -> str:
            for value in values:
                text = str(value or "").strip()
                if text and text.lower() not in {"none", "null"}:
                    return text
            return ""

        chat_columns = table_columns(connection, "ZCHAT")
        user_names: dict[str, str] = {}
        user_names_by_pk: dict[int, str] = {}
        if table_columns(connection, "ZUSER"):
            user_columns = table_columns(connection, "ZUSER")
            user_select = [
                select_column(user_columns, "Z_PK", "user_pk"),
                select_column(user_columns, "ZMID", "user_id"),
                select_column(user_columns, "ZCUSTOMNAME", "custom_name"),
                select_column(user_columns, "ZADDRESSBOOKNAME", "address_book_name"),
                select_column(user_columns, "ZNAME", "name"),
            ]
            for row in connection.execute("SELECT " + ", ".join(user_select) + " FROM ZUSER"):
                user_id = readable_name(row["user_id"])
                if user_id:
                    name = readable_name(row["custom_name"], row["address_book_name"], row["name"], user_id)
                    user_names[user_id] = name
                    if row["user_pk"] is not None:
                        user_names_by_pk[int(row["user_pk"])] = name
        group_names: dict[str, str] = {}
        if table_columns(connection, "ZGROUP"):
            group_columns = table_columns(connection, "ZGROUP")
            group_select = [
                select_column(group_columns, "ZID", "group_id"),
                select_column(group_columns, "ZNAME", "name"),
            ]
            for row in connection.execute("SELECT " + ", ".join(group_select) + " FROM ZGROUP"):
                group_id = readable_name(row["group_id"])
                if group_id:
                    group_names[group_id] = readable_name(row["name"], group_id)
        chat_select = [
            select_column(chat_columns, "Z_PK", "chat_pk"),
            select_column(chat_columns, "ZMID", "chat_id"),
            select_column(chat_columns, "ZTYPE", "chat_type"),
            select_column(chat_columns, "ZLASTUPDATED", "last_updated"),
            select_column(chat_columns, "ZLASTMESSAGE", "last_message"),
        ]
        for row in connection.execute("SELECT " + ", ".join(chat_select) + " FROM ZCHAT ORDER BY Z_PK"):
            pk = int(row["chat_pk"] or 0)
            chat_id = readable_name(row["chat_id"])
            chat_type = int(row["chat_type"] or 0)
            unified_group = unified_group_names.get(chat_id)
            title = user_names.get(chat_id, "") if chat_type == 0 else (unified_group.get("name", "") if unified_group else "")
            title_source = "user" if chat_type == 0 and title else ("unified-group" if title else "unresolved")
            if not title and chat_type in (1, 2, 100):
                title = group_names.get(chat_id, "")
                title_source = "group" if title else "unresolved"
            title_evidence = []
            if chat_type == 0 and title:
                title_evidence = [{"sourceDatabase": "Messages/Line.sqlite", "sourceTable": "ZUSER", "sourceColumn": "ZCUSTOMNAME/ZADDRESSBOOKNAME/ZNAME", "confidence": "exact"}]
            elif unified_group and title:
                title_evidence = [{"sourceDatabase": "Messages/UnifiedGroup.sqlite", "sourceTable": "ZUNIFIEDGROUP", "sourceColumn": "ZNAME", "sourcePk": unified_group.get("pk"), "confidence": "exact"}]
            elif title:
                title_evidence = [{"sourceDatabase": "Messages/Line.sqlite", "sourceTable": "ZGROUP", "sourceColumn": "ZNAME", "confidence": "exact"}]
            conversations[pk] = {
                "chatPk": pk,
                "id": chat_id,
                "title": title or chat_id or ("未命名聊天室" if chat_type == 0 else "未命名群組"),
                "titleSource": title_source,
                "titleEvidence": title_evidence,
                "type": "direct" if chat_type == 0 else ("group" if chat_type in (1, 2) else ("community" if chat_type == 100 else "unknown")),
                "messageCount": 0,
                "lastTimestamp": row["last_updated"],
                "lastMessage": str(row["last_message"] or ""),
            }
    except sqlite3.Error:
        # A partial fixture may contain ZMESSAGE without ZCHAT.
        conversations = {}
    finally:
        connection.close()

    current_chat_pk: int | None = None
    current_rows: list[dict[str, Any]] = []

    def flush_chat_rows(chat_pk: int | None, rows: list[dict[str, Any]]) -> None:
        nonlocal shard_count, total_rows, shard_sequence
        if not rows:
            return
        shard_sequence += 1
        safe_pk = "unknown" if chat_pk is None else str(chat_pk)
        shard = messages_dir / f"chat-{safe_pk}-{shard_sequence:06d}.jsonl"
        relative_shard = f"messages/{shard.name}"
        expected = completed_by_path.get(relative_shard)
        if expected and shard.is_file() and expected.get("sha256") == sha256_file(shard) and int(expected.get("row_count") or 0) == len(rows):
            return
        temporary = shard.with_name(shard.name + ".part")
        with temporary.open("w", encoding="utf-8") as handle:
            for row in rows:
                row = dict(row)
                sender_pk = row.get("sender_pk")
                row["sender_name"] = user_names_by_pk.get(int(sender_pk)) if sender_pk is not None and str(sender_pk).strip() else None
                row["source_shard"] = relative_shard
                handle.write(json.dumps(mask_account_ids(row), ensure_ascii=False, separators=(",", ":")) + "\n")
        os.replace(temporary, shard)
        first = rows[0].get("timestamp_raw")
        last = rows[-1].get("timestamp_raw")
        metadata = {"chat_pk": chat_pk, "path": relative_shard, "row_count": len(rows), "bytes": shard.stat().st_size, "first_timestamp": first, "last_timestamp": last, "sha256": sha256_file(shard)}
        chat_shards.append(metadata)
        completed_by_path[relative_shard] = metadata
        shard_count = len(chat_shards)
        total_rows += len(rows)
        atomic_write_json(progress_path, {"version": 1, "source_sha256": source_hash, "schema_fingerprint": schema_fingerprint, "chat_shards": chat_shards, "message_rows": total_rows, "message_shards": shard_count})

    rename_patterns = (
        re.compile(r"群組名稱\s*改為\s*[「『\"“](.*?)[」』\"”]"),
        re.compile(r"(?:change|changed)\s+the\s+group\s+name\s+to\s*[「『\"“](.*?)[」』\"”]", re.IGNORECASE),
        re.compile(r"(?:群組名稱|group\s+name)[^「『\"“]{0,24}[「『\"“](.*?)[」』\"”]", re.IGNORECASE),
    )
    rename_names: dict[int, str] = {}
    for batch in iter_all_message_batches(database, batch_size=args.batch_size, order_by_chat=True):
        for row in batch:
            chat_pk_value = row.get("chat_pk")
            chat_pk = int(chat_pk_value) if chat_pk_value is not None else None
            if current_chat_pk is not None and chat_pk != current_chat_pk:
                flush_chat_rows(current_chat_pk, current_rows)
                current_rows = []
            current_chat_pk = chat_pk
            current_rows.append(row)
            if chat_pk is not None:
                conversation = conversations.setdefault(chat_pk, {
                    "chatPk": chat_pk, "id": "", "title": "未命名聊天室", "titleSource": "unresolved", "titleEvidence": [], "type": "unknown", "messageCount": 0, "lastTimestamp": None, "lastMessage": "",
                })
                conversation["messageCount"] += 1
                conversation["lastTimestamp"] = row.get("timestamp_raw")
                if int(row.get("content_type") or 0) == 18 and row.get("text"):
                    text = str(row["text"]).replace("\u2068", "").replace("\u2069", "").strip()
                    for pattern in rename_patterns:
                        match = pattern.search(text)
                        if match and match.group(1).strip():
                            rename_names[chat_pk] = match.group(1).strip()
                            break
            if len(current_rows) >= args.batch_size:
                flush_chat_rows(current_chat_pk, current_rows)
                current_rows = []
    flush_chat_rows(current_chat_pk, current_rows)

    for chat_pk, title in rename_names.items():
        if chat_pk in conversations and conversations[chat_pk]["type"] in ("group", "community") and conversations[chat_pk]["titleSource"] == "unresolved":
            conversations[chat_pk]["title"] = title
            conversations[chat_pk]["titleSource"] = "rename"
            conversations[chat_pk]["titleEvidence"] = [{"sourceDatabase": "Messages/Line.sqlite", "sourceTable": "ZMESSAGE", "sourceColumn": "ZTEXT", "confidence": "inferred"}]

    conversations_path = output / "conversations.jsonl"
    conversations_temp = conversations_path.with_name(conversations_path.name + ".part")
    with conversations_temp.open("w", encoding="utf-8") as handle:
        for chat in sorted(conversations.values(), key=lambda item: (-(int(item.get("lastTimestamp") or 0)), int(item.get("chatPk") or 0))):
            handle.write(json.dumps(mask_account_ids(chat), ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(conversations_temp, conversations_path)
    participant_report = build_index_participants(database, output)
    attachment_report = build_index_attachments(snapshot, database, output, conversations)
    unresolved = [
        {"chatPk": chat.get("chatPk"), "id": chat.get("id"), "title": chat.get("title"), "type": chat.get("type"), "reason": "找不到可靠的 SQLite 名稱來源"}
        for chat in conversations.values() if chat.get("titleSource") == "unresolved"
    ]
    warnings_report = {
        "status": "warning" if unresolved or report.get("warnings") else "pass",
        "sourceWarnings": report.get("warnings", []),
        "unresolvedConversations": mask_account_ids(unresolved),
        "warnings": ["聊天室名稱未能由 ZUSER、UnifiedGroup.sqlite、ZGROUP 或改名系統訊息確認。"] if unresolved else [],
    }
    atomic_write_json(output / "reports" / "warnings.json", mask_account_ids(warnings_report))
    search_sidecar = build_search_sidecar(database, output, args.batch_size)
    verification_report = {"status": "passed", "message_rows": total_rows, "message_shards": len(chat_shards), "source_unchanged": True, "read_only_source": True}
    atomic_write_json(output / "reports" / "verification.json", verification_report)
    timestamp_values = []
    for shard in chat_shards:
        for key in ("first_timestamp", "last_timestamp"):
            value = shard.get(key)
            if value is None:
                continue
            try:
                timestamp_values.append(int(value))
            except (TypeError, ValueError):
                continue
    timestamp_range = {"min": min(timestamp_values), "max": max(timestamp_values)} if timestamp_values else None
    artifact_paths = [
        "conversations.jsonl",
        "participants.jsonl",
        "attachments.jsonl",
        "reports/warnings.json",
        "reports/verification.json",
    ] + ([search_sidecar["path"]] if search_sidecar.get("path") else [])
    artifacts = {path: index_artifact_metadata(output, path) for path in artifact_paths}
    manifest = {
        "index_version": "0.2",
        "parser_version": CLI_VERSION,
        "source": {"line_sqlite": mask_account_ids(report["core"]["line_sqlite"]), "file_count": report["summary"]["file_count"], "backup_bytes": report["summary"]["backup_bytes"]},
        "database_sha256": source_hash,
        "schema_fingerprint": schema_fingerprint,
        "timestamp_unit": detect_timestamp_unit(database),
        "source_databases": {
            "line_sqlite": {"path": mask_account_ids(database.relative_to(snapshot).as_posix()), "sha256": source_hash},
            **({"unified_group": {"path": mask_account_ids(unified_group_database.relative_to(snapshot).as_posix()), "sha256": sha256_file(unified_group_database), "schema_fingerprint": database_schema_fingerprint(unified_group_database)}} if unified_group_database.is_file() else {}),
        },
        "message_rows": total_rows,
        "message_shards": len(chat_shards),
        "conversation_count": len(conversations),
        "chat_shards": chat_shards,
        "participants": participant_report,
        "attachments": attachment_report,
        "health": {
            "status": "warning" if unresolved else "pass",
            "read_only": True,
            "checks": {
                "conversation_count": len(conversations),
                "message_rows": total_rows,
                "attachment_count": attachment_report["rows"],
                "unlinked_attachment_count": attachment_report["unlinked"],
                "source_sha256": source_hash,
                "timestamp_unit": detect_timestamp_unit(database),
                "timestamp_range": timestamp_range,
            },
            "warnings": warnings_report["warnings"],
        },
        "search_sidecar": search_sidecar,
        "files": ["manifest.json"] + artifact_paths,
        "artifacts": artifacts,
        "batch_size": args.batch_size,
        "stale_check": "compare source Line.sqlite and companion UnifiedGroup.sqlite SHA-256 values with source_databases",
        "media_copied": False,
        "read_only_source": True,
        "rerunnable": {"supported": True, "checkpoint": ".progress.json", "resume_command": "line_migrator.py index --resume"},
    }
    atomic_write_json(output / "manifest.json", manifest)
    progress_path.unlink(missing_ok=True)
    print(json.dumps({"output": str(output), "message_rows": total_rows, "message_shards": len(chat_shards), "source_unchanged": True, "participants": participant_report["rows"], "attachments": attachment_report["rows"]}, ensure_ascii=False, indent=2))
    return 0


def command_verify_index(args: argparse.Namespace) -> int:
    index = resolved_directory(args.index, "--index")
    manifest_path = index / "manifest.json"
    if not manifest_path.is_file():
        raise CliError(f"找不到大型索引 manifest.json：{manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"無法讀取大型索引 manifest.json：{error}") from error

    checked_files = 0
    failed_files: list[dict[str, Any]] = []
    for shard in manifest.get("chat_shards", []):
        relative = shard.get("path")
        expected = shard.get("sha256")
        if not relative or not expected:
            failed_files.append({"path": relative, "reason": "缺少檔案路徑或 SHA-256"})
            continue
        candidate = index / relative
        if not candidate.is_file():
            failed_files.append({"path": relative, "reason": "檔案不存在"})
            continue
        actual = sha256_file(candidate)
        checked_files += 1
        if actual != expected:
            failed_files.append({"path": relative, "reason": "SHA-256 不一致", "expected": expected, "actual": actual})

    artifacts = manifest.get("artifacts") or {}
    if not artifacts:
        # Indexes produced before artifact metadata was introduced still get a
        # useful minimum check, but are explicitly reported as legacy.
        legacy_artifacts = ["conversations.jsonl"]
        for relative in legacy_artifacts:
            candidate = index / relative
            if not candidate.is_file():
                failed_files.append({"path": relative, "reason": "檔案不存在"})
        artifact_status = "legacy"
    else:
        artifact_status = "checked"
        for relative, expected in artifacts.items():
            if not relative or not isinstance(expected, dict):
                failed_files.append({"path": relative, "reason": "artifact metadata 無效"})
                continue
            try:
                metadata = index_artifact_metadata(index, relative)
            except CliError as error:
                failed_files.append({"path": relative, "reason": str(error)})
                continue
            checked_files += 1
            if expected.get("bytes") is not None and int(expected["bytes"]) != metadata["bytes"]:
                failed_files.append({"path": relative, "reason": "bytes 不一致", "expected": expected.get("bytes"), "actual": metadata["bytes"]})
            if expected.get("sha256") and expected["sha256"] != metadata["sha256"]:
                failed_files.append({"path": relative, "reason": "SHA-256 不一致", "expected": expected.get("sha256"), "actual": metadata["sha256"]})

        listed_files = set(str(path) for path in manifest.get("files", []) if path != "manifest.json")
        missing_metadata = sorted(listed_files - set(artifacts))
        for relative in missing_metadata:
            failed_files.append({"path": relative, "reason": "manifest files 缺少 artifact metadata"})

    source_status = "not_checked"
    source_result: dict[str, Any] = {}
    if args.source:
        source = Path(args.source).expanduser().resolve()
        database = database_path_from_source(source)
        source_databases = manifest.get("source_databases") or {
            "line_sqlite": {"path": "Line.sqlite", "sha256": manifest.get("database_sha256")}
        }
        database_results: dict[str, Any] = {}
        stale = False
        for name, info in source_databases.items():
            expected = info.get("sha256")
            if name == "line_sqlite":
                candidates = [database]
            else:
                relative = str(info.get("path") or "")
                candidates = source_database_candidates(source, relative)
            if not candidates:
                database_results[name] = {"path": mask_account_ids(str(source / str(info.get("path") or ""))), "status": "missing", "expected_sha256": expected}
                stale = True
                continue
            if len(candidates) > 1:
                database_results[name] = {"path": mask_account_ids(str(candidates[0].parent)), "status": "ambiguous", "candidates": [mask_account_ids(str(candidate)) for candidate in candidates], "expected_sha256": expected}
                stale = True
                continue
            candidate = candidates[0]
            actual = sha256_file(candidate)
            status = "pass" if actual == expected else "stale"
            stale = stale or status == "stale"
            database_results[name] = {
                "path": mask_account_ids(str(candidate)),
                "status": status,
                "expected_sha256": expected,
                "actual_sha256": actual,
            }
        source_status = "stale" if stale else "pass"
        source_result = {
            "path": mask_account_ids(str(database)),
            "databases": database_results,
        }

    status = "passed" if not failed_files and source_status != "stale" else "failed"
    result = {
        "status": status,
        "index": str(index),
        "index_version": manifest.get("index_version"),
        "checked_shards": checked_files,
        "artifact_status": artifact_status,
        "failed_files": failed_files,
        "source_status": source_status,
        "source": source_result,
        "message_rows": manifest.get("message_rows"),
        "read_only": True,
    }
    print(json.dumps(mask_account_ids(result), ensure_ascii=False, indent=2))
    return 0 if status == "passed" else 1


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
    inspect_parser.add_argument("--deep", action="store_true", help="額外執行 SQLite health 與 capability 檢查。")
    inspect_parser.add_argument("--full-integrity", action="store_true", help="在 --deep 時執行較慢的完整 integrity_check。")
    inspect_parser.set_defaults(function=command_inspect)

    health_parser = subparsers.add_parser("health", help="唯讀檢查 LINE 來源與核心 SQLite 健康狀態。")
    health_parser.add_argument("--source", required=True, help="LINE App Container 資料夾或 Line.sqlite。")
    health_parser.add_argument("--full-integrity", action="store_true", help="執行較慢的完整 integrity_check。")
    health_parser.set_defaults(function=command_health)

    capabilities_parser = subparsers.add_parser("capabilities", help="探測 SQLite 編譯功能，不修改來源。")
    capabilities_parser.add_argument("--database", required=True, help="SQLite 檔案。")
    capabilities_parser.set_defaults(function=command_capabilities)

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

    messages_parser = subparsers.add_parser(
        "messages",
        help="以唯讀 keyset pagination 分批輸出單一聊天室訊息 JSONL。",
    )
    messages_parser.add_argument("--database", required=True, help="staging 中的 Messages/Line.sqlite。")
    messages_parser.add_argument("--chat-pk", required=True, type=int, help="ZCHAT.Z_PK；先由 inspect／schema 查詢。")
    messages_parser.add_argument("--out", required=True, help="不存在的新 JSONL 輸出檔案。")
    messages_parser.add_argument("--batch-size", type=int, default=500, help="每批最多讀取筆數，預設 500，最大 5000。")
    messages_parser.add_argument("--after-timestamp", type=int, default=0, help="從指定 timestamp_raw 之後繼續。")
    messages_parser.add_argument("--after-pk", type=int, default=0, help="同 timestamp 時從指定 Z_PK 之後繼續。")
    messages_parser.set_defaults(function=command_messages)

    search_parser = subparsers.add_parser("search", help="以唯讀批次方式搜尋訊息文字。")
    search_parser.add_argument("--database", required=True, help="staging 中的 Messages/Line.sqlite。")
    search_parser.add_argument("--query", required=True, help="搜尋文字。")
    search_parser.add_argument("--out", required=True, help="不存在的新 JSONL 輸出檔案。")
    search_parser.add_argument("--chat-pk", type=int)
    search_parser.add_argument("--sender-pk", type=int)
    search_parser.add_argument("--content-type", type=int)
    search_parser.add_argument("--from-timestamp", type=int)
    search_parser.add_argument("--to-timestamp", type=int)
    search_parser.add_argument("--limit", type=int, default=1000)
    search_parser.add_argument("--batch-size", type=int, default=500)
    search_parser.set_defaults(function=command_search)

    timeline_parser = subparsers.add_parser("timeline", help="產生訊息間隔與推測章節事件。")
    timeline_parser.add_argument("--database", required=True, help="staging 中的 Messages/Line.sqlite。")
    timeline_parser.add_argument("--out", required=True, help="不存在的新 JSONL 輸出檔案。")
    timeline_parser.add_argument("--chat-pk", type=int)
    timeline_parser.add_argument("--gap-seconds", type=int, default=7200)
    timeline_parser.add_argument("--burst-seconds", type=int, default=300)
    timeline_parser.add_argument("--batch-size", type=int, default=500)
    timeline_parser.set_defaults(function=command_timeline)

    schema_parser = subparsers.add_parser("schema", help="輸出遮罩後的 SQLite Schema Explorer JSON。")
    schema_parser.add_argument("--database", required=True, help="SQLite 檔案。")
    schema_parser.add_argument("--out", help="可選的 JSON 輸出路徑；檔案必須不存在。")
    schema_parser.add_argument("--sample-limit", type=int, default=20)
    schema_parser.set_defaults(function=command_schema)

    duplicates_parser = subparsers.add_parser("duplicates", help="串流掃描附件並找出 exact duplicate。")
    duplicates_parser.add_argument("--source", required=True, help="LINE App Container 資料夾。")
    duplicates_parser.add_argument("--out", required=True, help="不存在的新 JSON 報告。")
    duplicates_parser.set_defaults(function=command_duplicates)

    diff_parser = subparsers.add_parser("diff", help="比較兩份來源的 normalized 訊息差異。")
    diff_parser.add_argument("--left", required=True, help="左側 LINE 資料夾或 Line.sqlite。")
    diff_parser.add_argument("--right", required=True, help="右側 LINE 資料夾或 Line.sqlite。")
    diff_parser.add_argument("--out", required=True, help="不存在的新 JSONL 差異報告。")
    diff_parser.add_argument("--batch-size", type=int, default=500)
    diff_parser.set_defaults(function=command_diff)

    index_parser = subparsers.add_parser("index", help="建立可分片載入的大型備份 reader index。")
    index_parser.add_argument("--snapshot", required=True, help="已建立的 staging 資料夾。")
    index_parser.add_argument("--out", required=True, help="不存在或為空的 index 輸出資料夾。")
    index_parser.add_argument("--batch-size", type=int, default=500)
    index_parser.add_argument("--resume", action="store_true", help="從本工具留下的 .progress.json checkpoint 繼續；來源 hash 不得變更。")
    index_parser.set_defaults(function=command_index)

    verify_index_parser = subparsers.add_parser("verify-index", help="驗證大型索引分片與來源 SHA-256，不修改資料。")
    verify_index_parser.add_argument("--index", required=True, help="由 index 指令建立的索引資料夾。")
    verify_index_parser.add_argument("--source", help="可選的 staging 資料夾或 Line.sqlite，用來檢查來源是否已變更。")
    verify_index_parser.set_defaults(function=command_verify_index)

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
