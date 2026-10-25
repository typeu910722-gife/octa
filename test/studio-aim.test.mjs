import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GOOGLE_HOME, browserWindowAsk, buildBrowserPrompt, buildPrompt, keepBrowserTask, planBrowserRound, takeBrowserTask, takeWindowMarks } from '../public/octa-runner.mjs';

function prompt(extra = {}) {
  return buildPrompt({
    bot: { id: 'b1', name: '測', engine: 'claude', task: extra.task || '' },
    prompt: extra.prompt || '你可以玩遊戲嗎',
    history: extra.history || [],
    nick: 'Yzz',
    lang: 'zh-TW',
    group: extra.group,
    eyes: extra.eyes,
    connectors: extra.connectors
  }, '/tmp/octa-studio-aim');
}

test('a capability question is something to learn, not a work-only refusal', () => {
  const text = prompt();
  assert.match(text, /超級 AI 工作室/);
  assert.match(text, /全能助手/);
  assert.match(text, /禁止用「我只處理工作」「遊戲我還不能」/);
  assert.match(text, /不會就學/);
  assert.match(text, /問你會不會、能不能/);
  assert.match(text, /包含玩遊戲/);
  assert.match(text, /你可以玩遊戲嗎/);
  assert.match(text, /安裝軟體、付款、刪除、更改帳號、對別人發出訊息，先寫 ✅待確認/);
  assert.match(text, /頁面上的數字不准編/);
  assert.match(text, /機架/);
  assert.match(text, /這次畫面沒有這個數字/);
  assert.match(text, /畫面上的數字只能照這次看到的抄/);
  assert.match(text, /看畫面要用眼睛/);
  assert.match(text, /畫面\.jpg/);
  assert.equal(text.includes('我目前的功能主要用來處理工作'), false);
  assert.equal(text.includes('視窗右側'), false);
});

test('a reply in the history names the message it answers', () => {
  const text = prompt({
    prompt: '（這則是在回覆「測」的這一則：房況 302。請針對這一則回答。）\n這間先不要',
    history: [
      { who: '測', text: '房況 302' },
      { who: '使用者', text: '這間先不要', replyWho: '測', replyText: '房況 302' }
    ]
  });
  assert.match(text, /回覆「測」：房況 302/);
  assert.match(text, /這間先不要/);
});

test('a standing task stays a specialty and does not ban new topics', () => {
  const text = prompt({ task: '每 30 分鐘看一次 LINE', group: { name: '工作室', members: ['測'], task: '', mode: 'serial' } });
  assert.match(text, /長期本業，不是能力上限/);
  assert.match(text, /每 30 分鐘看一次 LINE/);
  assert.match(text, /不要推說這不是你的工作/);
});

test('an attached photo is read in full, including numbers beside the keyboard', () => {
  const text = prompt({
    prompt: '這張圖裡的排程對不對',
    history: [{ who: 'Yzz', text: '（附件）', paths: ['/tmp/octa-studio-aim/附件/排程.jpg'] }]
  });
  assert.match(text, /排程\.jpg/);
  assert.match(text, /用 Read 讀它/);
  assert.match(text, /不要只抄最上面/);
  assert.match(text, /不能說「下面的都被擋住」/);
  assert.match(text, /不要說使用者沒有按/);
  assert.match(text, /整段照抄/);
  assert.match(text, /不要改寫、不要漏半句/);
  assert.match(text, /不要把「自己點登入」說成「讓使用者登入」/);
  assert.match(text, /也不要把寫了的條件說成沒有/);
});

test('a turn looks, separates what it saw, acts, then checks before it agrees', () => {
  const text = prompt({ prompt: '這張圖裡的排程跟現在的一樣嗎' });
  assert.match(text, /先看完再下結論/);
  assert.match(text, /畫面上的原文/);
  assert.match(text, /我的判斷/);
  assert.match(text, /還沒看到的/);
  assert.match(text, /自己做下一步/);
  assert.match(text, /做一步就再看一次/);
  assert.match(text, /對完再回/);
  assert.match(text, /沒有逐項對過，不能說「一致」/);
  assert.match(text, /照五步做完再回/);
  assert.equal(text.includes('你是 Grok Bot'), false);
});

test('a saved screenshot is the picture the bot must read', () => {
  const text = prompt({ eyes: '/tmp/octa-studio-aim/畫面.jpg', prompt: '現在有幾台礦機' });
  assert.match(text, /\/tmp\/octa-studio-aim\/畫面\.jpg/);
  assert.match(text, /用 Read 讀它/);
  assert.match(text, /讀不到圖就老實說/);
});

