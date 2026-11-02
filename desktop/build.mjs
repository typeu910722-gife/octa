// Copy the web app (app/) and the schema into the desktop app folder before running or packaging.
// The API (desktop/api), runner (desktop/runner) and shared modules (desktop/lib) already live here.
import { cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(join(root, 'app'), join(here, 'web'), { recursive: true });
copyFileSync(join(root, 'schema.sql'), join(here, 'schema.sql'));
for (const f of ['api.js', 'model-route.mjs', 'connectors.mjs']) rmSync(join(here, f), { force: true });   // left over from a 3.x build
console.log('web (app), schema.sql 已更新');
