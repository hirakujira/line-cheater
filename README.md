# LINE 備份閱讀器｜GitHub Pages 部署包

這個資料夾是可直接上傳到 GitHub Pages 的純前端版本。

## 上傳方式

將本資料夾內的所有檔案放到 GitHub repository 的根目錄，或放到你設定給 GitHub Pages 的發布目錄。

不要把原始 LINE 備份資料夾、`Container`、`Payload`、SQLite 檔案或個人聊天內容放進 repository。

## 使用方式

LINE iOS App Container 備份檔案可透過 iMazing 備份軟體取得；本工具不會直接操作 iMazing，只讀取你選取的備份檔案。

### 1. 閱讀與匯出

1. 開啟 GitHub Pages 網址。
2. 選擇載入方式：
   - **完整 LINE 備份**：選取整個備份資料夾，可使用附件索引、圖片預覽與本機附件連結。
   - **只讀訊息**：只選取 `Messages/Line.sqlite`。完整路徑為：
     `Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_<account-id>/Messages/Line.sqlite`
     其中 `P_<account-id>` 是備份中實際存在的 `P_` 開頭資料夾。
3. 搜尋聊天室、閱讀訊息，或匯出 HTML／JSON／附件清單。
4. 若備份另有 `Line.sqlite-wal`／`Line.sqlite-shm`，建議使用完整備份模式，以降低遺漏最近資料的風險。

### 2. 附件瘦身

附件瘦身區分為兩種輸出：

| 輸出 | 用途 | 安全狀態 |
|---|---|---|
| 瘦身操作計畫 | 匯出要移除的附件清單、容量與警告 | 可直接產生，原始檔不會變更 |
| `.imazingapp.candidate` | 以未標記檔案重新建立 ZIP 候選封裝 | 實驗性，尚未宣稱可還原 |

安全操作順序：

1. 永遠保留原始 `.imazingapp`，不要直接覆寫。
2. 先在附件瘦身區搜尋並勾選要移除的檔案；未勾選檔案預設保留。
3. 優先只測試一個 `Message Thumbnails` 縮圖，不要第一輪刪除 `Message Attachments` 原始附件。
4. 使用「匯出瘦身操作計畫」保存 JSON／純文字清單。
5. 若要使用候選封裝，按下「建立 `.imazingapp` 候選封裝」，輸出檔名會以 `.imazingapp.candidate` 結尾。
6. 只在副本上將副檔名改回 `.imazingapp`，先於 iMazing 的 **Manage Apps → Restore App Data** 執行 dry-run。
7. 確認 iMazing 接受後，才使用測試裝置驗證；不要第一輪就在主力手機還原。

候選封裝限制：

- 只保留未標記的 `Container/`、`Payload/` 與必要根目錄檔案。
- `Messages/Line.sqlite` 若不在保留集合中，封裝會中止。
- 支援 File System Access API 的瀏覽器會直接寫入檔案；其他瀏覽器對大型輸出會阻止 Blob 下載，以避免記憶體峰值。
- 候選封裝會重新建立 ZIP，可能改變 ZIP metadata；目前沒有 iMazing 實機還原保證。
- 刪除縮圖通常只會移除預覽；刪除原始附件可能導致 LINE 無法開啟媒體。

目前已用原始 `.imazingapp` 的副本完成單一縮圖安全測試：只移除 1 個縮圖，原始檔未修改，`Line.sqlite`、`.lock` 與 `Payload/LINE.app/Info.plist` 的內容雜湊相同，ZIP CRC 驗證通過。這不等於已完成 iMazing 還原驗收。

參考：[Hiraku Dev 的 LINE 瘦身說明](https://hiraku.dev/2025/09/7802/)、[iMazing App Data 備份與還原說明](https://imazing.com/guides/how-to-export-backup-and-transfer-ios-apps-data-and-settings)。

### 3. 本機 CLI（開發中）

CLI 不包含在 GitHub Pages 部署包，位於主專案 `/Users/zeuik/Desktop/line`，目前提供安全探測、staging 與 SQLite schema 檢查：

```bash
cd /Users/zeuik/Desktop/line

# 掃描來源，不讀取訊息內容
python3 -m cli.line_migrator inspect \
  --source /path/to/line-backup \
  --format text

# 建立來源外部的 staging 副本，不修改來源
python3 -m cli.line_migrator snapshot \
  --source /path/to/line-backup \
  --out /path/to/line-work/snapshot

# 以唯讀 SQLite 連線檢查 schema
python3 -m cli.line_migrator parse \
  --snapshot /path/to/line-work/snapshot \
  --out /path/to/line-work/schema-output
```

CLI 安全限制：

- `--out` 不得放在來源資料夾本身或其子目錄。
- `snapshot` 只複製 `.lock`、`iTunesArtwork`、`iTunesMetadata.plist`、`Container/` 與 `Payload/`。
- SQLite 使用唯讀 URI；目前不會執行 `INSERT`、`UPDATE`、`DELETE` 或 `VACUUM`。
- CLI 尚未提供正式 `.imazingapp` 修改、WhatsApp 匯入或 Telegram 匯入。

### 4. 隱私與網路

資料只會在目前瀏覽器分頁內解析，不會上傳到這個網站的伺服器。sql.js 與候選封裝使用的 fflate 由 jsDelivr 載入，因此首次使用需要網路連線；連結預覽圖片若來自 LINE CDN 或原網站，瀏覽器顯示圖片時也會向該圖片網址發出請求。
