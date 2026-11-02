# OCTA 4.0 大改款規格（已完成，留作架構說明）

目標：1) 完全脫離雲端伺服器，純本機運作  2) 介面全面改版  3) 操作流程簡化  4) 程式架構重整。版本 4.0.0。

## 不變的原則
- 功能保留（機器人、群組、分區、例行任務、記憶/技能、核准、檔案、瀏覽器、通知 Telegram/LINE、手機遠端、程式任務、多語、自動更新）。
- 唯一使用者是 `local`。沒有帳號、登入、註冊、密碼、裝置清單、重設碼、主機切換、搬家、雲端排程、教練連結。
- 手機遠端保留：Cloudflare quick tunnel（cloudflared，使用者自己電腦開的通道，不是我們的伺服器）＋ 8 碼配對碼。手機開同一個 app，未配對時顯示配對畫面。
- 自動更新照舊走 GitHub Releases。
- 外部 webhook（routines.hook，`/api/hook/<key>`）：只在通道開著時可用，經 remote port 進來，不需配對（hook key 本身是秘密）。
- 舊雲端使用者：桌面版 4.0 第一次啟動時，若舊設定 mode==='cloud' 且有 runnerToken，用既有 `host/export` 一次性把雲端資料搬回本機（先備份），之後永遠本機。mode==='host' 直接改本機（資料本來就在）。

## 新目錄（擁有者）
- `app/`（UI 路）：網頁介面。`app/index.html` + `app/css/*.css` + `app/js/*.js`，i18n-core.js、i18n-dict.js、圖示、manifest、buddy.png、changelog.json 一起搬來。不能有任何對 octa.yzprojecttw.com 或雲端 API 的依賴。
- `desktop/api/`（API 路）：本機 API，`desktop/api/index.mjs` 匯出 `onRequest({ request, env, params: { path } })`（簽名與舊 functions/api/[[path]].js 相同），內部拆成多個模組。從 `functions/api/[[path]].js` 複製後刪掉雲端專用部分：signup/login/logout/password/reset*/devices*/runner-token/host/*/cron/coach*/hostInfo/hostOf/主機轉送/雲端排程 sched 選項/多帳號 auth（me 固定為 local；配對用 env.pairCheck 照舊）。import 共用模組用 `../lib/*.mjs`。
- `desktop/runner/`（執行器路）：從 `public/octa-runner.mjs` 拆成多個模組，`desktop/runner/index.mjs` 重新匯出原本所有 export（startRunner、ENGINES、findChrome、buildPrompt…測試用到的全部）。`octa-browseruse.py` 一起搬。拿掉只給雲端/獨立執行用的部分（命令列主程式、octa-runner.json token 檔、雲端網址），與本機 API 仍用 loopback HTTP 溝通（協定不變）。
- `desktop/lib/`（執行器路）：model-route.mjs、connectors.mjs、coding-runtime.mjs、coding-policy.mjs 從 public/ 搬來。
- `desktop/main.mjs`、`server.mjs`、`preload.cjs`、`splash.html`、`build.mjs`、`package.json`（桌面路）：永遠本機；移除 cloud/host 模式、hostLink、雲端登入橋接；server 用 `./api/index.mjs`、執行器用 `./runner/index.mjs`；build.mjs 把 `app/` 複製成 `desktop/web/`（開發時也可直接讀 ../app）；package.json files 加 `api/**`、`runner/**`、`lib/**`、`cloud-import.mjs`。`host-mode.mjs` 只留 importFromCloud → 改名 `desktop/cloud-import.mjs`。
- `site/`（桌面路）：octa.yzprojecttw.com 改成單頁下載介紹頁（說明已改純本機、下載桌面版、舊雲端資料第一次開桌面版會自動搬回）。wrangler.toml pages_build_output_dir 改 `site`。
- `functions/`（桌面路）：凍結的舊雲端 API，只為了讓舊使用者把資料搬回本機（host/export）。把它需要的 model-route/connectors 複製到 `functions/_lib/`，修 import。不再被桌面版使用。`.github/workflows/cron.yml` 刪除。
- `public/` 最後刪光。

## 測試
- `node --test test/*.test.mjs`。改版前基準：201 項，7 項原本就失敗（#2,#5,#16,#137,#173,#174,#185）。
- 各路更新自己負責檔案相關的測試 import 路徑；UI 路把讀 index.html 文字的 UI 測試改寫成對新介面有意義的檢查。不准用刪測試來變綠，刪除的功能（帳號、主機模式等）其測試可移除。
