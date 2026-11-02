// The web app's source (app/) for the UI tests: markup, scripts, styles and the translation dictionary.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const root = join(import.meta.dirname, '..');
export const read = p => readFileSync(join(root, p), 'utf8');
export const html = read('app/index.html');
// scripts in the order index.html loads them
export const scriptNames = [...html.matchAll(/<script defer src="\/js\/([\w-]+\.js)"><\/script>/g)].map(m => m[1]);
export const scripts = Object.fromEntries(readdirSync(join(root, 'app', 'js')).filter(f => f.endsWith('.js')).map(f => [f, read('app/js/' + f)]));
export const js = scriptNames.map(f => scripts[f]).join('\n');
export const styleNames = [...html.matchAll(/<link rel="stylesheet" href="\/css\/([\w-]+\.css)">/g)].map(m => m[1]);
export const css = styleNames.map(f => read('app/css/' + f)).join('\n');
export const page = html + '\n' + js + '\n' + css;
export const dictSrc = read('app/i18n-dict.js');
export const dict = (() => { const window = {}; new Function('window', dictSrc)(window); return window.OCTA_I18N; })();

// a function's source (from its declaration to the next top-level declaration), in whichever script holds it
export function fnSrc(name) {
  const re = new RegExp('(^|\\n)(?:async )?function ' + name + '\\(|(^|\\n)(?:const|let) ' + name + '=');
  for (const src of Object.values(scripts)) {
    const m = re.exec(src); if (!m) continue;
    const rest = src.slice(m.index + (m[0].startsWith('\n') ? 1 : 0));
    const end = rest.slice(1).search(/\n(?:async function |function |const |let |\$\('|\/\* |SEC\.)/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  }
  assert.fail(name + ' exists');
}
// one Settings section's source (SEC.look=…, SEC.ai=…)
export function secSrc(k) {
  const a = js.indexOf('SEC.' + k + '='); assert.ok(a >= 0, 'section ' + k);
  const rest = js.slice(a + 4), b = rest.search(/\n(?:SEC\.|\/\* -{5})/);
  return 'SEC.' + rest.slice(0, b < 0 ? undefined : b);
}
// the plain functions (app/js/pure.js), loaded on their own
export const pure = new Function(scripts['pure.js'] + '\nreturn { APPR, apprDecision, apprOwn, apprImpact, apprStrip, rtStatus, memberState, ASKRE, askText, askOpts, verCmp, nameProblem, pairCode, freeName };')();
// what the page shows for a key in a language (exact entries, then the patterns)
export function tr(lang, s) {
  const d = dict[lang]; if (d.t[s] !== undefined) return d.t[s];
  for (const [rx, rep] of d.p || []) { const m = s.match(new RegExp(rx)); if (m) return rep.replace(/\$(\d)/g, (_, i) => m[i] ?? ''); }
  return undefined;
}
