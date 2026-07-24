use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::candidate::build_candidate;
use crate::catalog::Catalog;
use crate::database::{LineDatabase, LineSquareDatabase, UnifiedGroupDatabase};
use crate::model::{
    AttachmentCursor, AttachmentKind, ChatCursor, ChatPage, DEFAULT_PAGE_SIZE,
    DuplicateGroupCursor, MessageCursor,
};
use crate::source::{PreparedSource, prepare_source};

pub const SIDECAR_PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

pub struct NativeSession {
    prepared: PreparedSource,
    database: LineDatabase,
    square_database: Option<LineSquareDatabase>,
    unified_group_database: Option<UnifiedGroupDatabase>,
    catalog: Catalog,
}

impl NativeSession {
    pub fn open(source: &Path, work_dir: &Path) -> Result<Self> {
        let prepared = prepare_source(source, work_dir)?;
        let database = LineDatabase::open(&prepared.database_path)?;
        let square_database = prepared
            .square_database_path
            .as_deref()
            .map(LineSquareDatabase::open)
            .transpose()?;
        let unified_group_database = prepared
            .unified_group_database_path
            .as_deref()
            .map(UnifiedGroupDatabase::open)
            .transpose()?;
        let catalog = Catalog::open(&work_dir.join("catalog.sqlite"))?;
        Ok(Self {
            prepared,
            database,
            square_database,
            unified_group_database,
            catalog,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatPageParams {
    #[serde(default = "default_chat_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<ChatCursor>,
    #[serde(default)]
    before_cursor: Option<ChatCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagePageParams {
    chat_pk: i64,
    #[serde(default = "default_message_source")]
    source: String,
    #[serde(default = "default_message_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<MessageCursor>,
    #[serde(default)]
    before_cursor: Option<MessageCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchParams {
    query: String,
    #[serde(default = "default_message_source")]
    source: String,
    #[serde(default)]
    chat_pk: Option<i64>,
    #[serde(default = "default_message_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<MessageCursor>,
    #[serde(default)]
    before_cursor: Option<MessageCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentPageParams {
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<AttachmentCursor>,
    #[serde(default)]
    kind: Option<AttachmentKind>,
    #[serde(default)]
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkParams {
    path: String,
    marked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewParams {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildCandidateParams {
    output: PathBuf,
    #[serde(default)]
    full_crc: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroupParams {
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<DuplicateGroupCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateMemberParams {
    sha256: String,
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<AttachmentCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupPageParams {
    #[serde(default = "default_cleanup_page")]
    page: u32,
    #[serde(default = "default_cleanup_page_size")]
    page_size: u32,
    #[serde(default)]
    search: Option<String>,
    #[serde(default = "default_cleanup_kind")]
    kind: String,
    #[serde(default = "default_cleanup_category")]
    category: String,
    #[serde(default = "default_cleanup_sort")]
    sort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupReviewParams {
    group_key: String,
    #[serde(flatten)]
    page: CleanupPageParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupGroupActionParams {
    group_key: String,
    action: String,
}

enum ReadLine {
    Eof,
    Line,
    TooLarge,
}

pub fn serve<R: BufRead, W: Write>(
    session: &mut NativeSession,
    input: &mut R,
    output: &mut W,
) -> Result<()> {
    write_json_line(
        output,
        &json!({
            "event": "ready",
            "protocolVersion": SIDECAR_PROTOCOL_VERSION,
            "source": session.prepared.report,
            "readOnly": session.database.is_read_only()?,
        }),
    )?;

    let mut line = Vec::new();
    loop {
        match read_bounded_line(input, &mut line, MAX_REQUEST_BYTES)? {
            ReadLine::Eof => break,
            ReadLine::TooLarge => {
                write_error(output, "", "request_too_large", "request exceeds 1 MiB")?;
                continue;
            }
            ReadLine::Line => {}
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Request = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_error(
                    output,
                    "",
                    "invalid_request",
                    &format!("invalid JSON request: {error}"),
                )?;
                continue;
            }
        };
        let should_shutdown = request.method == "shutdown";
        match handle_request(session, &request, output) {
            Ok(result) => write_json_line(
                output,
                &Response {
                    id: &request.id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
            )?,
            Err(error) => write_error(
                output,
                &request.id,
                "operation_failed",
                &format!("{error:#}"),
            )?,
        }
        if should_shutdown {
            break;
        }
    }
    Ok(())
}

fn handle_request<W: Write>(
    session: &mut NativeSession,
    request: &Request,
    output: &mut W,
) -> Result<Value> {
    match request.method.as_str() {
        "sessionInfo" => Ok(json!({
            "protocolVersion": SIDECAR_PROTOCOL_VERSION,
            "source": session.prepared.report,
            "readOnly": session.database.is_read_only()?,
            "quickCheck": session.database.quick_check()?,
            "lineSquareLoaded": session.square_database.is_some(),
            "unifiedGroupLoaded": session.unified_group_database.is_some(),
            "catalog": session.catalog.stats()?,
        })),
        "listChats" => {
            let params: ChatPageParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("chat pagination cannot use both cursor and beforeCursor");
            }
            let line_page = if let Some(cursor) = params.before_cursor.clone() {
                session.database.list_chats_before(cursor, params.limit)?
            } else {
                session
                    .database
                    .list_chats(params.cursor.clone(), params.limit)?
            };
            let mut items = line_page.items;
            let line_has_next = line_page.next_cursor.is_some();
            let line_has_previous = line_page.has_previous;
            let mut square_has_next = false;
            let mut square_has_previous = false;
            if let Some(square_database) = session.square_database.as_ref() {
                let square_page = if let Some(cursor) = params.before_cursor.clone() {
                    square_database.list_chats_before(cursor, params.limit)?
                } else {
                    square_database.list_chats(params.cursor.clone(), params.limit)?
                };
                square_has_next = square_page.next_cursor.is_some();
                square_has_previous = square_page.has_previous;
                items.extend(square_page.items);
            }
            session.database.enrich_chat_titles(
                &mut items,
                session.unified_group_database.as_ref(),
                session.square_database.as_ref(),
            )?;
            items.sort_by(|left, right| {
                right
                    .last_updated
                    .cmp(&left.last_updated)
                    .then_with(|| left.source.cmp(&right.source))
                    .then_with(|| left.pk.cmp(&right.pk))
            });
            let combined_len = items.len();
            let has_next = if params.before_cursor.is_some() {
                !items.is_empty()
            } else {
                combined_len > params.limit as usize || line_has_next || square_has_next
            };
            let has_previous = if params.before_cursor.is_some() {
                combined_len > params.limit as usize || line_has_previous || square_has_previous
            } else {
                params.cursor.is_some()
            };
            items.truncate(params.limit as usize);
            let next_cursor = if has_next {
                items.last().map(|chat| ChatCursor {
                    last_updated: chat.last_updated,
                    source: chat.source.clone(),
                    pk: chat.pk,
                })
            } else {
                None
            };
            let page = ChatPage {
                items,
                next_cursor,
                has_previous,
            };
            Ok(serde_json::to_value(page)?)
        }
        "listMessages" => {
            let params: MessagePageParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("message pagination cannot use both cursor and beforeCursor");
            }
            let mut page = match params.source.as_str() {
                "line" => match params.before_cursor {
                    Some(cursor) => session.database.list_messages_for_account_before(
                        params.chat_pk,
                        cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                    None => session.database.list_messages_for_account(
                        params.chat_pk,
                        params.cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                },
                "square" => match params.before_cursor {
                    Some(cursor) => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .list_messages_before(
                            params.chat_pk,
                            cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                    None => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .list_messages(
                            params.chat_pk,
                            params.cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                },
                _ => anyhow::bail!("message source must be `line` or `square`"),
            };
            session
                .catalog
                .enrich_messages_with_attachments(&mut page.items)?;
            Ok(serde_json::to_value(page)?)
        }
        "searchMessages" => {
            let params: MessageSearchParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("message search pagination cannot use both cursor and beforeCursor");
            }
            let mut page = match params.source.as_str() {
                "line" => match params.before_cursor {
                    Some(cursor) => session.database.search_messages_for_account_before(
                        &params.query,
                        params.chat_pk,
                        cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                    None => session.database.search_messages_for_account(
                        &params.query,
                        params.chat_pk,
                        params.cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                },
                "square" => match params.before_cursor {
                    Some(cursor) => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .search_messages_before(
                            &params.query,
                            params.chat_pk,
                            cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                    None => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .search_messages(
                            &params.query,
                            params.chat_pk,
                            params.cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                },
                _ => anyhow::bail!("message source must be `line` or `square`"),
            };
            session
                .catalog
                .enrich_messages_with_attachments(&mut page.items)?;
            Ok(serde_json::to_value(page)?)
        }
        "scanCatalog" => {
            let request_id = request.id.clone();
            session.catalog.scan_source(
                &session.prepared.original_path,
                session.prepared.report.kind,
                |progress| {
                    let _ = write_json_line(
                        output,
                        &json!({
                            "event": "catalogProgress",
                            "requestId": request_id,
                            "files": progress.files,
                            "bytes": progress.bytes,
                            "attachments": progress.attachments,
                        }),
                    );
                },
            )?;
            let context_request_id = request.id.clone();
            session.catalog.index_attachment_contexts(
                &session.database,
                session.square_database.as_ref(),
                session.unified_group_database.as_ref(),
                |progress| {
                    let _ = write_json_line(
                        output,
                        &json!({
                            "event": "catalogContextProgress",
                            "requestId": context_request_id,
                            "processedFiles": progress.processed_files,
                            "totalFiles": progress.total_files,
                            "referencedFiles": progress.referenced_files,
                            "unreferencedFiles": progress.unreferenced_files,
                            "unconfirmedFiles": progress.unconfirmed_files,
                        }),
                    );
                },
            )?;
            let stats = session.catalog.stats()?;
            Ok(serde_json::to_value(stats)?)
        }
        "listAttachments" => {
            let params: AttachmentPageParams = parse_params(request)?;
            let page = session.catalog.list_attachments(
                params.cursor,
                params.limit,
                params.kind,
                params.search.as_deref(),
            )?;
            Ok(serde_json::to_value(page)?)
        }
        "setAttachmentMarked" => {
            let params: MarkParams = parse_params(request)?;
            session.catalog.set_marked(&params.path, params.marked)?;
            Ok(serde_json::to_value(session.catalog.stats()?)?)
        }
        "stageAttachmentPreview" => {
            let params: PreviewParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session.catalog.stage_attachment_preview(
                    &session.prepared.original_path,
                    session.prepared.report.kind,
                    &params.path,
                )?,
            )?)
        }
        "catalogStats" => Ok(serde_json::to_value(session.catalog.stats()?)?),
        "cleanupOverview" => Ok(serde_json::to_value(session.catalog.cleanup_overview()?)?),
        "listCleanupGroups" => {
            let params: CleanupPageParams = parse_params(request)?;
            Ok(serde_json::to_value(session.catalog.list_cleanup_groups(
                params.page,
                params.page_size,
                params.search.as_deref(),
                &params.kind,
                &params.category,
                &params.sort,
            )?)?)
        }
        "listCleanupReviews" => {
            let params: CleanupReviewParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session.catalog.list_cleanup_reviews(
                    &params.group_key,
                    params.page.page,
                    params.page.page_size,
                    params.page.search.as_deref(),
                    &params.page.kind,
                    &params.page.category,
                    &params.page.sort,
                )?,
            )?)
        }
        "applyCleanupGroupAction" => {
            let params: CleanupGroupActionParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session
                    .catalog
                    .apply_cleanup_group_action(&params.group_key, &params.action)?,
            )?)
        }
        "hashDuplicateCandidates" => {
            let request_id = request.id.clone();
            let result = session.catalog.hash_duplicate_candidates(
                &session.prepared.original_path,
                session.prepared.report.kind,
                |progress| {
                    if progress.processed_files % 64 == 0
                        || progress.processed_files == progress.candidate_files
                    {
                        write_json_line(
                            output,
                            &json!({
                                "event": "duplicateHashProgress",
                                "requestId": request_id,
                                "candidateFiles": progress.candidate_files,
                                "processedFiles": progress.processed_files,
                                "totalBytes": progress.total_bytes,
                                "processedBytes": progress.processed_bytes,
                            }),
                        )
                    } else {
                        Ok(())
                    }
                },
            )?;
            Ok(serde_json::to_value(result)?)
        }
        "listDuplicateGroups" => {
            let params: DuplicateGroupParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session
                    .catalog
                    .list_duplicate_groups(params.cursor, params.limit)?,
            )?)
        }
        "listDuplicateMembers" => {
            let params: DuplicateMemberParams = parse_params(request)?;
            let page = session.catalog.list_duplicate_members(
                &params.sha256,
                params.cursor,
                params.limit,
            )?;
            Ok(serde_json::to_value(page)?)
        }
        "buildCandidate" => {
            let params: BuildCandidateParams = parse_params(request)?;
            let request_id = request.id.clone();
            let report = build_candidate(
                &session.prepared.original_path,
                &params.output,
                &session.catalog,
                params.full_crc,
                |progress| {
                    if progress.processed_entries % 64 == 0
                        || progress.processed_entries == progress.total_entries
                    {
                        write_json_line(
                            output,
                            &json!({
                                "event": "candidateProgress",
                                "requestId": request_id,
                                "processedBytes": progress.processed_bytes,
                                "totalBytes": progress.total_bytes,
                                "processedEntries": progress.processed_entries,
                                "totalEntries": progress.total_entries,
                            }),
                        )
                    } else {
                        Ok(())
                    }
                },
            )?;
            Ok(serde_json::to_value(report)?)
        }
        "shutdown" => Ok(json!({ "shuttingDown": true })),
        _ => anyhow::bail!("unknown method: {}", request.method),
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(request: &Request) -> Result<T> {
    serde_json::from_value(request.params.clone())
        .with_context(|| format!("invalid params for {}", request.method))
}

fn default_chat_limit() -> u32 {
    100
}

fn default_message_source() -> String {
    "line".to_string()
}

fn default_message_limit() -> u32 {
    DEFAULT_PAGE_SIZE
}

fn default_attachment_limit() -> u32 {
    100
}

fn default_cleanup_page() -> u32 {
    1
}

fn default_cleanup_page_size() -> u32 {
    24
}

fn default_cleanup_kind() -> String {
    "all".to_string()
}

fn default_cleanup_category() -> String {
    "all".to_string()
}

fn default_cleanup_sort() -> String {
    "recent".to_string()
}

fn write_error<W: Write>(
    output: &mut W,
    id: &str,
    code: &'static str,
    message: &str,
) -> Result<()> {
    write_json_line(
        output,
        &Response {
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code,
                message: message.to_string(),
            }),
        },
    )
}

fn write_json_line<W: Write>(output: &mut W, value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn read_bounded_line<R: BufRead>(
    input: &mut R,
    line: &mut Vec<u8>,
    maximum: usize,
) -> std::io::Result<ReadLine> {
    line.clear();
    let mut too_large = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !too_large {
                Ok(ReadLine::Eof)
            } else if too_large {
                Ok(ReadLine::TooLarge)
            } else {
                Ok(ReadLine::Line)
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if !too_large {
            if line.len().saturating_add(take) > maximum {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..take]);
            }
        }
        input.consume(take);
        if newline.is_some() {
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if too_large {
                Ok(ReadLine::TooLarge)
            } else {
                Ok(ReadLine::Line)
            };
        }
    }
}
