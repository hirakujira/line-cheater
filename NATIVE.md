# Native Core Architecture and Handoff

Last updated: 2026-07-24

This document is the durable handoff record for the bounded-memory desktop version
of LINE Cheater. Keep it updated whenever the native implementation,
data contract, safety rules, or next steps change.

## Goal

Browse, search, inspect attachments, and build a slimmed `.imazingapp` from LINE
backups that may be 30–200 GB on a machine with 16 GB RAM.

Input size must affect processing time and required disk space, but must not
determine resident memory usage.

## Architecture decision

The native core owns all large state and filesystem access. HTML/CSS/JavaScript
is a presentation layer that receives small pages of serializable records.

```text
HTML/CSS/JS UI
    │ small IPC requests, pages, and progress events
    ▼
Rust core / CLI
    ├── native read-only SQLite connection
    ├── catalog.sqlite working index
    ├── directory and .imazingapp source adapters
    └── streaming candidate writer
```

The core is a Rust library plus CLI so it is not tied to a desktop shell:

- Implemented preview shell: Electron with the Rust CLI as a long-running
  sidecar. This follows the requested Chromium frontend path and keeps the
  renderer isolated from native files.
- Future lower-baseline alternative: Tauri can implement the same provider and
  protocol if Electron's fixed overhead proves material after measurement.
- The existing GitHub Pages build remains the small-backup/demo provider.

Electron or Tauri alone does not solve the scale problem. The important boundary
is that the renderer never owns a complete SQLite database, complete attachment
list, complete chat, or complete output archive.

## Repository layout

```text
Cargo.toml                 Rust workspace
native/core/               Native library and line-backup-native CLI
native/core/src/source.rs  Directory, SQLite, and .imazingapp discovery/staging
native/core/src/database.rs
                           Read-only LINE SQLite queries and cursor pagination
native/core/src/catalog.rs Disk-backed file/attachment catalog and removal plan
native/core/src/model.rs   Serializable IPC/CLI data contract
native/core/tests/core.rs  Generated fixtures; never uses personal chat content
native/frontend/           Renderer data provider, contract tests, and handoff notes
native/electron/           Sandboxed Electron preview and sidecar client
```

Runtime work goes under `.line-reader-work/` by default and is ignored by Git.
Real LINE backups, `.imazingapp` files, SQLite databases, indexes containing
chat content, and generated candidates must never be committed.

## Current implementation status

Verified implementation:

- [x] Rust workspace and native CLI skeleton.
- [x] Detect an unpacked backup directory, direct `Line.sqlite`, or
  `.imazingapp`.
- [x] Prefer the account-specific
  `PrivateStore/P_*/Messages/Line.sqlite` over unrelated LINE databases.
- [x] For `.imazingapp`, extract only `Line.sqlite`, `LineSquare.sqlite`,
  `UnifiedGroup.sqlite`, and their available `-wal`/`-shm` companions to a
  source-fingerprinted staging directory.
- [x] Open source SQLite with `SQLITE_OPEN_READ_ONLY` and `PRAGMA query_only`.
- [x] Bound SQLite page cache and temp behavior independently of database size.
- [x] List main and `LineSquare.sqlite` community chats through one
  `(last_updated, source, pk)` cursor. Each chat carries its source so message
  pages are routed back to the correct database.
- [x] List messages with a `(timestamp, pk)` keyset cursor.
- [x] Reject pages larger than 1,000 records.
- [x] Store file metadata, attachment classification, and removal selections in
  a separate `catalog.sqlite`.
- [x] Scan directory entries or ZIP central-directory entries in batches of
  1,000 records.
- [x] Paginate attachment results by catalog row ID.
- [x] Generated unit/integration fixtures for read-only access, cursor behavior,
  catalog persistence, and selective archive staging.
- [x] `cargo fmt --all --check` and `cargo test --workspace`.
- [x] Smoke-test against the ignored local LINE fixture without logging chat
  titles, message text, account IDs, or attachment names.
