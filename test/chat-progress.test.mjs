// 4.7 (track B): live step progress, approval cards with 對象／內容／時間, the bots' markers as chips,
// layered replies and 同事協作 — the plain functions (app/js/pure.js) and how the chat / work panel use them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { css, fnSrc, html, pure, read } from './app-source.mjs';

test('progress: JSON from the runner, an object from the API, or an old plain line', () => {
  const { progOf, progView } = pure;
  const json = JSON.stringify({ text: '正在讀貳宿聊天列表', step: 2, total: 5, steps: ['打開', '讀列表', '整理', '擬回覆', '回報'], kind: 'browse', at: 9 });
  const v = progView(json);
  assert.equal(v.has, true);
  assert.equal(v.cur, '正在讀貳宿聊天列表');
  assert.deepEqual(v.list.map(s => s.st), ['done', 'now', 'next', 'next', 'next']);
  assert.equal(v.pct, 30);
  assert.deepEqual(progView(JSON.parse(json)).list, v.list, 'already parsed by /api/state');
  // old runners: one line of text, no steps, no bar
  const old = progView('讀取網頁內容');
  assert.deepEqual([old.has, old.cur, old.total, old.list.length, old.pct], [false, '讀取網頁內容', 0, 0, 0]);
  assert.equal(progOf('').text, '');
  assert.equal(progOf(null).text, '');
  assert.equal(progOf('{broken').text, '{broken', 'not JSON after all: shown as it is');
  // total without a list, step past the end, no step yet, words missing
  assert.deepEqual([progView({ step: 3, total: 4 }).has, progView({ step: 3, total: 4 }).cur], [true, '']);
  assert.equal(progOf({ step: 9, total: 4 }).step, 4);
  assert.equal(progView({ steps: ['a', 'b'] }).has, false, 'a plan but no step yet: no 「步驟 0/2」');
  assert.equal(progView({ step: 2, steps: ['a', 'b', 'c'] }).cur, 'b', 'no text: the step itself');
  assert.equal(progOf({ kind: 'weird' }).kind, '');
  assert.equal(progView({ step: 5, total: 5 }).pct, 90);
  assert.equal(progView({ step: 1, total: 30 }).pct, 4, 'a sliver shows at the start');
});

test('the avatar and group members read the new progress too', () => {
  const { botState, memberState } = pure;
  const busy = p => [{ bot_id: 'b', status: 'running', progress: p }];
  assert.equal(botState('b', busy(JSON.stringify({ text: '整理名單', kind: 'browse' }))), 'browsing');
  assert.equal(botState('b', busy(JSON.stringify({ text: '整理名單', step: 1, total: 3 }))), 'working');
  assert.equal(botState('b', busy({ text: '', step: 1, total: 3 })), 'working', 'a plan is more than thinking');
  assert.equal(botState('b', busy('')), 'thinking');
  assert.equal(botState('b', busy('打開 https://x.com')), 'browsing', 'old lines still work');
  assert.equal(memberState('b', busy({ text: '整理名單' }), []).p, '整理名單', 'not [object Object]');
});

