# LINE 備份閱讀器｜GitHub Pages 部署包

這個資料夾是可直接上傳到 GitHub Pages 的純前端版本。

## 上傳方式

將本資料夾內的所有檔案放到 GitHub repository 的根目錄，或放到你設定給 GitHub Pages 的發布目錄。

不要把原始 LINE 備份資料夾、`Container`、`Payload`、SQLite 檔案或個人聊天內容放進 repository。

## 使用方式

LINE iOS App Container 備份檔案可透過 iMazing 備份軟體取得；本工具不會直接操作 iMazing，只讀取你選取的備份檔案。

1. 開啟 GitHub Pages 網址。
2. 選擇載入方式：
   - 完整 LINE 備份：選取整個 LINE 備份資料夾，可使用附件索引與下載連結。
   - 只讀訊息：從備份根目錄找到並只選取 `Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_<account-id>/Messages/Line.sqlite`；其中 `P_<account-id>` 是備份中實際存在的 `P_` 開頭資料夾，不載入附件。
3. 在瀏覽器內搜尋聊天室、閱讀訊息，或匯出 HTML／JSON／附件清單。
4. 完整備份模式的「附件瘦身」可搜尋、分頁並勾選不要的附件，匯出 JSON 操作計畫與純文字操作說明。原始備份與 `Messages/Line.sqlite` 不會被修改。

附件瘦身目前是供人工執行的安全清單，不是已驗證可直接還原的 `.imazingapp`。請先複製原始 `.imazingapp`，再用支援原地編輯壓縮檔的工具處理副本；保留 `Container`、`Messages/Line.sqlite` 與所有未列出的檔案。完成後可在 iMazing 的 Manage Apps → Restore App Data 先做 dry-run，再考慮於測試裝置還原。參考：[Hiraku Dev 的 LINE 瘦身說明](https://hiraku.dev/2025/09/7802/)、[iMazing App Data 備份與還原說明](https://imazing.com/guides/how-to-export-backup-and-transfer-ios-apps-data-and-settings)。

若備份另有 `Line.sqlite-wal`／`Line.sqlite-shm`，建議使用完整備份模式，以降低遺漏最近資料的風險。

資料只會在目前瀏覽器分頁內解析，不會上傳到這個網站的伺服器。sql.js 由 jsDelivr 載入，因此首次使用需要網路連線。