- [x] Add long-running JSONL sidecar protocol for desktop IPC.
- [x] Add bounded native message search and enrich each attachment page with
  exact `ZMESSAGE.ZID` context when available.
- [ ] Add a resumable disk-backed FTS index; the initial native search uses a
  bounded-result read-only SQLite `LIKE` scan.
- [x] Add streaming SHA-256, size pre-grouping, on-disk checkpoints, and
  duplicate-group/member pages.
- [x] Add initial ZIP64/raw-copy candidate construction and validation.
- [x] Add dependency-free renderer `NativeDataProvider` and tests.
- [x] Add a runnable Electron 43.2.0 preview with a sandboxed preload,
  allowlisted IPC, native source/output dialogs, bounded sidecar parser, chat,
  message, search, attachment, marking, and candidate UI.
- [x] Port the web cleanup workflow: six category summaries, chat/special
  grouping, bounded group/review queries, kind/category/sort/search filters,
  exact/unreferenced/unconfirmed evidence, individual original/thumbnail
  selection, delete-all, and reversible keep-thumbnail actions. The provider
  default remains 24 rows; the fixed desktop viewport requests four group rows
  while detail mode streams 24-review virtual batches.
- [x] Correlate cleanup paths against both `Line.sqlite` and the same-store
  `LineSquare.sqlite`, including community titles and senders.
- [x] Add bounded local image previews. A preview is catalog-authorized, capped
  at 16 MiB, delivered through a tokenized local protocol, and never serialized
  into JSON. Archive previews are streamed on demand into a 32-file LRU cache.
- [x] Match the web chat-name evidence order with `ZUSER`, `LineSquare.sqlite`,
  `UnifiedGroup.sqlite`, `ZGROUP`, and inferred rename-message fallbacks. Chats
  with at least one stored message are shown like the web implementation;
  `humanMessageCount` remains a separate display statistic.
- [x] Resolve message ownership in Rust. A populated sender is “我” only when
  its `ZMID` matches the account ID from `PrivateStore/P_*`; `ZSENDSTATUS=1`
  and `ZMESSAGETYPE=S` are fallback evidence only when the sender is absent and
  the row is not a system event. The renderer consumes this explicit `isSelf`
  field instead of guessing.
- [x] Attach catalog-authorized original/thumbnail paths to bounded message
  pages and render chat images on demand. At most four previews are hydrated
  concurrently; image bytes never enter JSON or a complete-chat array.
- [x] Linkify credential-free HTTP(S) URLs in Electron chat messages, render up
  to four local domain/title preview cards per message, and open them through a
  main-process `shell.openExternal` bridge. Renderer navigation and non-HTTP(S)
  schemes stay blocked.
- [x] Render cleanup detail as a bounded iOS Photos-style album: continuous
  scrolling, sticky month sections, 24-review native batches, at most three
  adjacent batches/72 cards in the DOM, virtual spacers for discarded pages,
  aspect-ratio-preserving thumbnails, and message/file information below each
  image. Loaded thumbnails are keyboard-focusable zoom buttons that open the
  existing full-size image modal.
- [x] Port the web-style blocking load/package progress dialogs and chat/message
  panel layout, including incoming/outgoing/system bubbles and full-size image
  preview.
- [x] Present the desktop product as LINE Cheater with a two-screen native app
  shell: source selection and preparation first, an explicit Next action, then
  a persistent sidebar that switches between mutually exclusive Browse and
  Cleanup workspaces.
- [x] Lead the welcome screen with `.imazingapp` and label it `推薦`; keep the
  unpacked backup directory as the secondary choice and hide the diagnostic
  direct-`Line.sqlite` picker from the end-user UI.
- [x] Reuse the packaged folder/chat/shield app icon in the welcome header and
  workspace sidebar so in-app branding matches the macOS application icon.
