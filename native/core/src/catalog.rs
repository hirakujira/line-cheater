use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::database::{LineDatabase, LineSquareDatabase, OrphanMessage, UnifiedGroupDatabase};
use crate::model::{
    AdvancedCleanupReport, AttachmentContext, AttachmentCursor, AttachmentItem, AttachmentKind,
    AttachmentPage, AttachmentPreview, CatalogStats, Chat, CleanupCategoryTotal, CleanupGroup,
    CleanupGroupPage, CleanupOverview, CleanupReview, CleanupReviewPage, DuplicateGroup,
    DuplicateGroupCursor, DuplicateGroupPage, DuplicateHashProgress, DuplicateMemberPage, Message,
    MessageAttachment, checked_page_size,
};
use crate::source::SourceKind;

const CATALOG_BATCH_SIZE: usize = 1_000;
const HASH_UPDATE_BATCH_SIZE: usize = 100;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const CONTEXT_BATCH_SIZE: usize = 900;
const MAX_CLEANUP_RESPONSE_FILES: usize = 1_000;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STAGED_PREVIEWS: usize = 32;
const CONTEXT_INDEX_VERSION: &str = "3";
const CLEANUP_GROUP_EXPR: &str = "
    CASE f.reference_status
        WHEN 'unreferenced' THEN '__unreferenced__'
        WHEN 'unconfirmed' THEN '__unconfirmed__'
        ELSE 'chat:' || COALESCE(NULLIF(f.context_source, ''), 'unknown') || ':' ||
             COALESCE(CAST(f.message_chat_pk AS TEXT), NULLIF(f.context_chat_id, ''), f.chat_hint)
    END
";
const CLEANUP_CATEGORY_EXPR: &str = "
    CASE
        WHEN f.reference_status = 'unreferenced' THEN 'unreferenced'
        WHEN f.reference_status <> 'referenced' THEN 'unconfirmed'
        WHEN f.context_chat_kind = 'direct' THEN 'individual'
        WHEN f.context_chat_kind = 'group' THEN 'group'
        WHEN f.context_chat_kind = 'community' THEN 'community'
        ELSE 'unconfirmed'
    END
";
const THUMBNAIL_BACKED_IMAGE_EXPR: &str = "
    f.attachment_kind = 'original'
    AND f.reference_status = 'referenced'
    AND f.message_content_type IN (1, 16, 112)
    AND f.message_id <> ''
    AND EXISTS (
        SELECT 1
        FROM files thumbnail
        WHERE thumbnail.attachment_kind = 'thumbnail'
          AND thumbnail.reference_status = 'referenced'
          AND thumbnail.message_content_type IN (1, 16, 112)
          AND thumbnail.bytes > 0
          AND thumbnail.message_id = f.message_id
          AND thumbnail.chat_hint = f.chat_hint
    )
";
const IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR: &str = "
    f.attachment_kind = 'thumbnail'
    AND f.reference_status = 'referenced'
    AND f.message_content_type IN (1, 16, 112)
    AND f.bytes > 0
    AND f.message_id <> ''
    AND EXISTS (
        SELECT 1
        FROM files original
        WHERE original.attachment_kind = 'original'
          AND original.reference_status = 'referenced'
          AND original.message_content_type IN (1, 16, 112)
          AND original.message_id = f.message_id
          AND original.chat_hint = f.chat_hint
    )
";
const ATTACHMENT_COLUMNS: &str = "
    f.id, f.path, f.bytes, f.modified_ns, f.attachment_kind,
    f.message_id, f.chat_hint, p.path IS NOT NULL, f.reference_status,
    f.message_pk, f.message_chat_pk, f.context_source, f.context_chat_id,
    f.context_chat_title, f.context_chat_kind, f.message_timestamp,
    f.message_sender_pk, f.message_sender_name, f.message_content_type, f.message_text
";

