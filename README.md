# LINE Cheater

LINE iOS App Container 備份的本機瀏覽、分析與保守瘦身工具。支援純網頁版、Python CLI、Rust CLI 與 Electron 桌面版。所有來源備份都以唯讀方式開啟，候選輸出必須另存，不會覆寫原始檔。

**網頁版：<https://line-cheater.gginin.de>**

## 選擇使用方式

| 工具 | 適合情況 | 說明 |
|---|---|---|
| 網頁版 | 快速查看、匯出與附件審核 | 在瀏覽器本機讀取完整備份、單一 SQLite 或大型備份索引。 |
| Python CLI | 大型 SQLite、批次分析與可驗證的索引輸出 | 使用 Python 標準函式庫，支援 snapshot、health、index、search、diff 與 slim-test。 |
| Rust CLI | 有界記憶體的本機資料處理 | 提供聊天、訊息、搜尋、catalog、標記與候選檔建立能力。 |
| Electron 桌面版 | 大型備份的圖形介面與進階清理 | 以 Rust sidecar 處理 `.imazingapp` 或解開的備份資料夾；目前有 macOS arm64 DMG 與 Windows x64 ZIP 發布流程。 |

詳細命令與架構文件：

- [Python CLI](CLI.md)
- [原生 core 架構、限制與驗證紀錄](NATIVE.md)
- [Electron 開發、封裝與安全邊界](native/electron/README.md)

## 網頁版快速開始

LINE iOS App Container 備份可透過 iMazing 取得。本工具不會控制 iMazing，只讀取你選擇的本機檔案。

1. 開啟網頁版。
2. 選擇一種來源：
   - **完整 LINE 備份**：選取整個備份資料夾，可使用附件索引、圖片預覽與本機附件連結。
   - **只讀訊息**：選取 `Messages/Line.sqlite`。典型路徑為 `Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_<account-id>/Messages/Line.sqlite`。
   - **大型備份索引**：使用 Python CLI 產生 `line-reader-index` 後選取其資料夾，避免把超大 SQLite 載入瀏覽器記憶體。
3. 瀏覽聊天室與訊息、搜尋、匯出 HTML／JSON／附件清單，或進行附件審核。

若備份包含 `Line.sqlite-wal` 與 `Line.sqlite-shm`，請優先選擇完整備份模式，以降低遺漏最近資料的風險。

網頁版也提供完整性檢查、時間軸、Schema Explorer、SQLite 差異比較、附件 exact duplicate 掃描與進階搜尋篩選。

## 附件瘦身

附件會依訊息與路徑證據分組，並交叉讀取 `Line.sqlite`、`LineSquare.sqlite` 與 `UnifiedGroup.sqlite`。聊天室名稱優先使用資料庫中的名稱與改名系統訊息，不會用成員名單拼接名稱。

| 狀態 | 意義 | 建議 |
|---|---|---|
| `referenced` | 附件路徑中的聊天室 ID 與 SQLite 訊息唯一相符 | 審核縮圖、傳送者、時間與摘要後再決定。 |
| `unreferenced` | 路徑 ID 有效，但主資料庫與社群資料庫都沒有對應訊息 | 人工確認後才可標記。 |
| `unconfirmed` | 路徑、訊息 ID 或聊天室的對應關係不可靠 | 預設保留，不應視為孤兒檔案。 |

原始附件與縮圖可以分別標記，未勾選的檔案會保留。「只保留縮圖」只會標記已確認為圖片、且同一訊息有非空縮圖的原檔。PDF、影片、缺少縮圖、空縮圖與無法確認類型的附件都會保留。

### 安全操作順序

1. 保留原始 `.imazingapp`，不要直接覆寫。
2. 先匯出瘦身操作計畫，保存 JSON 或純文字清單。
3. 第一次僅測試少量 `Message Thumbnails`，不要直接移除 `Message Attachments` 原始附件。
4. 建立新的 `LINE-slimmed-<時間戳>.imazingapp`。
5. 在測試裝置以 iMazing 的 **Manage Apps → Restore App Data** 驗證後，再考慮主力裝置。

網頁版候選檔曾成功透過 iMazing 還原並正常開啟 LINE，但不同備份規模與附件組合都應自行先在測試裝置驗證。重新建立 ZIP 可能改變 ZIP metadata；來源備份必須持續保留。

支援 File System Access API 的桌面版 Chrome／Edge 會直接寫入輸出檔。其他瀏覽器對超過 256 MB 的輸出會阻止 Blob 下載，避免記憶體峰值。

## CLI 與大型備份

Python CLI 不需額外套件，適合建立備份外部的 snapshot、唯讀 health 檢查與可驗證的分片索引：