- [x] Replace the document-scrolling cleanup screen with a fixed-height native
  workspace. Header, filters, category strip, pagination, and candidate action
  stay in place while four group rows replace the center window. Detail mode
  removes the category/warning strips and pagination, then uses a contained
  virtual album scroller that preserves image proportions and puts the default
  original/thumbnail controls below the image.
- [x] Add a repeatable macOS arm64 packager that bundles the optimized Rust
  sidecar, custom icon, ad-hoc signature, ZIP, DMG, and SHA-256 checksums.
- [x] Replace the generated SVG icon with the supplied folder/chat/shield
  artwork normalized to a full-bleed 1024 × 1024 macOS PNG master. The source
  has no black corner matte or pre-applied system mask; packaging validates its
  dimensions and derives all ten legacy `.iconset` sizes before building the
  `.icns`.
- [ ] Add Apple Developer ID signing/notarization, Intel/universal macOS,
  Windows, and Linux packages with the correct sidecar for each target.
- [ ] Port duplicate review, cleanup-plan exports, and the remaining analysis
  UX.
- [ ] Validate native candidates with iMazing restore before calling the ZIP64
  writer production-compatible.

### Latest verification record

2026-07-24:

- Rust: 1.96.0.
- Native tests: 13 passed; renderer provider tests: 7 passed; Electron sidecar
  tests: 2 passed; app-shell/package contract tests: 9 passed; existing Python CLI
  tests: 19 passed.
- Electron: 43.2.0 pinned; `npm audit` reported 0 vulnerabilities.
- Ignored real fixture: 1.1 GB, 13,512 files, 11,239 classified attachments.
- Catalog scan: approximately 0.36 seconds on the current machine.
- Native SQLite: opened an 88 MiB account database read-only.
- Chat page: 25 bounded records with a continuation cursor.
- Message page: 180 bounded records with a continuation cursor; duplicate
  timestamps remained correctly ordered by primary key.
- JSONL sidecar: protocol v1 opened the real fixture read-only, returned
  `quick_check=ok`, observed the existing 13,512-row catalog, and shut down
  cleanly.
- Ignored real `.imazingapp`: 13,506 entries and 11,239 classified attachments
  were scanned from its central directory. Browsing stages only the main,
  community, and unified-group SQLite companions instead of copying the 1.0 GB
  archive.
- Duplicate pre-grouping selected 4,089 same-size attachment files totaling
  49,074,066 bytes. Streaming SHA-256 completed in approximately 3.1 seconds;
  an immediate second run selected 0 files, confirming the on-disk checkpoint.
  The first duplicate page contained 20 groups and a continuation cursor.
- A no-match native message search over the 88 MiB SQLite completed in
  approximately 0.5 seconds. In the first 100 real attachment rows, 85 received
  an exact message context without exposing any private field in the test log.
- Electron directory GUI smoke: `quick_check=ok`; 100 chat rows, 180 message
  rows, and 100 attachment rows stayed within their page windows; the first
  attachment page had 85 linked and 15 unlinked contexts. Apple-reference
  `ZCHAT` timestamps were normalized for display instead of appearing 31 years
  early.
- Production web comparison on the same directory fixture: 221 chats, 925,868
  messages, 11,239 attachments, and 59 cleanup groups across 3 pages.
- Source-aware desktop browsing returned the same 221 nonempty chats: 202 from
  the main database and 19 from `LineSquare.sqlite`, with 20 chats presented as
  communities after title enrichment. Fifteen system-only chats account for
  the earlier desktop undercount. There were zero duplicate cross-source chat
  IDs in this fixture.
- Across the first bounded message page of every real chat, main-database
  messages included both self and other senders (4,857 / 11,501); community
  pages contained 3,342 other-sender rows and were no longer mislabeled as
  “我”. Only aggregate counts were recorded.
