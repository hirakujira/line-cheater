# LINE 備份閱讀器 CLI

CLI 位於 `cli/line_migrator.py`，適合大量 SQLite、批次搜尋、附件重複掃描、備份差異與 `.imazingapp` 候選封裝測試。它以 Python 標準函式庫執行，來源 SQLite 使用唯讀連線；所有 `--out` 輸出都應放在來源外部的新資料夾。

## 建議流程

先在網頁載入完整 LINE 備份，確認聊天資料與附件分類。需要大量或細部處理時，在 Terminal 執行：

```bash
cd /path/to/line-github-pages

# 1. 先掃描來源結構；不讀取訊息內容
python3 cli/line_migrator.py inspect \
  --source /path/to/line-backup \
  --format text

# 2. 建立來源外部的 staging 副本；原始備份不會被修改
python3 cli/line_migrator.py snapshot \
  --source /path/to/line-backup \
  --out /path/to/line-work/snapshot

# 3. 執行唯讀健檢；需要時再加 --full-integrity
python3 cli/line_migrator.py health \
  --source /path/to/line-work/snapshot

# 4. 產生瀏覽器可讀的大型分片索引
python3 cli/line_migrator.py index \
  --snapshot /path/to/line-work/snapshot \
  --out /path/to/line-work/line-reader-index \
  --batch-size 500

# 5. 驗證索引分片與來源是否仍是同一份 Line.sqlite
python3 cli/line_migrator.py verify-index \
  --index /path/to/line-work/line-reader-index \
  --source /path/to/line-work/snapshot
```

接著在 GitHub Pages 選擇「大型備份索引」，載入 `line-reader-index` 資料夾。瀏覽器只會讀取 `manifest.json`、`conversations.jsonl` 與選取聊天室的 `messages/chat-*.jsonl`，不會把原始大型 `Line.sqlite` 轉成 JavaScript `ArrayBuffer`。

`verify-index` 回報 `passed` 才適合交給網頁使用；若來源 SQLite 在建立索引後被替換或修改，或同一個 `Messages/UnifiedGroup.sqlite` 被更新，會回報 `source_status: stale`，請重新建立索引。索引會從 `ZUSER`、`UnifiedGroup.sqlite` 的 `ZUNIFIEDGROUP`、`ZGROUP` 與聊天室時間軸中最新的改名系統訊息取得聊天室名稱，並保留 `titleSource`；仍無法確認時會顯示 unresolved，不使用成員資料拼接名稱，也不把 ID 當成名稱。

索引輸出會包含 `conversations.jsonl`、`participants.jsonl`、`attachments.jsonl`、`reports/warnings.json`、`reports/verification.json`，以及 SQLite 支援時的 `search.sqlite`。`manifest.json` 會為這些 artifact 記錄 bytes／SHA-256，並記錄每個訊息分片的列數、時間範圍、bytes／SHA-256、來源 schema fingerprint 與 timestamp unit；`verify-index` 會逐一驗證 artifact 與訊息分片。附件索引只保存相對路徑、大小、雜湊與 SQLite 脈絡，不複製媒體。

若 `index` 中途被中斷，保留同一個輸出資料夾並加上 `--resume` 即可從 `.progress.json` checkpoint 繼續；來源 `Line.sqlite` hash 或 schema fingerprint 改變時，續跑會停止並要求新輸出路徑。

## 常用命令

```bash
# 只載入單一資料庫時，先確認 capability
python3 cli/line_migrator.py capabilities --database /path/to/Messages/Line.sqlite

# schema 報告與遮罩後的限量 sample；同時區分 declared foreign key 與 inferred candidate relation
python3 cli/line_migrator.py schema \
  --database /path/to/Messages/Line.sqlite \
  --out /path/to/line-work/schema.json

# 全域搜尋，輸出 JSONL；可用聊天室、傳送者、content type、時間區間與結果上限篩選
python3 cli/line_migrator.py search \
  --database /path/to/Messages/Line.sqlite \
  --query "關鍵字" \
  --chat-pk 1713 \
  --sender-pk 42 \
  --content-type 0 \
  --from-timestamp 1700000000000 \
  --to-timestamp 1700086399999 \
  --out /path/to/line-work/search.jsonl

# 產生時間間隔／訊息高峰的啟發式事件
python3 cli/line_migrator.py timeline \
  --database /path/to/Messages/Line.sqlite \
  --out /path/to/line-work/timeline.jsonl

# 串流計算附件 SHA-256，找出 exact duplicate；不會刪檔
python3 cli/line_migrator.py duplicates \
  --source /path/to/line-work/snapshot \
  --out /path/to/line-work/duplicates.json

# 比較兩份資料庫／備份；跨備份 ID 不穩定時會標示 unresolved／inferred
python3 cli/line_migrator.py diff \
  --left /path/to/line-work/snapshot-a \
  --right /path/to/line-work/snapshot-b \
  --out /path/to/line-work/diff.jsonl

# 以 keyset pagination 讀取單一聊天室；先用 schema／索引確認 ZCHAT.Z_PK
python3 cli/line_migrator.py messages \
  --database /path/to/Messages/Line.sqlite \
  --chat-pk 1713 \
  --batch-size 500 \
  --out /path/to/line-work/chat-1713.jsonl
```

`index` 在 SQLite 支援 FTS5 時會另外產生 `search.sqlite` sidecar；它只保存搜尋用索引，沒有複製媒體。`manifest.json` 會記錄來源 `Line.sqlite` SHA-256、分片列數、時間範圍與 sidecar 狀態。

`timeline` 會先偵測秒／毫秒／微秒時間尺度，再用秒數套用 gap／burst 門檻；輸出同時保留 `timestamp_raw` 與換算後的秒數。`diff` 對跨備份重新產生的 `ZID` 會嘗試以聊天室／傳送者身份、時間、content type 與文字 hash 做保守 inferred 配對；低可信度結果會標成 `ambiguous` 或 `unresolved`，不直接稱為刪除。

## 安全的 `.imazingapp` 瘦身測試

```bash
python3 cli/line_migrator.py slim-test \
  --source /path/to/LINE.imazingapp \
  --out /path/to/line-work/LINE-slim.imazingapp.candidate \
  --entry 'Container/.../Message Thumbnails/<thumbnail-file>' \
  --report /path/to/line-work/slim-test-report.json
```

預設只允許移除 `Message Thumbnails`。移除 `Message Attachments` 原檔必須明確加上 `--allow-original-attachments`。CLI 會驗證 ZIP CRC、指定 entry 確實移除、核心 entry SHA-256 未變更與原始 `.imazingapp` 未變更；候選檔仍不是 iMazing 還原保證，請保留原始檔並先做 dry-run。

## 大型檔案原則

- 20 GB 以上的原始 SQLite 不要選進 GitHub Pages 的「只讀訊息」模式。
- `snapshot` 需要額外磁碟空間；若空間不足，至少先對原始資料做唯讀 `health`／`index`，不要在來源內輸出結果。
- CLI 的批次處理會使用 `fetchmany()`；瀏覽器索引模式則一次只讀一個分片。這改善記憶體峰值，但不代表所有 LINE 版本 schema 或 SQLite 損壞情況都能自動修復。
- `health --full-integrity` 與 `.imazingapp` 還原仍可能耗時；請先在副本執行。

完整介面與附件瘦身說明請回到 [README.md](README.md)。