test('markers become chips; the chat keeps only the words', () => {
  const { parseNotes, msgView, noteChips } = pure;
  const src = '今天有 3 則新訊息。\n\n- 王小姐：已回覆\n📌記住：週末不回\n📌 記住：用敬語\n📇事實：302 可以加床\n⏰例行任務：巡訊息｜09:00,13:30｜檢查訊息\n⏰停用：舊的巡查\n🧩技能：回訊息\n1. 打開\n2. 回\n🧩結束\n📘手冊：下載報表｜登入 → 報表 → 下載\n🗺️網站筆記：2bnb.tw｜訊息在左邊第二個\n📝任務更新：\n負責貳宿訊息\n📝結束\n📍 目前頁面：https://host.2bnb.tw/inbox\n🧭步驟：打開｜讀｜回\n【開瀏覽器】https://x.com\n【派瀏覽】\n網址：x\n要做的事：y\n【派完】\n✅ 完成：回了 3 則';
  const r = parseNotes(src);
  assert.equal(r.text, '今天有 3 則新訊息。\n\n- 王小姐：已回覆');
  assert.deepEqual(r.result, { ok: true, text: '回了 3 則' });
  assert.deepEqual(r.steps, ['打開', '讀', '回']);
  const types = r.notes.map(n => n.type).sort();
  assert.deepEqual(types, ['memory', 'memory', 'memory', 'page', 'routine', 'routine', 'site', 'skill', 'skill', 'task'].sort());
  assert.deepEqual(r.notes.find(n => n.type === 'routine' && !n.op), { type: 'routine', title: '巡訊息', body: '檢查訊息', when: '09:00,13:30' });
  assert.equal(r.notes.find(n => n.type === 'task').body, '負責貳宿訊息');
  assert.deepEqual(parseNotes('⚠ 沒做成：LINE 要重新登入').result, { ok: false, text: 'LINE 要重新登入' });
  assert.deepEqual(parseNotes('⚠️ 沒做成：x').result, { ok: false, text: 'x' });
  assert.equal(parseNotes('✅待確認：傳給客人').result, null, 'a card is not a result');
  assert.equal(parseNotes('【回覆】好的，馬上做').text, '好的，馬上做');
  assert.equal(parseNotes('只是回答').notes.length, 0);
  // chips: several 📌 make one; each ⏰ is its own; daily times read 「每天」
  const cs = noteChips(r.notes);
  assert.deepEqual(cs.map(c => c.type), ['routine', 'routine', 'memory', 'skill', 'task', 'site', 'page']);
  assert.deepEqual([cs[0].label, cs[0].daily, cs[0].when, cs[0].name], ['已排程', true, '09:00、13:30', '巡訊息']);
  assert.deepEqual([cs[1].label, cs[1].name], ['已停用例行任務', '舊的巡查']);
  assert.equal(cs[2].n, 3);
  assert.deepEqual([cs[3].label, cs[3].name], ['新技能', '回訊息、下載報表']);
  assert.equal(cs[6].name, 'host.2bnb.tw', 'the page by its host');
  assert.equal(noteChips([{ type: 'routine', title: '巡訊息', body: '', when: '每30分鐘' }])[0].daily, false);
  assert.equal(noteChips([{ type: 'skill', title: '下載報表', manual: true }])[0].label, '做事手冊');
  // A's meta keeping 名稱｜時間｜事 in one field still reads well
  assert.deepEqual((({ when, name, daily }) => ({ when, name, daily }))(noteChips([{ type: 'routine', title: '巡訊息｜09:00｜檢查' }])[0]), { when: '09:00', name: '巡訊息', daily: true });
  // meta first (contract §3), the text's own markers too, no duplicates; a string meta is parsed
  const meta = { notes: [{ type: 'memory', title: '', body: '週末不回' }], result: { ok: false, text: '沒登入' } };
  const v = msgView({ text: '好的。\n📌記住：週末不回\n📌記住：用敬語', meta: JSON.stringify(meta) });
  assert.equal(v.text, '好的。');
  assert.deepEqual(v.notes.map(n => n.body), ['週末不回', '用敬語']);
  assert.deepEqual(v.result, { ok: false, text: '沒登入' });
  assert.deepEqual(msgView({ text: 'x', meta: '{bad' }).notes, []);
  assert.equal(msgView({ text: 'x', meta: { result: { ok: true } } }).result.ok, true);
  assert.equal(msgView({ text: '✅ 完成：好了', meta: null }).result.text, '好了', 'old messages: parsed from the text');
});

test('long replies open with their first paragraph; the rest folds', () => {
  const { foldReply } = pure;
  const table = '整理好了，共 3 筆，1 筆要你確認。\n\n| 時間 | 客人 |\n|---|---|\n| 09:12 | 王小姐 |';
  assert.deepEqual(foldReply(table), { head: '整理好了，共 3 筆，1 筆要你確認。', rest: '| 時間 | 客人 |\n|---|---|\n| 09:12 | 王小姐 |' }, 'a table always folds');
  assert.deepEqual(foldReply('好的。\n\n明天見。'), { head: '好的。\n\n明天見。', rest: '' }, 'short replies stay whole');
  const long = '第一段結論。\n\n' + '細節'.repeat(200);
  assert.equal(foldReply(long).head, '第一段結論。');
  assert.equal(foldReply('- a\n- b').rest, '', 'starting with a list: nothing short to lead with');
  assert.deepEqual(foldReply(''), { head: '', rest: '' });
  assert.equal(foldReply('結論\n- 一\n- 二\n' + '說明'.repeat(200)).head, '結論');
});

test('the approval card reads 對象／內容／時間 under ✅待確認, and the text above it loses them', () => {
  const { apprFields, apprStrip } = pure;
  const t = '陳先生問能不能加床：\n✅待確認：回覆貳宿客人 陳先生\n對象：貳宿 · 陳先生\n內容：陳先生您好，可以加床。\n加床費每晚 500 元。\n時間：今天 12:00';
  assert.deepEqual(apprFields(t), { act: '回覆貳宿客人 陳先生', to: '貳宿 · 陳先生', content: '陳先生您好，可以加床。\n加床費每晚 500 元。', when: '今天 12:00', impact: '' });
  assert.equal(apprStrip(t), '陳先生問能不能加床：');
  assert.deepEqual(apprFields('✅待確認：付款 1200 元'), { act: '付款 1200 元', to: '', content: '', when: '', impact: '' }, 'the old one-line card');
  assert.equal(apprFields('沒有卡片'), null);
  assert.equal(apprFields('✅待確認：x\n內容：「您好」').content, '您好', 'quotes around the whole text go');
  assert.equal(apprFields('✅待確認：x\n影響：客人會收到\n對象：王').impact, '客人會收到');
  assert.equal(apprFields('✅待確認：x\n內容：第一行\n📌記住：別的').content, '第一行', 'a marker ends the content');
  // 內容 may hold paragraphs: it runs to the end (the card is the message's last part) — the same in both
  assert.equal(apprStrip('前言\n✅待確認：x\n內容：a\n\nb'), '前言');
  assert.equal(apprFields('前言\n✅待確認：x\n內容：a\n\nb').content, 'a\n\nb');
  assert.equal(apprStrip('前言\n✅待確認：x\n對象：王\n\n後記'), '前言\n\n後記', 'other fields end at their line');
});

