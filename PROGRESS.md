# OCTA 進度

> 部署規則：使用者 2026-10-22 指示「以後自動推上線」；2026-10-27 再指示「以後一律發布桌面版」— 每次改完測試通過就直接合併 main、推送並跑 desktop.yml 發布（git proxy 擋 tag，用 gh workflow run desktop.yml）。

## 雲端版（octa.yzprojecttw.com）
- [x] 前端（E·ROOM 金黑風格）、多帳號、Pages Functions + D1
- [x] 執行器 v4 `public/octa-runner.mjs`：可匯入的 startRunner()、最多 3 個並行、每個機器人獨立 Chrome（Playwright MCP）、截圖、遠端開瀏覽器
- [x] 分區 + 同分區互問、例行任務、範本
- [x] 核准按鈕（✅待確認：…）、附件（files 表）、分區資料 / 共用資料、Telegram / LINE 通知、工作紀錄
## 桌面版（desktop/）
- [x] server.mjs：sql.js 本機資料庫（D1 相容包裝）、共用同一份 API 與網頁、內建執行器、localhost 防 CSRF / DNS rebinding
- [x] 手機遠端：cloudflared 快速通道 + 8 碼配對碼（10 次錯誤自動換碼）
- [x] main.mjs：Electron 視窗、系統匣、電腦通知、開機自動啟動、內建 Playwright MCP（用 Electron 當 Node）
- [x] electron-builder NSIS 打包成功（Linux+wine 與 GitHub Actions windows-latest 皆成功，run 39585548610）；推 v* 標籤或手動觸發 workflow 可重打包
- [ ] 在真正的 Windows 上實測安裝檔（尚未）
- [ ] 手機遠端通道實測（沙盒內無法連 trycloudflare）
## 多 AI 引擎
- [x] bots.engine（claude / codex / gemini）；執行器 v5 依引擎呼叫 claude -p、codex exec（-c 注入 Playwright MCP）、gemini -p --yolo（.gemini/settings.json）
- [x] 任務設定可選 AI 引擎；設定指引顯示 Codex / Gemini 安裝狀態
- [x] 執行器 v6：再加 copilot、cursor(agent)、qwen、opencode；bots.model 選填；長提示寫入 octa-task.md 給吃參數的 CLI
- [ ] 各家真實帳號實測（沙盒只驗證到參數 / 設定檔解析：codex、opencode、copilot）
## AI 連線（易用性）
- [x] 執行器 v7 回報已安裝的 AI（users.engines）；連線測試工作（jobs.kind='test'，jobs.result）
- [x] 「AI 連線」頁：每個 AI 的適合對象、費用、安裝／登入步驟、複製按鈕、測試；桌面版一鍵安裝並登入（開終端機跑腳本）
- [x] 設定指引改為：連上電腦 → 連接 AI → Chrome → 建機器人 → 試跑；機器人 AI 選單顯示已連接狀態
## 流暢度與多語
- [x] 送出即顯示（樂觀更新）、依忙碌調整輪詢、只在內容變動時重繪、未讀數徽章與分頁標題、草稿保存、輸入框自動長高、新訊息按鈕、貼上／拖放附件、複製訊息、時間戳、搜尋（Ctrl+K）、Esc 關閉、提示訊息、動畫（尊重減少動態）
- [x] 多語：i18n-core.js 以字典翻譯畫面文字（[data-u] 使用者內容不翻）；en / ja 手寫、zh-CN 由 OpenCC 轉換；範本依語言建立；機器人依語言回覆（settings.lang）
- [x] 執行器 v8（回覆語言）
- [x] 機器人頭貼可選 Emoji（bots.avatar；24 個常用 + 自訂；範本附預設頭貼）
## 桌面版 2（帳號同步、效能）
- [x] 桌面版預設登入雲端帳號：視窗載入 octa.yzprojecttw.com，preload 橋接（octaDesktop），登入後自動取得本機專屬執行器金鑰（label desktop:主機名）並在主程序執行；可切換離線模式（本機 SQLite）
- [x] runner-token 依 label 分開，不會把其他電腦的金鑰作廢
- [x] 效能：AI 工具偵測改非同步並快取（原本 spawnSync 會卡住整個程式）、本機資料庫存檔改 3 秒批次
- [x] YZ 進度條：啟動畫面（splash）、網頁載入遮罩、操作中頂部進度條，重要操作期間鎖住畫面
## 自動更新
- [x] electron-updater（GitHub Releases，latest.yml）：啟動 8 秒後與每 6 小時檢查；左上角「更新」→ 下載進度 → 重新啟動並更新；設定可手動檢查
## 使用我的 Chrome
- [x] bots.browser='mine'：Playwright MCP --extension 連使用者真正的 Chrome（已登入網站、已儲存密碼），每個機器人自己的分頁群組；extension token 只存在本機（desktop.json / octa-runner.json extToken）；執行器 v9
## v2.0（2026-10-22）
- [x] 主機制：每帳號一台主機電腦執行（users.host，第一台連上的自動當主機），其他電腦待命；設定 → 電腦與主機可切換、移除
- [x] 即時推送：users.rev 變動計數＋/api/wait 長輪詢（25 秒）；執行器 runner/next 也長輪詢（有工作 <1 秒接到）
- [x] 資料庫寫入只在有變動時：主機心跳每 4 分鐘寫一次（sessions.seen）
- [x] 例行任務雲端／電腦排程（settings.sched，預設雲端）；/api/cron 由 GitHub Actions 每 5 分鐘呼叫，順便清理舊資料
- [x] 檔案存在主機電腦：上傳先暫存 chunks，主機收下後刪雲端；檢視時 want → 主機上傳暫存片段；截圖、輸出也存電腦；Google 雲端硬碟 / 自選資料夾（desktop/store）
- [x] 訊息依對話分頁載入（/api/messages），state 只給清單預覽與未讀
- [x] 裝置清單、密碼移除、改密碼、重設碼（已登入裝置產生或傳到 Telegram/LINE）、登入限流（logins 表）、90 天未用自動登出
- [x] 桌面版登出可保留工作；重新登入沿用執行器金鑰（runner/hello 比對帳號）
- [x] 每個裝置的瀏覽器通知；設定改選單；最新版本頁（public/changelog.json）；更新橫幅「看更新內容」
- [x] AI 連線：各家擅長、剩餘流量（Claude OAuth usage、Codex app-server rateLimits；其他顯示今日次數）；Ollama 取代付費 API
- [x] 測試：API 腳本 31 項、執行器假 CLI 端對端、網頁 UI、Electron 雲端模式（登入、登出保留、重新登入沿用）、離線模式舊資料庫遷移
- [ ] Windows 實機、Ollama / Codex 剩餘流量實機驗證
## 待辦
- [x] 公版清理：範本改通用（助理、研究、門市、民宿），移除個人化字樣；加入「設定指引」（無機器人時自動開啟，可試跑）；README 重寫
- [x] 倉庫已公開；Release v1.5.0 自動發布 OCTA-Setup.exe（固定網址 releases/latest/download/OCTA-Setup.exe）
- [x] 網頁版首頁（未登入顯示）：介紹、下載按鈕、三步驟、功能、支援的 AI、常見問題
## v2.2.0（2026-10-22 已上線：網站＋桌面版 Release）
- [x] 例行任務事件觸發：網頁監看（runner/watches、runner/watched，CDP 背景讀頁比對雜湊）、外部事件網址 /api/hook/<key>（LINE events 解析、合併待處理工作、限流）；⏰ 標記支援「監看 url」「外部事件」
- [x] Grok 引擎（官方 Grok CLI）；Grok Bot 引擎（grok-bot-cli / gbot）＋帶入機器人（grokbot/list、kind=list 工作）
- [x] 測試：webhook、監看、gbot 假 CLI 端對端、UI（觸發表單、帶入）、API 31 項
- [ ] 實機：Grok CLI / Grok Bot App 登入、LINE webhook 真實呼叫

