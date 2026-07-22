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
3. 在瀏覽器內搜尋聊天室、閱讀訊息，或匯出 HTML／JSON／附件清單。完整備份模式會在訊息中直接預覽可配對的圖片；若原圖不在備份內，閱讀器會改用 `Message Thumbnails` 或 SQLite 內保存的縮圖。訊息中的網址可以直接點擊，閱讀器也會使用 LINE 保存的連結 metadata 重建標題、摘要與預覽圖片；沒有 metadata 時仍會顯示網域與網址。通話紀錄會依 metadata 顯示語音／視訊通話、通話時間、未接、取消、忙線或拒接狀態。

若備份另有 `Line.sqlite-wal`／`Line.sqlite-shm`，建議使用完整備份模式，以降低遺漏最近資料的風險。

資料只會在目前瀏覽器分頁內解析，不會上傳到這個網站的伺服器。sql.js 由 jsDelivr 載入，因此首次使用需要網路連線；連結預覽圖片若來自 LINE CDN 或原網站，瀏覽器顯示圖片時也會向該圖片網址發出請求。