#[derive(Debug, Clone, Copy)]
pub struct CatalogScanProgress {
    pub files: u64,
    pub bytes: u64,
    pub attachments: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct CatalogContextProgress {
    pub processed_files: u64,
    pub total_files: u64,
    pub referenced_files: u64,
    pub unreferenced_files: u64,
    pub unconfirmed_files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChat {
    pub source: String,
    pub chat_pk: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedMessage {
    pub source: String,
    pub message_pk: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DatabaseCleanupPlan {
    pub chats: Vec<PlannedChat>,
    pub orphan_messages: Vec<PlannedMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DuplicateLinkMember {
    pub path: String,
    pub bytes: u64,
}

impl DatabaseCleanupPlan {
    pub fn is_empty(&self) -> bool {
        self.chats.is_empty() && self.orphan_messages.is_empty()
    }
}

#[derive(Debug)]
struct FileRecord {
    path: String,
    bytes: u64,
    modified_ns: i64,
    content_sha256: String,
    kind: Option<AttachmentKind>,
    message_id: String,
    chat_hint: String,
}

pub struct Catalog {
    path: PathBuf,
    connection: Connection,
}

impl Catalog {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "cache_size", -32_768_i64)?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                bytes INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                attachment_kind TEXT,
                message_id TEXT NOT NULL DEFAULT '',
                chat_hint TEXT NOT NULL DEFAULT '',
                seen_scan INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_attachment_page
                ON files(attachment_kind, id);
            CREATE INDEX IF NOT EXISTS files_message_id
                ON files(message_id) WHERE message_id <> '';
            CREATE TABLE IF NOT EXISTS removal_plan (
                path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_removal_plan (
                source TEXT NOT NULL CHECK(source IN ('line', 'square')),
                chat_pk INTEGER NOT NULL,
                chat_id TEXT NOT NULL,
                chat_title TEXT NOT NULL,
                chat_kind TEXT NOT NULL,
                message_count INTEGER NOT NULL,
                human_message_count INTEGER NOT NULL,
                reason TEXT NOT NULL CHECK(reason IN ('selected', 'empty', 'system_only')),
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, chat_pk)
            );
            CREATE TABLE IF NOT EXISTS chat_removal_files (
                source TEXT NOT NULL,
                chat_pk INTEGER NOT NULL,
                path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, chat_pk, path),
                FOREIGN KEY(source, chat_pk)
                    REFERENCES chat_removal_plan(source, chat_pk) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS orphan_message_removal_plan (
                source TEXT NOT NULL CHECK(source = 'square'),
                message_pk INTEGER NOT NULL,
                message_id TEXT NOT NULL,
                chat_pk INTEGER,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, message_pk)
            );
            CREATE VIEW IF NOT EXISTS all_removal_plan AS
                SELECT path FROM removal_plan
                UNION
                SELECT path FROM chat_removal_files;
            ",
        )?;
        ensure_column(&connection, "files", "sha256", "TEXT")?;
        ensure_column(&connection, "files", "content_sha256", "TEXT")?;
        ensure_column(&connection, "files", "message_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_chat_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_timestamp", "INTEGER")?;
        ensure_column(&connection, "files", "message_sender_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_sender_name", "TEXT")?;
        ensure_column(&connection, "files", "message_content_type", "INTEGER")?;
        ensure_column(&connection, "files", "message_text", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_id", "TEXT")?;
        ensure_column(&connection, "files", "context_source", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_title", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_kind", "TEXT")?;
        ensure_column(
            &connection,
            "files",
            "reference_status",
            "TEXT NOT NULL DEFAULT 'unconfirmed'",
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_sha256 ON files(sha256, id) WHERE sha256 IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_cleanup_group
             ON files(reference_status, context_source, message_chat_pk, context_chat_id, chat_hint, id)
             WHERE attachment_kind IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_referenced_thumbnail_lookup
             ON files(message_id, chat_hint)
             WHERE attachment_kind = 'thumbnail'
               AND reference_status = 'referenced'
               AND message_content_type IN (1, 16, 112)
               AND bytes > 0",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_referenced_original_lookup
             ON files(message_id, chat_hint)
             WHERE attachment_kind = 'original'
               AND reference_status = 'referenced'
               AND message_content_type IN (1, 16, 112)",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS chat_removal_files_path
             ON chat_removal_files(path)",
            [],
        )?;
        Ok(Self {
            path: path.to_path_buf(),
            connection,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn source_path(&self) -> Result<Option<PathBuf>> {
        Ok(self.meta("source_path")?.map(PathBuf::from))
    }

    pub fn source_fingerprint(&self) -> Result<Option<String>> {
        self.meta("source_fingerprint")
    }

    pub fn source_matches_current(&self, source: &Path, kind: SourceKind) -> Result<bool> {
        let Some(bound) = self.source_path()? else {
            return Ok(false);
        };
        let bound = bound.canonicalize().ok();
        let current = source.canonicalize()?;
        if bound.as_ref() != Some(&current) {
            return Ok(false);
        }
        let Some(stored_fingerprint) = self.meta("source_fingerprint")? else {
            return Ok(false);
        };
        if stored_fingerprint != source_metadata_fingerprint(&current, kind)? {
            return Ok(false);
        }
        self.content_matches_catalog(&current, kind)
    }

    fn content_matches_catalog(&self, source: &Path, kind: SourceKind) -> Result<bool> {
        let mut statement = self.connection.prepare(
            "SELECT path, bytes, modified_ns, content_sha256
             FROM files ORDER BY path ASC",
        )?;
        let mut rows = statement.query([])?;
        let mut archive = if kind == SourceKind::ImazingArchive {
            Some(ZipArchive::new(File::open(source)?)?)
        } else {
            None
        };
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let bytes = row.get::<_, i64>(1)?.max(0) as u64;
            let modified_ns: i64 = row.get(2)?;
            let Some(expected_digest) = row.get::<_, Option<String>>(3)? else {
                return Ok(false);
            };
            let digest = match archive.as_mut() {
                Some(archive) => {
                    let mut entry = match archive.by_name(&path) {
                        Ok(entry) => entry,
                        Err(_) => return Ok(false),
                    };
                    if entry.size() != bytes {
                        return Ok(false);
                    }
                    hash_reader(&mut entry)?
                }
                None => {
                    let file_path = if kind == SourceKind::Sqlite {
                        source.to_path_buf()
                    } else {
                        safe_source_join(source, &path)?
                    };
                    let before = file_record_fingerprint(&file_path)?;
                    if before != (bytes, modified_ns) {
                        return Ok(false);
                    }
                    let digest = hash_directory_file(&file_path, bytes, modified_ns)?;
                    if file_record_fingerprint(&file_path)? != before {
                        return Ok(false);
                    }
                    digest
                }
            };
            if digest != expected_digest {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn recover_interrupted_operations(&self, source: &Path, kind: SourceKind) -> Result<()> {
        if self.meta("scan_status")?.as_deref() == Some("scanning") {
            if self.source_matches_current(source, kind)? {
                self.set_meta("scan_status", "resumable")?;
            } else {
                self.clear_all_removal_plans()?;
                self.set_meta("scan_status", "not_started")?;
                self.set_meta("scan_last_path", "")?;
            }
        }
        if self.meta("context_status")?.as_deref() == Some("indexing") {
            self.clear_all_removal_plans()?;
            self.connection.execute(
                "
                UPDATE files SET
                    message_pk = NULL,
                    message_chat_pk = NULL,
                    message_timestamp = NULL,
                    message_sender_pk = NULL,
                    message_sender_name = NULL,
                    message_content_type = NULL,
                    message_text = NULL,
                    context_source = NULL,
                    context_chat_id = NULL,
                    context_chat_title = NULL,
                    context_chat_kind = NULL,
                    reference_status = 'unconfirmed'
                WHERE attachment_kind IS NOT NULL
                ",
                [],
            )?;
            self.set_meta("context_status", "not_started")?;
        }
        if self.meta("hash_status")?.as_deref() == Some("running") {
            if self.source_matches_current(source, kind)? {
                self.set_meta("hash_status", "resumable")?;
            } else {
                self.clear_duplicate_hashes()?;
                self.set_meta("hash_status", "not_started")?;
            }
        }
        self.clear_active_job("search")?;
        self.clear_active_job("candidate")?;
        Ok(())
    }

    pub fn marked_paths(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM all_removal_plan ORDER BY path")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn content_digest_for_path(&self, path: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT content_sha256 FROM files WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn scan_source<F>(
        &mut self,
        source: &Path,
        kind: SourceKind,
        mut on_progress: F,
    ) -> Result<CatalogStats>
    where
        F: FnMut(CatalogScanProgress),
    {
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        let source_key = source.display().to_string();
        let existing_source = self.meta("source_path")?;
        if existing_source
            .as_deref()
            .is_some_and(|value| value != source_key)
        {
            bail!(
                "catalog belongs to another source; create a new work directory instead of mixing backups"
            );
        }
        self.set_meta("source_path", &source_key)?;
        self.set_meta("source_kind", &format!("{kind:?}"))?;
        let source_fingerprint = source_metadata_fingerprint(&source, kind)?;
        let previous_fingerprint = self.meta("source_fingerprint")?;
        let source_changed = previous_fingerprint
            .as_ref()
            .is_some_and(|value| value != &source_fingerprint);
        let source_fingerprint_missing =
            existing_source.is_some() && previous_fingerprint.is_none();
        if source_changed || source_fingerprint_missing {
            self.clear_all_removal_plans()?;
            self.connection
                .execute("UPDATE files SET sha256 = NULL", [])?;
            self.set_meta("hash_status", "not_started")?;
        }
        self.set_meta("source_fingerprint", &source_fingerprint)?;
        let resume_scan = matches!(
            self.meta("scan_status")?.as_deref(),
            Some("scanning" | "resumable")
        ) && !source_changed
            && !source_fingerprint_missing
            && kind == SourceKind::Directory
            && self.meta("scan_last_path")?.is_some();
        let scan_id = if resume_scan {
            self.meta("scan_id")?
                .and_then(|value| value.parse::<i64>().ok())
                .context("resumable scan is missing its scan ID")?
        } else {
            self.meta("scan_id")?
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                + 1
        };
        let resume_after = if resume_scan {
            self.meta("scan_last_path")?
                .filter(|value| !value.is_empty())
        } else {
            None
        };
        self.set_meta("scan_id", &scan_id.to_string())?;
        self.set_meta("scan_status", "scanning")?;
        if !resume_scan {
            self.set_meta("scan_last_path", "")?;
        }

        let mut batch = Vec::with_capacity(CATALOG_BATCH_SIZE);
        let mut progress = CatalogScanProgress {
            files: 0,
            bytes: 0,
            attachments: 0,
        };
        match kind {
            SourceKind::Directory => {
                for entry in WalkDir::new(&source)
                    .follow_links(false)
                    .sort_by_file_name()
                {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            eprintln!("skipping unreadable path: {error}");
                            continue;
                        }
                    };
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let metadata = match entry.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            eprintln!("skipping unreadable metadata: {error}");
                            continue;
                        }
                    };
                    let relative = entry.path().strip_prefix(&source).unwrap_or(entry.path());
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if resume_after
                        .as_deref()
                        .is_some_and(|last| relative.as_str() <= last)
                    {
                        continue;
                    }
                    let content_sha256 = hash_directory_file(
                        entry.path(),
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                    )?;
                    batch.push(file_record(
                        relative,
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                        content_sha256,
                    ));
                    update_progress(&mut progress, batch.last().expect("record exists"));
                    if batch.len() == CATALOG_BATCH_SIZE {
                        let last_path = batch.last().expect("record exists").path.clone();
                        self.upsert_batch(scan_id, &mut batch)?;
                        self.set_meta("scan_last_path", &last_path)?;
                        on_progress(progress);
                    }
                }
            }
            SourceKind::ImazingArchive => {
                let file = File::open(&source)?;
                let mut archive = ZipArchive::new(file)?;
                for index in 0..archive.len() {
                    let mut entry = archive.by_index(index)?;
                    if entry.is_dir() {
                        continue;
                    }
                    let path = String::from_utf8_lossy(entry.name_raw()).replace('\\', "/");
                    let content_sha256 = hash_reader(&mut entry)?;
                    batch.push(file_record(path, entry.size(), 0, content_sha256));
                    update_progress(&mut progress, batch.last().expect("record exists"));
                    if batch.len() == CATALOG_BATCH_SIZE {
                        let last_path = batch.last().expect("record exists").path.clone();
                        self.upsert_batch(scan_id, &mut batch)?;
                        self.set_meta("scan_last_path", &last_path)?;
                        on_progress(progress);
                    }
                }
            }
            SourceKind::Sqlite => {
                let metadata = fs::metadata(&source)?;
                let path = source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                batch.push(file_record(
                    path,
                    metadata.len(),
                    modified_ns(metadata.modified().ok()),
                    hash_directory_file(
                        &source,
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                    )?,
                ));
                update_progress(&mut progress, batch.last().expect("record exists"));
            }
        }
        if !batch.is_empty() {
            let last_path = batch.last().expect("record exists").path.clone();
            self.upsert_batch(scan_id, &mut batch)?;
            self.set_meta("scan_last_path", &last_path)?;
        }
        self.connection
            .execute("DELETE FROM files WHERE seen_scan <> ?1", [scan_id])?;
        self.set_meta("scan_status", "complete")?;
        self.set_meta("scan_last_path", "")?;
        self.set_meta("scan_completed_at", &unix_seconds().to_string())?;
        on_progress(progress);
        self.stats()
    }

    pub fn list_attachments(
        &self,
        cursor: Option<AttachmentCursor>,
        limit: u32,
        kind: Option<AttachmentKind>,
        search: Option<&str>,
    ) -> Result<AttachmentPage> {
        let limit = checked_page_size(limit)?;
        let search = search
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{}%", escape_like(value)));
        let kind_value = kind.map(AttachmentKind::as_str);
        let sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.attachment_kind IS NOT NULL
              AND f.id > ?1
              AND (?2 IS NULL OR f.attachment_kind = ?2)
              AND (?3 IS NULL OR f.path LIKE ?3 ESCAPE '\\')
            ORDER BY f.id ASC
            LIMIT ?4
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                cursor.map(|value| value.id).unwrap_or(0),
                kind_value,
                search,
                limit as i64 + 1
            ],
            attachment_from_row,
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items
                .last()
                .map(|attachment| AttachmentCursor { id: attachment.id })
        } else {
            None
        };
        Ok(AttachmentPage { items, next_cursor })
    }

    pub fn set_marked(&self, path: &str, marked: bool) -> Result<()> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE path = ?1 AND attachment_kind IS NOT NULL)",
            [path],
            |row| row.get(0),
        )?;
        if !exists {
            bail!("attachment path is not present in this catalog");
        }
        if marked {
            self.connection.execute(
                "INSERT INTO removal_plan(path, marked_at) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET marked_at = excluded.marked_at",
                params![path, unix_seconds()],
            )?;
        } else {
            self.connection
                .execute("DELETE FROM removal_plan WHERE path = ?1", [path])?;
        }
        Ok(())
    }

    pub fn enrich_messages_with_attachments(&self, messages: &mut [Message]) -> Result<()> {
        if messages.len() > crate::model::MAX_PAGE_SIZE as usize {
            bail!(
                "message attachment enrichment cannot exceed {} messages",
                crate::model::MAX_PAGE_SIZE
            );
        }
        for message in messages.iter_mut() {
            message.attachments.clear();
        }
        if messages.is_empty() {
            return Ok(());
        }
        let mut message_indexes = HashMap::new();
        for (index, message) in messages.iter().enumerate() {
            message_indexes.insert(
                (
                    message.source.clone(),
                    message.pk,
                    message.chat_pk,
                    message.id.clone(),
                ),
                index,
            );
        }
        let mut message_pks = messages
            .iter()
            .map(|message| message.pk)
            .collect::<Vec<_>>();
        message_pks.sort_unstable();
        message_pks.dedup();
        for chunk in message_pks.chunks(200) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT f.context_source, f.message_pk, f.message_chat_pk, f.message_id, \
                        f.path, f.bytes, f.attachment_kind \
                 FROM files f \
                 WHERE f.reference_status = 'referenced' \
                   AND f.attachment_kind IS NOT NULL \
                   AND f.message_pk IN ({placeholders}) \
                 ORDER BY f.message_pk, \
                          CASE f.attachment_kind WHEN 'original' THEN 0 ELSE 1 END, \
                          f.path"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let mut rows = statement.query(rusqlite::params_from_iter(chunk.iter().copied()))?;
            while let Some(row) = rows.next()? {
                let source: String = row.get(0)?;
                let message_pk: i64 = row.get(1)?;
                let chat_pk: i64 = row.get(2)?;
                let message_id: String = row.get(3)?;
                let Some(index) = message_indexes
                    .get(&(source, message_pk, chat_pk, message_id))
                    .copied()
                else {
                    continue;
                };
                let bytes: i64 = row.get(5)?;
                messages[index].attachments.push(MessageAttachment {
                    path: row.get(4)?,
                    bytes: u64::try_from(bytes)
                        .context("catalog attachment has an invalid byte size")?,
                    kind: row.get::<_, String>(6)?.parse()?,
                });
            }
        }
        Ok(())
    }

    pub fn stage_attachment_preview(
        &self,
        source: &Path,
        source_kind: SourceKind,
        path: &str,
    ) -> Result<AttachmentPreview> {
        if path.is_empty() || path.len() > 4_096 {
            bail!("invalid attachment preview path");
        }
        let bytes = self
            .connection
            .query_row(
                "SELECT bytes FROM files
                 WHERE path = ?1 AND attachment_kind IS NOT NULL",
                [path],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .context("attachment preview path is not present in this catalog")?;
        let bytes = u64::try_from(bytes).context("attachment preview has an invalid size")?;
        if bytes == 0 || bytes > MAX_PREVIEW_BYTES {
            bail!("attachment preview must be between 1 byte and {MAX_PREVIEW_BYTES} bytes");
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        validate_bound_source(self, &source)?;
        let staged_path = match source_kind {
            SourceKind::Directory => {
                let candidate = source.join(path);
                let candidate = candidate
                    .canonicalize()
                    .with_context(|| format!("attachment preview does not exist: {path}"))?;
                if !candidate.starts_with(&source) || !candidate.is_file() {
                    bail!("attachment preview escapes the selected source");
                }
                candidate
            }
            SourceKind::ImazingArchive => self.stage_archive_preview(&source, path, bytes)?,
            SourceKind::Sqlite => bail!("a direct Line.sqlite source has no attachment previews"),
        };
        let media_type = detect_image_media_type(&staged_path)?
            .context("attachment is not a supported image")?;
        Ok(AttachmentPreview {
            staged_path: staged_path.display().to_string(),
            media_type: media_type.to_string(),
            bytes,
        })
    }

    fn stage_archive_preview(&self, source: &Path, path: &str, bytes: u64) -> Result<PathBuf> {
        let cache = self
            .path
            .parent()
            .context("catalog has no working directory")?
            .join("preview-cache");
        fs::create_dir_all(&cache)?;
        let digest = Sha256::digest(path.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let extension = Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 8
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
            .unwrap_or("bin");
        let destination = cache.join(format!("{digest}.{extension}"));
        if destination
            .metadata()
            .is_ok_and(|metadata| metadata.len() == bytes)
        {
            OpenOptions::new()
                .read(true)
                .open(&destination)?
                .set_times(FileTimes::new().set_modified(SystemTime::now()))?;
            return Ok(destination);
        }
        trim_preview_cache(&cache, MAX_STAGED_PREVIEWS.saturating_sub(1))?;
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file)?;
        let mut entry = archive
            .by_name(path)
            .with_context(|| format!("attachment preview is missing from archive: {path}"))?;
        if entry.is_dir() || entry.size() != bytes || entry.size() > MAX_PREVIEW_BYTES {
            bail!("archive preview metadata does not match the catalog");
        }
        let temporary = destination.with_extension("part");
        {
            let mut output = BufWriter::new(File::create(&temporary)?);
            let copied = std::io::copy(&mut entry, &mut output)?;
            output.flush()?;
            if copied != bytes {
                let _ = fs::remove_file(&temporary);
                bail!("archive preview extraction was incomplete");
            }
        }
        fs::rename(&temporary, &destination)?;
        Ok(destination)
    }

    pub fn index_attachment_contexts<F>(
        &mut self,
        database: &LineDatabase,
        square_database: Option<&LineSquareDatabase>,
        unified_group_database: Option<&UnifiedGroupDatabase>,
        mut on_progress: F,
    ) -> Result<CatalogContextProgress>
    where
        F: FnMut(CatalogContextProgress),
    {
        let total_files = self.connection.query_row(
            "SELECT COUNT(*) FROM files WHERE attachment_kind IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        self.set_meta("context_status", "indexing")?;
        let mut progress = CatalogContextProgress {
            processed_files: 0,
            total_files: total_files.max(0) as u64,
            referenced_files: 0,
            unreferenced_files: 0,
            unconfirmed_files: 0,
        };
        on_progress(progress);
        self.connection.execute(
            "
            UPDATE files SET
                message_pk = NULL,
                message_chat_pk = NULL,
                message_timestamp = NULL,
                message_sender_pk = NULL,
                message_sender_name = NULL,
                message_content_type = NULL,
                message_text = NULL,
                context_source = NULL,
                context_chat_id = NULL,
                context_chat_title = NULL,
                context_chat_kind = NULL,
                reference_status = 'unconfirmed'
            WHERE attachment_kind IS NOT NULL
            ",
            [],
        )?;
        let mut after_id = 0_i64;
        loop {
            let records = {
                let mut statement = self.connection.prepare(
                    "
                    SELECT id, message_id, chat_hint
                    FROM files
                    WHERE attachment_kind IS NOT NULL AND id > ?1
                    ORDER BY id ASC
                    LIMIT ?2
                    ",
                )?;
                let rows =
                    statement.query_map(params![after_id, CONTEXT_BATCH_SIZE as i64], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if records.is_empty() {
                break;
            }
            after_id = records.last().map(|record| record.0).unwrap_or(after_id);
            let mut message_ids = records
                .iter()
                .map(|record| record.1.clone())
                .filter(|message_id| !message_id.is_empty())
                .collect::<Vec<_>>();
            message_ids.sort_unstable();
            message_ids.dedup();
            let mut contexts = database.attachment_contexts(&message_ids)?;
            if let Some(square_database) = square_database {
                for (message_id, mut candidates) in
                    square_database.attachment_contexts(&message_ids)?
                {
                    contexts
                        .entry(message_id)
                        .or_default()
                        .append(&mut candidates);
                }
            }
            database.enrich_attachment_context_titles(
                &mut contexts,
                unified_group_database,
                square_database,
            )?;
            let transaction = self.connection.transaction()?;
            {
                let mut update = transaction.prepare(
                    "
                    UPDATE files SET
                        message_pk = ?2,
                        message_chat_pk = ?3,
                        message_timestamp = ?4,
                        message_sender_pk = ?5,
                        message_sender_name = ?6,
                        message_content_type = ?7,
                        message_text = ?8,
                        context_source = ?9,
                        context_chat_id = ?10,
                        context_chat_title = ?11,
                        context_chat_kind = ?12,
                        reference_status = ?13
                    WHERE id = ?1
                    ",
                )?;
                for (id, message_id, chat_hint) in &records {
                    let candidates = contexts.get(message_id).map(Vec::as_slice).unwrap_or(&[]);
                    let exact = candidates
                        .iter()
                        .filter(|context| context.chat_id.eq_ignore_ascii_case(chat_hint))
                        .collect::<Vec<_>>();
                    let context = (exact.len() == 1).then(|| exact[0]);
                    let reference_status = if context.is_some() {
                        progress.referenced_files += 1;
                        "referenced"
                    } else if message_id.is_empty()
                        || chat_hint.is_empty()
                        || !candidates.is_empty()
                    {
                        progress.unconfirmed_files += 1;
                        "unconfirmed"
                    } else {
                        progress.unreferenced_files += 1;
                        "unreferenced"
                    };
                    if let Some(context) = context {
                        update.execute(params![
                            id,
                            context.message_pk,
                            context.chat_pk,
                            context.timestamp,
                            context.sender_pk,
                            context.sender_name,
                            context.content_type,
                            context.text,
                            context.source,
                            context.chat_id,
                            context.chat_title,
                            context.chat_kind,
                            reference_status,
                        ])?;
                    } else {
                        update.execute(params![
                            id,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<String>::None,
                            Option::<i64>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            reference_status,
                        ])?;
                    }
                    progress.processed_files += 1;
                }
            }
            transaction.commit()?;
            on_progress(progress);
        }
        self.set_meta("context_status", "complete")?;
        self.set_meta("context_index_version", CONTEXT_INDEX_VERSION)?;
        self.set_meta("context_completed_at", &unix_seconds().to_string())?;
        self.refresh_chat_removal_files()?;
        on_progress(progress);
        Ok(progress)
    }

    pub fn enrich_planned_chats(&self, chats: &mut [Chat]) -> Result<()> {
        let mut statement = self
            .connection
            .prepare("SELECT source, chat_pk FROM chat_removal_plan")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let planned = rows.collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
        for chat in chats {
            chat.planned_for_removal = planned.contains(&(chat.source.clone(), chat.pk));
        }
        Ok(())
    }

    pub fn set_chat_removal_planned(&self, chat: &Chat, planned: bool, reason: &str) -> Result<()> {
        if !matches!(chat.source.as_str(), "line" | "square") {
            bail!("chat cleanup source must be `line` or `square`");
        }
        if !matches!(reason, "selected" | "empty" | "system_only") {
            bail!("invalid chat cleanup reason");
        }
        let transaction = self.connection.unchecked_transaction()?;
        if planned {
            transaction.execute(
                "
                INSERT INTO chat_removal_plan(
                    source, chat_pk, chat_id, chat_title, chat_kind,
                    message_count, human_message_count, reason, marked_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(source, chat_pk) DO UPDATE SET
                    chat_id = excluded.chat_id,
                    chat_title = excluded.chat_title,
                    chat_kind = excluded.chat_kind,
                    message_count = excluded.message_count,
                    human_message_count = excluded.human_message_count,
                    reason = CASE
                        WHEN chat_removal_plan.reason = 'selected'
                        THEN chat_removal_plan.reason
                        ELSE excluded.reason
                    END,
                    marked_at = excluded.marked_at
                ",
                params![
                    chat.source,
                    chat.pk,
                    chat.id,
                    chat.title,
                    chat.kind,
                    chat.message_count,
                    chat.human_message_count,
                    reason,
                    unix_seconds(),
                ],
            )?;
            transaction.execute(
                "
                INSERT OR IGNORE INTO chat_removal_files(source, chat_pk, path, marked_at)
                SELECT ?1, ?2, f.path, ?3
                FROM files f
                WHERE f.attachment_kind IS NOT NULL
                  AND (
                      (
                          f.reference_status = 'referenced'
                          AND f.context_source = ?1
                          AND f.message_chat_pk = ?2
                      )
                      OR (
                          ?4 <> ''
                          AND LOWER(f.chat_hint) = LOWER(?4)
                          AND (
                              f.reference_status <> 'referenced'
                              OR (
                                  f.context_source = ?1
                                  AND f.message_chat_pk = ?2
                              )
                          )
                      )
                  )
                ",
                params![chat.source, chat.pk, unix_seconds(), chat.id],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM chat_removal_files WHERE source = ?1 AND chat_pk = ?2",
                params![chat.source, chat.pk],
            )?;
            transaction.execute(
                "DELETE FROM chat_removal_plan WHERE source = ?1 AND chat_pk = ?2",
                params![chat.source, chat.pk],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn plan_automatic_cleanup(
        &self,
        chats: &[Chat],
        orphan_messages: &[OrphanMessage],
    ) -> Result<()> {
        if self.automatic_cleanup_planned()? {
            return self.clear_automatic_cleanup_plan();
        }
        for chat in chats {
            let reason = if chat.message_count == 0 {
                "empty"
            } else {
                "system_only"
            };
            self.set_chat_removal_planned(chat, true, reason)?;
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut insert = transaction.prepare(
                "
                INSERT INTO orphan_message_removal_plan(
                    source, message_pk, message_id, chat_pk, marked_at
                ) VALUES ('square', ?1, ?2, ?3, ?4)
                ON CONFLICT(source, message_pk) DO UPDATE SET
                    message_id = excluded.message_id,
                    chat_pk = excluded.chat_pk,
                    marked_at = excluded.marked_at
                ",
            )?;
            for message in orphan_messages {
                insert.execute(params![
                    message.pk,
                    message.id,
                    message.chat_pk,
                    unix_seconds()
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn automatic_cleanup_planned(&self) -> Result<bool> {
        self.connection
            .query_row(
                "
            SELECT EXISTS(
                SELECT 1 FROM chat_removal_plan
                WHERE reason IN ('empty', 'system_only')
                UNION ALL
                SELECT 1 FROM orphan_message_removal_plan
            )
            ",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn clear_automatic_cleanup_plan(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "
            DELETE FROM chat_removal_files
            WHERE (source, chat_pk) IN (
                SELECT source, chat_pk FROM chat_removal_plan
                WHERE reason IN ('empty', 'system_only')
            )
            ",
            [],
        )?;
        transaction.execute(
            "DELETE FROM chat_removal_plan WHERE reason IN ('empty', 'system_only')",
            [],
        )?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_advanced_cleanup_plan(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute("DELETE FROM chat_removal_plan", [])?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_all_removal_plans(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM removal_plan", [])?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute("DELETE FROM chat_removal_plan", [])?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn database_cleanup_plan(&self) -> Result<DatabaseCleanupPlan> {
        let mut chat_statement = self.connection.prepare(
            "SELECT source, chat_pk, message_count
             FROM chat_removal_plan ORDER BY source, chat_pk",
        )?;
        let chats = chat_statement
            .query_map([], |row| {
                Ok(PlannedChat {
                    source: row.get(0)?,
                    chat_pk: row.get(1)?,
                    message_count: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut message_statement = self.connection.prepare(
            "SELECT source, message_pk
             FROM orphan_message_removal_plan ORDER BY source, message_pk",
        )?;
        let orphan_messages = message_statement
            .query_map([], |row| {
                Ok(PlannedMessage {
                    source: row.get(0)?,
                    message_pk: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(DatabaseCleanupPlan {
            chats,
            orphan_messages,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn advanced_cleanup_report(
        &self,
        line_empty_chats: u64,
        line_system_only_chats: u64,
        square_available: bool,
        square_empty_chats: u64,
        square_system_only_chats: u64,
        orphan_community_messages: u64,
    ) -> Result<AdvancedCleanupReport> {
        let automatic_cleanup_planned = self.automatic_cleanup_planned()?;
        let (planned_chats, planned_chat_messages): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(message_count), 0)
                 FROM chat_removal_plan",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let planned_orphan_messages: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM orphan_message_removal_plan",
            [],
            |row| row.get(0),
        )?;
        let (planned_files, planned_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan planned
             JOIN files f ON f.path = planned.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(AdvancedCleanupReport {
            line_empty_chats,
            line_system_only_chats,
            square_available,
            square_empty_chats,
            square_system_only_chats,
            orphan_community_messages,
            automatic_cleanup_planned,
            planned_chats: planned_chats.max(0) as u64,
            planned_database_messages: planned_chat_messages
                .saturating_add(planned_orphan_messages)
                .max(0) as u64,
            planned_files: planned_files.max(0) as u64,
            planned_bytes: planned_bytes.max(0) as u64,
        })
    }

    fn refresh_chat_removal_files(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute(
            "
            INSERT INTO chat_removal_files(source, chat_pk, path, marked_at)
            SELECT crp.source, crp.chat_pk, f.path, ?1
            FROM chat_removal_plan crp
            JOIN files f
              ON (
                    (
                        f.reference_status = 'referenced'
                        AND f.context_source = crp.source
                        AND f.message_chat_pk = crp.chat_pk
                    )
                    OR (
                        crp.chat_id <> ''
                        AND LOWER(f.chat_hint) = LOWER(crp.chat_id)
                        AND (
                            f.reference_status <> 'referenced'
                            OR (
                                f.context_source = crp.source
                                AND f.message_chat_pk = crp.chat_pk
                            )
                        )
                    )
                 )
            WHERE f.attachment_kind IS NOT NULL
            ",
            [unix_seconds()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn cleanup_overview(&self) -> Result<CleanupOverview> {
        let sql = format!(
            "
            SELECT {CLEANUP_CATEGORY_EXPR} AS category,
                   COUNT(*), COALESCE(SUM(f.bytes), 0)
            FROM files f
            WHERE f.attachment_kind IS NOT NULL
            GROUP BY category
            "
        );
        let mut totals = [
            "all",
            "individual",
            "group",
            "community",
            "unreferenced",
            "unconfirmed",
        ]
        .into_iter()
        .map(|category| {
            (
                category.to_string(),
                CleanupCategoryTotal {
                    category: category.to_string(),
                    file_count: 0,
                    bytes: 0,
                },
            )
        })
        .collect::<HashMap<_, _>>();
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
                row.get::<_, i64>(2)?.max(0) as u64,
            ))
        })?;
        for row in rows {
            let (category, file_count, bytes) = row?;
            let category_key = if totals.contains_key(&category) && category != "all" {
                category.as_str()
            } else {
                "unconfirmed"
            };
            {
                let target = totals.get_mut(category_key).expect("cleanup total exists");
                target.file_count = target.file_count.saturating_add(file_count);
                target.bytes = target.bytes.saturating_add(bytes);
            }
            let all = totals.get_mut("all").expect("all total exists");
            all.file_count = all.file_count.saturating_add(file_count);
            all.bytes = all.bytes.saturating_add(bytes);
        }
        let (marked_count, marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan p JOIN files f ON f.path = p.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let categories = [
            "all",
            "individual",
            "group",
            "community",
            "unreferenced",
            "unconfirmed",
        ]
        .into_iter()
        .map(|category| totals.remove(category).expect("cleanup total exists"))
        .collect();
        Ok(CleanupOverview {
            categories,
            marked_count: marked_count.max(0) as u64,
            marked_bytes: marked_bytes.max(0) as u64,
            context_status: if self.meta("context_index_version")?.as_deref()
                == Some(CONTEXT_INDEX_VERSION)
            {
                self.meta("context_status")?
                    .unwrap_or_else(|| "not_started".to_string())
            } else {
                "stale".to_string()
            },
        })
    }

    pub fn indexed_attachment_chats(&self) -> Result<HashSet<(String, i64)>> {
        if self.meta("context_index_version")?.as_deref() != Some(CONTEXT_INDEX_VERSION)
            || self.meta("context_status")?.as_deref() != Some("complete")
        {
            bail!("請先重新掃描附件，再顯示沒有附件的聊天室");
        }
        let mut statement = self.connection.prepare(
            "
            SELECT DISTINCT context_source, message_chat_pk
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND reference_status = 'referenced'
              AND context_source IS NOT NULL
              AND context_source <> ''
              AND message_chat_pk IS NOT NULL
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashSet<_>>>()?)
    }

    pub fn list_empty_attachment_chats(
        &self,
        mut chats: Vec<Chat>,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        sort: &str,
    ) -> Result<CleanupGroupPage> {
        if page == 0 {
            bail!("cleanup page must be at least 1");
        }
        let limit = checked_page_size(page_size)?;
        if kind != "all" {
            bail!("沒有附件的聊天室不支援檔案篩選");
        }
        if !matches!(sort, "recent" | "oldest" | "size" | "path") {
            bail!("cleanup sort must be recent, oldest, size, or path");
        }
        let indexed_chats = self.indexed_attachment_chats()?;
        chats.retain(|chat| !indexed_chats.contains(&(chat.source.clone(), chat.pk)));
        if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let search = search.to_lowercase();
            chats.retain(|chat| {
                [
                    chat.title.as_str(),
                    chat.id.as_str(),
                    chat.last_message.as_str(),
                ]
                .into_iter()
                .any(|value| value.to_lowercase().contains(&search))
            });
        }
        self.enrich_planned_chats(&mut chats)?;
        chats.sort_by(|left, right| {
            let order = match sort {
                "recent" => right.last_updated.cmp(&left.last_updated),
                "oldest" => left.last_updated.cmp(&right.last_updated),
                _ => left.title.cmp(&right.title),
            };
            order
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.pk.cmp(&right.pk))
        });
        let total_items = chats.len() as u64;
        let offset = cleanup_offset(page, limit)?;
        let items = chats
            .into_iter()
            .skip(offset as usize)
            .take(limit)
            .map(|chat| CleanupGroup {
                key: format!("empty:{}:{}", chat.source, chat.pk),
                chat_source: chat.source,
                chat_pk: Some(chat.pk),
                chat_id: chat.id,
                chat_title: chat.title,
                chat_kind: chat.kind,
                reference_status: "no_attachments".to_string(),
                file_count: 0,
                total_bytes: 0,
                marked_count: 0,
                has_original: false,
                has_thumbnail: false,
                thumbnail_backed_image_count: 0,
                keeping_thumbnails: false,
                latest_timestamp: chat.last_updated,
                planned_for_chat_removal: chat.planned_for_removal,
            })
            .collect();
        Ok(CleanupGroupPage {
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_cleanup_groups(
        &self,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        category: &str,
        sort: &str,
    ) -> Result<CleanupGroupPage> {
        validate_cleanup_query(page, page_size, kind, category, sort)?;
        let limit = checked_page_size(page_size)?;
        let offset = cleanup_offset(page, limit)?;
        let search = cleanup_search_pattern(search);
        let sql = format!(
            "
            WITH base AS (
                SELECT f.*, p.path IS NOT NULL AS marked,
                       {CLEANUP_GROUP_EXPR} AS group_key,
                       {CLEANUP_CATEGORY_EXPR} AS category,
                       CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END
                           AS thumbnail_backed_image,
                       CASE WHEN {IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR} THEN 1 ELSE 0 END
                           AS image_thumbnail_with_original
                FROM files f
                LEFT JOIN all_removal_plan p ON p.path = f.path
                WHERE f.attachment_kind IS NOT NULL
            ),
            grouped AS (
                SELECT group_key,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN ''
                           ELSE COALESCE(context_source, '')
                       END) AS chat_source,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN NULL
                           ELSE message_chat_pk
                       END) AS chat_pk,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN ''
                           ELSE COALESCE(context_chat_id, '')
                       END) AS chat_id,
                       MAX(CASE reference_status
                           WHEN 'unreferenced' THEN '孤兒檔案（SQLite 未引用）'
                           WHEN 'unconfirmed' THEN '無法確認引用的附件'
                           ELSE COALESCE(NULLIF(context_chat_title, ''), NULLIF(chat_hint, ''), '無法辨識的聊天室')
                       END) AS chat_title,
                       MAX(CASE reference_status
                           WHEN 'unreferenced' THEN 'unreferenced'
                           WHEN 'unconfirmed' THEN 'unknown'
                           ELSE COALESCE(NULLIF(context_chat_kind, ''), 'unknown')
                       END) AS chat_kind,
                       MAX(reference_status) AS reference_status,
                       COUNT(*) AS file_count,
                       COALESCE(SUM(bytes), 0) AS total_bytes,
                       SUM(CASE WHEN marked THEN 1 ELSE 0 END) AS marked_count,
                       MAX(CASE WHEN attachment_kind = 'original' THEN 1 ELSE 0 END) AS has_original,
                       MAX(CASE WHEN attachment_kind = 'thumbnail' THEN 1 ELSE 0 END) AS has_thumbnail,
                       SUM(thumbnail_backed_image) AS thumbnail_backed_image_count,
                       CASE
                           WHEN SUM(thumbnail_backed_image) > 0
                            AND SUM(CASE WHEN thumbnail_backed_image AND marked THEN 1 ELSE 0 END)
                                = SUM(thumbnail_backed_image)
                            AND SUM(CASE WHEN image_thumbnail_with_original AND marked THEN 1 ELSE 0 END) = 0
                           THEN 1 ELSE 0
                       END AS keeping_thumbnails,
                       COALESCE(MAX(message_timestamp), 0) AS latest_timestamp,
                       MAX(CASE
                           WHEN EXISTS (
                               SELECT 1 FROM chat_removal_plan crp
                               WHERE crp.source = base.context_source
                                 AND crp.chat_pk = base.message_chat_pk
                           )
                           THEN 1 ELSE 0
                       END) AS planned_for_chat_removal,
                       MIN(path) AS path_sort
                FROM base
                GROUP BY group_key
                HAVING MAX(CASE WHEN
                    (?1 = 'all'
                     OR (?1 = 'original' AND attachment_kind = 'original')
                     OR (?1 = 'thumbnail' AND attachment_kind = 'thumbnail')
                     OR (?1 = 'marked' AND marked))
                    AND (?2 = 'all' OR category = ?2)
                    AND (?3 IS NULL
                         OR path LIKE ?3 ESCAPE '\\'
                         OR chat_hint LIKE ?3 ESCAPE '\\'
                         OR COALESCE(context_chat_title, '') LIKE ?3 ESCAPE '\\'
                         OR COALESCE(message_sender_name, '') LIKE ?3 ESCAPE '\\'
                         OR COALESCE(message_text, '') LIKE ?3 ESCAPE '\\')
                    THEN 1 ELSE 0 END) = 1
            )
            SELECT group_key, chat_source, chat_pk, chat_id, chat_title, chat_kind, reference_status,
                   file_count, total_bytes, marked_count, has_original,
                   has_thumbnail, thumbnail_backed_image_count, keeping_thumbnails,
                   latest_timestamp, planned_for_chat_removal, COUNT(*) OVER()
            FROM grouped
            ORDER BY
                CASE WHEN ?4 = 'size' THEN total_bytes END DESC,
                CASE WHEN ?4 = 'path' THEN chat_title END ASC,
                CASE WHEN ?4 = 'oldest' THEN latest_timestamp END ASC,
                CASE WHEN ?4 = 'recent' THEN latest_timestamp END DESC,
                chat_title ASC, group_key ASC
            LIMIT ?5 OFFSET ?6
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![kind, category, search, sort, limit as i64, offset],
            cleanup_group_from_row,
        )?;
        let mut items = Vec::new();
        let mut total_items = 0_u64;
        for row in rows {
            let (group, total) = row?;
            total_items = total;
            items.push(group);
        }
        Ok(CleanupGroupPage {
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_cleanup_reviews(
        &self,
        group_key: &str,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        category: &str,
        sort: &str,
    ) -> Result<CleanupReviewPage> {
        validate_cleanup_group_key(group_key)?;
        validate_cleanup_query(page, page_size, kind, category, sort)?;
        let limit = checked_page_size(page_size)?;
        let offset = cleanup_offset(page, limit)?;
        let search = cleanup_search_pattern(search);
        let group = self.cleanup_group(group_key)?;
        let bundle_expr = "
            CASE
                WHEN f.message_id <> '' THEN 'message:' || f.message_id
                ELSE 'file:' || f.path
            END
        ";
        let bundle_sql = format!(
            "
            WITH base AS (
                SELECT f.*, p.path IS NOT NULL AS marked,
                       {CLEANUP_GROUP_EXPR} AS group_key,
                       {CLEANUP_CATEGORY_EXPR} AS category,
                       {bundle_expr} AS bundle_key
                FROM files f
                LEFT JOIN all_removal_plan p ON p.path = f.path
                WHERE f.attachment_kind IS NOT NULL
            ),
            bundles AS (
                SELECT bundle_key, COALESCE(SUM(bytes), 0) AS total_bytes,
                       COALESCE(MAX(message_timestamp), 0) AS latest_timestamp,
                       MIN(path) AS path_sort
                FROM base
                WHERE group_key = ?1
                  AND (?2 = 'all'
                       OR (?2 = 'original' AND attachment_kind = 'original')
                       OR (?2 = 'thumbnail' AND attachment_kind = 'thumbnail')
                       OR (?2 = 'marked' AND marked))
                  AND (?3 = 'all' OR category = ?3)
                  AND (?4 IS NULL
                       OR path LIKE ?4 ESCAPE '\\'
                       OR COALESCE(context_chat_title, '') LIKE ?4 ESCAPE '\\'
                       OR COALESCE(message_sender_name, '') LIKE ?4 ESCAPE '\\'
                       OR COALESCE(message_text, '') LIKE ?4 ESCAPE '\\')
                GROUP BY bundle_key
            )
            SELECT bundle_key, total_bytes, COUNT(*) OVER()
            FROM bundles
            ORDER BY
                CASE WHEN ?5 = 'size' THEN total_bytes END DESC,
                CASE WHEN ?5 = 'path' THEN path_sort END ASC,
                CASE WHEN ?5 = 'oldest' THEN latest_timestamp END ASC,
                CASE WHEN ?5 = 'recent' THEN latest_timestamp END DESC,
                path_sort ASC, bundle_key ASC
            LIMIT ?6 OFFSET ?7
            "
        );
        let mut bundle_statement = self.connection.prepare(&bundle_sql)?;
        let bundle_rows = bundle_statement.query_map(
            params![
                group_key,
                kind,
                category,
                search,
                sort,
                limit as i64,
                offset
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                    row.get::<_, i64>(2)?.max(0) as u64,
                ))
            },
        )?;
        let mut bundle_keys = Vec::new();
        let mut bundle_bytes = HashMap::new();
        let mut total_items = 0_u64;
        for row in bundle_rows {
            let (key, bytes, total) = row?;
            total_items = total;
            bundle_bytes.insert(key.clone(), bytes);
            bundle_keys.push(key);
        }
        if bundle_keys.is_empty() {
            return Ok(CleanupReviewPage {
                group,
                items: Vec::new(),
                page,
                page_size,
                total_items,
                total_pages: cleanup_total_pages(total_items, page_size),
            });
        }
        let placeholders = std::iter::repeat_n("?", bundle_keys.len())
            .collect::<Vec<_>>()
            .join(",");
        let file_sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}, {bundle_expr} AS bundle_key
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE {CLEANUP_GROUP_EXPR} = ?
              AND {bundle_expr} IN ({placeholders})
              AND (? = 'all'
                   OR (? = 'original' AND f.attachment_kind = 'original')
                   OR (? = 'thumbnail' AND f.attachment_kind = 'thumbnail')
                   OR (? = 'marked' AND p.path IS NOT NULL))
              AND (? IS NULL
                   OR f.path LIKE ? ESCAPE '\\'
                   OR COALESCE(f.context_chat_title, '') LIKE ? ESCAPE '\\'
                   OR COALESCE(f.message_sender_name, '') LIKE ? ESCAPE '\\'
                   OR COALESCE(f.message_text, '') LIKE ? ESCAPE '\\')
            ORDER BY bundle_key ASC,
                     CASE f.attachment_kind WHEN 'original' THEN 0 ELSE 1 END,
                     f.bytes DESC, f.path ASC
            LIMIT {}
            ",
            MAX_CLEANUP_RESPONSE_FILES + 1
        );
        let mut values = Vec::<rusqlite::types::Value>::new();
        values.push(group_key.to_string().into());
        values.extend(
            bundle_keys
                .iter()
                .cloned()
                .map(rusqlite::types::Value::from),
        );
        values.extend([
            kind.to_string().into(),
            kind.to_string().into(),
            kind.to_string().into(),
            kind.to_string().into(),
            search.clone().into(),
            search.clone().into(),
            search.clone().into(),
            search.clone().into(),
            search.into(),
        ]);
        let mut file_statement = self.connection.prepare(&file_sql)?;
        let mut rows = file_statement.query(rusqlite::params_from_iter(values.iter()))?;
        let mut files_by_bundle = HashMap::<String, Vec<AttachmentItem>>::new();
        let mut response_files = 0_usize;
        while let Some(row) = rows.next()? {
            response_files += 1;
            if response_files > MAX_CLEANUP_RESPONSE_FILES {
                bail!(
                    "cleanup review page exceeds {MAX_CLEANUP_RESPONSE_FILES} files; narrow the filters"
                );
            }
            let item = attachment_from_row(row)?;
            let bundle_key: String = row.get(20)?;
            files_by_bundle.entry(bundle_key).or_default().push(item);
        }
        let items = bundle_keys
            .into_iter()
            .filter_map(|key| {
                let files = files_by_bundle.remove(&key)?;
                let first = files.first()?;
                Some(CleanupReview {
                    key: key.clone(),
                    message_id: first.message_id.clone(),
                    reference_status: first.reference_status.clone(),
                    context: first.context.clone(),
                    files,
                    total_bytes: bundle_bytes.remove(&key).unwrap_or(0),
                })
            })
            .collect();
        Ok(CleanupReviewPage {
            group,
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    pub fn apply_cleanup_group_action(
        &self,
        group_key: &str,
        action: &str,
    ) -> Result<CleanupOverview> {
        validate_cleanup_group_key(group_key)?;
        if !matches!(action, "toggle_all" | "keep_thumbnail") {
            bail!("cleanup group action must be `toggle_all` or `keep_thumbnail`");
        }
        let predicate = format!("f.attachment_kind IS NOT NULL AND {CLEANUP_GROUP_EXPR} = ?1");
        let (
            total,
            marked,
            thumbnail_backed_images,
            marked_thumbnail_backed_images,
            marked_image_thumbnails,
        ) = self.connection.query_row(
            &format!(
                "
                    SELECT COUNT(*),
                           SUM(CASE WHEN p.path IS NOT NULL THEN 1 ELSE 0 END),
                           SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END),
                           SUM(CASE
                               WHEN ({THUMBNAIL_BACKED_IMAGE_EXPR}) AND p.path IS NOT NULL
                               THEN 1 ELSE 0
                           END),
                           SUM(CASE
                               WHEN ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR}) AND p.path IS NOT NULL
                               THEN 1 ELSE 0
                           END)
                    FROM files f
                    LEFT JOIN all_removal_plan p ON p.path = f.path
                    WHERE {predicate}
                    "
            ),
            [group_key],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
        if total == 0 {
            bail!("cleanup group does not exist");
        }
        let now = unix_seconds();
        if action == "toggle_all" {
            if marked == total {
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (SELECT f.path FROM files f WHERE {predicate})"
                    ),
                    [group_key],
                )?;
            } else {
                self.connection.execute(
                    &format!(
                        "INSERT OR REPLACE INTO removal_plan(path, marked_at)
                         SELECT f.path, ?2 FROM files f WHERE {predicate}"
                    ),
                    params![group_key, now],
                )?;
            }
        } else {
            if thumbnail_backed_images == 0 {
                bail!("cleanup group does not contain image originals with matching thumbnails");
            }
            let keeping_thumbnails = marked_thumbnail_backed_images == thumbnail_backed_images
                && marked_image_thumbnails == 0;
            if keeping_thumbnails {
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (
                             SELECT f.path FROM files f
                             WHERE {predicate} AND ({THUMBNAIL_BACKED_IMAGE_EXPR})
                         )"
                    ),
                    [group_key],
                )?;
            } else {
                self.connection.execute(
                    &format!(
                        "INSERT OR REPLACE INTO removal_plan(path, marked_at)
                         SELECT f.path, ?2 FROM files f
                         WHERE {predicate} AND ({THUMBNAIL_BACKED_IMAGE_EXPR})"
                    ),
                    params![group_key, now],
                )?;
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (
                             SELECT f.path FROM files f
                             WHERE {predicate} AND ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR})
                         )"
                    ),
                    [group_key],
                )?;
            }
        }
        self.cleanup_overview()
    }

    pub fn hash_duplicate_candidates<F>(
        &self,
        source: &Path,
        kind: SourceKind,
        mut on_progress: F,
    ) -> Result<DuplicateHashProgress>
    where
        F: FnMut(DuplicateHashProgress) -> Result<()>,
    {
        self.set_meta("hash_status", "running")?;
        let result = self.hash_duplicate_candidates_inner(source, kind, &mut on_progress);
        if result.is_err() {
            let _ = self.clear_duplicate_hashes();
            let _ = self.set_meta("hash_status", "not_started");
        } else {
            self.set_meta("hash_status", "complete")?;
        }
        result
    }

    fn hash_duplicate_candidates_inner<F>(
        &self,
        source: &Path,
        kind: SourceKind,
        on_progress: &mut F,
    ) -> Result<DuplicateHashProgress>
    where
        F: FnMut(DuplicateHashProgress) -> Result<()>,
    {
        if kind == SourceKind::Sqlite {
            bail!("a direct Line.sqlite source has no attachment files");
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        validate_bound_source(self, &source)?;
        if !self.source_matches_current(&source, kind)? {
            bail!("source changed since the last scan; rescan before hashing duplicates");
        }
        let read_connection = Connection::open(&self.path)?;
        read_connection.pragma_update(None, "query_only", true)?;
        read_connection.pragma_update(None, "temp_store", "FILE")?;
        let mut write_connection = Connection::open(&self.path)?;
        let (candidate_files, total_bytes): (i64, i64) = read_connection.query_row(
            "
            SELECT COUNT(*), COALESCE(SUM(bytes), 0)
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND bytes > 0
              AND sha256 IS NULL
              AND bytes IN (
                  SELECT bytes FROM files
                  WHERE attachment_kind IS NOT NULL AND bytes > 0
                  GROUP BY bytes HAVING COUNT(*) > 1
              )
            ",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut statement = read_connection.prepare(
            "
            SELECT path, bytes, modified_ns
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND bytes > 0
              AND sha256 IS NULL
              AND bytes IN (
                  SELECT bytes FROM files
                  WHERE attachment_kind IS NOT NULL AND bytes > 0
                  GROUP BY bytes HAVING COUNT(*) > 1
              )
            ORDER BY id ASC
            ",
        )?;
        let mut rows = statement.query([])?;
        let archive_fingerprint = if kind == SourceKind::ImazingArchive {
            Some(source_metadata_fingerprint(&source, kind)?)
        } else {
            None
        };
        let mut archive = if kind == SourceKind::ImazingArchive {
            Some(ZipArchive::new(File::open(&source)?)?)
        } else {
            None
        };
        let mut pending = Vec::with_capacity(HASH_UPDATE_BATCH_SIZE);
        let mut progress = DuplicateHashProgress {
            candidate_files: candidate_files.max(0) as u64,
            processed_files: 0,
            total_bytes: total_bytes.max(0) as u64,
            processed_bytes: 0,
        };
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let bytes = row.get::<_, i64>(1)?.max(0) as u64;
            let modified_ns: i64 = row.get(2)?;
            let digest = match archive.as_mut() {
                Some(archive) => {
                    let entry = archive.by_name(&path).with_context(|| {
                        format!("archive entry disappeared during hash: {path}")
                    })?;
                    if entry.size() != bytes {
                        bail!("archive entry size changed since catalog scan: {path}");
                    }
                    hash_reader(entry)?
                }
                None => {
                    let file_path = safe_source_join(&source, &path)?;
                    let before = file_record_fingerprint(&file_path)?;
                    if before.0 != bytes || before.1 != modified_ns {
                        bail!("source file changed since catalog scan: {path}");
                    }
                    let digest = hash_reader(BufReader::with_capacity(
                        HASH_BUFFER_BYTES,
                        File::open(&file_path)?,
                    ))?;
                    if file_record_fingerprint(&file_path)? != before {
                        bail!("source file changed while hashing: {path}");
                    }
                    digest
                }
            };
            pending.push((path, digest));
            progress.processed_files += 1;
            progress.processed_bytes = progress.processed_bytes.saturating_add(bytes);
            if pending.len() == HASH_UPDATE_BATCH_SIZE {
                update_hash_batch(&mut write_connection, &mut pending)?;
            }
            on_progress(progress)?;
        }
        update_hash_batch(&mut write_connection, &mut pending)?;
        if let Some(before) = archive_fingerprint
            && source_metadata_fingerprint(&source, kind)? != before
        {
            bail!("source archive changed while hashing");
        }
        Ok(progress)
    }

    fn clear_duplicate_hashes(&self) -> Result<()> {
        self.connection
            .execute("UPDATE files SET sha256 = NULL", [])?;
        Ok(())
    }

    pub fn list_duplicate_groups(
        &self,
        cursor: Option<DuplicateGroupCursor>,
        limit: u32,
    ) -> Result<DuplicateGroupPage> {
        let limit = checked_page_size(limit)?;
        let reclaimable = "((COUNT(*) - 1) * bytes)";
        let cursor_filter = if cursor.is_some() {
            format!(
                "HAVING COUNT(*) > 1 AND ({reclaimable} < ?1 OR ({reclaimable} = ?1 AND sha256 > ?2))"
            )
        } else {
            "HAVING COUNT(*) > 1".to_string()
        };
        let sql = format!(
            "
            SELECT sha256, bytes, COUNT(*), {reclaimable},
                   MAX(CASE WHEN attachment_kind = 'original' THEN 1 ELSE 0 END),
                   MAX(CASE WHEN attachment_kind = 'thumbnail' THEN 1 ELSE 0 END),
                   MIN(path)
            FROM files
            WHERE sha256 IS NOT NULL
            GROUP BY sha256, bytes
            {cursor_filter}
            ORDER BY {reclaimable} DESC, sha256 ASC
            LIMIT ?3
            "
        );
        let cursor = cursor.unwrap_or(DuplicateGroupCursor {
            reclaimable_bytes: u64::MAX,
            sha256: String::new(),
        });
        let reclaimable_cursor = i64::try_from(cursor.reclaimable_bytes).unwrap_or(i64::MAX);
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![reclaimable_cursor, cursor.sha256, limit as i64 + 1],
            |row| {
                Ok(DuplicateGroup {
                    sha256: row.get(0)?,
                    bytes: row.get::<_, i64>(1)?.max(0) as u64,
                    file_count: row.get::<_, i64>(2)?.max(0) as u64,
                    reclaimable_bytes: row.get::<_, i64>(3)?.max(0) as u64,
                    has_original: row.get::<_, i64>(4)? != 0,
                    has_thumbnail: row.get::<_, i64>(5)? != 0,
                    preview_path: row.get(6)?,
                })
            },
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items.last().map(|group| DuplicateGroupCursor {
                reclaimable_bytes: group.reclaimable_bytes,
                sha256: group.sha256.clone(),
            })
        } else {
            None
        };
        Ok(DuplicateGroupPage { items, next_cursor })
    }

    pub fn list_duplicate_members(
        &self,
        sha256: &str,
        cursor: Option<AttachmentCursor>,
        limit: u32,
    ) -> Result<DuplicateMemberPage> {
        validate_sha256(sha256)?;
        let limit = checked_page_size(limit)?;
        let sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.sha256 = ?1 AND f.id > ?2
            ORDER BY f.id ASC
            LIMIT ?3
            ",
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                sha256,
                cursor.map(|value| value.id).unwrap_or(0),
                limit as i64 + 1
            ],
            attachment_from_row,
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items
                .last()
                .map(|attachment| AttachmentCursor { id: attachment.id })
        } else {
            None
        };
        Ok(DuplicateMemberPage { items, next_cursor })
    }

    pub(crate) fn duplicate_link_groups(
        &self,
        excluded: &HashSet<String>,
    ) -> Result<Vec<Vec<DuplicateLinkMember>>> {
        if self.meta("hash_status")?.as_deref() != Some("complete") {
            bail!("duplicate scan is not complete; scan exact duplicates before linking them");
        }
        let mut statement = self.connection.prepare(
            "
            SELECT sha256, bytes, path
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND sha256 IS NOT NULL
              AND sha256 IN (
                  SELECT sha256
                  FROM files
                  WHERE attachment_kind IS NOT NULL
                    AND sha256 IS NOT NULL
                  GROUP BY sha256, bytes
                  HAVING COUNT(*) > 1
              )
            ORDER BY sha256 ASC, bytes ASC,
                     CASE reference_status
                         WHEN 'referenced' THEN 0
                         WHEN 'unconfirmed' THEN 1
                         ELSE 2
                     END,
                     CASE attachment_kind WHEN 'original' THEN 0 ELSE 1 END,
                     path ASC
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
                DuplicateLinkMember {
                    path: row.get(2)?,
                    bytes: row.get::<_, i64>(1)?.max(0) as u64,
                },
            ))
        })?;

        let mut groups = Vec::new();
        let mut current_key: Option<(String, u64)> = None;
        let mut current_members = Vec::new();
        for row in rows {
            let (sha256, bytes, member) = row?;
            let key = (sha256, bytes);
            if current_key.as_ref().is_some_and(|value| value != &key) {
                if current_members.len() > 1 {
                    groups.push(std::mem::take(&mut current_members));
                } else {
                    current_members.clear();
                }
            }
            current_key = Some(key);
            if !excluded.contains(&member.path) {
                current_members.push(member);
            }
        }
        if current_members.len() > 1 {
            groups.push(current_members);
        }
        Ok(groups)
    }

    fn cleanup_group(&self, group_key: &str) -> Result<CleanupGroup> {
        let sql = format!(
            "
            SELECT {CLEANUP_GROUP_EXPR} AS group_key,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN ''
                       ELSE COALESCE(f.context_source, '')
                   END) AS chat_source,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN NULL
                       ELSE f.message_chat_pk
                   END) AS chat_pk,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN ''
                       ELSE COALESCE(f.context_chat_id, '')
                   END) AS chat_id,
                   MAX(CASE f.reference_status
                       WHEN 'unreferenced' THEN '孤兒檔案（SQLite 未引用）'
                       WHEN 'unconfirmed' THEN '無法確認引用的附件'
                       ELSE COALESCE(NULLIF(f.context_chat_title, ''), NULLIF(f.chat_hint, ''), '無法辨識的聊天室')
                   END) AS chat_title,
                   MAX(CASE f.reference_status
                       WHEN 'unreferenced' THEN 'unreferenced'
                       WHEN 'unconfirmed' THEN 'unknown'
                       ELSE COALESCE(NULLIF(f.context_chat_kind, ''), 'unknown')
                   END) AS chat_kind,
                   MAX(f.reference_status) AS reference_status,
                   COUNT(*) AS file_count,
                   COALESCE(SUM(f.bytes), 0) AS total_bytes,
                   SUM(CASE WHEN p.path IS NOT NULL THEN 1 ELSE 0 END) AS marked_count,
                   MAX(CASE WHEN f.attachment_kind = 'original' THEN 1 ELSE 0 END) AS has_original,
                   MAX(CASE WHEN f.attachment_kind = 'thumbnail' THEN 1 ELSE 0 END) AS has_thumbnail,
                   SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END)
                       AS thumbnail_backed_image_count,
                   CASE
                       WHEN SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END) > 0
                        AND SUM(CASE
                            WHEN ({THUMBNAIL_BACKED_IMAGE_EXPR}) AND p.path IS NOT NULL
                            THEN 1 ELSE 0
                        END) = SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END)
                        AND SUM(CASE
                            WHEN ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR}) AND p.path IS NOT NULL
                            THEN 1 ELSE 0
                        END) = 0
                       THEN 1 ELSE 0
                   END AS keeping_thumbnails,
                   COALESCE(MAX(f.message_timestamp), 0) AS latest_timestamp,
                   MAX(CASE
                       WHEN EXISTS (
                           SELECT 1 FROM chat_removal_plan crp
                           WHERE crp.source = f.context_source
                             AND crp.chat_pk = f.message_chat_pk
                       )
                       THEN 1 ELSE 0
                   END) AS planned_for_chat_removal,
                   1
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.attachment_kind IS NOT NULL
              AND {CLEANUP_GROUP_EXPR} = ?1
            GROUP BY group_key
            "
        );
        self.connection
            .query_row(&sql, [group_key], cleanup_group_from_row)
            .optional()?
            .map(|value| value.0)
            .context("cleanup group does not exist")
    }

    pub fn stats(&self) -> Result<CatalogStats> {
        let (file_count, total_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM files",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (attachment_count, attachment_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM files WHERE attachment_kind IS NOT NULL",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (marked_count, marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan p JOIN files f ON f.path = p.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(CatalogStats {
            source_path: self.meta("source_path")?.unwrap_or_default(),
            scan_status: self
                .meta("scan_status")?
                .unwrap_or_else(|| "not_started".to_string()),
            file_count: file_count.max(0) as u64,
            total_bytes: total_bytes.max(0) as u64,
            attachment_count: attachment_count.max(0) as u64,
            attachment_bytes: attachment_bytes.max(0) as u64,
            marked_count: marked_count.max(0) as u64,
            marked_bytes: marked_bytes.max(0) as u64,
        })
    }

    pub fn set_active_job(&self, kind: &str, job_id: Option<&str>) -> Result<()> {
        let key = format!("active_{kind}_job_id");
        match job_id.filter(|value| !value.is_empty()) {
            Some(value) => self.set_meta(&key, value),
            None => self.clear_meta(&key),
        }
    }

    pub fn clear_active_job(&self, kind: &str) -> Result<()> {
        self.clear_meta(&format!("active_{kind}_job_id"))
    }

    pub fn active_job(&self) -> Result<Option<(String, String)>> {
        for (kind, key) in [
            ("scan", "active_scan_job_id"),
            ("hash", "active_hash_job_id"),
            ("candidate", "active_candidate_job_id"),
        ] {
            if let Some(job_id) = self.meta(key)? {
                return Ok(Some((kind.to_string(), job_id)));
            }
        }
        Ok(None)
    }

    fn upsert_batch(&mut self, scan_id: i64, batch: &mut Vec<FileRecord>) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.transaction()?;
        insert_records(&transaction, scan_id, batch)?;
        transaction.commit()?;
        batch.clear();
        Ok(())
    }

    fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn clear_meta(&self, key: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM meta WHERE key = ?1", [key])?;
        Ok(())
    }
}

fn insert_records(
    transaction: &Transaction<'_>,
    scan_id: i64,
    records: &[FileRecord],
) -> Result<()> {
    let mut statement = transaction.prepare(
        "
        INSERT INTO files(path, bytes, modified_ns, content_sha256, attachment_kind, message_id, chat_hint, seen_scan)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(path) DO UPDATE SET
            bytes = excluded.bytes,
            modified_ns = excluded.modified_ns,
            content_sha256 = excluded.content_sha256,
            attachment_kind = excluded.attachment_kind,
            message_id = excluded.message_id,
            chat_hint = excluded.chat_hint,
            sha256 = CASE
                WHEN files.content_sha256 = excluded.content_sha256
                THEN files.sha256
                ELSE NULL
            END,
            seen_scan = excluded.seen_scan
        ",
    )?;
    for record in records {
        let bytes = i64::try_from(record.bytes).context("file is too large for catalog SQLite")?;
        statement.execute(params![
            record.path,
            bytes,
            record.modified_ns,
            record.content_sha256,
            record.kind.map(AttachmentKind::as_str),
            record.message_id,
            record.chat_hint,
            scan_id
        ])?;
    }
    Ok(())
}

fn update_progress(progress: &mut CatalogScanProgress, record: &FileRecord) {
    progress.files += 1;
    progress.bytes = progress.bytes.saturating_add(record.bytes);
    if record.kind.is_some() {
        progress.attachments += 1;
    }
}

fn file_record(path: String, bytes: u64, modified_ns: i64, content_sha256: String) -> FileRecord {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let attachment = segments
        .iter()
        .position(|segment| *segment == "Message Attachments" || *segment == "Message Thumbnails");
    let kind = attachment.map(|index| {
        if segments[index] == "Message Thumbnails" {
            AttachmentKind::Thumbnail
        } else {
            AttachmentKind::Original
        }
    });
    let filename = segments.last().copied().unwrap_or_default();
    let message_id = leading_message_id(filename);
    let chat_hint = attachment
        .and_then(|index| segments.get(index + 1))
        .filter(|value| **value != filename)
        .copied()
        .unwrap_or_default()
        .to_string();
    FileRecord {
        path: normalized,
        bytes,
        modified_ns,
        content_sha256,
        kind,
        message_id,
        chat_hint,
    }
}

fn leading_message_id(filename: &str) -> String {
    let digits: String = filename
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.len() >= 8 {
        digits
    } else {
        String::new()
    }
}

fn modified_ns(value: Option<SystemTime>) -> i64 {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_nanos()).ok())
        .unwrap_or(0)
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_secs()).ok())
        .unwrap_or(0)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn cleanup_search_pattern(search: Option<&str>) -> Option<String> {
    search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", escape_like(value)))
}