## 2026-10-23 2.5.2–2.5.6
- 群組：無 @ 時成員並行處理、無關的回「（略過）」並隱藏；規則含「輪流/依序/接力」才依序。成員可 @問、@交接。
- 外部交接：Grok Bot 首席 POST hook → Claude助理 實測成功（約 30 秒）；對話顯示交接者與內容。
- 共用登入：job 開始時也從其他機器人「開著的」瀏覽器抓 cookies（2.5.3）。
- Ollama：關 grep/glob（ripgrep 缺）、給 octa-task.md 絕對路徑。
- 機器人可自己點「已記住帳號」登入；需密碼仍停下。
- LINE 測試：Claude、Gemini 已傳給 yzz；ChatGPT 要使用者輸入 LINE 密碼；Ollama 待 2.5.6 重試。
- 待辦：Grok Bot CLI 匯入（app 不寫 gateway-descriptor.json）；Claude 週額度剩 3%（10/26 重置）。
- 2.6.0：背景互通（私聊中 @同事 → 對方自己對話跑 〔背景:id:ask|give〕，結果 🔁 回傳；ask 會叫回原機器人）；24 小時待命 = 例行任務「待命巡查」*/N，不發系統訊息、（略過）隱藏；同事清單改全部機器人。
- 2.7.0：備援 AI（bots.fb、jobs.eng，QUOTA 錯誤→下一個）；瀏覽器 --window-name＋profile 名稱/主題色；群組依「之後/然後」依序；所有引擎給 octa-task.md 絕對路徑；agy 英文旁白過濾；cookie host-only 用 url 設定。
- 2.8.0：群組提問側窗（#askp，回覆=@bot）、無@回答回給發問者（asksUser，你們/大家除外）、聊聊/討論→輪流、st.spent 記住額度用完到 reset、瀏覽器留在桌面（cascade，不最小化/不移出畫面）、【回覆】標記切掉工作旁白。
- 2.9.0：tagScript 加即時游標（mousemove/mousedown/keydown/focusin）；playwright-mcp 加 --caps vision（browser_mouse_click_xy）；網站操作步驟提示；🗺️網站筆記 → st.sites 共用注入 prompt。
- 2.9.3：dayInfo（今天/昨天/明天＋住宿分類規則、搜尋前幾天）、workNotes（bots/<id>/工作筆記.md 自動注入 prompt，機器人自行維護）。待查：Grok Bot 對同問題的回答（使用者中止電腦操作）。
- 2.9.5/2.9.6：無年份日期當今年、疑點另列不整份拒給；自動接續（（自動接續 n）最多 2 次）；codex model_reasoning_effort=high。貳宿首席已設任務並移入兩館每日作業。比對結論：Grok 有記憶/新鮮度判斷/eroom 對照/做幾分鐘；OCTA 目前只剩 ChatGPT Free 可用（Antigravity、Claude 額度皆用完）。

## 2026-10-26 3.0.35
- Cloudflare 警告原因：runner 每 1.5s 上傳 ≤500KB 即時畫面到 D1（CPU 超限）、網頁每 1.2s 拉 live/<bot>、進度每 4s bump rev 讓所有畫面重抓 /api/state（D1 讀取超量）。修正：live.watch（有人看才傳；沒看每 6s peek）、live?since 不重傳、users.prog 進度計數 + /api/busy、wait 1.5s、jobs 保留 14 天、ensureSchema 一次 batch。
- 公版通用：runner 移除住宿寫死規則，改放「民宿」範本分區資料；空任務機器人只做交代的事。
- 3.0.36：Grok 風格：rail 改 搜尋/＋ 選單，quickBot 直接建立（📛名稱 自動命名＋emoji）；輸入列整條圓角；我方實心泡泡；A/B 卡片（optText 去重）；小八 SVG 章魚（moods idle/hi/listen/work/done/ask/err/sleep、眼睛追游標、選單：工作中/待回覆/未讀/快速動作）。

- 3.0.37（10/27）：內嵌瀏覽器碰到 accounts.google.com 登入頁 → desktop googleBlocked 記 cfg.realChrome[botId]、停掉內嵌、runner switchToChrome 改開真 Chrome（機器人專屬 profile）到 ServiceLogin?continue=；之後該機器人一律用 Chrome 視窗。runner v17.20
- 3.0.38（10/27）：教練連結 /api/coach/<key>（sessions kind=coach 存 sha，auth 不接受）：GET 說明+清單、bot/<id>、ask(feedback)、job/<id>?wait、teach(remember/skill/task)、hire、inbox?since。設定 AI 連線加「讓 Grok Bot 當教練」區塊（/api/coach GET/POST/DELETE）。
- 3.0.39（10/27）：⏰刪除／停用／啟用：名稱（runner/done 處理，conv 或 bot 的例行任務，模糊比對單一命中）；runner/next 對提到例行/刪/停用的 chat 工作附 ROUTINE_SELF 說明（舊執行器也有效）；runner v17.21 prompt；coach routine 端點。
- 3.0.40（10/27）：登出原因：內嵌 Storage.setCookies 直接把 CDP 格式丟給 Electron（缺 url、expires 欄名不同→網域 cookie 設定失敗、其他變成工作階段 cookie）、sameSite 名稱互不相容、syncIn 用舊 jar 蓋掉自己的新登入、session cookie 重開即消失。修：electronCookie 轉換＋session cookie 存 30 天（keepLogins）、flushStore（設定後/停止/關閉）、syncIn 先 syncOut 自己、cookieParams 正規化 sameSite。Electron 實測重開後保留。runner v17.22
- 3.0.41（10/27）：登入卡片的「繼續」改 data-resume（關接手＋送短句），不再 data-retry 重送上一則指示。
- 3.0.42（10/27）：對照 Grok（分工/存檔/記憶）：browseRounds 報告存 bots/<id>/紀錄/<日期時間> <事>.txt（30 天），prompt 加 records()：用程式算、比對前幾天、有今天紀錄就不重捲、糾正即 📌記住。runner v17.23。待做：工作中仍可回聊天（背景讀取）。
- 3.0.43（10/27）：檔案儲存「套用」id stGo 與登入列「繼續」重複→改 stApply（原本點套用無反應，且開過儲存頁後登入列繼續會被蓋成套用）。
- 3.0.44（10/27）：job 732（09:09「我有教你怎麼撈補助嗎」）卡 10 分鐘無 progress：warm=-1 的 Claude 待機 session 從 06:41 閒置，電腦睡眠後連線卡死、stdin 寫入無回應且無逾時。加 turnWithWatch（首個事件 3 分、中途靜默 6 分→中止，重開完整 prompt 重試一次）、WARM_STALE 20 分閒置即重開。runner v17.24

## 2026-10-27 3.1.0（四個代理並行開發後合併）
- 可靠性：jobs.err_kind/err_msg/shot/retry_of；失敗分類（model-route.mjs FAIL_KINDS）、可重試類型自動重試 ≤2 次（第 2 次附原因換方法）、失敗截圖、最終失敗 Telegram sendPhoto 通知、工作紀錄原因＋看截圖＋↻重試（logs/retry）；prompt 加交件前自我核對。
- 主動性：bots.autonomy（auto/report/ask）、📋計畫＋✅待確認「照計畫執行」、bots.stood（有指定任務自動開 30 分待命一次）、jobs.via＋/api/backstage「🔁 幕後 N 則」；群組 @ 最長名稱比對、@交接不重複接棒、「私下」走背景互問、runner/done 重送去重（status='running' 條件更新）；名稱不能有空白（舊名提示）。
- 記憶與成長：規則／📇事實／📘手冊（≥3 步）分段注入；stats 表＋/api/board 成果看板；每週自我檢討（review/run、✅待確認：更新規則 → 核准直接寫入）。
- 介面：瀏覽器小卡（WebContentsView）遇對話框讓開、可縮小圓點（desktop.json 記住）、訊息底部留空；電腦與主機「很久沒連線／從未連線」可清除、版本較舊提示；新範本 排程發訊／資料整理／網站監看／遊戲自動化。
- i18n/build.py 已改成只替換 TEMPLATES_I18N 區塊；build 要用 opencc-python-reimplemented（系統 OpenCC 1.4 轉出的簡體不同）。
- 測試：新增 reliability、proactive、memory-board、ui-fixes；既有 7 項失敗（appearance-ui 2、cdp-bridge 1、phone-ui 1、studio-aim 3）與 main 相同。
- 實機基準（升級前，群組 123456）：並行 OK；接力時 2 被觸發兩次；機器人公開 @「claude 測試用」對方沒反應；小視窗擋訊息；一句自我介紹約 81K tokens（群組 prompt 偏大，待評估精簡）。
- 實機發現：群組互問後兩個機器人用 @ 互相「收到／好喔」來回 5 輪（燒 token）→ mentionAsks()：道謝/確認類、回答給發問者的 @ 不開新一輪（有？才算新問題）。
- 實機（測試4）：交接後 2 回報時 @ 回 claude測試用 又開一輪 → 回報給交接者也不算新問題（除非有？）。
- 3.1.0 已發布：網站（main）＋桌面版 Release（workflow_dispatch desktop.yml；git proxy 擋 tag push，改用 gh workflow run）。使用者電腦已自動更新到 3.1.0。
- 升級後實測（群組 123456）：接力＋@交接 只跑一次、幕後 N 則顯示、私下互問只回一句話、不再互相道謝來回、新執行器回報做事權限「做完告知」、瀏覽器小卡可縮成 🌐 圓點且開對話框時讓開。
- 待辦：群組 token 偏高（今天約 1.1M），評估精簡群組 prompt（歷史 30 則、規則全塞）；小圓點仍會略蓋到訊息右緣。

