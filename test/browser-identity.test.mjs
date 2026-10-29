import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KEEP_DAYS, clientHintHeaders, electronCookie, googleRefused, identity } from '../desktop/browser-catalog.mjs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const NOW = 1_800_000_000;

test('the bot page presents the Chrome build it runs on, with matching client hints', () => {
  const id = identity('chrome', '152.0.7977.130', 'win32', 'x64');
  assert.equal(id.userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  assert.doesNotMatch(id.userAgent, /Electron|OCTA|octa/);
  assert.deepEqual(id.metadata.brands.map(b => b.brand), ['Not_A Brand', 'Chromium', 'Google Chrome']);
  assert.ok(id.metadata.brands.every(b => b.brand === 'Not_A Brand' || b.version === '152'));
  assert.equal(id.metadata.architecture, 'x86');
  assert.equal(identity('chrome', '152.0.7977.130', 'darwin', 'arm64').metadata.architecture, 'arm');

  const low = clientHintHeaders(id, { 'User-Agent': 'x', 'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24"' });
  assert.equal(low['sec-ch-ua'], '"Not_A Brand";v="24", "Chromium";v="152", "Google Chrome";v="152"');
  assert.equal(low['sec-ch-ua-mobile'], '?0');
  assert.equal(low['sec-ch-ua-platform'], '"Windows"');
  assert.equal('sec-ch-ua-full-version-list' in low, false, 'a hint the site did not ask for is not added');

  const asked = clientHintHeaders(id, { 'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7977.130"', 'sec-ch-ua-platform-version': '"10.0.0"', 'Sec-CH-UA-Arch': '"x86"' });
  assert.equal(asked['sec-ch-ua-full-version-list'], '"Not_A Brand";v="24.0.0.0", "Chromium";v="152.0.7977.130", "Google Chrome";v="152.0.7977.130"');
  assert.equal(asked['sec-ch-ua-platform-version'], '"15.0.0"');
  assert.equal(asked['sec-ch-ua-arch'], '"x86"');

  const edge = clientHintHeaders(identity('edge', '152.0.7977.130'), {});
  assert.match(edge['sec-ch-ua'], /"Microsoft Edge";v="152"/);
  const fox = clientHintHeaders(identity('firefox', '156.0'), { 'sec-ch-ua-full-version-list': 'x' });
  assert.equal(fox['sec-ch-ua'], null);
  assert.equal(fox['sec-ch-ua-full-version-list'], null);
});

test('Chrome window cookies go into the in-app browser the way Electron accepts them', () => {
  // a domain cookie from Storage.getCookies
  const sid = electronCookie({ name: 'SID', value: 'abc', domain: '.google.com', path: '/', secure: false, httpOnly: false, expires: NOW + 100, sameSite: 'None' }, NOW);
  assert.deepEqual(sid, { url: 'http://google.com/', name: 'SID', value: 'abc', path: '/', secure: false, httpOnly: false, domain: '.google.com', sameSite: 'no_restriction', expirationDate: NOW + 100 });
  // __Secure- must be secure (https) even if the copy lost the flag
  const ps = electronCookie({ name: '__Secure-1PSID', value: 'x', domain: '.google.com', path: '/', expires: NOW + 100 }, NOW);
  assert.equal(ps.secure, true);
  assert.equal(ps.url, 'https://google.com/');
  // __Host- never carries a domain and always has path /
  const host = electronCookie({ name: '__Host-GAPS', value: 'g', domain: 'accounts.google.com', path: '/x', secure: true, expires: NOW + 100, sameSite: 'Lax' }, NOW);
  assert.equal('domain' in host, false);
  assert.equal(host.path, '/');
  assert.equal(host.url, 'https://accounts.google.com/x');
  assert.equal(host.sameSite, 'lax');
  // the runner's cookieParams() form: a url instead of a domain
  const byUrl = electronCookie({ name: 'sessionid', value: 's', url: 'https://www.instagram.com/', path: '/', secure: true, httpOnly: true }, NOW);
  assert.equal(byUrl.url, 'https://www.instagram.com/');
  assert.equal('domain' in byUrl, false);
  // a session cookie is kept like a remembered login
  assert.equal(byUrl.expirationDate, NOW + KEEP_DAYS * 86400);
  // Electron's own names (from the in-app jar) still map
  assert.equal(electronCookie({ name: 'a', value: '1', domain: '.x.test', sameSite: 'strict', expires: NOW + 5 }, NOW).sameSite, 'strict');
  assert.equal('sameSite' in electronCookie({ name: 'a', value: '1', domain: '.x.test', sameSite: 'unspecified', expires: NOW + 5 }, NOW), false);
  // nothing to set
  assert.equal(electronCookie({ name: 'old', value: '1', domain: '.x.test', expires: NOW - 1 }, NOW), null);
  assert.equal(electronCookie({ name: '', value: '1', domain: '.x.test' }, NOW), null);
  assert.equal(electronCookie({ name: 'a', value: '1' }, NOW), null);
  assert.equal(electronCookie({ name: 'n', value: undefined, domain: 'x.test', expires: NOW + 5 }, NOW).value, '');
});

test('only a real refusal sends the bot to Chrome; a plain sign-in page is tried in OCTA', () => {
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/rejected?continue=x'), true);
  assert.equal(googleRefused('https://accounts.google.com/signin/rejected'), true);
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/identifier?continue=x'), false);
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/identifier', '無法登入\n這個瀏覽器或應用程式可能不安全。'), true);
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/identifier', "Couldn't sign you in\nThis browser or app may not be secure."), true);
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/challenge/pwd', '密碼錯誤，請再試一次'), false);
  assert.equal(googleRefused('https://example.test/rejected', '這個瀏覽器或應用程式可能不安全'), false);
  assert.equal(googleRefused('not a url', 'x'), false);
});

test('the desktop app gives cross-site frames the same identity and can switch a bot back from Chrome', () => {
  const main = read('../desktop/main.mjs');
  // cross-site frames get the same identity; their events never reach Playwright
  assert.match(main, /Target\.setAutoAttach/);
  assert.match(main, /async function dressChild\(wc, ev\)/);
  assert.match(main, /Runtime\.runIfWaitingForDebugger/);
  assert.match(main, /if \(sessionId \|\| method === 'Target\.attachedToTarget'/);
  assert.match(main, /googleRefused\(url, text\)/);
  assert.match(main, /useEmbedded, mode: browserMode/);
  assert.match(main, /runnerMod\.returnToEmbed\(bot, \{ manual: true \}\)/);
  assert.doesNotMatch(main, /^function electronCookie/m, 'one cookie conversion, the tested one');
  const server = read('../desktop/server.mjs');
  assert.match(server, /p === 'browser-mode'/);
  assert.match(server, /p === 'browser-embed'/);
  const bridge = read('../desktop/cdp-bridge.mjs');
  assert.match(bridge, /adapter\.version\?\.\(\)/);
});
