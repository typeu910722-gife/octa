// OCTA 4.0 web app (app/): structure, local-only API use, desktop bridge, looks, i18n.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { root, read, html, scripts, scriptNames, styleNames, js, css, dict, fnSrc, pure, tr } from './app-source.mjs';

test('index.html is markup only and loads every script and stylesheet that exists', () => {
  assert.ok(html.length < 20000, 'index.html stays small: ' + html.length);
  assert.equal(html.match(/<style/g), null, 'no inline styles block');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(inline.length, 1, 'only the before-first-paint look script is inline');
  assert.ok(inline[0][1].length < 960);   // 4.9: + the 深海 look
  for (const f of scriptNames) assert.ok(scripts[f], f + ' exists');
  assert.deepEqual([...scriptNames].sort(), Object.keys(scripts).sort(), 'every script in app/js is loaded');
  for (const f of styleNames) assert.ok(existsSync(join(root, 'app', 'css', f)), f);
  for (const a of ['icon.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'i18n-core.js', 'i18n-dict.js', 'changelog.json', 'avatar/idle.svg', 'avatar/working.svg', 'avatar/thinking.svg', 'avatar/browsing.svg', 'avatar/chatting.svg']) assert.ok(existsSync(join(root, 'app', a)), a);
  assert.ok(!existsSync(join(root, 'app', 'buddy.png')) && !scripts['buddy.js'], '小八 is gone');
  assert.ok(!existsSync(join(root, 'public', 'index.html')), 'the old one-file page is gone');
  for (const [f, src] of Object.entries(scripts)) {
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f + ' parses');
    assert.ok(src.split('\n').every(l => l.length < 1200) || f === 'bots.js', f + ' has no 4k-character lines');
  }
  for (const f of Object.keys(scripts)) assert.ok(statSync(join(root, 'app', 'js', f)).size < 40000, f + ' stays a readable size');
});

test('the scripts run in order and every element they look up exists', () => {
  // classic scripts share one global scope; nothing at the top level may need a later script before load
  const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
  for (const m of js.matchAll(/\bid="([\w-]+)"/g)) ids.add(m[1]);   // made by templates
  for (const m of js.matchAll(/\.id='([\w-]+)'/g)) ids.add(m[1]);
  for (const m of js.matchAll(/(?:toggleRow|I18N\.select|block)\('([\w-]+)'/g)) ids.add(m[1]);   // helpers that write id="…"
  for (const m of js.matchAll(/paletteHtml\([^)]*?,'([\w-]+)'\)/g)) ids.add(m[1]);
  const used = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  const prefixes = [...js.matchAll(/\bid="([\w-]+)\$\{/g)].map(m => m[1]);   // id="sf_fb${i}"
  const missing = [...used].filter(id => !ids.has(id) && !prefixes.some(p => id.startsWith(p)));
  assert.deepEqual(missing, [], 'ids used with $() but never in the markup or a template');
  // the page can boot: every top-level $('x').on… handler refers to static markup
  const top = [...js.matchAll(/^\$\('([\w-]+)'\)\.(?:on\w+|addEventListener)/gm)].map(m => m[1]);
  const statics = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
  assert.deepEqual(top.filter(id => !statics.has(id)), []);
});

test('only the local API: no accounts, cloud, host moving or coach link', () => {
  const calls = [...js.matchAll(/api\('([\w/-]+)/g)].map(m => m[1]);
  assert.ok(calls.length > 40);
  for (const gone of ['signup', 'login', 'logout', 'password', 'reset', 'reset-code', 'reset/send', 'devices', 'devices/remove', 'runner-token', 'host', 'cron', 'coach'])
    assert.ok(!calls.some(c => c === gone || c.startsWith(gone + '/')), gone + ' is not called');
  assert.doesNotMatch(js + html, /octa\.yzprojecttw\.com|hostOffline|CLOUD_ONLY|HOFF/);
  assert.doesNotMatch(js, /useOffline|useCloud|hostMove|hostBack|onHostProgress|octaDesktop\.connect|\.disconnect\(/);
  // the one sign-in left: a phone pairs with the code shown on the computer
  assert.match(fnSrc('showPair'), /pairLangSel/);
  assert.match(js, /api\('pair','POST',\{code\}\)/);
  assert.match(js, /if\(CFG\.pair&&!TOKEN\)showPair\(\);else start\(\)/);
  assert.match(fnSrc('api_'), /r\.status===401&&path!=='pair'\)\{unpaired\(\)/);
  assert.equal(pure.pairCode(' 7k3p-9qxa '), '7K3P9QXA');
});

test('the desktop bridge keeps its contracts', () => {
  const pre = read('desktop/preload.cjs');
  for (const fn of ['focusBot', 'dock', 'control', 'cover', 'pip', 'onPip', 'onStage', 'show', 'version']) {
    assert.match(js, new RegExp('octaDesktop[^;]*\\b' + fn + '\\b|D\\.' + fn + '\\b|D\\?\\.' + fn), fn + ' used');
    assert.match(pre, new RegExp('\\b' + fn + ':'), fn + ' exists in preload');
  }
  assert.match(js, /window\.octaDesktop\?\.update/);
  // only the open bot's browser stays on screen; dialogs and menus make it step aside; the corner card keeps clear of the last message
  assert.match(fnSrc('focusBrowser'), /focusBot\?\.\(id\)/);
  assert.match(js, /D\.cover\(on\)/);
  assert.match(js, /!\$\('veil'\)\.hidden\|\|!!document\.querySelector\('\.mveil'\)/);
  assert.match(css, /html\.pip \.msgs::after\{content:"";flex:none;height:var\(--pip,0px\)\}/);
  // 4.1: the bot's browser sits in the work panel's 瀏覽器 tab; menus over it make it step aside too
  assert.match(fnSrc('dockSync'), /window\.octaDesktop\.dock\(rect\?\{\.\.\.rect,bot:id,theme:currentTheme\(\)\}:null\)/);
  assert.match(js, /hit\(menu\.getBoundingClientRect\(\),WP\.dock\)/);
  // 接手 / 繼續 from the browser frame, and from the sign-in card
  assert.match(js, /octaDesktop\?\.control\?\.\(hd\.dataset\.hand,true\)/);
  assert.match(js, /const resume=HAND_BUSY\.delete\(d\.bot\)\|\|handWaits\(d\.bot\)/);
});

test('looks: tokens for light and dark, the system decides unless you choose, reduced motion respected', () => {
  const tokens = read('app/css/tokens.css');
  for (const v of ['--bg', '--panel', '--ink', '--accent', '--line', '--r', '--sh-2', '--ring']) assert.match(tokens, new RegExp(v + ':'), v);
  assert.match(tokens, /@media \(prefers-color-scheme:dark\)\{\s*:root:not\(\[data-theme="light"\]\)\{/);
  assert.match(tokens, /:root\[data-theme="dark"\]\{/);
  assert.match(tokens, /"Noto Sans TC","PingFang TC","Microsoft JhengHei"/);
  assert.match(tokens, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(tokens, /:focus-visible\{/);
  // the before-paint script only sets data-theme for a choice; "system" removes it
  assert.match(html, /if\(t==='light'\|\|t==='dark'\)d\.setAttribute\('data-theme',t\)/);
  const applyTheme = fnSrc('applyTheme');
  assert.match(applyTheme, /else delete h\.dataset\.theme/);
  assert.match(applyTheme, /store\.set\('octa_theme',t==='light'\|\|t==='dark'\|\|t==='sea'\?t:null\)/);   // 4.9: and 深海
  assert.match(js, /data-set-theme="\$\{k\}"/);
  assert.match(js, /\[\['system','跟隨系統','monitor'\],\['light','淺色','sun'\],\['dark','深色','moon'\],\['sea','深海','sea'\]\]/);
  // colours are tokens: components never hard-code the gold
  for (const f of ['components.css', 'layout.css', 'chat.css']) assert.doesNotMatch(read('app/css/' + f).replace(/url\("data:[^"]+"\)/g, ''), /#d4a23c|#96661a|#e2ae4d/i, f);
});

test('text size applies to the whole interface and is remembered on the device', () => {
  assert.match(fnSrc('applyFs'), /store\.set\('octa_fs',String\(p\)\)/);
  assert.match(js, /type="range" min="70" max="200"/, '4.8: smaller sizes too');
  assert.match(html, /var f=localStorage\.getItem\('octa_fs'\);var map=\{s:\.93,m:1,l:1\.12,xl:2\}/);
  assert.match(css, /html\[data-fs="s"\]\{--fz:\.93\}html\[data-fs="l"\]\{--fz:1\.12\}html\[data-fs="xl"\]\{--fz:2\}/);
  assert.match(css, /body\{[^}]*font-size:calc\(14\.5px \* var\(--fz\)\)/);
  assert.match(css, /\.bub\{[^}]*font-size:calc\(15px \* var\(--fz\)\)/);
});

test('settings is one page with eight sections', () => {
  const secs = [...fnSrc('SECTIONS').matchAll(/\['(\w+)','([^']+)'/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(secs, [['look', '外觀與語言'], ['ai', 'AI 連線'], ['browser', '瀏覽器'], ['noti', '通知'], ['remote', '手機遠端'], ['pcs', '電腦'], ['work', '工作與排程'], ['adv', '進階']]);
  for (const [k] of secs) assert.match(js, new RegExp('SEC\\.' + k + '='), k + ' renders');
  // switching sections asks about unsaved edits first; sub pages have a way back
  assert.match(fnSrc('settingsFrame'), /\.snav \[data-s\]'\)\.forEach\(b=>b\.onclick=\(\)=>leaveOk\(/);
  assert.match(fnSrc('subPage'), /SUB\.back=back/);
  // what lives where
  for (const [k, what] of [['look', /nick/], ['ai', /openAI\(focus\)/], ['ai', /warmSel/], ['browser', /desktop\/ext-token/], ['browser', /shareBrowser/], ['noti', /notify\/test/], ['remote', /desktop\/remote/], ['pcs', /linkGet\(\)/], ['work', /schedList\(\)/], ['work', /jobMax/], ['work', /review\/run/], ['work', /openLogs\(\)/], ['work', /openBoard\(\)/], ['adv', /notes/], ['adv', /paintConnectors/], ['adv', /paintStore/], ['adv', /openCode\(\)/], ['adv', /desktop\/autostart/], ['adv', /paintVersion/]]) {
    const a = js.indexOf('SEC.' + k + '='), rest = js.slice(a + 4), b = rest.search(/\n(?:SEC\.|\/\* -{5})/);
    const src = rest.slice(0, b < 0 ? undefined : b);
    assert.match(src, what, k + ' has ' + what);
  }
  assert.match(css, /\.sgrid\{display:grid;grid-template-columns:248px minmax\(0,1fr\)/);
  assert.match(css, /\.sgrid:not\(\.at-nav\) \.snav\{display:none\}/, 'the phone shows the section list, then one section');
});

test('a new bot needs only a name; everything else lives in its detail panel', () => {
  const nb = fnSrc('newBotSheet');
  assert.match(nb, /id="nbName"/);
  assert.doesNotMatch(nb, /sf_e|engine select|sf_b/);
  assert.match(nb, /api\('bots','POST',\{name,task:'',engine:firstEngine\(\),color:pal\.get\(\)/);
  assert.match(nb, /paletteHtml\(first,'nbPal'\)/, 'a name and a colour from the palette');
  assert.doesNotMatch(js, /emojiRow|EMOJIS|bindEmoji/, 'no emoji avatars any more');
  assert.equal(pure.freeName('新機器人', ['新機器人', '新機器人2']), '新機器人3');
  assert.equal(pure.nameProblem('客服 小幫手', ''), '名稱不能有空格，才能用 @ 叫它');
  assert.equal(pure.nameProblem('舊 名字', '舊 名字'), '', 'an old name with a space may stay');
  const d = fnSrc('paintDetail');
  for (const k of ["dsec('task'", "dsec('rt'", "dsec('mem'", "dsec('ai'", "dsec('auth'", "dsec('brw'", "dsec('more'"]) assert.ok(d.includes(k), k);
  for (const id of ['sf_e', 'sf_m', 'sf_fb', 'sf_au', 'sf_b', 'sf_stand', 'sf_q', 'sf_f', 'rt']) assert.match(d, new RegExp('id="' + id + '"|id=\\\\?"' + id), id);
  // one 儲存 saves the open routine form and a typed memory line too; unsaved edits are flagged and guarded
  assert.match(d, /rf\._save\(true\)/);
  assert.match(d, /addMem&&!\(await addMem\(\)\)/);
  assert.match(d, /trackDirty\(box\.querySelector\('\.dp'\),saveAll\)/);
  assert.match(d, /data-dirty-bar/);
  assert.match(fnSrc('leaveInfo'), /isDirty\(\)&&\$\('detail'\)\.contains\(DIRTY\.el\)\)\{leaveOk/);
  assert.match(fnSrc('closePanel'), /leaveInfo\(/);
  assert.match(fnSrc('detailLive'), /isDirty\(\)\|\|rtEdit!=null/, 'live updates never redraw over your edits');
  // phone: the panel is a full page with back
  assert.match(css, /\.wp\{position:fixed;inset:0;z-index:40/);
});

test('first run: connect an AI, then create the first bot', () => {
  assert.match(fnSrc('tourOn'), /!S\.bots\.length&&!store\.get\('ebot_guided'\)/);
  const t = fnSrc('paintTour');
  assert.match(t, /連接一個 AI/);
  assert.match(t, /desktop\/install/);
  assert.match(t, /engine-install/);
  assert.match(t, /testAI\(/);
  assert.match(t, /建立第一個機器人/);
  assert.match(t, /bindTpl\(s2/);
  assert.match(fnSrc('start'), /if\(tourOn\(\)\)startTour\(\);else whatsNew\(\)/);
});

test('features stay reachable', () => {
  for (const f of ['goAsk', 'apprHtml', 'alwaysSheet', 'compactConv', 'clearConv', 'dupBot', 'deleteConv', 'folderSheet', 'groupSheet', 'tplSheet', 'openLogs', 'openBoard', 'openCode', 'grokImport', 'remoteUrl', 'shotSheet', 'urlSheet', 'pollLive', 'renderAsks', 'fragmentSheet', 'pickTarget', 'setReply', 'runSlash', 'renderRoutines', 'bindMem', 'focusSearch', 'whatsNew', 'renderPanel', 'paintWork', 'paintWeb', 'paletteHtml', 'octSvg', 'notifyNew', 'apprNag', 'saveDraft', 'loadDraft'])
    assert.ok(fnSrc(f), f);
  assert.match(js, /\(mod&&k==='k'&&app\)\{e\.preventDefault\(\);focusSearch\(\)\}/, 'Ctrl+K');
  assert.match(js, /\(e\.altKey&&k==='n'\)/, 'Alt+N new bot');
  assert.match(js, /if\(mod&&e\.key===','&&app\)\{e\.preventDefault\(\);openSettings\(\)\}/, 'Ctrl+, settings');
  for (const c of ['/瀏覽器', '/停止', '/歷史畫面', '/詳細資料', '/壓縮對話', '/清空對話', '/網址']) assert.ok(fnSrc('slashItems').includes(c), c);
  assert.match(fnSrc('renderList'), /class="apbar" data-apgo=/);
  assert.match(fnSrc('listTag'), /<i class="ub" title=/, 'unread badges (4.8: with a tooltip)');
  assert.match(fnSrc('itemMenu'), /pin.*mute.*dup.*cmp.*clr.*del/s);
});

test('every piece of interface text has English and Japanese (Simplified Chinese is converted)', () => {
  const py = spawnSync('python3', [join(root, 'i18n', 'missing.py')], { encoding: 'utf8' });
  if (py.error) return;   // no Python here: the dictionary checks below still run
  assert.equal(py.status, 0, py.stderr);
  assert.equal(py.stdout.trim(), '', 'untranslated:\n' + py.stdout);
  assert.match(py.stderr, /^0 missing/m);
});

test('the dictionary covers the new screens in every language', () => {
  for (const s of ['外觀與語言', 'AI 連線', '手機遠端', '工作與排程', '進階', '連接你的電腦', '歡迎使用 OCTA', '建立第一個機器人', '詳細資料', '它的工作', '做事權限', '新機器人', '跟隨系統', '待你核准', '核准（只這次）']) {
    assert.ok(tr('en', s), s + ' en'); assert.ok(tr('ja', s), s + ' ja'); assert.ok(dict['zh-CN'].t[s], s + ' zh-CN');
  }
  assert.match(tr('en', '連接你的電腦'), /^Connect/);
  assert.match(dict['zh-CN'].t['詳細資料'], /^详细/);
  assert.equal(tr('en', '目前：開啟，每 30 分鐘巡查一次').includes('30'), true);
  // the language can be switched from the pairing screen and from Settings
  assert.match(fnSrc('showPair'), /I18N\.set\(e\.target\.value\)/);
  assert.match(fnSrc('setLang'), /I18N\.set\(l\);api\('settings','PUT',\{lang:l\}\)/);
  assert.match(js, /window\.addEventListener\('octa-lang',/);
  // text inside data-u (names, messages) is never translated; system notes are
  assert.match(fnSrc('renderChat'), /<div class="sys"><span>\$\{esc\(t\)\}<\/span>/);
});

test('phone: list ↔ chat ↔ details, bottom-safe composer, back goes up one level', () => {
  assert.match(css, /@media \(max-width:760px\)\{[\s\S]*\.pane\{position:fixed;inset:0;z-index:10;transform:translateX\(100%\)/);
  assert.match(css, /\.app\.chat \.pane\{transform:none;visibility:visible\}/);
  assert.match(css, /\.composer\{[^}]*padding:[^;}]*var\(--safe-b\)/);
  assert.match(html, /viewport-fit=cover,interactive-widget=resizes-content/);
  assert.match(fnSrc('navPush'), /if\(!phoneUI\(\)\)return;if\(navSkip>0\)\{navQueue\.push\(k\);return\}/);
  assert.match(js, /else if\(k==='detail'\)\{closeDetail\(true\)\}/);
  assert.match(js, /if\(dy>110\)closeSheet\(\)/);
  assert.match(css, /\.menu\.asheet\{/);
  assert.match(js, /class="mcancel">取消</);
});