## 2026-10-27 3.1.1
- 省 token：claude 加 --tools（只載入 WebFetch,WebSearch,Read,Write,Edit,Glob,Grep,Bash；瀏覽器輪只 Read）＋ --disable-slash-commands，依 `claude --help` 偵測支援才加（leanFlags）。沙盒實測「只回一個字」：原本 ~46.9K（cache 建立 15.5K＋讀 31.4K）→ 20.7K。
- 群組 prompt：歷史只取最近 GROUP_HISTORY=14 則，舊訊息截 300 字、最近 4 則上限 1500 字（範例 16.5K→11.4K 字元）。
- 注意：OCTA 顯示的 tokens = input+output+cache 建立+cache 讀取（cache 讀取實際成本約一成），數字看起來偏大。
- 對話泡泡移除 draggable（拖到別的機器人複製的功能拿掉），桌面可直接選取文字；觸控裝置維持長按選單。
- 3.1.1 已發布並更新使用者電腦。實測群組「各用一句話自我介紹」：每個機器人約 19.2K tokens（成果看板差值），升級前約 40.5K，少約 53%。

## 2026-10-27 3.1.2（只更新網站）
- 手機版（≤760px）獨立版面，Grok Bot 風格：清單分區標題＋圓頭貼＋預覽、全螢幕對話頁、⋯詳細資料頁、底部圓角輸入列（＋選單、打@才跳成員）、核准按鈕 2×2、小八移到頁首、設定/任務設定全螢幕頁、pushState 返回。桌面版不變（只修 .tw 動畫誤套到表格）。截圖 /home/claude/octa-ref/mobile-after/。
- 未在真手機測 iOS/Android 鍵盤與滑回。

## 2026-10-27 3.1.3
- 實機：12:00 後多個機器人「執行逾時」、之後全部「排隊中」。原因：spawnCli 逾時用 child.kill()，Windows shell:true 只殺到 cmd，claude.exe＋Playwright MCP 成為孤兒、握著 stdout，close 不觸發 → 3 個 slot 永遠被占（實機看到 11:56、12:26、13:12 三個 claude -p 仍在跑）。修：taskkill /t /f 整組、exit 後 5 秒/kill 後 10 秒保底 resolve、QUIET_MS=8 分鐘無輸出即中止（訊息含「很久沒有回應」→ timeout 自動重試）。
- 根因未明：瀏覽器那一輪的 browser_snapshot（讀取網頁內容）為何卡住（推測 LINE 頁面有彈窗/凍結）。

## 2026-10-27 3.1.4
- 14:05 Cloudflare 通知 D1 每日 500 萬列讀取用完（UTC 0 點＝台灣 08:00 重置，期間雲端版全部報錯）。分析：/api/state 每次變動每台裝置都讀，其中今日 token 統計 `jobs WHERE user_id AND created>=` 無可用索引→整個帳號的 jobs 全掃（約 1600 列）＋未讀 300 列。修：新增索引 job_created(user_id, created)（MIGRATIONS＋ensureSchema 用 INDEXED BY 探測）、未讀改 LIMIT 100。待辦：明天用 meta.rows_read 實測各端點；同帳號其他 D1 專案（E·ROOM、到班）也共用 500 萬額度。

