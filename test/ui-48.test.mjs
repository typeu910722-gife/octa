// 4.8 app side of the 4.7 field test: real outcomes coloured, the result line said once, progress in one place,
// the queue, previews with what needs you, notifications that say what happened, both quota windows, smaller text,
// settings that apply at once, and redraws that keep what did not change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { css, fnSrc, html, js, pure, read, secSrc, tr } from './app-source.mjs';

const { jobOutcome, resultBody, needTag, queueView, queueOrder, etaText, quotaWins, quotaTone, runUse, gistOf, firstSent } = pure;

test('a run is 完成 only when nothing says otherwise; 未完成 is amber (waits for you) or red', () => {
  assert.deepEqual(jobOutcome({ status: 'done' }), { tone: 'ok', label: '完成', why: '' });
  // the two from the report: 「我改好了」 (a reply that said ⚠ 沒做成) and 「看吧」 (接手)
  assert.equal(jobOutcome({ status: 'done' }, { ok: false, text: 'LINE 後台要先登入' }).tone, 'warn');
  assert.equal(jobOutcome({ status: 'done' }, null, '後台要先登入。\n⚠ 沒做成：房號沒傳出去').label, '未完成');
  const handed = jobOutcome({ status: 'done', err_kind: 'handed' });
  assert.equal(handed.tone, 'warn'); assert.equal(handed.why, '等你接手');
  assert.equal(jobOutcome({ status: 'done', err_kind: 'not_logged_in' }).tone, 'warn');
  assert.equal(jobOutcome({ status: 'done', err_kind: 'api', err_msg: '銀行 API 503' }).tone, 'err');
  assert.equal(jobOutcome({ status: 'error', err_kind: 'timeout' }).why, '逾時');
  assert.equal(jobOutcome({ status: 'error' }).tone, 'err');
  assert.equal(jobOutcome({ status: 'error', err_kind: 'stopped' }).tone, 'stop');
  // the work panel, the settings log and the overview use it
  assert.match(fnSrc('workItems'), /jobOutcome\(j,rv\?\.result,rv\?\.text\)/);
  assert.match(js, /jobwarn:\['info','warn','未完成'\]/);
  assert.doesNotMatch(fnSrc('workItems'), /k:j\.status==='error'\?'jobfail':'job'/, 'no longer by status alone');
  assert.match(js, /const o=l\.status==='done'\|\|l\.status==='error'\?jobOutcome\(l\):null/, '工作紀錄 in Settings too');
});

test('the ✅／⚠ line is said once: the pill, and the body without the sentence it repeats', () => {
  assert.deepEqual(resultBody('LINE 後台要先登入，房號沒傳出去。\n\n我停在登入頁。', { ok: false, text: 'LINE 後台要先登入，房號沒傳出去' }), { text: '我停在登入頁。', pill: true });
  assert.deepEqual(resultBody('完成', { ok: true, text: '完成' }, true), { text: '', pill: true }, 'whole: the reply was only that line');
  assert.deepEqual(resultBody('名單如下：\n- 王 201', { ok: true, text: '入住 2 筆' }), { text: '名單如下：\n- 王 201', pill: true });
  assert.deepEqual(resultBody('沒有結果行', null), { text: '沒有結果行', pill: false });
  const row = fnSrc('renderChat');
  assert.match(row, /resultBody\(v\.text,v\.result,msgMeta\(m\)\?\.result\?\.whole\)/);
  assert.match(row, /<b class="rrk">\$\{v\.result\.ok\?'完成':'未完成'\}<\/b>/, 'the pill says 完成／未完成 in words');
});

