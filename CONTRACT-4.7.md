# OCTA 4.7 三路共用約定（A＝執行器與瀏覽器、B＝對話與工作面板介面、C＝新頁面與通知）

## 1. 步驟進度（A 產生、B 顯示）
- 執行器回報 `POST /api/runner/progress {job, text, step?, total?, steps?: [字串...], kind?: 'browse'|'think'|'tool'|'ask'}`。
- API 把它存進 `jobs.progress`（JSON 字串）：`{ text, step, total, steps, kind, at }`；舊的純文字 progress 仍要相容（B 讀到非 JSON 就當 `{text}`）。
- `GET /api/state` 與 `/api/busy` 每件執行中的工作帶 `progress`（已解析物件）、`paused`（布林）。
- AI 一開始先列步驟：執行器讓主 AI 在開工時輸出一行「🧭步驟：步驟1｜步驟2｜…」（不會出現在對話），之後每做完一步回報 step。沒有列步驟時 total 為空，B 只顯示目前文字。

## 2. 暫停／繼續／停止（A 實作伺服器與執行器、B 做按鈕）
- `POST /api/job/<id>/pause {on: true|false}`；`POST /api/cancel`（既有）停止。
- 暫停＝執行器在下一步之前停住（瀏覽器操作之間、工具呼叫之間），`paused` 為真；繼續後接著做。做不到即時暫停的引擎（純 CLI 一輪）就在這一輪結束後不再接續，UI 顯示「這一步做完會暫停」。

## 3. 內部標記（B 顯示、A 在存訊息前清理）
- 回覆裡的 📝任務更新…📝結束、📌記住、🧩技能…🧩結束、⏰例行任務、🗺️網站筆記、📍目前頁面、🧭步驟、【派瀏覽】…【派完】、【開瀏覽器】【關瀏覽器】、✅ 完成／⚠ 沒做成 行：
  - A：`runner/done` 已經處理的標記，從存進 messages.text 的文字裡移除，改存到 `messages.meta`（JSON：`{ notes: [{type:'task'|'memory'|'skill'|'routine'|'site'|'page', title, body}], result: {ok:true|false, text} }`）；欄位要加 migration（server.mjs 與 desktop/api 兩個清單＋schema.sql）。
  - B：對話只顯示人話；meta.notes 顯示成訊息下方的小標籤（例如「📌 已記住 1 條規則」），點開看全文；meta.result 顯示成第一行的狀態（✅ 或 ⚠）。舊訊息沒有 meta 時 B 自己用同樣規則解析、收起來。

## 4. 核准卡（B）
- 既有 ✅待確認 卡片改成：對象、完整內容預覽（可展開）、預計何時送、按鈕「核准（只這次）」「一律允許」「修改」「拒絕」。永遠不需要手打「核准：」。A 讓 AI 在 ✅待確認 下面附「對象：」「內容：」「時間：」三行（選填），B 讀這些欄位。

## 5. 檔案分工
- A：desktop/runner/**、desktop/api/runner-routes.mjs、runner-done.mjs、jobs.mjs、新增 job 暫停路由、schema/migrations。
- B：app/js/chat.js、composer.js、panel 相關（work panel）、app/css/chat.css、panels.css。
- C：新增 app/js/overview.js、app/js/memory-view.js、desktop/api 新模組（overview、memory 編輯 API）、通知（desktop/api/notify.mjs、桌面通知）、建立機器人的範本選擇、額度顯示。
- 共用檔案（index.html、i18n/strings.py、app/i18n-dict.js、settings.js、main.js）：只加不改別人的；合併時我處理。不要改版本號與 app/changelog.json。