fn validate_cleanup_query(
    page: u32,
    page_size: u32,
    kind: &str,
    category: &str,
    sort: &str,
) -> Result<()> {
    if page == 0 {
        bail!("cleanup page must be at least 1");
    }
    checked_page_size(page_size)?;
    if !matches!(kind, "all" | "original" | "thumbnail" | "marked") {
        bail!("cleanup kind must be all, original, thumbnail, or marked");
    }
    if !matches!(
        category,
        "all" | "individual" | "group" | "community" | "unreferenced" | "unconfirmed"
    ) {
        bail!("unsupported cleanup category");
    }
    if !matches!(sort, "recent" | "oldest" | "size" | "path") {
        bail!("cleanup sort must be recent, oldest, size, or path");
    }
    Ok(())
}

fn validate_cleanup_group_key(group_key: &str) -> Result<()> {
    if group_key.is_empty() || group_key.len() > 1_024 {
        bail!("invalid cleanup group key");
    }
    Ok(())
}

fn cleanup_offset(page: u32, page_size: usize) -> Result<i64> {
    let offset = u64::from(page - 1)
        .checked_mul(page_size as u64)
        .context("cleanup page offset overflow")?;
    i64::try_from(offset).context("cleanup page offset is too large")
}

fn cleanup_total_pages(total_items: u64, page_size: u32) -> u64 {
    if total_items == 0 {
        1
    } else {
        total_items.div_ceil(u64::from(page_size))
    }
}

