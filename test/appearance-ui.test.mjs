import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { read, html, js, css, fnSrc } from './app-source.mjs';

// the local API is split into modules: its source is all of desktop/api/*.mjs
const apiDir = new URL('../desktop/api/', import.meta.url);
const api = readdirSync(apiDir).filter(f => f.endsWith('.mjs')).sort().map(f => readFileSync(new URL(f, apiDir), 'utf8')).join('\n');
const log = JSON.parse(read('app/changelog.json'));
const pkg = JSON.parse(read('desktop/package.json'));

test('the look is switched only inside Settings, and the colours fade across', () => {
  assert.doesNotMatch(html, /data-theme-btn|id="hTheme"|id="lTheme"|id="theme"/);
  assert.match(fnSrc('applyTheme'), /h\.classList\.add\('theming'\)/);
  assert.match(css, /html\.theming,html\.theming \*,html\.theming \*::before,html\.theming \*::after\{transition:background-color \.35s ease/);
  for (const k of ['system', 'light', 'dark']) assert.match(js, new RegExp(`\\['${k}','`), k);
  assert.match(js, /data-set-theme="\$\{k\}"/);
  // the choice is per device and applied before the first paint
  assert.match(fnSrc('themeChoice'), /store\.get\('octa_theme'\)/);
  assert.match(html, /s=localStorage\.getItem\('octa_theme'\)/);
});

test('reply to one message, select a part, the little octopus, the browser follows the open bot', () => {
  assert.match(js, /function fragmentSheet/);
  assert.match(js, /選取片段/);
  assert.match(js, /回覆這則/);
  assert.match(html, /id="replybar"/);
  assert.match(js, /data-jump/);
  assert.match(js, /id="frag"/);
  assert.match(js, /function buddySync/);
  assert.match(html, /id="buddy"/);
  assert.match(js, /octa_buddy/);
  assert.match(js, /focusBot\?\.\(id\)/);
  // replies show the quoted message and jump to it
  assert.match(fnSrc('quoteHtml'), /class="qref" data-jump="\$\{m\.reply\}"/);
  assert.match(fnSrc('sendMsg'), /reply:reply\|\|undefined/);
  // a hover toolbar on each message: reply, copy, more
  assert.match(fnSrc('renderChat'), /data-reply="\$\{m\.id\}"[\s\S]*data-copy-msg="\$\{m\.id\}"[\s\S]*data-mmenu="\$\{m\.id\}"/);
});

test('attachments show as thumbnails or file cards before and after sending', () => {
  const att = fnSrc('renderAtt');
  assert.match(att, /class="chip pic\$\{f\.up\?' up':''\}"><img src="\$\{f\.url\}"/);
  assert.match(att, /class="chip file\$\{f\.up\?' up':''\}"><span class="fico">/);
  assert.match(fnSrc('addFiles'), /url:\/\^image\\\/\/\.test\(file\.type\)\?URL\.createObjectURL\(file\):''/);
  assert.match(fnSrc('addFiles'), /fileCache\[r\.id\]=Promise\.resolve\(\{name,mime,data\}\)/);
  assert.match(fnSrc('filesHtml'), /class="fcard" data-open-file="\$\{esc\(f\.id\)\}"/);
  assert.match(js, /function fico\(name,mime\)/);
  assert.match(js, /const fsize=n=>/);
  assert.match(css, /\.chip\.pic\{position:relative;padding:0;border-radius:12px;overflow:hidden;width:64px;height:64px/);
  // pictures are shrunk before upload, GIFs kept
  assert.match(fnSrc('filePayload'), /file\.type!=='image\/gif'/);
  // the server keeps the size with the message so cards show it after a reload, in the order they were attached
  assert.match(api, /SELECT id,name,mime,size FROM files WHERE user_id=\? AND id IN/);
  assert.match(api, /files\.sort\(\(x, y\) => fileIds\.indexOf\(x\.id\) - fileIds\.indexOf\(y\.id\)\)/);
});

test('the desktop version matches the changelog, and older releases are still recorded', () => {
  assert.equal(pkg.version, log[0].v);
  const big = log.find(e => e.v === '4.0.0');
  assert.ok(big, '4.0.0 entry');
  for (const k of ['notes', 'notes_en', 'notes_ja']) assert.equal(big[k].length, 6, k);
  assert.ok(big.notes.some(n => n.includes('完全在你的電腦上')));
  for (const k of ['notes', 'notes_en', 'notes_ja']) assert.ok(log[0][k].length > 0, k);
  assert.ok(big.notes_en.some(n => n.includes('no account')));
  const pair = log.find(x => x.v === '3.4.2');
  assert.ok(pair.notes.some(n => n.includes('配對碼')));
  const backup = log.find(x => x.v === '3.0.32');
  assert.ok(backup.notes.some(n => n.includes('備援')));
  const live = log.find(x => x.v === '3.0.30');
  assert.ok(live.notes.some(n => n.includes('接手')));
  const reply = log.find(x => x.v === '3.0.26');
  assert.ok(reply.notes.some(n => n.includes('回覆對話裡的某一則')));
  const look = log.find(x => x.v === '3.0.13');
  assert.ok(look.notes.some(n => n.includes('字體大小')));
  // the page reads the notes in the chosen language
  assert.match(fnSrc('notesOf'), /I18N\.lang==='en'&&y\.notes_en/);
  assert.match(html, /id="followbar"/);
  assert.match(js, /連接器/);
});
