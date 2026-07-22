import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
import unittest
import zipfile

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
        connection.execute("CREATE TABLE ZMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT)")
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


def shutil_copytree(source: Path, destination: Path) -> Path:
    import shutil
    shutil.copytree(source, destination)
    return destination


if __name__ == "__main__":
    unittest.main()