fn cleanup_group_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(CleanupGroup, u64)> {
    Ok((
        CleanupGroup {
            key: row.get(0)?,
            chat_source: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            chat_pk: row.get(2)?,
            chat_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            chat_title: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            chat_kind: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            reference_status: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            file_count: row.get::<_, i64>(7)?.max(0) as u64,
            total_bytes: row.get::<_, i64>(8)?.max(0) as u64,
            marked_count: row.get::<_, i64>(9)?.max(0) as u64,
            has_original: row.get::<_, i64>(10)? != 0,
            has_thumbnail: row.get::<_, i64>(11)? != 0,
            thumbnail_backed_image_count: row.get::<_, i64>(12)?.max(0) as u64,
            keeping_thumbnails: row.get::<_, i64>(13)? != 0,
            latest_timestamp: row.get::<_, i64>(14)?,
            planned_for_chat_removal: row.get::<_, i64>(15)? != 0,
        },
        row.get::<_, i64>(16)?.max(0) as u64,
    ))
}

fn detect_image_media_type(path: &Path) -> Result<Option<&'static str>> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 16];
    let read = file.read(&mut header)?;
    let header = &header[..read];
    let media_type = if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Some("image/webp")
    } else if header.starts_with(b"BM") {
        Some("image/bmp")
    } else if header.len() >= 12
        && &header[4..8] == b"ftyp"
        && matches!(&header[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    };
    Ok(media_type)
}

