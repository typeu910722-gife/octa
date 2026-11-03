import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const desk = join(root, 'desktop');
const pkg = JSON.parse(readFileSync(join(desk, 'package.json'), 'utf8'));
const read = rel => readFileSync(join(desk, rel), 'utf8');

function packaged(rel) {
  return pkg.build.files.some(pattern => {
    if (pattern.endsWith('/**')) return rel === pattern.slice(0, -3) || rel.startsWith(pattern.slice(0, -3) + '/');
    return pattern === rel;
  });
}
const relImports = src => [...src.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)].map(m => m[1]);

test('4.0 desktop package: version, the new folders on the file list, the 3.x cloud pieces gone', () => {
  assert.match(pkg.version, /^4\./);
  for (const f of ['api/**', 'runner/**', 'lib/**', 'web/**', 'cloud-import.mjs', 'schema.sql', 'main.mjs', 'server.mjs', 'preload.cjs', 'splash.html'])
    assert.ok(pkg.build.files.includes(f), f + ' must be packed');
  for (const f of ['host-mode.mjs', 'api.js', 'model-route.mjs', 'connectors.mjs'])
    assert.ok(!pkg.build.files.includes(f), f + ' is not part of 4.0');
  assert.equal(existsSync(join(desk, 'host-mode.mjs')), false);
});

test('the desktop installer packs every file the Electron main process and the server import', () => {
  for (const file of ['main.mjs', 'server.mjs']) {
    const specs = relImports(read(file));
    assert.ok(specs.length >= 1, file);
    for (const spec of specs) {
      const rel = spec.slice(2);
      assert.equal(packaged(rel), true, `${rel} is imported by desktop/${file} but missing from electron-builder files`);
      readFileSync(join(desk, rel));
    }
  }
  assert.ok(relImports(read('main.mjs')).includes('./cdp-bridge.mjs'));
  assert.ok(relImports(read('main.mjs')).includes('./cloud-import.mjs'));
});

// once the API / runner / shared modules live in desktop/, every relative import inside them must stay in packed folders
test('desktop/api, desktop/runner and desktop/lib only import packed files', () => {
  const dirs = ['api', 'runner', 'lib'].filter(d => existsSync(join(desk, d)));
  const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.m?js$/.test(f) ? [p] : []; });
  for (const d of dirs) for (const file of walk(join(desk, d))) {
    for (const spec of relImports(readFileSync(file, 'utf8'))) {
      const target = normalize(join(dirname(file), spec));
      const rel = relative(desk, target).replace(/\\/g, '/');
      assert.ok(!rel.startsWith('..'), `${relative(root, file)} imports ${spec}, outside desktop/ (not in the installer)`);
      assert.equal(packaged(rel), true, `${relative(root, file)} imports ${rel}, which is not packed`);
      assert.ok(existsSync(target), `${relative(root, file)} imports missing ${rel}`);
    }
  }
});

test('the window is always local: no cloud page, no cloud sign-in or 主機模式 bridges', () => {
  const main = read('main.mjs'), preload = read('preload.cjs'), server = read('server.mjs'), splash = read('splash.html');
  assert.doesNotMatch(main, /loadURL\(CLOUD\)|octa:(offline|cloud'|connect|disconnect|working|host-move|host-back)|hostToCloud|hostStart|runner-token/);
  assert.doesNotMatch(preload, /useOffline|useCloud|hostMove|hostBack|onHostProgress|connect:|disconnect:|working:/);
  assert.doesNotMatch(server, /hostHandler|hostLink|x-octa-sig|hostMode/);
  assert.doesNotMatch(splash, /useCloud|useOffline/);
  // the one-time import of a 3.x cloud account, retryable from settings
  assert.match(main, /handle\('octa:cloud-import'/);
  assert.match(main, /handle\('octa:cloud-import-status'/);
  assert.match(preload, /cloudImport: \{/);
  assert.match(main, /migrateConfig\(cfg\)/);
  // API, runner and web app: the 4.0 locations first
  assert.match(server, /join\(here, 'api', 'index\.mjs'\)/);
  assert.match(server, /join\(here, 'runner', 'index\.mjs'\)/);
  assert.match(server, /join\(here, 'web', 'index\.html'\), join\(here, '\.\.', 'app', 'index\.html'\)/);
});

test('build.mjs copies app/ into desktop/web', () => {
  const build = read('build.mjs');
  assert.match(build, /cpSync\(join\(root, 'app'\), join\(here, 'web'\)/);
  assert.match(build, /join\(here, 'web'\)/);
});

test('the legacy cloud keeps only what old desktops need to move their data home', () => {
  const api = readFileSync(join(root, 'functions', 'api', '[[path]].js'), 'utf8');
  const specs = relImports(api);
  assert.deepEqual(specs, ['../../legacy/model-route.mjs', '../../legacy/connectors.mjs', '../../legacy/hook-relay.mjs']);   // 4.5: the 交接網址 forwarder
  for (const s of specs) assert.ok(existsSync(join(root, 'functions', 'api', s)), s);
  const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.match(wrangler, /^pages_build_output_dir = "site"$/m);
  assert.equal(existsSync(join(root, '.github', 'workflows', 'cron.yml')), false);
  const site = readFileSync(join(root, 'site', 'index.html'), 'utf8');
  assert.match(site, /releases\/latest\/download\/OCTA-Setup\.exe/);
  assert.match(site, /請盡快打開桌面版/);
  assert.ok(existsSync(join(root, 'site', 'icon.png')));
});

test('the Windows installer closes running OCTA first: build/installer.nsh is where electron-builder looks for it', () => {
  const nsh = readFileSync(join(root, 'desktop', 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /taskkill \/F \/T \/IM "OCTA\.exe"/);
  assert.match(nsh, /APPDATA\\OCTA/);
  for (const l of nsh.split('\n')) assert.ok(l.length < 1000, 'NSIS line too long');
  const p = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'));
  assert.equal(p.build.nsis.include, undefined);
  assert.ok(!p.build.directories?.buildResources || p.build.directories.buildResources === 'build');
});