## 2026-10-27 3.2.0 主機模式（資料存主機）
- 雲端：users.hmode/hurl/hkey/hseen＋host_hooks；/api/host/register|export|activate|deactivate；hmode=1 時非白名單（CLOUD_ONLY）請求以 HMAC 簽章（x-octa-user/ts/sig）轉送到主機 quick tunnel，主機回 x-octa-host on/off/bad；連不上回 503 hostOffline；session＋host 資訊 isolate 快取 60 秒（每請求 ≤1 次 D1 讀）；cron 略過主機帳號；待命電腦 runner/* 回 standby。
- 主機：desktop/host-mode.mjs（簽章驗證、hostHandler、importFromCloud、hostLink 心跳 10 分）；cfg.mode=host 視窗載入本機 server；遷移 octa:host-move（備份→暫存庫逐表分頁→驗證→替換→activate→補抓訊息）、octa:host-back。
- 前端：hostOffline 頂部提示 5→10→30→60 秒退避；設定→電腦與主機 搬移／改回按鈕。
- 修 schema.sql retry_of 行逗號寫在註解裡（新庫的 via 被吃成型別名稱）。
- 未實測：Electron IPC 搬移流程、真實 cloudflared、Worker→trycloudflare、手機畫面。待 D1 額度重置（台灣 08:00）後在使用者電腦實際搬移。風險：quick tunnel 網址會變（心跳 10 分重註冊）、Workers 免費每日 10 萬請求。

## 2026-10-28 3.2.1
- 主機模式已在使用者電腦生效（08:43 搬移、備份 ebot.backup-20261028-004314.sqlite），雲端 08:42 後無新資料。
- 瀏覽器「僅觀看｜取得控制權」：透明擋板 WebContentsView（browser-shield.html）蓋頁面，滾輪由主程序程式捲動；控制時各分頁設 window.__octaUser=true，tagScript 隱藏游標；取得控制＝接手（hand）、回僅觀看＝繼續（go，只在需要時送繼續訊息）；工具列接手/繼續按鈕移除。xvfb＋Electron 以 XTest 實測擋板與游標；完整 main.mjs 未實跑。
- 已知：桌面重開後面板預設僅觀看，但伺服器若仍記接手中會不一致。

## 2026-10-28 3.3.0（Grok Bot 評論逐點升級，三代理合併）
- 介面：不自動切對話（提示條＋傳給：）、trackDirty/leaveOk 單一儲存、核准卡 apprDecision＋待核准數＋approvalNag 15 分鐘通知、例行任務 last/next 顯示、群組成員狀態列、state 加 ask/gask。
- 排程與記憶：routines.prompt 必填、routines.last_run/last_status/last_job/last_text、jobs.routine、next_run、routineTarget（內容寫貼到群組→在群組跑）、splitTaskSchedules（📝 時間句搬到例行任務）、tidyOnce 一次性整理（✅待確認：整理排程）、scheduleAsk/correctionAsk 補救待確認（建立排程／記住規則，ownApproval 直接處理）。
- 執行：旁聊（busyTurn/sideKind，jobs.via k=side，不打斷主工作）、API 優先、自行登入一輪＋loginHints/hideSecrets、結果行（missingResult 提醒）、findUploads＋MCP --allow-unrestricted-file-access、群組補位 prompt、本機模式 bump 即時喚醒（送出→拿到工作 767ms→4ms）、執行器背景回報額度。Claude 主回合 allowedTools 加 Bash。
- 未實測：真實 AI 是否照新規則、自行登入實際網站、Windows 旁聊並行、tidyOnce 首次會發幾則。

## 2026-10-28 3.3.1
- 20:09 實機：OCTA 無法啟動 ERR_ADDRESS_IN_USE (-147) loading 127.0.0.1:17777。查到整台電腦 TIME_WAIT 15.5 萬（443 埠 9.5 萬），Honeygain 同時開 3196 條連線 → 臨時埠用光，OCTA 連自己的本機頁都開不了。修：main.mjs loadLocal() 遇暫時性連線錯誤以 1→30 秒退避重試最多 12 次並顯示說明，不再跳錯誤框。根因在 Honeygain，需使用者決定是否暫停／限制。

## 2026-10-28 3.3.2
- 15 分鐘上限改設定 settings.jobMax（15/30/60/120/180，預設 60）→ job.maxMin → 執行器 ctl.maxMs（spawnCli 與 agy --print-timeout）；jobs.beat（runner/progress 心跳每分鐘最多寫一次）；伺服器卡住判定改為 IFNULL(beat,started) 超過 20 分鐘或總時間超過 jobMax+5 分。test/job-time.test.mjs。
- 修：3.3.2 第一次推送時 runEngine 內誤用不在範圍的 job（Claude 一般執行會 job is not defined），測試抓到後已取消該次桌面建置並修正再發布。

## 2026-10-29 3.3.3
- 映日所（教練建立）因 Google 登入被 3.0.37 機制永久切到真 Chrome。改：googleRefused 只在 /signin/rejected 或「瀏覽器可能不安全」才切；realChrome 改記 {at,why,stay}；returnToEmbed（讀 Chrome profile cookies→electronCookie→內嵌，SID/__Secure-1PSID 判斷已登入；啟動後第一次開瀏覽器或偵測到新登入時自動改回；15 分鐘內再被擋設 stay）；跨站 iframe/worker 也套標準 Chrome UA 與 client hints；CDP /json/version 回 Chrome 身分；runner/note；介面「改回內建瀏覽器」。
- 修 loadLocal 等待中視窗關閉的 null 錯誤、startThumbs 的 webContents undefined。
- 未實測：真實 Google 是否接受、Windows DPAPI cookie 讀取。
## 2026-10-29 3.3.4
- [x] 執行器每分鐘檢查 `ollama list`，有新模型就立即回報模型選單（原本 30 分鐘才更新）
## 2026-10-29 3.3.5
- [x] 長的系統訊息（超過 70 字或多行）摺疊成一行重點，點擊展開
## 2026-10-30 3.3.6（四個機器人回報）
- 診斷（筆電舊主機 DB 備份）：10:55～15:43 沒有任何 runner/next（電腦睡眠／執行器卡住），15:43 一次補做 16 件；例行任務的執行 prompt 含「例行任務」＋時間，schedulesFromTurn 每次跑都從自己的 prompt 建新排程（亂碼排程、刪了又建回來的原因）。
- 修：desktop powerSaveBlocker（主機不睡）、powerMonitor resume 與 pollAge>4 分重啟執行器；runner api 全部加時限（runner/next 75 秒）、首次 runner/next 帶 boot → 伺服器把 running 的工作 continueJob（interrupted，接著做）；stale 逾時也改接著做；retryPrompt timeout/interrupted 每次都附「不要重做重傳」。
- 部分結果：turnWithWatch 收集文字、單件工作時限也在待機 session 生效；中止時【中止前已完成的部分】→ runner/done 先貼出再重試。
- 排程：schedulesFromTurn 忽略例行任務執行／同事／重試／刪除類指示；非 userTurn 不建排程；splitTaskSchedules 不搬「不要/取消」句；sameRoutine 同時間＋名稱或內容重疊視為同一個；routineName 去掉結尾編號；整理排程預覽列出會建立的名稱與時間。
- 通用規則 SAFE_WORK_RULES（dayInfo）：搜尋框找對象、找不到不改傳、先查傳過沒、先傳附件、資料表逐字比對、寫回前讀最新、只用 API、做一件記一件。
- Google「目前無法登入帳戶」視為拒絕；教練連結主機未接上回 503，不給雲端舊資料；coach group rename/delete。
- 測試 test/host-care.test.mjs 8 項；全套失敗仍是原本 7 項。
- 未實測：真實 Windows 睡眠阻擋、resume 重啟、各機器人是否照新規則；E·ROOM 的部分欄位寫入要靠 E·ROOM API 本身支援。

- 3.3.7（2026-10-31）：Ollama 卡住根因＝OpenCode 每次指令約 16–18K tokens，octa-ctx 只有 4K/8K，server.log 顯示 truncating input prompt → 2050。OLLAMA_NUM_CTX 改 24576（舊 octa-ctx 標籤會自動重建）。8GB 顯卡跑 qwen3 會稍微溢出到 CPU，較慢但能完成。
- 3.3.8（2026-10-31）：Ollama 瀏覽改走 browser-use（public/octa-browseruse.py，pin 0.13.14，venv 在 work/browser-use，CDP 連機器人自己的瀏覽器、keep_alive、use_judge=False、num_ctx 走原生 /api/chat）；mine（使用者 Chrome 擴充）或未安裝好時仍走 OpenCode+Playwright。ollama show 讀 Capabilities：無 tools 直接回說明；預設模型挑 tools＋vision。沙箱以假 Ollama＋Chromium 實測橋接通過；使用者 Windows 實機尚未驗證。
- 3.3.9（2026-10-31）：DESKTOP-R6E41UN 只有 Python 3.14＋uv 0.13 → setupBrowserUse 有 uv 就 uv venv --python 3.12＋uv pip install；系統 Python 限 3.11–3.13。沙箱實測 uv 流程可裝 browser-use 0.13.14。
- 3.4.0（2026-11-01）：使用者反映 Claude 額度用很快。runEngine 的 Claude 分支沒指定模型時帶 --model sonnet（CLAUDE_DEFAULT_MODEL），選單標示「預設 sonnet，較省額度」；執行器 19.2。查證：當天 OCTA 無工作、教練連結建立後未使用，額度主因是使用者自己的長對話。
- 3.4.1（2026-11-01）：一鍵壓縮對話。POST /api/compact（只限單一機器人、≥6 則、沒在工作）→ 加 sys「壓縮中」並派 via {k:'compact',from} 的工作（COMPACT_PROMPT：📌記住 + 目前進度）；runner/done 成功後刪 id<from 的訊息並留摘要；執行器 19.3 壓縮完關掉 AI 待機 session。UI：標題列 🗜 壓縮（手機隱藏，改在詳細資料頁）、更多選單、/壓縮對話。test/compact.test.mjs。複製機器人不帶記憶（未改）。
- 3.4.2（2026-11-01）：主機模式顯示「手機遠端」（原本只在離線模式）。同一條 quick tunnel，未簽章請求走配對碼，配對 session 為 local 使用者＝主機資料。host-server.test 加假 cloudflared 驗證配對後看得到主機機器人、關掉不影響主機通道。教練連結仍走雲端（未改）。

## 4.0.0 大改款（2026-11-02）
- 規格見 REDESIGN.md：純本機、介面改版、流程簡化、架構重整（app/、desktop/api、desktop/runner、desktop/lib、site/）。
- [x] 桌面：永遠本機，移除雲端/主機模式；3.x 雲端帳號第一次啟動自動搬回（cloud-import.mjs，先備份，失敗可重試）；hook 經通道免配對；site/ 下載頁；functions/ 凍結只留 host/export（任何該帳號桌面金鑰可匯出）；cron.yml 刪除
- [x] API：desktop/api/ 19 個模組，移除帳號/主機/雲端排程/教練/xfer 等端點
- [x] 執行器：desktop/runner/ 16 個模組、desktop/lib/；移除命令列入口與 token 檔
- [x] 介面：app/（index.html＋css/＋js/ 18 檔），淺/深色、兩步驟引導、建機器人只要名字、設定單頁七區、手機配對畫面；docs/screens/ 截圖
- [x] 測試 217 項，剩 4 項舊有失敗（browser-return refused、runner prompt 三項）；沙箱實測 新介面→API→執行器→真 Claude 回覆 26 秒
- 未實測：Windows 實機安裝 4.0、3.x 雲端帳號實際搬家、Electron 主程式完整跑

## 4.1.0 章魚頭像＋右側工作面板（2026-11-02）
- [x] 刪掉小八（buddy.js、buddy.png、設定開關、CSS、字串、測試）
- [x] 所有機器人頭像改成使用者提供的 OCTA 章魚（app/avatar/*.svg 轉成 app/js/avatar.js 內嵌 SVG＋app/css/avatar.css），五種狀態：待命（沒工作）、思考（剛開始、還沒進度）、工作中、操作瀏覽器（進度是瀏覽器動作或開瀏覽器工作）、交流（在回覆其他機器人的背景請求，busy.bg）。側欄只有非待命的會動；prefers-reduced-motion 全部靜止；SVG 內沒有 id
- [x] 每個機器人可選顏色：14 色調色盤（預設金 #D6B27A 第一），建立與詳細資料都用色票格（鍵盤可操作）；bots.color 欄位、POST/PUT 驗證（調色盤或 #RRGGBB）；範本機器人各給一色；群組用成員頭像疊起來
- [x] 右側可收起工作面板（工作／瀏覽器／詳細資料），收起狀態記在裝置；≥1181 欄位可拖寬、761–1180 浮在對話上、手機整頁
- [x] 對話只留對話：你的訊息、機器人回覆、圖片檔案、核准卡、提問、登入請求。系統訊息、背景互問（幕後）、失敗、重試、例行任務紀錄移到「工作」時間軸；messages.kind（bg/fail/note）讓未讀與預覽不算這些；機器人工作時對話只顯示「…」，送出鍵變停止鍵；失敗在輸入框上方一行小提示（查看／重試）
- [x] 桌面版：octaDesktop.dock(rect) → main 把機器人的內嵌瀏覽器放進面板「瀏覽器」分頁（embed-layout dock 模式），收起、換分頁、對話框或選單蓋到時隱藏；僅觀看／取得控制權照舊；嵌入框跟著淺色。xvfb 下 Electron 實測過（docs/screens/desktop-electron-browser-docked.png）
- [x] 瀏覽器分頁預留 #webCtl 給 4.2 手機遙控
- [x] 測試 226 項（新增 test/work-panel.test.mjs），剩原本 4 項舊有失敗
- 未實測：Windows 實機、真的 AI 工作時的瀏覽器狀態切換、高 DPI／縮放下的 dock 位置、手機實機

## 4.2.0 手機遙控機器人的瀏覽器（像 Grok Bot 手機版，2026-11-02）
- [x] 即時畫面：desktop/screen-cast.mjs 用 CDP Page.startScreencast（JPEG 60、依手機螢幕×DPR 決定大小、每張 ack），內建瀏覽器（經 cdp-bridge）和 Chrome 視窗兩種都支援；收不到 screencast 時改每 0.8 秒截圖；換頁/操作後 1 秒沒新畫面就再要一次。只在有人看時傳：離開分頁（/bye）或 30 秒沒人要畫面就停
- [x] 傳輸：長輪詢 GET /api/screen/<bot>?after=<seq>，有新畫面立刻回 JPEG 本體（x-octa-seq / x-octa-meta / x-octa-handed 標頭），沒變就 204。走原本的 API 路徑（配對驗證、通道），不另開 WebSocket。本機實測 57–60 fps、伺服器到手機約 2 ms、點擊到新畫面約 50–90 ms（Chrome 模式；內建瀏覽器剛接手時多等到 0.7 秒）
- [x] 接手後操作：POST /api/screen/<bot>/input（tap / scroll / text / key: Enter、Backspace、Tab）、/nav（go / back / reload），必須先接手（live.handed），每個機器人限流 20 次/秒；Chrome 視窗用 CDP Input.*，內建瀏覽器改用 Electron sendInputEvent（收在背景的頁面也收得到，CDP 滑鼠事件會掉）
- [x] 接手／我好了沿用 handoff ＋「登入好了，繼續剛才的工作」流程（跟電腦上「僅觀看／取得控制權」同一套判斷）；handoff 會呼叫 env.onHandoff → 頁面 window.__octaUser、電腦的開關跟著切換；電腦切換時手機從 x-octa-handed 知道
- [x] 手機介面（app/js/screen.js）：瀏覽器分頁滿版畫面、網址列（可改→前往）、上一頁、重新整理、點擊漣漪、單指拖曳＝捲動、雙指縮放/移動只放大手機上的畫面（座標換算 pure.js scrMap：置中留白、DPR、手機縮放、頁面縮放）、打字列（送出＝insertText、隱藏文字）、刪除/下一格/Enter/貼上、安全區、不會捲動或縮放 OCTA 本身
- [x] 需要你登入：手機通知點下去直接開這個機器人的瀏覽器分頁、「接手」閃動提示；Telegram/LINE 通知在手機遠端開著時附「用手機接手」連結（…/#web=<bot>，未配對的手機配對後也會打開）
- [x] 遠端埠權限：/api/screen/* 要配對，操作要接手；/api/runner、/api/desktop 仍 403；手機的點擊不會讓其他畫面重抓（NO_BUMP）
- [x] 測試：test/phone-remote.test.mjs（座標換算、CDP 指令、串流開始/跟著分頁/改截圖/30 秒停、輸入限流、遠端權限、Electron 輸入、介面）
- [x] 實測：xvfb 下 Electron（內建瀏覽器收在背景）＋ Playwright 手機 390×844 透過遠端埠配對：畫面、點按鈕、打字、Enter 送出表單、刪除、捲動、雙指縮放後點擊、網址列、上一頁、我好了；也測過 server.mjs ＋ 真 Chromium（Chrome 視窗模式）。截圖 docs/screens/phone-remote-*.png（淺/深色）
- 未實測：真手機經真的 trycloudflare 通道（延遲、iOS Safari 的手勢與鍵盤）、Windows 實機、內建瀏覽器的頁面縮放（Ctrl+＋）時的座標、「使用我的 Chrome」（不支援，照舊顯示說明）

## 4.3.0 兩台電腦一份資料：主機電腦／遙控器（2026-11-03）
- [x] 角色：desktop.json `link.role` 'host'（預設）／'remote'（`{hostId, hostName, token, lastUrl, secret, epoch}`）。遙控器的本機伺服器把頁面的 /api/* 轉送到主機的通道網址並自己加上電腦金鑰（金鑰不進頁面、清掉瀏覽器資料也不會掉）；/api/config 回 `via`；自己的執行器不跑，自己的資料庫不動（當備份）
- [x] 連一次：設定 → 電腦 →「讓另一台電腦連進來」產生連線碼（`網址#octa-link=8碼`，10 分鐘、一次有效、猜錯 10 次作廢）；另一台在設定或第一次使用畫面貼上 → POST /api/link/pair → sessions.kind='computer'（不過期，主機可移除）＋共用的 32 位元組連線密鑰
- [x] 找回主機：有連結的電腦時主機開機就開通道，網址變了或每 6 小時把 AES-256-GCM 加密的 {url, epoch, hostId} 發到 ntfy.sh（topic 由密鑰導出）；遙控器先試 lastUrl（/api/link/hello），不行再讀 ntfy.sh 最新訊息、解密、驗證後重連（5→60 秒退避）。ntfy.sh 連不到時顯示說明並可貼上新網址。desktop/host-link.mjs（純函式，fetch 可注入）
- [x] 遙控器畫面：側欄「遙控 主機名稱」＋連線狀態、連不到時上方提示「連不到主機電腦，重新連線中…」；需要主機本機的功能改走遙控方式（瀏覽器分頁用 4.2 即時畫面＋接手，不嵌入；檔案經 API 下載；一鍵安裝 AI 改「在電腦上安裝」；檔案資料夾、Chrome、手機遠端顯示要到主機設定）
- [x] 換成這台當主機：主機暫停執行器、拒絕寫入（503）→ 資料庫快照分段下載（4 MB，SHA-256）→ 核對每個資料表筆數 → 檔案資料夾 1 GB 以內一起搬（超過則說明要手動複製）→ 先備份自己的資料庫再換上 → 開通道 → 通知原主機（commit）→ 原主機改當遙控器、新主機 epoch+1 發布。任何一步失敗：還原資料庫、關通道、abort，原主機繼續；原主機 10 分鐘沒動靜自動恢復；中途當機下次開機依 `link.switching` 完成或還原；ntfy 上 epoch 較大的主機為準，舊主機看到就停手
- [x] 端點：/api/link/pair、hello、bye、handover/begin（要 computer 金鑰＋confirm）、handover/db、files、file（要 ticket）、commit、abort；/api/desktop/link（本機設定頁）；遠端埠：電腦金鑰在手機遠端關閉時也能用，舊主機對電腦金鑰回 409 moved
- [x] 測試 test/host-link.test.mjs：連線碼、加解密與 ntfy 輪詢（假 fetch）、lastUrl 失效→ntfy→新網址、兩個真的 startServer（A/B 不同資料夾、遠端埠直連、假 ntfy）：配對、轉送、job 排在 A、ntfy 找回、ntfy 掛掉＋貼網址、移除、交接中拒絕寫入與取消、換主機成功（檔案也搬）、換回途中失敗復原
- [x] 實測：xvfb 下兩個 Electron（不同 HOME，OCTA_TEST_TUNNEL=direct 用遠端埠當通道，**真的 ntfy.sh**）：連線、B 看到 A 的機器人、B 傳訊息在 A 排工作、瀏覽器分頁即時畫面、A 關掉時 B 顯示提示、A 重開自動重連、B 換成主機（A 自動改當遙控器）、B 換了埠重開後 A 經 ntfy.sh 8 秒找回。截圖 docs/screens/pc-*.png
- 未實測：真的 trycloudflare 通道（網址變動、Cloudflare 錯誤頁判斷）、Windows 實機、大檔案資料夾經通道的速度、兩台不同版本混用

## 4.4.0 手機遠端不用每次重新配對（2026-11-03）
- 問題：主機電腦重開 OCTA 後手機遠端是關的（`remote.on=false`），quick tunnel 網址也換了，每支手機都要重新配對。
- [x] 手機遠端記住開關：desktop.json `phoneRemote`（Electron 經 hooks.getPhoneRemote/setPhoneRemote）。true＝開機自動開通道並打開手機遠端；false＝使用者關掉（關掉＝所有手機連不進來，但配對保留，再打開不用重配）；沒設定（4.4 以前）＝還有 90 天內用過的手機就自動打開。每分鐘檢查一次，通道斷了自己再開。配對碼每次開機換新，只給新手機用。releaseTunnel 不會在手機遠端開著／正在開時關掉通道（開機時與 4.3 的 keepTunnel 互相競爭的問題）
- [x] 固定入口 `https://octa.yzprojecttw.com/go`（`site/go.html`＋`site/go-core.js`＋`site/go.webmanifest`，純靜態）：
  - 主機設定的 QR／連結：`/go#tp=<topic>&k=<手機金鑰>&h=<主機 id>&n=<名稱>&u=<目前網址>&c=<配對碼>`，全部在 fragment，不會送到任何伺服器；/go 存進自己的 localStorage 後把 fragment 從網址列拿掉
  - 找主機：讀 ntfy.sh 同一個 topic（4.3 的 topicOf(連線密鑰)）的最新訊息，用手機金鑰 `phoneKeyOf(secret)=sha256('octa-phone:'+secret)` 解密（AES-256-GCM，與 host-link.mjs `seal` 同格式，WebCrypto 版放在 go-core.js，測試在 Node 互通）；確認 hostId、epoch/時間最新；`/__octa_ping` 回 `x-octa-host`、`x-octa-phone`（CORS *）；ntfy.sh 不通時試上次的網址
  - 第一次（帶配對碼）：/go 跨站 `POST <網址>/api/pair`（只對 OCTA 網站來源開 CORS）換到這支手機自己的 token；之後每次打開直接 `location.replace(<網址>/#t=<token>&go=<…/go>)`，app 收下 token、記住 /go 位置、清掉 fragment
  - 第一次會顯示「設定好了」＋加到主畫面的說明（iPhone Safari 分享 → 加入主畫面；Android Chrome ⋮ → 加到主畫面）；主機沒開：「主機電腦沒開或沒連上網路，開機後會自動連上」每 10 秒再試；手機遠端被關：說明要在主機打開；沒存資料：教你到主機掃 QR；「忘記這台電腦」。zh-TW 為主，en/ja/zh-CN 跟手機語言；淺／深色跟系統
  - manifest `display: browser`（iOS 加到主畫面的網頁 App 會有自己空的儲存空間，改成用 Safari 打開才讀得到 /go 存的資料）
  - 只記一台主機：掃另一台的 QR 就換成那台
- [x] 手機只拿到由連線密鑰單向導出的手機金鑰：讀得到給手機的那份（網址），讀不到也偽造不了給電腦的那份；主機只要手機遠端開著就發布（沒有連結電腦也會，第一次需要時才產生連線密鑰）
- [x] App：已經在 app 裡用配對碼配對的手機，配對後跳「把 OCTA 加到手機主畫面」→ `GET /api/phone/go` 拿資料組 /go 連結；設定 → 手機遠端（手機上）也有這個按鈕。從 /go 來的 app 連不到時（電腦重開、網址失效）自己回 /go 找新網址（一分鐘最多一次）
- [x] 主機設定 → 手機遠端：開關、/go 的 QR 與加到主畫面說明、已配對的手機（iPhone／Android 手機…、最近使用、配對日期、移除＝立刻登出）、或手動輸入網址＋配對碼、外部事件。`/api/desktop/phones`（只在本機）；session 的 seen 改成 15 分鐘更新一次
- [x] Telegram／LINE 的「用手機接手」連結改成 `/go#web=<bot>`（只帶機器人 id），電腦重開後也能用
- [x] 測試 test/phone-go.test.mjs 7 項：Node seal ↔ WebCrypto unseal（兩個方向、竄改、錯的密鑰）、手機金鑰只讀得到自己那份、/go 找主機（ntfy → ping → 上次網址、別台、關掉、ntfy 掛掉）、fragment 解析與 app 端 octaFrag/goLink、/go 頁面與 manifest、兩次以上 startServer（假 cloudflared，每次新網址）：開關記住、重開自動打開並發布新網址、token 重開後仍有效、4.4 以前沒設定時有手機就打開、關掉後重開維持關、CORS、移除後 401。全套 246 項，失敗只剩原本 4 項
- [x] 實測（沙箱）：site/ 用本機靜態伺服器（/go → go.html）、主機 server.mjs（OCTA_TEST_TUNNEL=direct）、**真的 ntfy.sh**、Playwright Chromium 手機 390×844：開 QR 連結 → 配對 →「設定好了」→ 打開 OCTA 已登入；主機換埠重開（新網址）→ ntfy.sh 0.6–1.7 秒有新網址 → 開著的舊 app 分頁自己回 /go 並在約 5 秒內回到新網址；重開 /go 0.4 秒進 app 不用配對；`/go#web=<bot>` 打開那個機器人；主機關掉 → 提示＋倒數，主機回來 10 秒內自動進 app；主機移除手機 → app 回配對畫面；app 內用配對碼配對 → 提示 → /go 設定 → 回 app。截圖 docs/screens/phone-go-*.png、host-phone-remote-qr-*.png（舊的幾張桌面截圖改成 256 色以維持資料夾 3 MB 以下）
- 未實測：真手機（iOS Safari 的 7 天未使用清除 localStorage、加到主畫面後是否用 Safari 打開、Android Chrome 捷徑）、真的 trycloudflare 通道（網址失效時 Cloudflare 錯誤頁）、Cloudflare Pages 上 `/go` 對應 go.html 與 fragment 是否保留（Pages 預設會這樣處理，未部署驗證）、Windows 實機、換主機（4.3 handover）後手機仍需重新配對（手機 session 不搬）

## 4.5.0 一鍵清除這台電腦的 OCTA 資料（2026-11-03）
- [x] 設定 → 進階最下面的危險區「清除這台電腦的所有資料」（app/js/wipe.js）：列出會刪除（機器人、群組、對話、例行任務、記憶、設定、附件與輸出檔案、各機器人的網站登入狀態、連結的電腦與手機）與不會刪除（電腦上的 AI 工具與帳號，例如 Claude Code 的登入；OCTA 本身；開機自動啟動的設定）。只在桌面版 App 裡顯示（`window.octaDesktop`），手機看不到；遙控器電腦上也有，說明只清自己的資料、不影響主機
- [x] 確認對話框：輸入「刪除」才能按（也接受 删除／DELETE／削除、全形；伺服器同樣檢查）；「先備份一份到 <文件>」預設勾選；檔案資料夾是自選的（不在資料夾內，例如 Google 雲端硬碟）時多一個「也刪除檔案資料夾 <路徑>」預設不勾並說明
- [x] 備份（desktop/wipe.mjs makeBackup）：`<文件>/OCTA-備份-YYYYMMDD-HHMM/`（en/ja/zh-CN 用 OCTA-backup／バックアップ／备份；同一分鐘再做加 -2）放 ebot.sqlite、desktop.json、files/（檔案資料夾 1 GB 以內；超過只放資料庫和設定，說明.txt 寫檔案在哪）、還原說明。位置：app.getPath('documents')（Linux 沒有 XDG 時改用 ~/Documents），不行再用下載、家目錄。備份失敗就什麼都不刪、執行器恢復
- [x] 清除流程（main.mjs wipeComputer/runWipe）：POST /api/desktop/wipe（只在本機埠；遠端埠 /api/desktop/* 一律 403）→ 停執行器 → 備份 → 回應頁面（顯示備份位置 1.5 秒）→ 視窗換成啟動畫面 → 關掉所有機器人瀏覽器與內嵌瀏覽器 → server.wipeShutdown()：遙控器對主機 bye（主機移除這台的連結，主機資料不動）；有連結電腦的主機經 ntfy.sh 發一則加密的「gone」訊息（host-link.mjs publishGone）→ 遙控器狀態 `gone`、不再重試、顯示「主機已清除資料」；關通道與手機遠端、關資料庫 → 先寫 `wipe-pending` 標記 → 每個 `persist:octa-bot-*` 分區與預設 session 的 clearStorageData＋clearCache → 刪資料夾內容（保留 Chromium 的 Singleton*/lockfile；Windows 被占用的檔案重試）→ app.relaunch＋exit → 入門畫面
- [x] 下次啟動最開頭（取得單一執行鎖之後、讀設定之前）：有 `wipe-pending` 就把標記裡列的資料夾清乾淨（重試等舊程序結束）、刪標記；舊版 E·BOT 資料夾清空後也移除；開機自動啟動維持使用者原本的選擇（標記帶 autostartChosen）；載入後跳一次原生對話框「已清除這台電腦的 OCTA 資料」＋備份位置＋「打開備份資料夾」（依清除時的介面語言）
- [x] 清除後 cfg 不再寫回（避免視窗位置等計時器把舊設定寫回 desktop.json）；安全檢查：不會清除磁碟根目錄、家目錄（或它的上層）、文件／下載等系統資料夾
- [x] 測試 test/wipe.test.mjs 8 項：確認字、備份內容（資料庫、設定、檔案、超過上限、同分鐘、語言）、清除（鎖檔保留、自選檔案資料夾預設保留、勾選才刪、危險路徑拒絕）、下次啟動完成標記、gone 訊息（手機金鑰讀不到、findHost/遙控器狀態不重試）、端點（錯的字不動作、遠端埠 403、其他網站 403）、三個真的 startServer（遙控器清除只 bye、主機資料不變；主機清除後遙控器變 gone）。全套 254 項，失敗只剩原本 4 項
- [x] 實測：xvfb 下 Electron（HOME 指到暫存資料夾，claude 有裝所以機器人真的開了內嵌瀏覽器），建立 2 個機器人與對話、檔案資料夾改到自選的「Google Drive/OCTA」→ 從介面輸入「刪除」清除：~/Documents/OCTA-備份-… 有 ebot.sqlite（2 個機器人、6 則訊息）、desktop.json、files/、說明.txt；自選資料夾保留；資料夾只剩新的檔案（Partitions 不見、新的連結 id）；自動重新啟動到入門畫面、localStorage 已清空；原生對話框顯示備份位置與「打開備份資料夾」。截圖 docs/screens/wipe-settings-item-light.png、wipe-confirm-light.png
- 未實測：Windows 實機（檔案被占用時的重試與下次啟動清除、app.relaunch 與單一執行鎖、文件資料夾在 OneDrive 時）、macOS、真的 ntfy.sh 上的 gone 訊息（用假的 ntfy 測）、手機 /go 頁面在主機清除後只會顯示「主機電腦沒開」（沒有特別說明）
## 4.5 交接網址完整 API（給 Grok Bot 這類外部 AI）＋ Windows 不支援 Grok Bot（2026-11-03）
- 問題：Windows 版 Grok Bot App 不產生 gateway-descriptor.json，grok-bot-cli 在 Windows 上不能用；交接網址只能交派、拿不到結果，而且網址是通道網址（每次重開都換）。
- [x] Windows：主機是 Windows 時（`env.hostOs`／執行器 `cfg.platform`），AI 連線 → Grok Bot 顯示「Windows 不支援，請改用交接網址」＋「取得交接網址」按鈕，不顯示帶入；API 拒絕 grokbot/list、engine-test grokbot、把機器人設成 grokbot（已經是的保留，工作會說明原因）；執行器不找 gbot、不讀 App 資料夾、engineReady=false，跑到時回「Windows 不支援 Grok Bot…這台電腦沒有安裝…」→ 分類為 unavailable（有備援就換、不重試），runner-done 保留原因文字；desktop/status 的 engines.grokbot 不執行 `gbot --version`。機器人的 AI 選單標示同一句。macOS／Linux 不變
- [x] API（desktop/api/hooks.mjs，token＝例行任務的 hook 鑰匙，指向那個機器人或群組）：`POST hook/<t>` {text,from} → {ok,job}（沒有 text 照舊當事件）；`GET hook/<t>/job/<id>` → running|done|failed（queued 也算 running，附 `queued:true`）、text（回覆或錯誤）、files；`GET hook/<t>/inbox`（這個 token 做完還沒讀過的，讀了就標記；`?peek=1` 不標記；`GET job` 拿到結果也算讀過）；`POST hook/<t>/feedback` {job,text} → 新工作，提示含原本指示＋上次結果＋指正，要它重做完整結果；像「以後…」的指正直接記成規則；`POST hook/<t>/teach` {text,name?} → 📌 規則（有名稱且 3 步以上存成📘做事手冊）；群組的 token 教給每個成員
- [x] 工作連結：jobs.hook（hook_jobs.id）、jobs.outs（回覆的檔案），重試、群組下一步、自動接續、工作紀錄重試都帶著；結果＝那串工作每個成員的最後回覆（群組多人時加【名字】）；hook_jobs 表記來源、指示、重做的上一件、已讀時間（30 天清掉）。兩份 MIGRATIONS＋schema.sql
- [x] 時間軸：交派／指正／教學在工作面板（messages.kind='bg'），回覆照舊進對話
- [x] 安全：錯或沒帶 token 一律 401 同樣內容 `{"error":"交接網址不正確"}`（常數時間比對；錯的 15 分鐘超過 300 次 429）；CORS *；64 KB；每個 token 寫入 120 次／15 分（存資料庫，跟舊事件同一個計數）、查詢 900 次／15 分（記憶體）；遠端埠只放行確切的 hook 路徑形狀，而且不帶本機信任（`../` 進不了其他 API）
- [x] 公開網址：主機只要有 hook 就保持通道（releaseTunnel 也看這個，不影響 4.3／4.4），每分鐘檢查；每個 token 把目前通道網址用 `sha256('octa-hook-key:'+token)` 加密（host-link `sealKey`，o1. 格式）發到 `base32(sha256('octa-hook-topic:'+token)).slice(0,32)`：網址變了、新增 hook（hooksChanged）、每 6 小時。functions/api/[[path]].js 的 hook/ 改成在 ensureSchema 之前交給 legacy/hook-relay.mjs：依 token 讀 ntfy.sh（30 秒快取，查無 3 秒）、WebCrypto 解密、只轉到 `https://*.trycloudflare.com`（HOOK_ALLOW_ORIGINS 只給測試）、25 秒逾時；找不到／解不開 401、主機沒回或回的不是 JSON（Cloudflare 錯誤頁）→ 先重查一次新網址（逾時不重送，避免重複建立）→ 503 `{"error":"主機電腦沒有連線"}`；ntfy 不通 503。不碰資料庫、不存內容
- [x] 介面：交接網址顯示 `https://octa.yzprojecttw.com/api/hook/<token>`（/api/config `hook`），「直接連到這台電腦的網址」收在詳細裡；例行任務（外部事件）、機器人詳細資料、AI 連線 → Grok Bot 都有「複製給外部 AI 的說明」（英文的 API 說明，網址與 token 已填好）；設定 → 手機遠端的「外部事件與交接網址」說明改成不用開手機遠端
- [x] 測試 test/hook-api.test.mjs 5 項（Node ↔ WebCrypto、轉送器換新網址／逾時不重送／413／405、五個端點與各種 401、已讀、重做帶前文、教學、群組、暫停 409、經 Pages Function＋假 ntfy＋真主機、刪掉的 token 401、ntfy 掛 503、主機關 503、Windows 判斷與畫面、說明文字）；desktop-server 測試的錯 token 改 401。全套 250 項，失敗只剩原本 4 項
- [x] 實測（沙箱，**真的 ntfy.sh**，主機 server.mjs 以遠端埠當通道，Pages Function 用 Node 包成 HTTP，假執行器 1 秒回覆）：新增 hook 後 1.8 秒 ntfy.sh 上有加密網址；curl 公開形式的網址：錯 token 401（0.32 秒，含查 ntfy）→ 建立 0.06 秒（第一次含查 ntfy）→ running/queued → 1.3 秒後 done → inbox 拿到、再讀是空的 → feedback 重做（提示含原指示與上次結果，規則已記住）→ teach 寫進記憶；快取後每次 4–6 ms（本機）；主機換埠重開後 2.2 秒內經網站再連上；主機關掉 503
- 未實測：Windows 實機（Grok Bot 卡片、選單）、真的 Grok Bot 呼叫、真的 trycloudflare 通道經 Cloudflare Pages（部署後 Pages Function 對 ntfy.sh 與 trycloudflare 的延遲、Cloudflare 錯誤頁判斷）、ntfy.sh 匿名發布的每日上限（每個 token 每天約 4 則＋重開次數，hook 很多時可能碰到）

