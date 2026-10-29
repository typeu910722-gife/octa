// Which browser the in-app page claims to be, and where OCTA downloads its own copy.
// The copy lives in OCTA's folder. It is not the browser the person already uses.

export const ENGINE_IDS = ['chrome', 'brave', 'firefox', 'edge'];
export const ENGINE_LABEL = { chrome: 'Chrome', brave: 'Brave', firefox: 'Firefox', edge: 'Edge' };

export const CHROME_CATALOG = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
export const BRAVE_RELEASE = 'https://api.github.com/repos/brave/brave-browser/releases/latest';
// Playwright publishes a portable Firefox. Mozilla's own download is a system installer, which OCTA does not run.
export const FIREFOX_BUILD = { revision: '1553', version: '156.0' };

export function hostPlatform(platform = 'win32', arch = 'x64') {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return 'linux64';
  return 'win64';
}

function osBits(platformKey) {
  if (String(platformKey).startsWith('mac')) {
    return { token: 'Macintosh; Intel Mac OS X 10_15_7', nav: 'MacIntel', hint: 'macOS', hintVersion: '15.0.0' };
  }
  if (String(platformKey).startsWith('linux')) {
    return { token: 'X11; Linux x86_64', nav: 'Linux x86_64', hint: 'Linux', hintVersion: '6.8.0' };
  }
  return { token: 'Windows NT 10.0; Win64; x64', nav: 'Win32', hint: 'Windows', hintVersion: '15.0.0' };
}

function cleanVersion(version, fallback) {
  const v = String(version || '').trim().replace(/[^\d.]/g, '');
  return v || fallback;
}

// A current browser identity, without the Electron token sites use to refuse the page.
export function identity(engine, version, platform = 'win32', arch = 'x64') {
  const id = ENGINE_IDS.includes(engine) ? engine : 'chrome';
  const os = osBits(hostPlatform(platform, arch));
  if (id === 'firefox') {
    const v = cleanVersion(version, '156.0');
    const major = v.split('.')[0];
    return {
      engine: id,
      userAgent: `Mozilla/5.0 (${os.token}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`,
      platform: os.nav,
      metadata: null,
      clientHint: ''
    };
  }
  const v = cleanVersion(version, '131.0.6778.86');
  const major = v.split('.')[0];
  const brand = id === 'edge' ? 'Microsoft Edge' : id === 'brave' ? 'Brave' : 'Google Chrome';
  const tail = id === 'edge' ? ` Edg/${v}` : '';
  const brands = [
    { brand: 'Not_A Brand', version: '24' },
    { brand: 'Chromium', version: major },
    { brand, version: major }
  ];
  return {
    engine: id,
    userAgent: `Mozilla/5.0 (${os.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36${tail}`,
    platform: os.nav,
    metadata: {
      brands,
      fullVersionList: brands.map(b => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? '24.0.0.0' : v })),
      fullVersion: v,
      platform: os.hint,
      platformVersion: os.hintVersion,
      architecture: String(arch).startsWith('arm') ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false
    },
    clientHint: brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ')
  };
}