- Electron + Rust cleanup comparison on that directory: 11,239 attachments,
  59 groups, and the same six-category totals after `LineSquare.sqlite`
  support was added. The current fixed desktop UI presents 15 four-row group
  pages. A real group detail page kept original/thumbnail checkboxes separate;
  the current renderer requests 24-review batches and virtualizes the continuous
  month-sectioned album instead of exposing those pages to the user.
- After title-evidence parity was added, the first 100 real main-database chats
  had zero raw-ID fallbacks; 18 titles came from `UnifiedGroup.sqlite`. Across
  58 referenced attachment chats, zero cleanup group titles fell back to the raw
  chat ID. Only aggregate counts were logged.
- A targeted real message-page check returned one referenced image message with
  two catalog-authorized variants (original and thumbnail), confirming the
  message/image route without logging private paths or content.
- The real `.imazingapp` sidecar produced the same aggregate cleanup result:
  11,239 attachments and 59 groups. A provider-default query still returns
  three 24-row pages, while the current fixed desktop UI returned 15 pages and
  four groups on page one. Community and unreferenced totals also matched the
  directory run. Its session reported both `lineSquareLoaded` and
  `unifiedGroupLoaded`. A second read-only browse check returned the same 221
  chats and 20 community labels, and successfully routed a 180-row community
  message page through the archive-staged `LineSquare.sqlite`.
- The Electron directory picker, two-screen welcome/Next flow, persistent
  sidebar, mutually exclusive Browse/Cleanup views, cleanup group list, category
  summaries, pagination, review cards, and real image pixels were GUI-tested.
  No removal checkbox or candidate build was triggered during this read-only
  visual pass. Manually regress native pickers and image rendering on every
  release target.
- The fixed cleanup viewport was GUI-tested again with the real `.imazingapp`:
  the default view kept four group rows, pagination, and the candidate action
  visible without a document scrollbar. That pass used the earlier two-card
  detail layout; it established data and image parity before the continuous
  virtual album presentation replaced it. No removal checkbox or candidate build was
  triggered.
- The current packaged app was GUI-tested with a generated, non-private
  directory fixture. A plain HTTP(S) message produced both a focusable link and
  a bounded preview card; the external URL was deliberately not opened. The
  cleanup detail rendered its uncropped image above the sender/time/file
  controls, and clicking it opened and closed the shared full-size image modal.
  That test predated continuous scrolling; it remains the zoom/link fixture,
  while the month-sectioned virtual-window behavior is covered separately.
- The continuous album was then GUI-tested read-only against the ignored real
  `.imazingapp`, recording only aggregates. A 612-review group opened with
  `1–24 / 612`, no detail Previous/Next controls, and a sticky month heading.
  Scrolling loaded `1–48`, then crossed a month boundary and reported
  `25–96 / 612`: this demonstrates forward batch loading and eviction of the
  first 24-card page while the three-page/72-card window remained bounded. No
  removal checkbox or candidate build was triggered.
- Generated candidate fixtures verify directory streaming, archive raw-copy,
  explicit attachment removal, complete CRC reads, and protected core hashes.
- The macOS arm64 release package embeds an arm64 optimized Rust sidecar and
  Electron runtime. The 281 MiB app, 116 MiB ZIP, and 130 MiB DMG passed deep
  ad-hoc signature verification, ZIP entry validation, DMG CRC verification,
  bundled-sidecar execution, and SHA-256 generation. The packaged app was
  launched through macOS and reached the LINE Cheater welcome/source screen
  without loading a personal backup.
- This artifact is not Developer ID signed or notarized. Treat it as a tester
  build; do not describe it as Gatekeeper-ready public distribution.
- Peak RSS was not recorded because the sandbox denied the platform `sysctl`
  call used by `/usr/bin/time -l`. Do not infer a memory figure from this run.

Do not assume checked items are production-ready. The project must pass the
verification gates below before a release.

## CLI contract

All successful command results are JSON on stdout. Progress and warnings go to
stderr so a desktop wrapper can parse stdout safely.