fn trim_preview_cache(directory: &Path, keep: usize) -> Result<()> {
    let mut files = fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata
                .is_file()
                .then(|| (metadata.modified().unwrap_or(UNIX_EPOCH), entry.path()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.0);
    let remove_count = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(remove_count) {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == column) {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"),
            [],
        )?;
    }
    Ok(())
}

fn validate_bound_source(catalog: &Catalog, source: &Path) -> Result<()> {
    let bound = catalog
        .source_path()?
        .context("catalog has not been scanned yet")?
        .canonicalize()
        .context("catalog source no longer exists")?;
    if bound != source {
        bail!("catalog belongs to another source");
    }
    Ok(())
}

fn update_hash_batch(
    connection: &mut Connection,
    pending: &mut Vec<(String, String)>,
) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare("UPDATE files SET sha256 = ?2 WHERE path = ?1")?;
        for (path, digest) in pending.iter() {
            statement.execute(params![path, digest])?;
        }
    }
    transaction.commit()?;
    pending.clear();
    Ok(())
}

fn hash_reader(mut reader: impl Read) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn safe_source_join(source: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        bail!("catalog contains an unsafe source path: {relative}");
    }
    Ok(source.join(relative))
}

fn file_record_fingerprint(path: &Path) -> Result<(u64, i64)> {
    let metadata = fs::metadata(path)?;
    Ok((metadata.len(), modified_ns(metadata.modified().ok())))
}

