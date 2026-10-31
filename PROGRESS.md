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