```bash
# Inspect structure without reading chat content.
cargo run -p line-backup-native -- \
  inspect --source /path/to/LINE

# List the first page from the main database. The desktop uses `serve` below to
# merge source-aware main/community pages.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  chats --source /path/to/LINE --limit 100

# Resume the main-database CLI page using both CLI cursor components.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  chats --source /path/to/LINE --limit 100 \
  --after-updated 1700000000000 --after-pk 42

# Read one bounded message page.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  messages --source /path/to/LINE --chat-pk 42 --limit 180

# Search message text with a bounded result page. This initial implementation
# scans the read-only source SQLite; it does not build an FTS index yet.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  search --source /path/to/LINE --query "keyword" --limit 180

# Build/update the on-disk file catalog.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  catalog --source /path/to/LINE

# Page attachment metadata without loading attachment contents.
cargo run -p line-backup-native -- \
  attachments --catalog /path/to/work/catalog.sqlite --limit 100

# Hash only same-size duplicate candidates with fixed-size buffered reads.
cargo run -p line-backup-native -- \
  hash-duplicates \
  --source /path/to/LINE.imazingapp \
  --catalog /path/to/work/catalog.sqlite

# Page exact-content duplicate groups, then page one group's members.
cargo run -p line-backup-native -- \
  duplicates --catalog /path/to/work/catalog.sqlite --limit 100
cargo run -p line-backup-native -- \
  duplicate-members \
  --catalog /path/to/work/catalog.sqlite \
  --sha256 <digest-from-duplicates> \
  --limit 100

# Start the long-running desktop sidecar.
cargo run -p line-backup-native -- \
  --work-dir /path/to/work \
  serve --source /path/to/LINE

# Build a new candidate from an already-scanned source.
cargo run -p line-backup-native -- \
  slim \
  --source /path/to/LINE.imazingapp \
  --catalog /path/to/work/catalog.sqlite \
  --output /path/to/LINE-slim.imazingapp \
  --full-crc
```

CLI cursor components are an atomic pair. Supplying only one component is an
error. The sidecar's chat cursor additionally includes `source`; renderer code
must round-trip the complete opaque cursor. The UI must replace old windows of
data instead of accumulating every returned page.

## Sidecar protocol v1

`serve` reads one JSON request per line from stdin and writes responses/events
as JSON Lines to stdout. Each line is flushed immediately.

Ready event:

```json
{"event":"ready","protocolVersion":1,"source":{},"readOnly":true}
```

Request and success response:

```json
{"id":"42","method":"listMessages","params":{"source":"square","chatPk":7,"limit":180}}
{"id":"42","ok":true,"result":{"items":[],"nextCursor":null}}
```

Structured error:

```json
{"id":"42","ok":false,"error":{"code":"operation_failed","message":"..."}}
```

Supported methods:

- `sessionInfo`
- `listChats`
- `listMessages`
- `searchMessages`
- `scanCatalog`
- `listAttachments`
- `setAttachmentMarked`
- `stageAttachmentPreview`
- `catalogStats`
- `cleanupOverview`
- `listCleanupGroups`
- `listCleanupReviews`
- `applyCleanupGroupAction`
- `hashDuplicateCandidates`
- `listDuplicateGroups`
- `listDuplicateMembers`
- `buildCandidate`
- `shutdown`

`scanCatalog` may emit `catalogProgress` and `catalogContextProgress` events
carrying the originating `requestId`; duplicate hashing emits
`duplicateHashProgress`; `buildCandidate` emits `candidateProgress`. Input lines
larger than 1 MiB are rejected. Output pages remain subject to the 1,000-record
core limit.

Protocol v1 currently processes one request at a time. Cancellation tokens and
parallel read-only jobs are future protocol additions; add them without changing
existing method semantics. A broken stdout pipe aborts candidate construction
and removes the core-owned `.partial` file.

## Electron desktop boundary

See [`native/electron/README.md`](native/electron/README.md) for run commands,
security details, the web/native comparison, packaging expectations, and GUI
handoff gaps.