test('同事協作: waiting / answered / failed with durations, and who is waiting on whom', () => {
  const { collabItems, collabWait, minsOf } = pure;
  const now = 1_000_000;
  const rows = [
    { id: 1, from: 'a', to: 'r', kind: 'ask', what: '空房', reply: '有 2 間', status: 'done', created: now - 600000, ms: 40000 },
    { id: 2, from: 'a', to: 'r', kind: 'ask', what: '停車', status: 'running', created: now - 200000 },
    { id: 3, from: 'a', to: 'c', kind: 'give', what: '貼價目表', status: 'error', created: now - 300000, ms: 5000 },
    { id: 4, from: 'x', to: 'a', kind: 'ask', what: '別人問的', status: 'pending', created: now - 100000 }
  ];
  const xs = collabItems(rows, now);
  assert.deepEqual(xs.map(x => x.st), ['ok', 'run', 'fail', 'wait']);
  assert.deepEqual(xs.map(x => x.dur), [40000, 200000, 5000, 100000]);
  assert.equal(xs[2].kind, 'give');
  assert.deepEqual(collabWait(rows, ['a'], now), { from: 'a', to: 'r', since: now - 200000, dur: 200000, kind: 'ask', n: 1 });
  assert.equal(collabWait(rows, ['zzz'], now), null);
  assert.equal(collabWait(rows.slice(0, 1), ['a'], now), null, 'answered: nobody waits');
  assert.equal(minsOf(200000), 3);
  assert.equal(minsOf(-5), 0);
});

test('the chat, panel and sidebar use them (and stay readable for old data)', () => {
  const row = fnSrc('renderChat');
  assert.match(row, /const v=msgView\(m\)/, 'bot messages go through msgView');
  assert.match(row, /foldReply\(body\)/);
  assert.match(row, /notesHtml\(m,v\.notes\)/);
  assert.match(row, /typing\.map\(jobChip\)/, 'a running job is one line with steps, 暫停 and 停止');
  assert.match(fnSrc('jobChip'), /data-jpause|pauseBtn\(x\)/);
  assert.match(fnSrc('jobChip'), /data-jstop/);
  assert.match(fnSrc('pauseBtn'), /data-on="\$\{resume\?0:1\}"/);
  assert.match(fnSrc('jobPause'), /api\('job\/'\+job\+'\/pause','POST',\{on\}\)/, 'contract §2');
  assert.match(fnSrc('pauseOf'), /x\.paused/);
  assert.match(fnSrc('progLine'), /這一步做完會暫停/);
  assert.match(fnSrc('apprHtml'), /apprFields\(m\.text\)/);
  assert.match(fnSrc('apprHtml'), /核准（只這次）[\s\S]*一律允許[\s\S]*修改[\s\S]*拒絕/);
  assert.match(fnSrc('apprEditSend'), /'核准：'\+act/, 'an edit goes back as the approval: nothing to type');
  assert.match(fnSrc('curCard'), /v\.list\.length/, 'the step plan in 工作');
  assert.match(fnSrc('curCard'), /WP\.steps\[x\.job\]/, 'older runners: the reported lines');
  assert.match(fnSrc('paintWork'), /collabHtml\(id\)/);
  assert.match(fnSrc('paintCollab'), /collabWait\(BS\[c\.id\]\?\.items/);
  assert.match(fnSrc('rowHtml'), /runLine\(c\.id,st\)/, 'the sidebar row shows 2/5');
  assert.match(html, /id="cwait"/);
  assert.match(fnSrc('trackJobs'), /progOf\(x\.progress\)\.text/);
  for (const sel of ['.jchip', '.jbar', '.nchip', '.nfull', '.rres', '.apbody', '.aped', '.cwait', '.lbar']) assert.ok(css.includes(sel + '{'), sel + ' styled');
  assert.ok(read('app/css/workpanel.css').includes('.wsteps.plan li.done .wck'), 'done steps get a check');
  assert.match(css, /@media \(max-width:760px\)\{\n {2}\.jchip\{/, 'the phone layout of the chip');
});
