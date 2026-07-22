# 外站票雷達

監控「外站出發」機票好價的個人工具:電腦掃 Google Flights → 找出比台北出發便宜的組合 → PWA 儀表板手機隨時看。

## 使用

| 動作 | 方式 |
|---|---|
| 掃描(輪值組) | 點兩下 `掃描-今日輪值.cmd`(偶數日=歐洲組,奇數日=澳紐冰島組,約 30 分) |
| 掃描(指定) | `掃描-歐洲組.cmd` / `掃描-澳紐冰島組.cmd` / `掃描-全部.cmd`(約 1 小時) |
| 看儀表板(本機) | `node engine\serve.js` → http://localhost:8931 |
| 看儀表板(手機) | GitHub Pages 網址(設好 remote 後掃描會自動 push) |
| 測單一航線 | `node engine\scan.js route BKK VIE business 10`(需先 `set NODE_PATH=C:\Users\ericw\AppData\Roaming\npm\node_modules`) |

## 監控矩陣(config.json 可改)

- 出發地:BKK 曼谷、MNL 馬尼拉、ICN 首爾、KUL 吉隆坡、TYO 東京 + TPE 台北(基準)
- 目的地:歐洲組 VIE/MUC/PRG(中歐自駕鐵三角)、澳紐冰島組 SYD/AKL/KEF
- 商務+經濟艙 × 10/16 天來回 × 未來約 5~6 個月(月曆視圖翻 3 頁)

## 好價判定

1. **價差**:外站價 ≦ 台北同線同月最低的 80%(`dealRatio`)
2. **絕對門檻**:`absoluteThresholds` 按區域/艙等(KEF 有獨立門檻)
- 命中→Windows 彈窗 + 寫入 `data/deals.json`(儀表板置頂)

## 架構

- `engine/tfs.js`:把行程編成 Google Flights `tfs` URL 參數(protobuf),一條 URL 直達搜尋結果,免模擬填表
- `engine/scan.js`:Playwright 開 Chromium → 讀月曆視圖每日最低價(「$X.XX萬」近似值,±500 內)→ 每完成一組即存 `data/latest.json` → 判定好價 → 更新 `data/trend.json` → 有 git remote 就自動 push
- `index.html` + `sw.js` + `manifest.webmanifest`:單檔 PWA 儀表板(好價卡/外站vs台北對照表/月曆熱圖/走勢),service worker 網路優先、離線退快取
- Playwright 裝在全域 npm(`NODE_PATH` 指到 `%APPDATA%\npm\node_modules`),Chromium 在 `%LOCALAPPDATA%\ms-playwright`,都不進 OneDrive/git
- `data/browser-profile/` 是掃價瀏覽器的 cookie/profile,**已 gitignore,不可上傳**

## 注意

- 價格是全航空最低價;長榮/華航同機經 TPE 的價格請點格子→「在 Google Flights 開啟查證」看航班明細
- 掃太頻繁可能被 Google 擋(引擎偵測到會提前中止並提示);一天 1~2 組是安全頻率
- 尚未設定 GitHub remote 時,掃描結果只在本機,`[git]` 行會提示跳過上傳

## GitHub Pages 一次性設定(待辦)

1. 登入 GitHub → 建 public repo(例如 `fare-radar`)
2. `git remote add origin https://github.com/<帳號>/fare-radar.git` → `git push -u origin main`
3. repo Settings → Pages → Branch 選 `main`(root)
4. 手機開 `https://<帳號>.github.io/fare-radar/` → 加入主畫面
