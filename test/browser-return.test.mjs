import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { googleLoginDone, googleLoginMark, googleSignedIn } from '../public/octa-runner.mjs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const NOW = 1_800_000_000;
const ck = (name, domain, extra = {}) => ({ name, domain, value: 'v-' + name, path: '/', secure: true, httpOnly: true, expires: NOW + 86400, ...extra });

test('a Chrome profile counts as signed in to Google only with a live sign-in cookie on google.com', () => {
  assert.equal(googleSignedIn([ck('SID', '.google.com')], NOW), true);
  assert.equal(googleSignedIn([ck('__Secure-1PSID', '.google.com')], NOW), true);
  assert.equal(googleSignedIn([ck('__Secure-3PSID', 'google.com')], NOW), true);
  // cookies every visitor gets, other sites, and the accounts page's own cookies are not a sign-in
  assert.equal(googleSignedIn([ck('NID', '.google.com'), ck('AEC', '.google.com'), ck('LSID', 'accounts.google.com'), ck('__Host-GAPS', 'accounts.google.com')], NOW), false);
  assert.equal(googleSignedIn([ck('SID', '.youtube.com'), ck('SID', '.google.com.evil.test')], NOW), false);
  assert.equal(googleSignedIn([ck('SID', '.google.com', { expires: NOW - 10 })], NOW), false);
  assert.equal(googleSignedIn([ck('SID', '.google.com', { value: '' })], NOW), false);
  assert.equal(googleSignedIn([ck('SID', '.google.com', { expires: 0 })], NOW), true);   // a session cookie still signs in
  assert.equal(googleSignedIn(null, NOW), false);
});

test('only a new Google sign-in in the Chrome window brings the bot back, not the one it already had', () => {
  const old = [ck('SID', '.google.com'), ck('__Secure-1PSID', '.google.com'), ck('NID', '.google.com')];
  const before = googleLoginMark(old, NOW);
  assert.ok(before);
  assert.equal(googleLoginMark([ck('NID', '.google.com')], NOW), '');
  assert.equal(googleLoginDone(before, old, NOW), false);
  assert.equal(googleLoginDone(before, [old[0], old[1], ck('NID', '.google.com', { value: 'changed' })], NOW), false, 'other cookies changing is not a sign-in');
  assert.equal(googleLoginDone(before, [ck('SID', '.google.com', { value: 'new' }), old[1]], NOW), true);
  assert.equal(googleLoginDone('', old, NOW), true, 'signed out before, signed in now');
  assert.equal(googleLoginDone(before, [ck('NID', '.google.com')], NOW), false, 'signed out is never done');
  // the order cookies come back in does not matter
  assert.equal(googleLoginMark([...old].reverse(), NOW), before);
});

test('the runner, the server and the page carry the way back from the Chrome window', () => {
  const runner = read('../public/octa-runner.mjs');
  assert.match(runner, /export async function returnToEmbed\(bot, opts = \{\}\)/);
  assert.match(runner, /openBrowser\(bot, \{ noBack: true \}\)/, 'switching to Chrome must not bounce straight back');
  assert.match(runner, /api\('runner\/note'/);
  const api = read('../functions/api/[[path]].js');
  assert.match(api, /path === 'runner\/note' && m === 'POST'/);
  const page = read('../public/index.html');
  assert.match(page, /desktop\/browser-embed/);
  assert.match(page, /改回內建瀏覽器/);
  assert.match(page, /因 Google 登入改用 Chrome 視窗/);
});