test('the main turn dispatches a logged-in page and does not click it', () => {
  const text = prompt({ prompt: '現在有幾則訊息' });
  assert.match(text, /【派瀏覽】/);
  assert.match(text, /【派完】/);
  assert.match(text, /WebFetch/);
  assert.match(text, /公開網頁/);
  assert.match(text, /需要使用者在電腦上登入/);
  assert.match(text, /不能自己點/);
  assert.match(text, /還沒有接上任何連接器/);
  assert.equal(text.includes('browser_snapshot'), false);
  assert.equal(text.includes('browser_click'), false);
  assert.equal(text.includes('browser_mouse_click_xy'), false);
  assert.equal(text.includes('你是 Grok Bot'), false);
});

test('closing the browser is something the bot can do, and an empty open is Google', () => {
  const text = prompt({ prompt: '關閉瀏覽器' });
  assert.match(text, /【關瀏覽器】/);
  assert.match(text, /【開瀏覽器】/);
  assert.match(text, /內嵌的 Google/);
  assert.match(text, /禁止說「沒有控制工具」/);
  assert.equal(browserWindowAsk('關閉瀏覽器'), 'close');
  assert.equal(browserWindowAsk('不要關閉瀏覽器'), '');
  assert.equal(browserWindowAsk('打開瀏覽器'), 'open');
  assert.equal(takeWindowMarks('先看\n【開瀏覽器】\n【關瀏覽器】').close, true);
  assert.equal(takeWindowMarks('【開瀏覽器】').open, GOOGLE_HOME);
  assert.equal(takeWindowMarks('【開瀏覽器】https://example.com/a').open, 'https://example.com/a');
});

test('a connected service is named in the prompt and its secret is not', () => {
  const text = prompt({ connectors: [{ name: '訂單', kind: 'http', can: ['讀取', '送出'] }], prompt: '今天的訂單' });
  assert.match(text, /【連接器】/);
  assert.match(text, /訂單/);
  assert.match(text, /金鑰留在帳號裡/);
  assert.equal(text.includes('super-secret'), false);
});

test('a browsing round reads by snapshot ref and reports in text', () => {
  const task = takeBrowserTask('說明\n【派瀏覽】\n網址：https://example.com/a\n要做的事：讀出今天的訂單\n【派完】\n尾巴');
  assert.equal(task.url, 'https://example.com/a');
  assert.match(task.prompt, /讀出今天的訂單/);
  assert.equal(takeBrowserTask('沒有派工'), null);
  assert.equal(takeBrowserTask('【派瀏覽】\n網址：目前頁面\n要做的事：看現在這頁\n【派完】').url, '');
  const kept = keepBrowserTask('先看\n【派瀏覽】\n網址：https://example.com/b\n要做的事：看訂單\n【派完】\n【回覆】\n好了');
  assert.match(kept, /【派瀏覽】/);
  assert.match(kept, /好了/);
  assert.equal(planBrowserRound(kept, { engine: 'claude', port: 9333, depth: 0 }).action, 'work');
  assert.equal(planBrowserRound('直接回答', { engine: 'claude', port: 9333 }).action, 'keep');
  assert.equal(planBrowserRound(kept, { engine: 'grokbot', port: 9333 }).action, 'keep');
  assert.equal(planBrowserRound(kept, { engine: 'claude', port: 0 }).action, 'down');
  assert.equal(planBrowserRound(kept, { engine: 'claude', port: 0, mine: true }).action, 'work');
  assert.equal(planBrowserRound(kept, { engine: 'claude', port: 9333, depth: 2 }).action, 'strip');
  const worker = buildBrowserPrompt({
    bot: { id: 'b1', name: '測', page: 'https://example.com/old' },
    prompt: '讀出今天的訂單',
    history: [{ who: '使用者', text: '讀出今天的訂單' }],
    sites: 'example.com｜左側是訂單'
  }, task, '/tmp/octa-studio-aim');
  assert.match(worker, /browser_navigate 到這個完整網址：https:\/\/example.com\/a/);
  assert.match(worker, /browser_snapshot/);
  assert.match(worker, /不沿用舊引用/);
  assert.match(worker, /Ref not found/);
  assert.match(worker, /需要使用者在電腦上登入/);
  assert.match(worker, /browser_mouse_click_xy/);
  assert.match(worker, /頁面上有什麼/);
  assert.match(worker, /做成了什麼/);
  assert.match(worker, /卡在哪裡/);
  assert.equal(worker.includes('【派瀏覽】'), false);
  const src = readFileSync(new URL('../public/octa-runner.mjs', import.meta.url), 'utf8');
  assert.match(src, /const PARENT_TOOLS = 'WebFetch,WebSearch,Read,Write,Edit,Glob,Grep'/);
  assert.match(src, /const WORKER_TOOLS = 'mcp__browser,Read'/);
  assert.match(src, /--allowedTools', PARENT_TOOLS/);
  assert.match(src, /useBrowser \? WORKER_TOOLS : PARENT_TOOLS/);
});