## 4.7 郵件連接器：Gmail 應用程式密碼（IMAP 讀信＋SMTP 寄信，不用瀏覽器登入 Gmail）
- 問題：Google 拒絕在內嵌瀏覽器登入，機器人沒辦法可靠地用 Gmail。改走連接器：應用程式密碼＋IMAP/SMTP，不用瀏覽器。
- [x] desktop/lib/mail.mjs：只用 Node 的 tls/net 的小型 IMAP（LOGIN、LIST、STATUS、EXAMINE/SELECT、UID SEARCH（含 CHARSET UTF-8 literal、Gmail X-GM-RAW）、UID FETCH、UID STORE（含 X-GM-LABELS）、UID MOVE/COPY）與 SMTP（465 TLS／587 STARTTLS、AUTH PLAIN/LOGIN、dot-stuffing）；MIME 解析（RFC 2047/2231、base64/QP、multipart、Big5 等字集、HTML 轉文字）與組信（UTF-8 主旨、附件、In-Reply-To）。不加任何套件。非 993/465 一律 STARTTLS，伺服器不支援加密就不連
- [x] desktop/lib/mail-connector.mjs：設定（Gmail 必須 16 個字母、空格自動拿掉；Yahoo／iCloud／Outlook／自訂主機）、測試連線（IMAP 登入＋收件匣封數，SMTP 只登入不寄）、機器人的動作：/list（未讀、寄件者、主旨、從何時、資料夾／標籤、數量）、/search（Gmail 在「所有郵件」用 X-GM-RAW）、/read（純文字、去掉控制字元與 OCTA 標記如【】✅待確認 核准：，附件列表）、/save 或「存附件」（存到機器人資料夾的「附件」）、/mark /archive /label、/send /reply（附件從機器人資料夾，不能出檔案資料夾）
- [x] 寄信一律要同意：這一輪的「核准：」（核准裡寫了地址時只能寄給那些地址）或這個機器人的「一律允許」有寄信／信類的項目；沒有時不連 SMTP，回給 AI「✅待確認＋對象／內容／時間」三行（CONTRACT-4.7 §4）。動作寫「寄出」（執行器的「送出」檢查照舊，最後由 API 判斷），寫成「送出」也一樣擋
- [x] 接進原本的連接器：publicConnectors 多 kind 'mail'（只有名稱與地址），connectorLines 加信箱寫法，takeConnectorTask 認得「寄出／整理」、欄位直接寫在路徑下面也收，toolForBrowse 寄信類優先用信箱。執行器的 runner/connector 先經 desktop/api/mail-routes.mjs（在 runner-routes 前面；不是信箱就交回原本的處理），帶機器人的資料夾（env.getStore）與一律允許清單。沒有改 desktop/runner/**、runner-routes.mjs
- [x] 設定 → 進階「Gmail（應用程式密碼）」（app/js/mail.js）：電子郵件＋應用程式密碼、四步說明（兩步驟驗證 → myaccount.google.com/apppasswords → 建立 → 貼上，連結用系統瀏覽器開）、測試連線、儲存、更改（密碼留空沿用）、移除、進階欄位。密碼存在設定（跟其他連接器金鑰一樣），之後只回 ••••後四碼；API：POST connectors/mail、connectors/mail-test，GET connectors 多 `mail`
- [x] 測試 test/mail-connector.test.mjs 8 項（test/mail-fake.mjs 假 IMAP/SMTP 在 127.0.0.1）：MIME、設定驗證、指令解析、登入成功／失敗、列表／搜尋／讀信／存附件／整理、沒加密就拒絕、寄信要核准（沒核准連 SMTP 都不連、核准別人不行、一律允許可以、回信串接、附件、不能跑出資料夾）、經 startServer 的完整 API（密碼遮蔽、執行器拿到的工作沒有密碼、存附件到機器人資料夾、核准後寄出）、設定畫面。全套 268 項，失敗只剩原本 4 項
- [x] 實測：Chrome 開設定畫面（zh-TW、en）新增、測試連線、已接上列；i18n 0 missing
- 未實測：真的 Gmail（imap.gmail.com／smtp.gmail.com 的 TLS、X-GM-RAW 與中文標籤、寄出後「寄件備份」由 Gmail 自動存）、Yahoo／iCloud／自訂主機、超大信件與奇怪 MIME、Windows 實機。非 Gmail 寄出的信不會另存到寄件備份

## 4.7 A：瀏覽器同一輪直接操作、步驟進度、暫停、內部標記收起來（執行器與 API）
- [x] #4 直接操作：Claude Code、Codex、Antigravity（agy）、Qwen、Copilot、Cursor、Grok CLI 的主回合直接拿到機器人自己的瀏覽器（Playwright MCP 經 CDP 連到它的內建瀏覽器或 Chrome 視窗），同一輪打開、點、輸入、讀，不再【派瀏覽】。Claude 的工具：`DIRECT_ALLOWED`（原本的＋mcp__browser）、`mcp-browser.json`；AI 待機的 session 也一樣。Ollama／OpenCode 仍走【派瀏覽】（browser-use 或 OpenCode MCP 那一輪）；Grok Bot 不用這台電腦的瀏覽器。直接型 AI 還是寫了【派瀏覽】時，交回給它自己做；接手照舊（使用者接手就停手）
- [x] 提示：直接型不再有「你不能自己點」，改成快照引用、接手後重讀、登入先自己試再請使用者接手、送出前 ✅待確認（附對象／內容／時間）、API 優先；結果第一行、細節空一行後再寫
- [x] #1 步驟：AI 先寫「🧭步驟：a｜b｜c」、每步「🧭第N步」（指示前再提醒一次）；執行器從 Claude stream-json 與其他 CLI 印出的文字讀，加上目前工具，送 runner/progress {text,step,total,steps,kind,pmode,held}；API 存 JSON，state/busy 給解析後的 progress 與 paused（舊純文字相容）
- [x] 暫停：POST /api/job/<id>/pause {on}。Claude（一般與 AI 待機）在「上一個動作的結果回來、下一個還沒開始」時停下，繼續時用同一個 session `--resume` 接著做（提示先重讀頁面）；其他引擎在這一輪 AI 結束後、下一輪（連接器、派瀏覽、補看頁面）之前停（pmode 'turn'）。暫停中不算單件工作逾時（仍要有心跳）
- [x] #3 meta：runner/done 把 📝📌📇📘🧩🗺️⏰📍、🧭、【派瀏覽】【開／關瀏覽器】、✅ 完成／⚠ 沒做成 從文字拿掉，存 messages.meta {notes,result,approval}；GET messages 帶 meta；附在回覆上的「已記住…」等系統行改放工作面板（kind note）；回覆保留結果後的一個空行
- [x] #2 核准卡：✅待確認 下面的 對象／內容（可多行）／時間 解析到 meta.approval（文字照留，給 AI 的對話紀錄用）
- [x] #8：⚠ 沒做成 依內容分成 logout（例行任務遇到登入頁）／api／missing 等寫進 err_kind、例行任務記為失敗並送失敗通知（C 的推播讀這些）
- [x] Gmail／Google：要 Google 帳號的工作（Gmail、雲端硬碟、日曆…）先把機器人移到它自己的 Chrome 視窗並固定在那裡；內建瀏覽器一到 Google 登入頁就改用 Chrome；不再自動改回內建；Google 的 cookie 不進共用登入、手動改回內建也不帶過去（複製過去的 Google 登入會被登出）
- [x] 實測（沙箱，server.mjs＋執行器＋真 Claude Code＋Chromium Chrome 模式）：example.com 標題一輪 18 秒；本機 3 步下單頁有步驟 1/3→3/3、meta.result；暫停在兩個動作之間停住（held）、繼續後同一 session 做完、只有一件工作（AI 待機與一般兩種都測）；Chrome 設定檔的 Google cookie 重開後仍在、共用登入沒有 Google cookie
- 未實測：Codex／agy／Qwen／Copilot／Cursor／Grok CLI 的直接操作（沙箱沒有這些 CLI）、Electron 內建瀏覽器實際遇到 Google 登入頁時改用 Chrome（只有單元測試）、真的 Google 登入、Windows