```bash
python3 cli/line_migrator.py inspect --source /path/to/line-backup --format text
python3 cli/line_migrator.py snapshot --source /path/to/line-backup --out /path/to/line-work/snapshot
python3 cli/line_migrator.py index --snapshot /path/to/line-work/snapshot --out /path/to/line-work/line-reader-index
python3 cli/line_migrator.py verify-index --index /path/to/line-work/line-reader-index --source /path/to/line-work/snapshot
```

完整流程、`search`、`timeline`、`schema`、`duplicates`、`diff`、`messages` 與 `slim-test` 說明請見 [CLI.md](CLI.md)。所有 `--out` 輸出應放在來源備份以外的新資料夾。

Rust CLI 可從專案根目錄建置：

```bash
cargo build -p line-cheater
```

它是 Electron 桌面版使用的 sidecar，也可直接在本機執行。命令與行為細節請見 [NATIVE.md](NATIVE.md)。

## Electron 桌面版

桌面版適合處理大型 `.imazingapp` 或解開的備份資料夾。它以 sandboxed renderer、受限 IPC 與 Rust sidecar 分離介面和檔案處理，來源保持唯讀。

```bash
cargo build -p line-cheater
npm --prefix native/electron ci
npm --prefix native/electron test
npm --prefix native/electron run dev
```

macOS 12 以上的 Apple Silicon 測試封裝可在 macOS 上重複建立：

```bash
native/electron/scripts/package-dmg.sh
```

已有依賴時可設定 `SKIP_NPM_CI=1`。沒有簽章 secrets 時輸出為 ad-hoc 簽章；GitHub Actions 可使用 passwordless `MACOS_CERTIFICATE_BASE64` P12 與 `MACOS_SIGN_IDENTITY` 進行 Developer ID 簽署，但仍需另外完成 notarization。Windows x64 ZIP 由 [Windows GitHub Actions workflow](.github/workflows/build-windows.yml) 建立與驗證；目前未配置 Windows code signing。請參考 [Electron package 說明](native/electron/README.md#macos-package)。

桌面版提供聊天與訊息瀏覽、受限原圖預覽、附件清理、完全相同附件審核，以及受保護的進階模式。重複附件以檔案大小與 SHA-256 分組，標記前會要求至少保留一份。進階模式可規劃移除選定聊天室及其附件，或掃描空聊天室、僅含系統訊息的聊天室與沒有對應聊天列的 `LineSquare` 訊息。SQLite 只會在新建候選檔中重寫與 `VACUUM`，原始資料庫不會被修改。

原生候選檔已以實際 iMazing 還原流程驗證；不同備份規模與附件組合仍應先在測試裝置驗證，來源備份也必須持續保留。

## 隱私與網路

- 網頁版在目前瀏覽器分頁解析資料，不會將備份上傳到本站伺服器。首次使用會從 jsDelivr 載入 sql.js。
- 開啟 LINE CDN、原網站圖片或連結預覽時，瀏覽器會向該網址發出請求。
- Electron 會在本機使用者資料目錄建立 session staging SQLite、`catalog.sqlite` 與聊天 metadata。它們屬於私密資料，請保護本機帳號與磁碟。
- 不要把備份、`Container`、`Payload`、SQLite、候選檔、工作目錄、聊天室內容或帳號識別資訊提交到 Git repository。

## GitHub Pages 部署

只部署追蹤中的網頁靜態檔，例如 `index.html`、`app.js`、`styles.css`、圖片與需要的 Pages 設定。不要把整個本機工作目錄直接上傳，也不要把備份、封裝檔或建置輸出放到發布目錄。

## 限制

- 超大 SQLite 不應使用網頁版的「只讀訊息」模式，請先建立大型備份索引或使用桌面版。
- 桌面版在來源完成完整驗證後使用工作目錄內可重建的 FTS5 搜尋索引；若
  FTS5 不可用會退回有界的 `LIKE` 掃描。CLI `search` 維持唯讀 `LIKE` 介面。
- ZIP 媒體處理採串流，但 central directory metadata 仍會隨檔案數量增加。
- catalog 建立、搜尋索引、雜湊與候選檔建立支援 job ID；取消會安全重建
  sidecar，目錄掃描與重複檔案雜湊可從已提交 checkpoint 繼續，候選 ZIP 則
  會從頭重建。catalog 同時保存每個檔案的串流內容指紋，因此同大小同
  mtime 的內容替換也會被辨識；舊 catalog 需重新掃描建立指紋。

參考：[Hiraku Dev 的 LINE 瘦身說明](https://hiraku.dev/2025/09/7802/)、[iMazing App Data 備份與還原說明](https://imazing.com/guides/how-to-export-backup-and-transfer-ios-apps-data-and-settings)。
