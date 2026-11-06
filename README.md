# OCTA｜奧克塔

用聊天介面指揮多個 AI 機器人。機器人在**你自己的電腦**上工作，用的是你自己的訂閱方案，不用另外付 API 費用。每個機器人可以選：

| AI 引擎 | 需要安裝的工具 | 登入方式 |
| --- | --- | --- |
| Claude | [Claude Code](https://code.claude.com) | `claude` → `/login`（Pro / Max） |
| ChatGPT | [Codex CLI](https://developers.openai.com/codex/cli) | `codex` → Sign in with ChatGPT |
| Gemini | [Antigravity CLI](https://antigravity.google/docs/cli)（`agy`） | `agy` → Google 帳號（免費帳號可用） |
| Grok Bot（帶入你在 Grok Bot 的機器人） | [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli)（第三方）＋ Grok Bot 桌面 App | 先登入 Grok Bot App（Windows 不支援：Windows 版 App 不產生 grok-bot-cli 需要的登入檔，請改用交接網址） |
| 本機開源模型（免費，不接付費 API） | [Ollama](https://ollama.com) ＋ [OpenCode](https://opencode.ai) | `ollama pull qwen3`，機器人模型填 `qwen3` |

## 快速開始（桌面版，推薦）

1. 安裝至少一個 AI 工具並登入（見上表，預設用 Claude）
2. 安裝 [Google Chrome](https://www.google.com/chrome/)
3. 下載 [OCTA-Setup.exe](https://github.com/typeu910722-gife/octa/releases/latest/download/OCTA-Setup.exe) 並安裝（或到 [octa.yzprojecttw.com](https://octa.yzprojecttw.com) 首頁按下載）
4. 打開 OCTA，照「設定指引」完成，選一個範本試跑

打開就能用，不用註冊或登入，所有資料只存在這台電腦。想用手機指揮：設定 → 手機遠端，用手機相機掃一次 QR code，再把那一頁加到手機主畫面（電腦重開也不用再配對）。第一次執行時 Windows 若顯示「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」（安裝檔未簽章）。3.x 用雲端帳號的人，第一次打開 4.0 會自動把資料搬回電腦。

## 能做什麼

- **機器人**：每個機器人有自己的指定任務，並可選 Claude、ChatGPT、Gemini、Ollama 本機模型，或帶入 Grok Bot 的機器人
- **群組**：把機器人拉進群組依序協作，或用 `@名字` 指定誰做
- **分區**：區隔不同門市或專案；同分區的機器人可以互相詢問
- **例行任務**：每天固定時間或每隔幾分鐘自動執行，可隨時開關（電腦需開著）
- **瀏覽器**：每個機器人可用自己的獨立 Chrome（分頁、登入分開），或「使用我的 Chrome」直接用你已登入的網站與已儲存的密碼（透過 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，每個機器人有自己的分頁群組）；最多 3 個同時工作
- **用聊天交代**：建立機器人只要取名字，直接傳訊息說要做什麼，它會自己整理成指定任務、建好例行任務（每天幾點或每隔幾分鐘）
- **全力模式（4.11，預設開）**：不限單件工作的時間、回合與 token，AI 一直待機；回合結束還沒做完就自動在同一個對話接著做，直到 ✅ 完成或確定 ⚠ 沒做成（需要你核准、回答或登入時停下等你，連續幾輪沒進展判斷卡住）；額度用完會等重置時間自動繼續，例行任務在額度快用完時自動延後。設定 → 工作與排程可以關掉（回到省額度），每個機器人也能單獨設定
- **自主工作**：自己規劃步驟一路做完，做完列出需要你決定的事；登入時把它的瀏覽器叫到螢幕上幫它登入再按「繼續」
- **記憶與技能**：📌 記住你的偏好和規則；🧩 把做順的流程存成技能，輸入 / 叫出指令選單
- **技能與工具（4.12）**：說「去 GitHub 學 pdf」（或機器人發現自己不會時自己去找），OCTA 會在 GitHub 找最適合那個機器人 AI 的技能（Claude 先找 anthropics/skills、ChatGPT／Codex 先找 openai/skills、Gemini 找 Gemini CLI 擴充），下載後先檢查：會做什麼、有沒有程式、會不會連網路、寫檔、讀金鑰、安裝東西、有沒有可疑的指令，在對話裡出一張核准卡，**你核准才會裝**。裝好後放進那個 AI 自己讀技能的地方（Claude Code：`.claude/skills`；Codex、Antigravity：`.agents/skills`），其他 AI 在工作相關時把說明放進提示；「它記得什麼」看得到來源、版本、誰核准，可以更新、移除、給其他機器人。**工具箱**：FFmpeg、ImageMagick、yt-dlp、uv、Python 從官方來源下載並比對檢查碼後直接裝在 OCTA 自己的資料夾（不需要管理員權限），只放進指定機器人的 PATH；npm／pip 套件、MCP 伺服器、GitHub 上的程式要你核准。**產生圖片與影片**：填自己的 OpenAI、Google Gemini（Imagen／Veo）或 Replicate 金鑰，機器人就能畫圖、做短片，檔案存在它的「輸出」資料夾並直接出現在對話裡（影片可直接播放）。設定 → 技能與工具
- **核准按鈕**：發訊息、付款這類動作先擬好等你核准，可選「只這次」「一律允許」或「拒絕」；清單上會標「待你處理」
- **檔案存在電腦**：附件、截圖、機器人放進「輸出」的檔案都存在 OCTA 資料夾（每個機器人／群組一個資料夾，可互相讀取），也能改存到 Google 雲端硬碟
- **即時更新**：長輪詢，指示和回覆馬上出現；每個裝置都能跳通知
- **AI 剩餘流量**：AI 連線頁顯示 Claude、ChatGPT 方案剩餘比例，其他顯示 OCTA 今日使用次數
- **分區資料／共用資料**：寫一次，機器人都會讀
- **通知**：需要你處理時，跳電腦通知，也可以送到 Telegram 或 LINE
- **手機遠端**：設定 → 手機遠端，手機掃一次 QR code 就配對好，把 [octa.yzprojecttw.com/go](https://octa.yzprojecttw.com/go) 加到主畫面；電腦重開後手機遠端自動再打開，網址換了也會經 ntfy.sh（加密）自動找到，不用重新配對（也可用網址加 8 碼配對碼；通道由你自己的電腦開）。設定裡列出已配對的手機，可一鍵移除；在手機上即時看機器人的瀏覽器，需要登入或輸入驗證碼時按「接手」直接在手機上點、捲動、打字，好了按「我好了」它就接著做
- **兩台電腦一份資料**：設定 → 電腦，另一台電腦（例如家裡）貼上主機的連線碼就成為遙控器，看到同一份機器人與對話，工作都在主機上做；主機網址換了會透過免費的公開轉送服務 ntfy.sh（加密，不經過 OCTA 伺服器）自動找回；也能一鍵「換成這台當主機」把資料搬過來
- **交接網址（給其他 AI，例如 Grok Bot）**：機器人的詳細資料或 AI 連線 → Grok Bot 產生 `https://octa.yzprojecttw.com/api/hook/<token>`，按「複製給外部 AI 的說明」貼給對方。對方可以交派工作（POST）、查狀態與結果（`/job/<id>`）、讀還沒看過的結果（`/inbox`）、指正重做（`/feedback`）、教它做法（`/teach`，寫進 📌 記憶）。網址固定不變：OCTA 網站只依 token 從 ntfy.sh 讀出加密的主機網址再轉送，不存任何資料；token 等同密碼，錯的一律 401
- **深海基地就是主畫面（4.10）**：電腦上（1024 px 以上）主畫面中間就是即時的 3D 海底基地：每個分區是一座玻璃艙室、每個機器人是自己的章魚坐在桌前工作，泡泡寫它在做什麼、誰在等你；沒工作的會到「遊戲角」打桌球、下棋、玩街機、跳舞、看書，有工作馬上游回座位。打開的對話是浮在基地上的玻璃面板（可拖寬、記住），按「收起對話」（Alt+M）收成一條就能看整個基地。從側邊欄、卡片或直接點章魚選機器人，就打開它的對話、鏡頭游到它旁邊（不會被對話擋住），腳下有一圈光。右側面板第一個分頁「總覽」是每個機器人的卡片，依分區排：工作中 · 需要你 · 今天完成 · 沒做成 這排數字也是篩選；卡片上可以一鍵重試、已處理、打開對話、看工作、它記得什麼、暫停、去核准。側邊欄「總覽」（有「N 件有問題」徽章，Alt+O）打開這個分頁並收起對話看全景。手機上 3D 在對話清單上方（可收起，收起就不繪製），清單上有「聊天｜總覽」。只在你看得到時以每秒 30 格繪製，對話蓋住大半、打字中或視窗在背景時降到每秒 10 格，視窗隱藏或在背景超過 30 秒就停；省電模式／減少動態是靜態畫面。設定 → 外觀與語言 可以關掉「主畫面 3D 基地」，也有「深海」配色
- **工作紀錄**：每次執行的結果與花費時間
- **清除這台電腦的資料**：設定 → 進階最下面，一鍵把 OCTA 恢復成剛安裝好的樣子（先備份到「文件」資料夾、輸入「刪除」確認；電腦上的 AI 工具與帳號不受影響）
- **多語介面**：繁體中文、English、简体中文、日本語（機器人也會用你選的語言回覆）

## 架構（4.0 起純本機）

```
桌面版 OCTA（Electron）
 ├─ 本機伺服器 desktop/server.mjs ── 本機 API desktop/api/ ── SQLite（sql.js）
 ├─ 執行器 desktop/runner/ ── claude / codex / agy / ollama… ＋ 每個機器人的瀏覽器
 ├─ 手機遠端：cloudflared 快速通道 ＋ 8 碼配對碼（自己電腦開的，不經過 OCTA 伺服器）；手機的固定入口 site/go.html（靜態頁，從 ntfy.sh 讀加密的網址）
 ├─ 遙控器電腦（4.3）：同一條通道＋長期的電腦配對；主機網址加密後放在 ntfy.sh（desktop/host-link.mjs、link-server.mjs）
 └─ 交接網址（4.5）：desktop/api/hooks.mjs；主機對每個 token 把通道網址加密發到 ntfy.sh，octa.yzprojecttw.com/api/hook/* 由無狀態轉送器（legacy/hook-relay.mjs）轉到主機
```

不需要帳號，也沒有雲端伺服器；資料只存在這台電腦。3.x 用雲端帳號的人，第一次打開 4.0 會自動把雲端資料搬回電腦（先備份）。octa.yzprojecttw.com 只剩下載介紹頁（`site/`）與交接網址的轉送（`/api/hook/*`，不存資料）；`functions/` 其餘是凍結的舊雲端 API，只留給舊資料搬家用。

## 開發

```
cd desktop
npm install
npm run serve      # 用 Node 直接跑，自動打開瀏覽器
npm start          # Electron 視窗
npm run dist       # 打包 Windows 安裝檔（Linux 需要 wine64 + wine32）
node --test ../test/*.test.mjs
```

在 Actions 執行「Desktop build」（或推送 `v*` 標籤），會在 Windows 上打包並發布成最新 Release；版本號取自 `desktop/package.json`。

| 路徑 | 內容 |
| --- | --- |
| `app/` | 網頁介面：`index.html`、`css/`、`js/`（不需建置） |
| `desktop/api/` | 本機 API（`index.mjs` 匯出 `onRequest`） |
| `desktop/runner/` | 執行器：領任務、呼叫 AI 工具、管理每個機器人的瀏覽器 |
| `desktop/lib/` | 共用模組：模型路由、連接器、程式任務、技能（`skills.mjs`）、工具箱目錄（`toolbox.mjs`）、產生圖片影片（`gen.mjs`） |
| `desktop/` 其他 | Electron 主程式、本機伺服器、內嵌瀏覽器、舊雲端資料搬家（`cloud-import.mjs`） |
| `schema.sql` | 資料表 |
| `i18n/` | 多語：在 `i18n/strings.py` 加翻譯，執行 `python3 i18n/build.py` 產生 `app/i18n-dict.js` |
| `site/` | octa.yzprojecttw.com 下載介紹頁；`go.html`＋`go-core.js` 是手機的固定入口 /go |

## 安全

- 機器人預設不替你發訊息、付款、刪資料，會先請你核准
- 執行器只允許瀏覽器、網路查詢，以及機器人自己資料夾內的讀寫
- 從 GitHub 學的技能、工具箱以外的工具都要你核准才裝；技能內容在核准前只當資料看（由程式檢查，不交給會動手的 AI），有可疑指令會標「風險高」；工具箱的下載固定版本、比對 SHA-256，對不上就不裝；產生圖片影片的金鑰只給這台電腦的執行器，機器人看不到
- 桌面版只接受本機連線；手機遠端需要配對碼，猜錯 10 次自動換碼
- 交接網址的 token 等同密碼：錯的或沒帶一律 401（同樣內容，不透露存不存在），每個 token 15 分鐘最多 120 次寫入、900 次查詢；轉送器只轉到 `*.trycloudflare.com`，不存任何內容

## 授權

MIT