The Electron renderer runs with context isolation, sandboxing, no Node
integration, no permissions, and no arbitrary navigation. A custom local
protocol serves an allowlist of bundled assets and catalog-authorized preview
tokens. The preload exposes only source selection, a one-use candidate-output
token, a bounded attachment-preview request, allowlisted sidecar requests, and
four progress event types. The main process validates the sender and caps
request/response lines before parsing.

Development work directories are source-path-hashed subdirectories under the
Electron `userData/sessions` directory. They may contain staged SQLite and chat
metadata and therefore must be treated as private local application data.

## Bounded-memory invariants

These rules are part of the product contract:

1. Never call an equivalent of `read_to_end()` for a database, attachment, or
   archive.
2. Never return unbounded query results over CLI/IPC.
3. Never send attachment bytes through JSON. Use a bounded thumbnail endpoint or
   a native/custom protocol.
4. Never hold all backup paths in a Rust `Vec` or JavaScript array.
5. Batch catalog writes. The initial batch size is 1,000.
6. Hash files with a reusable fixed-size buffer and bounded concurrency.
7. Write output to a new `.partial` file and rename only after validation.
8. The original source is read-only and is never the output destination.
9. If WAL/SHM are present, preserve and stage them with `Line.sqlite`. Do not use
   SQLite `immutable=1` unless the snapshot has been proven frozen.
10. Do not add indexes or FTS tables to the source database. Put derived indexes
    in the work directory.

## Catalog behavior

`catalog.sqlite` is disposable derived data, not a backup.

It contains:

- `meta`: source identity and scan state.
- `files`: path, size, timestamp, attachment classification, message ID hint,
  chat path hint, persisted SQLite evidence/reference status, scan generation,
  and an optional exact-content SHA-256.
- `removal_plan`: explicit user selections only.

A catalog is bound to one canonical source path. Reusing it for another source
is rejected.

Scans commit every 1,000 records. An interrupted scan leaves valid committed
batches and `scan_status=scanning`; rerunning is idempotent. The current
implementation re-enumerates the source and upserts existing paths rather than
resuming from an exact directory cursor. Exact checkpoint continuation is still
future work. Cleanup-context schema version 2 includes companion-database titles;
older complete catalogs are reported as stale and reindexed automatically.

Duplicate hashing first selects attachment rows whose positive byte size occurs
more than once, then reads each candidate with one reusable 1 MiB buffer. Hashes
are committed every 100 files, so rerunning after cancellation resumes from
the last committed batch. Directory rescans preserve a hash only when size and
mtime are unchanged; a changed archive source fingerprint clears cached hashes.
The duplicate-group query requires equal SHA-256 and byte size, reports
reclaimable bytes as `(file_count - 1) * bytes`, and is cursor-paginated.

This checkpoint is a performance cache rather than a trust boundary. A file
that changes without changing detectable source metadata is outside the current
cache invalidation model; candidate construction still performs its independent
source and protected-core checks.

### Cleanup parity contract

These behaviors intentionally match the web implementation and are protected by
generated fixture tests:

- Nonempty main and community chats share a source-aware keyset page. A selected
  chat's `source` must be sent with every list/search message request.
- Sender ownership is native-derived from the backup account ID plus the sender
  record. A send-status flag cannot override a populated sender belonging to
  another participant.
- An attachment is `referenced` only when its path chat ID and message ID match
  exactly one message in `Line.sqlite` or `LineSquare.sqlite`.
- A valid chat/message path whose message ID does not exist in either database
  is `unreferenced`.
- A missing path component, missing message ID, duplicate exact match, or a
  message ID found in a different chat is `unconfirmed`.
- Referenced files group by chat. All unreferenced files share one special
  group; all unconfirmed files share another.