test('progress lives only in the 工作 panel: no chip in the chat, no 1/3 in the header or the sidebar', () => {
  assert.doesNotMatch(js, /function jobChip\(/);
  assert.match(fnSrc('typingDots'), /class="tdots/);
  assert.doesNotMatch(fnSrc('renderChat'), /pstep/);
  assert.doesNotMatch(fnSrc('runLine'), /lstep/);
  // folded, the panel toggle carries the step as a tiny badge (the same panel) and says what its dot means
  const badge = fnSrc('paintBadge');
  assert.match(badge, /b\.textContent=rv\?\.has\?rv\.step\+'\/'\+rv\.total:''/);
  assert.match(badge, /\$\('panelBtn'\)\.title=tip/);
  assert.match(css, /\.wbadge\.num\{/);
});

test('the queue: position, who is ahead, about how long, and 插隊', () => {
  const now = 1e12, M = 60000;
  const busy = [
    { job: 1, status: 'running', bot_id: 'a', started: now - 1 * M, kind: 'chat' },
    { job: 2, status: 'running', bot_id: 'b', started: now - 2 * M, kind: 'chat' },
    { job: 3, status: 'running', bot_id: 'c', started: now - 0.5 * M, kind: 'chat' },
    { job: 4, status: 'pending', bot_id: 'd', kind: 'chat' },
    { job: 5, status: 'pending', bot_id: 'e', kind: 'chat' },
    { job: 6, status: 'pending', bot_id: 'a', kind: 'chat' }
  ];
  const v = queueView(5, busy, { avg: 4 * M, slots: 3 }, now);
  assert.equal(v.pos, 2); assert.equal(v.total, 3); assert.equal(v.why, 'full');
  assert.deepEqual(v.ahead.map(x => x.job), [1, 2, 3, 4]);
  assert.ok(v.eta >= 2 * M && v.eta <= 4 * M, String(v.eta));
  assert.equal(etaText(v.eta), '約 3 分鐘');
  assert.equal(etaText(20000), '不到 1 分鐘');
  // its own bot is still busy: it waits for that one
  assert.equal(queueView(6, busy, { avg: 4 * M, slots: 3 }, now).why, 'own');
  // 插隊 (prio) goes first; 'open' before everything
  assert.deepEqual(queueOrder([...busy, { job: 7, status: 'pending', bot_id: 'f', prio: 2 }, { job: 8, status: 'pending', bot_id: 'g', kind: 'open' }]).map(x => x.job), [8, 7, 4, 5, 6]);
  const q = fnSrc('queueHtml');
  assert.match(q, /queueView\(x\.job,S\.busy,S\.queue\)/);
  assert.match(q, /data-qbump=/);
  assert.match(js, /api\('job\/'\+qb\.dataset\.qbump\+'\/bump','POST'/);
  assert.match(fnSrc('paintWork'), /queueHtml\(q\)/);
});

test('the sidebar preview leads with the conclusion; what needs you is a tag in words', () => {
  assert.equal(firstSent('補助小獵人：Yzz，我看到 11/4 的名單有三筆新的。細節如下'), '補助小獵人：Yzz，我看到 11/4 的名單有三筆新的。');
  assert.equal(gistOf('長長的內容', { ok: false, text: '後台要先登入' }), '沒做成：後台要先登入');
  assert.equal(gistOf('好\n✅待確認：寄出對帳單'), '要你核准：寄出對帳單');
  assert.equal(needTag({ by: 'b1', text: '好', awhat: '寄出對帳單' }).k, 'ap');
  assert.equal(needTag({ by: 'b1', text: '需要使用者在電腦上登入（後台）' }).label, '要你登入');
  assert.equal(needTag({ by: 'b1', text: '要用哪一個？❓' }).label, '待你回答');
  assert.equal(needTag({ by: 'b1', text: '沒傳出去', rok: 0, ts: 5 }).label, '未完成');
  assert.equal(needTag({ by: 'b1', text: '我先停手。', ts: 100 }, { ok: false, kind: 'handed', at: 100 }).label, '等你接手');
  assert.equal(needTag({ by: 'b1', text: '好了', rok: 1 }, { ok: true }).k, '');
  assert.equal(needTag({ by: 'me', text: '好' }, { ok: false, kind: 'stopped', at: 1 }).k, '', 'you pressed 停止: nothing to do');
  assert.match(fnSrc('preview'), /msgGist\(m,46\)/);
  assert.match(fnSrc('listTag'), /class="need \$\{n\.k\}" title=/);
  assert.match(fnSrc('listTag'), /class="ub" title=/, 'unread: a quiet count with a tooltip');
  assert.match(css, /\.l2 small\.pv\{[^}]*-webkit-line-clamp:2/, 'two lines before it is cut');
  assert.match(css, /\.ub\{[^}]*background:var\(--line\)/, 'unread is neutral');
  assert.match(css, /\.need\.fail\{/);
});

test('notifications and hints say what happened; the badges say what they count', () => {
  const n = fnSrc('notifyNew');
  assert.match(n, /what=msgGist\(ml\|\|l,90\)/);
  assert.match(n, /body:what\|\|/);
  assert.match(n, /showHint\(c,need\.k\?'ask':'new','n:'\+c\+':'\+l\.id,what,need\)/);
  assert.match(fnSrc('showHint'), /class="fw" data-u>\$\{esc\(what\|\|/);
  assert.match(fnSrc('ovBadge'), /件有問題/);
  assert.match(fnSrc('ovBadge'), /b\.title=tip/);
  assert.match(js, /const body=\[what&&I18N\.t\('做什麼：'\)\+what\.trim\(\),why,/, 'alert notifications say what and why');
  for (const s of ['件有問題', '則新訊息', '要你核准：', '未完成', '等你接手', '插隊', '待你回答', '要你登入']) assert.notEqual(tr('en', s), s, s + ' in English');
});

test('quota: both windows of each AI in use, coloured by what is left; one run\'s use in the work panel', () => {
  const list = quotaWins({ claude: { plan: 'Claude Max', windows: [{ k: '7d', used: 27 }, { k: '5h', used: 78 }] }, codex: { windows: [{ k: '5h', used: 10 }] }, gemini: { windows: [{ k: '5h', used: 99 }] } }, new Set(['claude', 'codex']));
  assert.deepEqual(list.map(x => x.eng), ['claude', 'codex'], 'only AIs the bots use; the tightest first');
  assert.deepEqual(list[0].wins.map(w => [w.k, w.left]), [['5h', 22], ['7d', 73]]);
  assert.equal(quotaTone(22), 'warn'); assert.equal(quotaTone(8), 'err'); assert.equal(quotaTone(60), 'ok');
  assert.equal(runUse({ tokens: 12345, quse: { before: 40, after: 42 } }), '這一輪用了約 2% 額度 · 12k tokens');
  assert.equal(runUse({ quse: { before: 40, after: 40 } }), '這一輪用了不到 1% 額度');
  assert.equal(runUse({}), '');
  assert.match(fnSrc('paintQuota'), /quotaWins\(u\.usage,used\)/);
  assert.match(fnSrc('quotaPop'), /重置/);
  assert.match(fnSrc('wiHtml'), /runUse\(j\)/);
});

test('text size goes down to 70% and the page is zoomed as one below 100%', () => {
  assert.match(fnSrc('applyFs'), /root\.style\.zoom=String\(z\)/);
  assert.match(js, /const FS_MIN=70/);
  assert.match(html, /if\(n>=70&&n<=200\)z=n\/100/);
  assert.match(html, /if\(z<1\)d\.style\.zoom=z/);
  assert.equal(fnSrc('fsName').includes("'極小'"), true);
});

test('settings apply at once (no 儲存): accent, density, chat width, widths and order, shortcuts', () => {
  const look = secSrc('look');
  for (const f of ['applyAccent', 'applyDensity', 'applyChatWidth', 'applyFs', 'resetOrder', 'shortcutSheet']) assert.match(look, new RegExp(f), f);
  assert.doesNotMatch(look, /儲存<\/button>/);
  assert.match(look, /\$\('nick'\)\.oninput=\(\)=>\{clearTimeout\(t\);t=setTimeout\(save,700\)\}/, 'the name saves itself');
  assert.match(html, /octa_accent_css/, 'the accent is there before first paint');
  assert.match(html, /data-density/);
  // accent colours read on their surface in both looks
  const src = read('app/js/prefs.js');
  assert.match(src, /readable\(c,W,4\.6,K\)/);
  assert.match(css, /html\[data-density="compact"\]\{--row-h:44px/);
  assert.match(css, /html\[data-cw="wide"\] \.pane\{--col:1120px\}/);
  assert.match(src, /store\.set\('octa_sidew'/, 'the sidebar width is remembered');
  assert.match(src, /function moveRow\(id,target,after\)/);
  assert.match(fnSrc('renderList'), /ordered\(S\.bots\.filter/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('redraws keep what did not change (no flicker): chat, sidebar and work panel use morph', () => {
  assert.match(fnSrc('renderChat'), /morph\(box,mh\)/);
  assert.match(fnSrc('renderList'), /morph\(\$\('list'\),h\)/);
  assert.match(fnSrc('paintWork'), /morph\(\$\('wpWork'\),h\)/);
  assert.match(js, /const morphKey=n=>n\.nodeType===1\?\(n\.getAttribute\('data-k'\)/);
  // a reply rewritten on the server (one message per turn) replaces the copy here
  assert.match(fnSrc('loadMsgs'), /for\(const x of d\.changed\|\|\[\]\)/);
  assert.match(fnSrc('loadMsgs'), /&since=/);
});
