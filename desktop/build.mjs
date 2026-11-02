// Copy the web app (app/) and the schema into the desktop app folder before running or packaging.
// The API (desktop/api), runner (desktop/runner) and shared modules (desktop/lib) already live here.
// Until they do, the old layout is still built: public/ as the web app and api.js from functions/.
import { cpSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
const webSrc = existsSync(join(root, 'app', 'index.html')) ? join(root, 'app') : join(root, 'public');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(webSrc, join(here, 'web'), { recursive: true, filter: s => !/(ebot|octa)-runner\.json$|[\\/]work([\\/]|$)/.test(s) });
copyFileSync(join(root, 'schema.sql'), join(here, 'schema.sql'));
const made = ['web (' + webSrc.slice(root.length + 1) + ')', 'schema.sql'];
// fallback for a checkout without the 4.0 API / shared modules yet
if (!existsSync(join(here, 'api', 'index.mjs'))) {
  const apiSrc = readFileSync(join(root, 'functions', 'api', '[[path]].js'), 'utf8')
    .replaceAll("from '../_lib/model-route.mjs'", "from './model-route.mjs'")
    .replaceAll("from '../_lib/connectors.mjs'", "from './connectors.mjs'");
  writeFileSync(join(here, 'api.js'), apiSrc);
  for (const f of ['model-route.mjs', 'connectors.mjs']) copyFileSync(join(root, 'functions', '_lib', f), join(here, f));
  made.push('api.js (舊版)', 'model-route.mjs', 'connectors.mjs');
} else for (const f of ['api.js', 'model-route.mjs', 'connectors.mjs']) rmSync(join(here, f), { force: true });   // left over from a 3.x build
console.log(made.join(', ') + ' 已更新');
