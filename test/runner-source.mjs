// The runner's source text (all of desktop/runner/*.mjs), for tests that check how it is wired.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'desktop', 'runner');
export const runnerSource = () => readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()
  .map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