- Provider group and review pages default to 24 items and retain a 1,000-file
  safety ceiling. Electron requests four groups for the paged group list. Its
  detail album fetches 24 reviews at a time, retains at most three adjacent
  batches, and replaces discarded DOM with measured virtual spacers; source
  size therefore does not determine renderer DOM size.
- Original attachments sort before thumbnails within a bundle and retain
  independent removal checkboxes.
- `toggle_all` marks every file unless the group is already fully marked, in
  which case it clears every mark.
- `keep_thumbnail` marks originals and clears thumbnail marks. Invoking it again
  while already in that state restores the originals.

The UI filters `all/original/thumbnail/marked`, categories
`all/individual/group/community/unreferenced/unconfirmed`, sorting
`recent/oldest/size/path`, and search across chat title, sender, message text,
and attachment path. Filtered pages are queried from `catalog.sqlite`; the
renderer never materializes the complete attachment collection.

Image previews are separate from cleanup metadata. The sidecar validates the
path against the current catalog and rejects files over 16 MiB or unsupported
image signatures. Directory previews stay at their source path. Archive
previews are streamed to a source-private cache containing at most 32 files.
Electron maps the validated local file to an opaque preview token and retains at
most 128 live tokens. `listMessages` and `searchMessages` add only the matching
catalog path, byte count, and original/thumbnail kind to each bounded result;
the renderer hydrates image pixels afterward with at most four concurrent
requests.

## SQLite safety and performance

The source connection uses:

- `SQLITE_OPEN_READ_ONLY`
- `PRAGMA query_only=ON`
- approximately 64 MiB suggested page cache
- file-backed temporary storage
- a bounded memory-mapping ceiling

Message pagination is keyset-based:

```sql
WHERE ZCHAT = ?
  AND (
    timestamp > ?
    OR (timestamp = ? AND Z_PK > ?)
  )
ORDER BY timestamp, Z_PK
LIMIT ?
```

LINE schema differs by version, so query construction checks table columns
before referring to optional fields. New schema variants must be added with
fixtures and must preserve fallback behavior.

The core currently queries message counts per chat when `ZCHAT.ZMESSAGECOUNT`
does not exist. This may be slow on a database without an index on
`ZMESSAGE(ZCHAT, ZTIMESTAMP, Z_PK)`. Never modify the source to add that index;
future work should persist chat statistics in `catalog.sqlite`.

`searchMessages` applies an escaped, non-empty `LIKE` pattern to `ZTEXT`, returns
at most 1,000 rows, and uses the same `(timestamp, pk)` continuation cursor as
message browsing. This bounds response memory but may still rescan a large
message table for each page. The production search path should incrementally
copy message text into a disposable FTS5 database in the work directory, commit
in batches, bind it to the source database fingerprint, and page hits without
changing the source.

`scanCatalog` extracts numeric message ID hints from media filenames and
correlates attachment rows in 200-ID batches against both message databases.
The derived evidence is persisted in `catalog.sqlite`, so every later cleanup
page is a bounded catalog query rather than repeated source-database joins.
Missing or ambiguous context remains explicitly unconfirmed; it is never
evidence that a file is safe to delete.

## `.imazingapp` plan

Archive browsing and slimming must support ZIP64. The candidate builder should:

1. Read the central directory without extracting media.
2. Validate every requested removal path and protect `.lock`, `Line.sqlite`,
   WAL/SHM, payload metadata, and iMazing root metadata.
3. Raw-copy retained compressed entries where possible.
4. Write a new `<name>.imazingapp.partial`.
5. Emit cancellable progress based on bytes.
6. Finish ZIP64 central-directory records.
7. Verify structure/CRC and hashes of protected core entries.
8. Atomically rename to the requested candidate name.
9. Reconfirm that the source fingerprint did not change.

ZIP64 library support does not prove that iMazing accepts the exact metadata.
Keep a fixture matrix and perform iMazing restore tests before claiming
compatibility.

The initial implementation now performs these steps with the following explicit
limitations:

- `.imazingapp` inputs raw-copy compressed entries; directory inputs write
  uncompressed entries.
