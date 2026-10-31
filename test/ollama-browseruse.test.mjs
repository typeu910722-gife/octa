import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOllamaCaps, ollamaChoices, NO_TOOLS_TEXT, buildBrowserPrompt, OLLAMA_NUM_CTX } from '../public/octa-runner.mjs';

const SHOW = `  Model
    architecture        qwen3
    parameters          8.2B
    context length      40960

  Capabilities
    completion
    tools
    thinking       
        levels     false, true    
        default    true           

  Parameters
    temperature    0.6
`;

test('reads what a local model can do from ollama show', () => {
  const c = parseOllamaCaps(SHOW);
  assert.ok(c.has('tools') && c.has('completion') && c.has('thinking'));
  assert.ok(!c.has('vision') && !c.has('temperature'));
  assert.equal(parseOllamaCaps('no such section').size, 0);
  assert.ok(parseOllamaCaps('Capabilities\r\n  completion\r\n  vision\r\n  tools\r\n').has('vision'));
});

test('a model without tool calling is explained instead of hanging', () => {
  assert.match(NO_TOOLS_TEXT('gemma2'), /tool calling/);
  assert.match(NO_TOOLS_TEXT('gemma2'), /qwen3-vl:8b/);
});

test('OCTA context copies are not offered as models', () => {
  assert.deepEqual(ollamaChoices(['gpt-oss:20b', 'octa-ctx-qwen3-latest:latest', 'qwen3:latest']), ['gpt-oss:20b', 'qwen3:latest']);
});

test('local models get room for the whole instruction', () => {
  assert.ok(OLLAMA_NUM_CTX >= 24576);
});

test('browser-use rounds get plain steps, not Playwright tool names, and keep the report format', () => {
  const job = { bot: { name: '映日所' }, prompt: '查訂單' };
  const plain = buildBrowserPrompt(job, { url: 'https://example.com', prompt: '看今天訂單' }, '', { plain: true });
  assert.ok(!/browser_/.test(plain));
  assert.match(plain, /https:\/\/example\.com/);
  for (const k of ['網址：', '頁面上有什麼：', '做成了什麼：', '卡在哪裡：']) assert.ok(plain.includes(k));
  const pw = buildBrowserPrompt(job, { url: 'https://example.com', prompt: '看今天訂單' }, '');
  assert.match(pw, /browser_snapshot/);
});

test('the browser-use bridge keeps the bot browser open and skips the extra judge call', () => {
  const py = readFileSync(new URL('../public/octa-browseruse.py', import.meta.url), 'utf8');
  assert.match(py, /keep_alive=True/);
  assert.match(py, /use_judge=False/);
  assert.match(py, /num_ctx/);
});
