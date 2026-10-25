import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENGINE_IDS, braveDownload, chromeDownload, edgeDownload, firefoxDownload, identity, pageNeedsAttention, pageUnsupported } from '../desktop/browser-catalog.mjs';

test('the in-app page can present a current browser instead of Electron', () => {
  for (const engine of ENGINE_IDS) {
    const id = identity(engine, engine === 'firefox' ? '156.0' : '156.0.8078.47', 'win32', 'x64');
    assert.equal(id.engine, engine);
    assert.doesNotMatch(id.userAgent, /Electron/);
  }
  const chrome = identity('chrome', '156.0.8078.47');
  assert.match(chrome.userAgent, /Chrome\/156\.0\.8078\.47/);
  assert.doesNotMatch(chrome.userAgent, /Edg\//);
  assert.ok(chrome.metadata.brands.some(b => b.brand === 'Google Chrome'));
  const edge = identity('edge', '156.0.4314.42');
  assert.match(edge.userAgent, /Edg\/156\.0\.4314\.42/);
  assert.ok(edge.metadata.brands.some(b => b.brand === 'Microsoft Edge'));
  const firefox = identity('firefox', '156.0');
  assert.match(firefox.userAgent, /Firefox\/156\.0/);
  assert.equal(firefox.metadata, null);
  assert.equal(firefox.clientHint, '');
  const brave = identity('brave', '1.98.60');
  assert.ok(brave.metadata.brands.some(b => b.brand === 'Brave'));
});

test('a refused LINE page is recognized, and a normal page is not', () => {
  assert.equal(pageUnsupported('請使用最新版本的 Google Chrome。不支援此瀏覽器'), true);
  assert.equal(pageNeedsAttention('您輸入的內容有誤'), true);
  assert.equal(pageNeedsAttention('登入完成'), false);
  assert.equal(pageUnsupported('您輸入的內容有誤'), false);
});

test('OCTA can find a portable copy of Chrome, Brave, and Firefox', () => {
  const chrome = chromeDownload({
    channels: { Stable: { version: '156.0.8078.47', downloads: { chrome: [
      { platform: 'linux64', url: 'https://example.test/linux.zip' },
      { platform: 'win64', url: 'https://example.test/win.zip' }
    ] } } }
  }, 'win64');
  assert.equal(chrome.url, 'https://example.test/win.zip');
  assert.equal(chrome.version, '156.0.8078.47');
  const brave = braveDownload({
    tag_name: 'v1.98.60',
    assets: [{ name: 'brave-v1.98.60-win32-x64.zip', browser_download_url: 'https://example.test/brave.zip' }]
  }, 'win64');
  assert.equal(brave.url, 'https://example.test/brave.zip');
  const firefox = firefoxDownload('win64');
  assert.match(firefox.url, /firefox\/1553\/firefox-win64\.zip$/);
  assert.equal(edgeDownload(), null);
});

test('the desktop app applies that identity before the page loads and can download the chosen browser', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /Emulation\.setUserAgentOverride/);
  assert.match(main, /octa:browser-engine/);
  assert.match(main, /await hookPage/);
  assert.match(main, /'-profile', profile, '-no-remote'/);
  assert.match(main, /已改用 Edge 的身分/);
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('browser-catalog.mjs'));
  const preload = readFileSync(new URL('../desktop/browser-preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /octa:browser-engine/);
});