- Non-UTF-8 paths, entry names that cannot round-trip byte-for-byte, encrypted
  entries, duplicate entry names, and unsafe relative paths are rejected instead
  of silently rewritten.
- `--full-crc` reads the entire output after writing and therefore adds one full
  sequential pass.
- The current `zip` crate writer holds central-directory metadata in memory.
  Media bytes are streamed, but memory will still grow with the number and
  length of entry names. Add a disk-backed central-directory writer before
  claiming bounded memory for multi-million-entry inputs.
- Source archives are checked by size/mtime plus protected core hashes.
  Directory files are checked before and after each copy; additions/removals
  concurrent with traversal are not yet covered by a complete manifest lock.

## Verification gates

Run before every handoff:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix native/electron test
npm --prefix native/electron audit --omit=dev
python3 -m unittest cli.tests.test_line_migrator
git diff --check
```

Current-machine note: the Homebrew `clippy-driver --print sysroot` unexpectedly
resolves to an old Theos iPhone SDK. The 2026-07-24 Clippy gate passed only after
temporarily setting `RUSTFLAGS=--sysroot=/opt/homebrew/Cellar/rust/1.96.0`.
This is a local toolchain problem, not a repository setting; do not commit that
absolute path.

Real-data smoke tests must use ignored local inputs and a temporary work
directory. Record only aggregate counts, durations, peak RSS, and errors; never
paste chat titles, message text, account IDs, attachment names, or absolute
private paths into commits or issue reports.

The large-data acceptance test should eventually generate a sparse/synthetic
fixture rather than requiring a personal backup:

- 200 GB logical media size or a representative stress fixture.
- More than 65,535 archive entries.
- At least one file larger than 4 GB.
- Duplicate timestamps and message IDs across chats.
- WAL and SHM present.
- Cancellation and restart during catalog, hash, and candidate jobs.
- Peak RSS target under 1 GB for the native core.

## Next implementation steps

The next owner should proceed in this order:

1. Add cancellation tokens and job IDs to the existing `serve` JSONL protocol,
   including catalog, hashing, and candidate jobs.
2. Port the web cleanup-plan JSON/text exports and duplicate review UI.
   Source-aware community browsing is implemented; add cross-store coalescing
   if a future fixture contains the same normalized chat ID in both databases,
   preserving a merged chronological message stream like the web app.
3. Move chat counts into the work catalog and add a resumable FTS5 sidecar keyed
   by the source database fingerprint.
4. Manually regress directory, SQLite, and `.imazingapp` native pickers on
   macOS/Windows/Linux. The macOS arm64 bundle/sidecar is repeatable; add
   Developer ID notarization, Intel/universal builds, Windows/Linux packaging,
   and release CI.
5. Replace in-memory ZIP central-directory bookkeeping for million-entry
   archives and add cancellation.
6. Add synthetic ZIP64 stress fixtures: more than 65,535 entries, one entry
   larger than 4 GiB, restart, cancellation, and measured peak RSS.
7. Validate generated ZIP64 candidates with iMazing dry-run and restore.
8. Measure the Electron and Rust processes separately; only evaluate a Tauri
   shell if Electron's measured baseline is unacceptable.

## Handoff checklist

When handing this work to another engineer or agent:

- Read this file completely.
- Run the verification gates and record which ones pass.
- Inspect `git status`; do not delete ignored personal fixtures.
- Preserve the browser implementation and Python CLI unless an explicit
  migration removes them.
- Do not relax read-only source behavior.
- Do not increase page sizes beyond 1,000 as a performance workaround.
- Keep the cleanup shell fixed-height. If new controls need space, use
  progressive disclosure or another bounded page instead of restoring a
  document-level scrollbar.
- Update “Current implementation status” and “Next implementation steps.”
- Document any measured peak RSS and the exact synthetic fixture parameters.
- Leave source and output paths out of committed logs.
