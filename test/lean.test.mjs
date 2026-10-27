// 省 token: lean Claude Code flags and a shorter group history in the prompt
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leanFlags, buildPrompt, GROUP_HISTORY } from '../public/octa-runner.mjs';

test('lean flags only when this Claude Code knows them', () => {
  const help = '  --tools <tools...>  Specify the list\n  --disable-slash-commands  Disable all skills';
  assert.deepEqual(leanFlags(help, false), ['--tools', 'WebFetch,WebSearch,Read,Write,Edit,Glob,Grep,Bash', '--disable-slash-commands']);
  assert.deepEqual(leanFlags(help, true), ['--tools', 'Read', '--disable-slash-commands']);
  assert.deepEqual(leanFlags('  --allowedTools <tools...>', false), [], 'an older Claude Code gets no new flags');
  assert.deepEqual(leanFlags('', false), []);
});

const long = '行程：' + '14:00 赤崁樓，看古蹟和碑林。'.repeat(150);
const job = extra => ({ id: 1, kind: 'chat', prompt: '大家各用一句話自我介紹', bot: { id: 'b1', name: '2', task: '', engine: 'claude' }, history: Array.from({ length: 30 }, (_, i) => ({ id: i, who: i % 2 ? '2' : '使用者', text: `第${i}則 ` + long, files: [] })), memory: [], facts: [], manuals: [], lang: 'zh-TW', ...extra });

test('a group prompt keeps only the latest messages, shortened', () => {
  const g = buildPrompt(job({ group: { name: 'g', task: '', members: ['甲', '2'], mode: 'parallel' } }), '/tmp/x');
  const p = buildPrompt(job({}), '/tmp/x');
  assert.ok(!g.includes('第15則'), 'older messages are left out');
  assert.ok(g.includes(`第${30 - GROUP_HISTORY}則`) && g.includes('第29則'));
  assert.ok(g.includes('（已截短，全文在對話裡）'));
  assert.ok(p.includes('第0則'), 'a private chat keeps its history');
  assert.ok(g.length < p.length * 0.6, `group ${g.length} vs private ${p.length}`);
});
