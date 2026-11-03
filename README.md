# OCTA｜奧克塔

用聊天介面指揮多個 AI 機器人。機器人在**你自己的電腦**上工作，用的是你自己的訂閱方案，不用另外付 API 費用。每個機器人可以選：

| AI 引擎 | 需要安裝的工具 | 登入方式 |
| --- | --- | --- |
| Claude | [Claude Code](https://code.claude.com) | `claude` → `/login`（Pro / Max） |
| ChatGPT | [Codex CLI](https://developers.openai.com/codex/cli) | `codex` → Sign in with ChatGPT |
| Gemini | [Antigravity CLI](https://antigravity.google/docs/cli)（`agy`） | `agy` → Google 帳號（免費帳號可用） |
| Grok Bot（帶入你在 Grok Bot 的機器人） | [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli)（第三方）＋ Grok Bot 桌面 App | 先登入 Grok Bot App |
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
- **自主工作**：自己規劃步驟一路做完，做完列出需要你決定的事；登入時把它的瀏覽器叫到螢幕上幫它登入再按「繼續」
- **記憶與技能**：📌 記住你的偏好和規則；🧩 把做順的流程存成技能，輸入 / 叫出指令選單
- **核准按鈕**：發訊息、付款這類動作先擬好等你核准，可選「只這次」「一律允許」或「拒絕」；清單上會標「待你處理」
- **檔案存在電腦**：附件、截圖、機器人放進「輸出」的檔案都存在 OCTA 資料夾（每個機器人／群組一個資料夾，可互相讀取），也能改存到 Google 雲端硬碟
- **即時更新**：長輪詢，指示和回覆馬上出現；每個裝置都能跳通知
- **AI 剩餘流量**：AI 連線頁顯示 Claude、ChatGPT 方案剩餘比例，其他顯示 OCTA 今日使用次數
- **分區資料／共用資料**：寫一次，機器人都會讀
- **通知**：需要你處理時，跳電腦通知，也可以送到 Telegram 或 LINE
- **手機遠端**：設定 → 手機遠端，手機掃一次 QR code 就配對好，把 [octa.yzprojecttw.com/go](https://octa.yzprojecttw.com/go) 加到主畫面；電腦重開後手機遠端自動再打開，網址換了也會經 ntfy.sh（加密）自動找到，不用重新配對（也可用網址加 8 碼配對碼；通道由你自己的電腦開）。設定裡列出已配對的手機，可一鍵移除；在手機上即時看機器人的瀏覽器，需要登入或輸入驗證碼時按「接手」直接在手機上點、捲動、打字，好了按「我好了」它就接著做
- **兩台電腦一份資料**：設定 → 電腦，另一台電腦（例如家裡）貼上主機的連線碼就成為遙控器，看到同一份機器人與對話，工作都在主機上做；主機網址換了會透過免費的公開轉送服務 ntfy.sh（加密，不經過 OCTA 伺服器）自動找回；也能一鍵「換成這台當主機」把資料搬過來
- **工作紀錄**：每次執行的結果與花費時間
- **多語介面**：繁體中文、English、简体中文、日本語（機器人也會用你選的語言回覆）

## 架構（4.0 起純本機）

```
桌面版 OCTA（Electron）
 ├─ 本機伺服器 desktop/server.mjs ── 本機 API desktop/api/ ── SQLite（sql.js）
 ├─ 執行器 desktop/runner/ ── claude / codex / agy / ollama… ＋ 每個機器人的瀏覽器
 ├─ 手機遠端：cloudflared 快速通道 ＋ 8 碼配對碼（自己電腦開的，不經過 OCTA 伺服器）；手機的固定入口 site/go.html（靜態頁，從 ntfy.sh 讀加密的網址）
 └─ 遙控器電腦（4.3）：同一條通道＋長期的電腦配對；主機網址加密後放在 ntfy.sh（desktop/host-link.mjs、link-server.mjs）
```

不需要帳號，也沒有雲端伺服器；資料只存在這台電腦。3.x 用雲端帳號的人，第一次打開 4.0 會自動把雲端資料搬回電腦（先備份）。octa.yzprojecttw.com 只剩下載介紹頁（`site/`）；`functions/` 是凍結的舊雲端 API，只留給舊資料搬家用。

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
| `desktop/lib/` | 共用模組：模型路由、連接器、程式任務 |
| `desktop/` 其他 | Electron 主程式、本機伺服器、內嵌瀏覽器、舊雲端資料搬家（`cloud-import.mjs`） |
| `schema.sql` | 資料表 |
| `i18n/` | 多語：在 `i18n/strings.py` 加翻譯，執行 `python3 i18n/build.py` 產生 `app/i18n-dict.js` |
| `site/` | octa.yzprojecttw.com 下載介紹頁；`go.html`＋`go-core.js` 是手機的固定入口 /go |

## 安全

- 機器人預設不替你發訊息、付款、刪資料，會先請你核准
- 執行器只允許瀏覽器、網路查詢，以及機器人自己資料夾內的讀寫
- 桌面版只接受本機連線；手機遠端需要配對碼，猜錯 10 次自動換碼

## 授權

MIT
