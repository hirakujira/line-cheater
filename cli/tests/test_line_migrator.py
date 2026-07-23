import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest import mock

from cli import line_migrator


class LineMigratorTests(unittest.TestCase):
    def make_fixture(self, root: Path) -> Path:
        source = root / "line-backup"
        db_dir = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages"
        db_dir.mkdir(parents=True)
        (source / "Payload" / "LINE.app").mkdir(parents=True)
        (source / ".lock").write_bytes(b"lock")
        (source / "Payload" / "LINE.app" / "Info.plist").write_bytes(b"plist")
        db_path = db_dir / "Line.sqlite"
        connection = sqlite3.connect(db_path)
        connection.execute("CREATE TABLE ZCHAT (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT)")
        connection.execute(
            "CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTIMESTAMP INTEGER, "
            "ZCHAT INTEGER, ZSENDER INTEGER, ZSENDSTATUS INTEGER, ZCONTENTTYPE INTEGER, "
            "ZMESSAGETYPE TEXT, ZTEXT TEXT, ZLATITUDE REAL, ZLONGITUDE REAL)"
        )
        connection.commit()
        connection.close()
        return source

    def test_inspect_finds_line_container(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = line_migrator.scan_source(self.make_fixture(Path(temporary)))
            self.assertEqual(report["backup_type"], "line-ios-app-container")
            self.assertEqual(report["core"]["line_sqlite"].split("/")[-2:], ["Messages", "Line.sqlite"])
            self.assertEqual(report["summary"]["file_count"], 3)

    def test_snapshot_rejects_source_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = self.make_fixture(Path(temporary))
            with self.assertRaises(line_migrator.CliError):
                line_migrator.ensure_snapshot_destination(source, source / "work" / "snapshot")

    def test_snapshot_excludes_non_backup_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            (source / "README.md").write_text("development file", encoding="utf-8")
            report = line_migrator.scan_source(source)
            destination = root / "snapshot"
            line_migrator.ensure_snapshot_destination(source, destination)
            line_migrator.copy_backup_members(source, destination, report["_records"])
            self.assertTrue((destination / "Container").is_dir())
            self.assertFalse((destination / "README.md").exists())
            self.assertIn("README.md", report["excluded_non_backup_files"])

    def test_parse_writes_schema_and_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            snapshot = root / "snapshot"
            snapshot = Path(shutil_copytree(source, snapshot))
            report = line_migrator.scan_source(snapshot)
            output = root / "output"
            schema = line_migrator.build_schema_report(snapshot, report)
            line_migrator.write_json(output / "schema.json", schema)
            payload = json.loads((output / "schema.json").read_text(encoding="utf-8"))
            table_names = {table["name"] for table in payload["databases"][0]["tables"]}
            self.assertEqual(table_names, {"ZCHAT", "ZMESSAGE"})
            self.assertTrue(all("read_only_uri" not in database for database in payload["databases"]))
            self.assertNotIn("ue966", json.dumps(payload))

    def test_report_masks_account_folder(self):
        report = {"source": {"path": "Container/P_abc123/Messages/Line.sqlite"}}
        self.assertEqual(
            line_migrator.public_report(report)["source"]["path"],
            "Container/P_<account-id>/Messages/Line.sqlite",
        )

    def test_report_masks_account_folder_in_dictionary_keys(self):
        report = {
            "preserved_core_sha256": {
                "Container/P_abc123/Messages/Line.sqlite": "hash",
            },
        }
        payload = line_migrator.public_report(report)
        self.assertIn("Container/P_<account-id>/Messages/Line.sqlite", payload["preserved_core_sha256"])
        self.assertNotIn("P_abc123", json.dumps(payload))

    def test_sqlite_uri_is_read_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = self.make_fixture(Path(temporary))
            report = line_migrator.scan_source(source)
            database_path = source / report["core"]["line_sqlite"]
            connection = sqlite3.connect(line_migrator.sqlite_uri(database_path), uri=True)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("CREATE TABLE SHOULD_NOT_BE_WRITTEN (id INTEGER)")
            connection.close()
            self.assertFalse((database_path.parent / "SHOULD_NOT_BE_WRITTEN").exists())

    def test_slim_test_removes_requested_thumbnail_and_preserves_core(self):
        if shutil.which("zip") is None or shutil.which("unzip") is None:
            self.skipTest("需要 macOS Info-ZIP zip/unzip")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "LINE.imazingapp"
            thumbnail = (
                "Container/AppGroups/group.com.linecorp.line/"
                "Library/Application Support/PrivateStore/P_test/"
                "Message Thumbnails/test.thumb"
            )
            attachment = thumbnail.replace("Message Thumbnails/test.thumb", "Message Attachments/original.jpg")
            line_sqlite = "Container/AppGroups/group.com.linecorp.line/Messages/Line.sqlite"
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(".lock", b"lock")
                archive.writestr("Payload/LINE.app/Info.plist", b"plist")
                archive.writestr(line_sqlite, b"sqlite")
                archive.writestr(thumbnail, b"thumbnail")
                archive.writestr(attachment, b"original")

            source_hash = line_migrator.sha256_file(source)
            output = root / "LINE-slim.imazingapp.candidate"
            result = line_migrator.slim_test_archive(source, output, [thumbnail])

            self.assertEqual(result["status"], "passed")
            self.assertTrue(result["source_unchanged"])
            self.assertEqual(result["entry_count_before"] - result["entry_count_after"], 1)
            self.assertEqual(line_migrator.sha256_file(source), source_hash)
            with zipfile.ZipFile(output) as archive:
                self.assertNotIn(thumbnail, archive.namelist())
                self.assertIn(attachment, archive.namelist())
                self.assertIn(line_sqlite, archive.namelist())

    def test_slim_test_rejects_original_attachment_by_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "LINE.imazingapp"
            source.write_bytes(b"not a zip")
            with self.assertRaises(line_migrator.CliError):
                line_migrator.slim_test_archive(
                    source,
                    root / "LINE-slim.imazingapp.candidate",
                    ["Container/P_test/Message Attachments/original.jpg"],
                )

    def test_iter_message_batches_uses_keyset_pagination(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTIMESTAMP INTEGER, ZCHAT INTEGER, ZSENDER INTEGER, ZSENDSTATUS INTEGER, ZCONTENTTYPE INTEGER, ZMESSAGETYPE TEXT, ZTEXT TEXT, ZLATITUDE REAL, ZLONGITUDE REAL)")
            connection.executemany(
                "INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZTEXT) VALUES (?, ?, ?, ?, ?)",
                [(1, "one", 100, 7, "one"), (2, "two", 100, 7, "two"), (3, "three", 200, 7, "three")],
            )
            connection.commit()
            connection.close()

            batches = list(line_migrator.iter_message_batches(database, 7, batch_size=2))
            self.assertEqual([[row["id"] for row in batch] for batch in batches], [["one", "two"], ["three"]])
            resumed = list(line_migrator.iter_message_batches(database, 7, batch_size=2, after_timestamp=100, after_pk=2))
            self.assertEqual([row["id"] for batch in resumed for row in batch], ["three"])

    def test_capability_and_health_are_read_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = self.make_fixture(Path(temporary))
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            capabilities = line_migrator.capability_probe(database)
            health = line_migrator.sqlite_health(database)
            self.assertTrue(capabilities["read_only"])
            self.assertEqual(health["status"], "pass")
            self.assertEqual(health["checks"]["quick_check"], ["ok"])
            self.assertFalse((database.parent / "SHOULD_NOT_BE_WRITTEN").exists())

    def test_search_timeline_schema_and_index_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.executemany(
                "INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZSENDER, ZTEXT) VALUES (?, ?, ?, ?, ?, ?)",
                [(1, "m1", 100, 7, 1, "first hello"), (2, "m2", 200, 7, 1, "second hello"), (3, "m3", 10000, 7, 2, "later")],
            )
            connection.commit()
            connection.close()

            search_out = root / "search.jsonl"
            line_migrator.command_search(SimpleNamespace(database=str(database), query="hello", out=str(search_out), chat_pk=7, from_timestamp=None, to_timestamp=None, limit=10, batch_size=2))
            self.assertEqual(len(search_out.read_text(encoding="utf-8").splitlines()), 2)

            timeline_out = root / "timeline.jsonl"
            line_migrator.command_timeline(SimpleNamespace(database=str(database), out=str(timeline_out), chat_pk=7, gap_seconds=5000, burst_seconds=200, batch_size=2))
            timeline_rows = timeline_out.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(timeline_rows), 2)
            self.assertIn('"type":"burst"', timeline_rows[0])

            schema_out = root / "schema.json"
            line_migrator.command_schema(SimpleNamespace(database=str(database), out=str(schema_out), sample_limit=5))
            self.assertIn("ZMESSAGE", schema_out.read_text(encoding="utf-8"))

            index_out = root / "index"
            line_migrator.command_index(SimpleNamespace(snapshot=str(source), out=str(index_out), batch_size=2))
            manifest = json.loads((index_out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["message_rows"], 3)
            self.assertEqual(manifest["health"]["checks"]["timestamp_range"], {"min": 100, "max": 10000})
            self.assertEqual(len(list((index_out / "messages").glob("*.jsonl"))), 2)
            self.assertEqual(manifest["search_sidecar"]["status"], "built")
            self.assertTrue((index_out / "search.sqlite").is_file())
            verify_args = SimpleNamespace(index=str(index_out), source=str(source))
            self.assertEqual(line_migrator.command_verify_index(verify_args), 0)

            database.write_bytes(database.read_bytes() + b"\n")
            self.assertEqual(line_migrator.command_verify_index(verify_args), 1)

    def test_millisecond_timeline_keeps_raw_values_and_uses_seconds_threshold(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.executemany(
                "INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZTEXT) VALUES (?, ?, ?, ?, ?)",
                [(1, "m1", 1700000000000, 7, "first"), (2, "m2", 1700000002000, 7, "second")],
            )
            connection.commit()
            connection.close()
            output = root / "timeline.jsonl"
            line_migrator.command_timeline(SimpleNamespace(database=str(database), out=str(output), chat_pk=7, gap_seconds=1, burst_seconds=1, batch_size=10))
            payload = json.loads(output.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(payload["timestamp_unit"], "milliseconds")
            self.assertEqual(payload["from_timestamp"], 1700000000000)
            self.assertEqual(payload["to_timestamp"], 1700000002000)
            self.assertAlmostEqual(payload["gap_seconds"], 2.0)

    def test_diff_infers_regenerated_message_id_and_reports_changed_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            left = root / "left.sqlite"
            right = root / "right.sqlite"
            for path, message_id, text in ((left, "old-id", "same"), (right, "new-id", "changed")):
                connection = sqlite3.connect(path)
                connection.execute("CREATE TABLE ZCHAT (Z_PK INTEGER PRIMARY KEY, ZMID TEXT, ZTYPE INTEGER)")
                connection.execute("CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTIMESTAMP INTEGER, ZCHAT INTEGER, ZSENDER INTEGER, ZCONTENTTYPE INTEGER, ZTEXT TEXT)")
                connection.execute("INSERT INTO ZCHAT VALUES (7, 'chat-stable', 1)")
                connection.execute("INSERT INTO ZMESSAGE VALUES (1, ?, 100, 7, 1, 0, ?)", (message_id, text))
                connection.commit()
                connection.close()
            output = root / "diff.jsonl"
            line_migrator.command_diff(SimpleNamespace(left=str(left), right=str(right), out=str(output), batch_size=10))
            changes = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(changes), 1)
            self.assertEqual(changes[0]["status"], "changed")
            self.assertEqual(changes[0]["confidence"], "inferred")

    def test_diff_reports_same_id_content_type_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            left = root / "left.sqlite"
            right = root / "right.sqlite"
            for path, content_type in ((left, 0), (right, 7)):
                connection = sqlite3.connect(path)
                connection.execute("CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTIMESTAMP INTEGER, ZCHAT INTEGER, ZSENDER INTEGER, ZCONTENTTYPE INTEGER, ZTEXT TEXT)")
                connection.execute("INSERT INTO ZMESSAGE VALUES (1, 'same-id', 100, 7, 1, ?, 'same text')", (content_type,))
                connection.commit()
                connection.close()
            output = root / "diff.jsonl"
            line_migrator.command_diff(SimpleNamespace(left=str(left), right=str(right), out=str(output), batch_size=10))
            change = json.loads(output.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(change["status"], "changed")
            self.assertEqual(change["confidence"], "exact")

    def test_index_artifacts_and_declared_foreign_keys_are_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("CREATE TABLE ZEXTRA (Z_PK INTEGER PRIMARY KEY, ZCHAT INTEGER REFERENCES ZCHAT(Z_PK))")
            connection.commit()
            connection.close()
            schema = line_migrator.schema_explorer_report(database, sample_limit=2)
            extra = next(table for table in schema["tables"] if table["name"] == "ZEXTRA")
            self.assertEqual(extra["declared_foreign_keys"][0]["table"], "ZCHAT")
            output = root / "index"
            line_migrator.command_index(SimpleNamespace(snapshot=str(source), out=str(output), batch_size=2))
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertIn("participants.jsonl", manifest["files"])
            self.assertIn("attachments.jsonl", manifest["files"])
            self.assertIn("reports/warnings.json", manifest["files"])
            self.assertEqual(set(manifest["artifacts"]), set(manifest["files"]) - {"manifest.json"})
            self.assertEqual(line_migrator.command_verify_index(SimpleNamespace(index=str(output), source=str(source))), 0)
            (output / "participants.jsonl").write_text("broken\n", encoding="utf-8")
            self.assertEqual(line_migrator.command_verify_index(SimpleNamespace(index=str(output), source=str(source))), 1)

    def test_index_resume_uses_checkpoint_after_interruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.executemany(
                "INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZTEXT) VALUES (?, ?, ?, ?, ?)",
                [(1, "m1", 100, 7, "one"), (2, "m2", 200, 7, "two")],
            )
            connection.commit()
            connection.close()
            output = root / "index"
            with mock.patch.object(line_migrator, "build_search_sidecar", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    line_migrator.command_index(SimpleNamespace(snapshot=str(source), out=str(output), batch_size=1))
            self.assertTrue((output / ".progress.json").is_file())
            line_migrator.command_index(SimpleNamespace(snapshot=str(source), out=str(output), batch_size=1, resume=True))
            self.assertFalse((output / ".progress.json").exists())
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["message_rows"], 2)
            self.assertEqual(line_migrator.command_verify_index(SimpleNamespace(index=str(output), source=str(source))), 0)

    def test_duplicate_and_diff_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            attachments = source / "Container" / "Library" / "Application Support" / "PrivateStore" / "P_test" / "Message Attachments"
            attachments.mkdir(parents=True)
            (attachments / "one.bin").write_bytes(b"same")
            (attachments / "two.bin").write_bytes(b"same")
            (attachments / ".DS_Store").write_bytes(b"finder metadata")
            duplicates_out = root / "duplicates.json"
            line_migrator.command_duplicates(SimpleNamespace(source=str(source), out=str(duplicates_out)))
            duplicate_report = json.loads(duplicates_out.read_text(encoding="utf-8"))
            self.assertEqual(duplicate_report["scanned_files"], 2)
            self.assertEqual(len(duplicate_report["duplicate_groups"]), 1)

            left = root / "left.sqlite"
            right = root / "right.sqlite"
            for path, text in ((left, "left"), (right, "right")):
                connection = sqlite3.connect(path)
                connection.execute("CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTIMESTAMP INTEGER, ZCHAT INTEGER, ZSENDER INTEGER, ZTEXT TEXT)")
                connection.execute("INSERT INTO ZMESSAGE VALUES (1, 'same-id', 100, 7, 1, ?)", (text,))
                connection.commit()
                connection.close()
            diff_out = root / "diff.jsonl"
            line_migrator.command_diff(SimpleNamespace(left=str(left), right=str(right), out=str(diff_out), batch_size=2))
            self.assertEqual(len(diff_out.read_text(encoding="utf-8").splitlines()), 1)

    def test_index_resolves_user_and_group_titles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_fixture(root)
            database = source / "Container" / "AppGroups" / "group.com.linecorp.line" / "Messages" / "Line.sqlite"
            connection = sqlite3.connect(database)
            connection.execute("ALTER TABLE ZCHAT ADD COLUMN ZMID TEXT")
            connection.execute("ALTER TABLE ZCHAT ADD COLUMN ZTYPE INTEGER")
            connection.execute("CREATE TABLE ZUSER (Z_PK INTEGER PRIMARY KEY, ZMID TEXT, ZNAME TEXT, ZCUSTOMNAME TEXT, ZADDRESSBOOKNAME TEXT)")
            connection.execute("CREATE TABLE ZGROUP (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZNAME TEXT)")
            connection.execute("INSERT INTO ZCHAT (Z_PK, ZNAME, ZMID, ZTYPE) VALUES (1, '', 'u' || printf('%032x', 1), 0)")
            connection.execute("INSERT INTO ZCHAT (Z_PK, ZNAME, ZMID, ZTYPE) VALUES (2, '', 'c' || printf('%032x', 2), 2)")
            connection.execute("INSERT INTO ZCHAT (Z_PK, ZNAME, ZMID, ZTYPE) VALUES (3, '', 'c' || printf('%032x', 3), 2)")
            connection.execute("INSERT INTO ZCHAT (Z_PK, ZNAME, ZMID, ZTYPE) VALUES (4, '', 'c' || printf('%032x', 4), 2)")
            connection.execute("INSERT INTO ZUSER (Z_PK, ZMID, ZNAME) VALUES (1, 'u' || printf('%032x', 1), 'Alice')")
            connection.execute("INSERT INTO ZGROUP (Z_PK, ZID, ZNAME) VALUES (1, 'c' || printf('%032x', 2), 'Project Group')")
            connection.execute("INSERT INTO ZGROUP (Z_PK, ZID, ZNAME) VALUES (2, 'c' || printf('%032x', 3), 'Static Group')")
            connection.execute("INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZCONTENTTYPE, ZTEXT) VALUES (10, 'rename', 200, 2, 18, '已將群組名稱改為「Latest Group」')")
            connection.execute("INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZCONTENTTYPE, ZTEXT) VALUES (11, 'rename2', 300, 3, 18, '已將群組名稱改為「Older Than Unified」')")
            connection.execute("INSERT INTO ZMESSAGE (Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZCONTENTTYPE, ZTEXT) VALUES (12, 'rename3', 400, 4, 18, '已將群組名稱改為「Latest Unresolved Group」')")
            connection.commit()
            connection.close()
            unified_group = database.parent / "UnifiedGroup.sqlite"
            unified_connection = sqlite3.connect(unified_group)
            unified_connection.execute("CREATE TABLE ZUNIFIEDGROUP (Z_PK INTEGER PRIMARY KEY, ZID TEXT, ZTYPE INTEGER, ZNAME TEXT)")
            unified_connection.execute("INSERT INTO ZUNIFIEDGROUP (Z_PK, ZID, ZTYPE, ZNAME) VALUES (1, 'c' || printf('%032x', 3), 1, 'Unified Current Group')")
            unified_connection.commit()
            unified_connection.close()

            output = root / "index"
            line_migrator.command_index(SimpleNamespace(snapshot=str(source), out=str(output), batch_size=2))
            conversations = [json.loads(line) for line in (output / "conversations.jsonl").read_text(encoding="utf-8").splitlines()]
            by_pk = {row["chatPk"]: row for row in conversations}
            self.assertEqual(by_pk[1]["title"], "Alice")
            self.assertEqual(by_pk[1]["titleSource"], "user")
            self.assertEqual(by_pk[2]["title"], "Project Group")
            self.assertEqual(by_pk[2]["titleSource"], "group")
            self.assertEqual(by_pk[3]["title"], "Unified Current Group")
            self.assertEqual(by_pk[3]["titleSource"], "unified-group")
            self.assertEqual(by_pk[4]["title"], "Latest Unresolved Group")
            self.assertEqual(by_pk[4]["titleSource"], "rename")


def shutil_copytree(source: Path, destination: Path) -> Path:
    import shutil
    shutil.copytree(source, destination)
    return destination


if __name__ == "__main__":
    unittest.main()