fn hash_directory_file(path: &Path, bytes: u64, modified_ns: i64) -> Result<String> {
    let before = file_record_fingerprint(path)?;
    if before != (bytes, modified_ns) {
        bail!("source file changed while scanning: {}", path.display());
    }
    let digest = hash_reader(BufReader::with_capacity(
        HASH_BUFFER_BYTES,
        File::open(path)?,
    ))?;
    if file_record_fingerprint(path)? != before {
        bail!("source file changed while scanning: {}", path.display());
    }
    Ok(digest)
}

fn source_metadata_fingerprint(path: &Path, kind: SourceKind) -> Result<String> {
    let mut hasher = Sha256::new();
    if kind == SourceKind::Directory {
        let mut entries = Vec::new();
        for entry in WalkDir::new(path).follow_links(false) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(path).with_context(|| {
                format!(
                    "source entry is outside the source root: {}",
                    entry.path().display()
                )
            })?;
            let metadata = entry.metadata()?;
            entries.push((
                relative.to_string_lossy().replace('\\', "/"),
                metadata.len(),
                modified_ns(metadata.modified().ok()),
            ));
        }
        entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        hasher.update((entries.len() as u64).to_le_bytes());
        for (relative, bytes, modified) in entries {
            hasher.update(relative.as_bytes());
            hasher.update([0]);
            hasher.update(bytes.to_le_bytes());
            hasher.update(modified.to_le_bytes());
        }
    } else {
        let metadata = fs::metadata(path)?;
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(modified_ns(metadata.modified().ok()).to_le_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("sha256 must contain exactly 64 hexadecimal characters");
    }
    Ok(())
}