// Client-hint request headers for this identity (header name → value, null = remove).
// The three low-entropy ones always go out. The others are rewritten only when Chromium already sends them
// (the site asked with Accept-CH), so a request never carries a hint a real Chrome would not send.
const CH_MORE = ['sec-ch-ua-full-version-list', 'sec-ch-ua-full-version', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-wow64'];
export function clientHintHeaders(id, sent = {}) {
  const has = name => Object.keys(sent || {}).some(k => k.toLowerCase() === name);
  const out = {};
  const m = id?.metadata;
  if (!m) {   // Firefox sends no client hints at all
    for (const k of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', ...CH_MORE]) out[k] = null;
    return out;
  }
  const q = v => `"${v}"`;
  out['sec-ch-ua'] = id.clientHint;
  out['sec-ch-ua-mobile'] = m.mobile ? '?1' : '?0';
  out['sec-ch-ua-platform'] = q(m.platform);
  const more = {
    'sec-ch-ua-full-version-list': m.fullVersionList.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-full-version': q(m.fullVersion),
    'sec-ch-ua-platform-version': q(m.platformVersion),
    'sec-ch-ua-arch': q(m.architecture),
    'sec-ch-ua-bitness': q(m.bitness),
    'sec-ch-ua-model': q(m.model),
    'sec-ch-ua-wow64': m.wow64 ? '?1' : '?0'
  };
  for (const k of CH_MORE) if (has(k)) out[k] = more[k];
  return out;
}

// CDP cookies (what the runner keeps) ↔ Electron cookies. Electron needs a url and calls the expiry expirationDate.
export const SAME_TO_CDP = { lax: 'Lax', strict: 'Strict', no_restriction: 'None' };
const SAME_TO_EL = { Lax: 'lax', Strict: 'strict', None: 'no_restriction', lax: 'lax', strict: 'strict', no_restriction: 'no_restriction' };
export const KEEP_DAYS = 30;
// null: nothing to set (no name, no site, or already expired)
export function electronCookie(c, now = Date.now() / 1000) {
  if (!c?.name) return null;
  const host = String(c.domain || '').replace(/^\./, '') || (() => { try { return new URL(c.url).hostname; } catch { return ''; } })();
  if (!host) return null;
  if (+c.expires > 0 && +c.expires < now) return null;
  // __Secure- and __Host- cookies are only accepted over https; __Host- never carries a domain
  const prefixed = /^__(Secure|Host)-/.test(c.name);
  const secure = !!c.secure || prefixed;
  const out = { url: c.url || `${secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: String(c.value ?? ''), path: c.name.startsWith('__Host-') ? '/' : (c.path || '/'), secure, httpOnly: !!c.httpOnly };
  if (String(c.domain || '').startsWith('.') && !c.name.startsWith('__Host-')) out.domain = c.domain;
  if (SAME_TO_EL[c.sameSite]) out.sameSite = SAME_TO_EL[c.sameSite];
  // a sign-in kept only "for this session" would be gone after OCTA restarts: bots keep it like a remembered login
  out.expirationDate = +c.expires > 0 ? +c.expires : now + KEEP_DAYS * 86400;
  return out;
}

// Google refused the sign-in because this is an embedded browser ("這個瀏覽器或應用程式可能不安全").
// Only this sends the bot to a Chrome window; a plain sign-in page is tried in OCTA first.
const GOOGLE_REFUSED = ['這個瀏覽器或應用程式可能不安全', '此瀏覽器或應用程式可能不安全', '这个浏览器或应用可能不安全', '此浏览器或应用可能不安全', 'This browser or app may not be secure', "Couldn't sign you in", '無法登入'];
export function googleRefused(url, text = '') {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.hostname !== 'accounts.google.com') return false;
  if (/\/rejected\b|\/signin\/rejected/i.test(u.pathname)) return true;
  const t = String(text || '');
  return GOOGLE_REFUSED.slice(0, 5).some(w => t.includes(w)) || (/signin|ServiceLogin|AddSession/i.test(u.pathname) && GOOGLE_REFUSED.slice(5).some(w => t.includes(w)) && /瀏覽器|browser|浏览器/i.test(t));
}

export function pageUnsupported(text) {
  return String(text || '').includes('不支援此瀏覽器');
}

export function pageNeedsAttention(text) {
  const t = String(text || '');
  return pageUnsupported(t) || t.includes('您輸入的內容有誤');
}

export function chromeDownload(catalog, platformKey) {
  const stable = catalog?.channels?.Stable;
  const list = stable?.downloads?.chrome || [];
  const hit = list.find(x => x.platform === platformKey) || list.find(x => x.platform === 'win64');
  if (!hit?.url || !stable?.version) return null;
  return { engine: 'chrome', version: stable.version, url: hit.url, kind: 'zip' };
}

export function braveDownload(release, platformKey) {
  const version = String(release?.tag_name || '').replace(/^v/, '');
  if (!version) return null;
  const file = {
    win64: `brave-v${version}-win32-x64.zip`,
    'mac-arm64': `brave-v${version}-darwin-arm64.zip`,
    'mac-x64': `brave-v${version}-darwin-x64.zip`,
    linux64: `brave-browser-${version}-linux-amd64.zip`
  }[platformKey];
  const hit = (release?.assets || []).find(a => a.name === file);
  if (!hit?.browser_download_url) return null;
  return { engine: 'brave', version, url: hit.browser_download_url, kind: 'zip' };
}

export function firefoxDownload(platformKey, build = FIREFOX_BUILD) {
  const file = {
    win64: 'firefox-win64.zip',
    linux64: 'firefox-ubuntu-22.04.zip',
    'mac-x64': 'firefox-mac.zip',
    'mac-arm64': 'firefox-mac-arm64.zip'
  }[platformKey];
  if (!file || !build?.revision) return null;
  return {
    engine: 'firefox',
    version: build.version,
    url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/${build.revision}/${file}`,
    kind: 'zip'
  };
}

// Edge is offered as an identity on this page. OCTA does not run Edge's system installer.
export function edgeDownload() {
  return null;
}