fn attachment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentItem> {
    let raw_kind: String = row.get(4)?;
    let kind = match raw_kind.as_str() {
        "original" => AttachmentKind::Original,
        "thumbnail" => AttachmentKind::Thumbnail,
        _ => unreachable!("catalog only stores known attachment kinds"),
    };
    let reference_status: String = row.get(8)?;
    let context = if reference_status == "referenced" {
        Some(AttachmentContext {
            source: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            message_pk: row.get(9)?,
            chat_pk: row.get(10)?,
            chat_id: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
            chat_title: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
            chat_kind: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
            timestamp: row.get::<_, Option<i64>>(15)?.unwrap_or(0),
            sender_pk: row.get(16)?,
            sender_name: row.get::<_, Option<String>>(17)?.unwrap_or_default(),
            content_type: row.get(18)?,
            text: row.get::<_, Option<String>>(19)?.unwrap_or_default(),
        })
    } else {
        None
    };
    Ok(AttachmentItem {
        id: row.get(0)?,
        path: row.get(1)?,
        bytes: row.get::<_, i64>(2)?.max(0) as u64,
        modified_ns: row.get(3)?,
        kind,
        message_id: row.get(5)?,
        chat_hint: row.get(6)?,
        marked_for_removal: row.get(7)?,
        reference_status,
        context,
    })
}
