import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyModelFailure, decideRoute, replyIsProviderRefusal, providerFailureText } from '../public/model-route.mjs';

const chain = [{ id: 'claude' }, { id: 'gemini' }, { id: 'opencode|qwen3' }];
const now = 1_000_000;

test('simulated errors are classified before any fallback decision', () => {
  assert.equal(classifyModelFailure('usage limit exceeded'), 'quota');
  assert.equal(classifyModelFailure('HTTP 429 too many requests'), 'rate_limit');
  assert.equal(classifyModelFailure('invalid api key'), 'auth');
  assert.equal(classifyModelFailure('503 temporarily unavailable'), 'transient');
  assert.equal(classifyModelFailure('AssertionError test.js failed'), 'execution');
  assert.equal(classifyModelFailure('WebSearch failed: network'), 'tool');
  assert.equal(classifyModelFailure('usage limit', { stopped: true }), 'cancelled');
});

test('simulated quota switches once and stops when every model is spent', () => {
  const first = decideRoute({ kind: 'quota', tries: 0, chain, index: 0, now });
  assert.equal(first.action, 'switch');
  assert.equal(first.index, 1);
  const second = decideRoute({ kind: 'quota', tries: 0, chain, index: 1, now });
  assert.equal(second.action, 'switch');
  assert.equal(second.index, 2);
  const done = decideRoute({ kind: 'quota', tries: 0, chain, index: 2, now });
  assert.equal(done.action, 'stop');
  assert.match(done.message, /保留/);
});

test('simulated HTTP 429 retries once, then switches, and does not loop', () => {
  const retry = decideRoute({ kind: 'rate_limit', tries: 0, chain, index: 0, now });
  assert.equal(retry.action, 'retry');
  const again = decideRoute({ kind: 'rate_limit', tries: 1, chain, index: 0, now });
  assert.equal(again.action, 'switch');
  assert.equal(again.index, 1);
  const none = decideRoute({ kind: 'rate_limit', tries: 1, chain: [chain[0]], index: 0, now });
  assert.equal(none.action, 'stop');
});

test('simulated auth, tool, execution, and cancel do not switch or retry', () => {
  for (const kind of ['auth', 'tool', 'execution', 'cancelled']) {
    const d = decideRoute({ kind, tries: 0, chain, index: 0, now });
    assert.equal(d.action, 'stop', kind);
    assert.equal(d.index, undefined);
  }
  assert.match(decideRoute({ kind: 'auth', chain, index: 0, now }).message, /API Key/);
  assert.equal(decideRoute({ kind: 'execution', chain, index: 0, now }).message, '');
});

test('simulated transient failure retries twice on the same model before switching', () => {
  assert.equal(decideRoute({ kind: 'transient', tries: 0, chain, index: 0, now }).action, 'retry');
  assert.equal(decideRoute({ kind: 'transient', tries: 1, chain, index: 0, now }).action, 'retry');
  const hop = decideRoute({ kind: 'transient', tries: 2, chain, index: 0, now });
  assert.equal(hop.action, 'switch');
  assert.equal(hop.index, 1);
});

test('a quota refusal in Chinese switches, and a normal sentence that only looks similar does not', () => {
  for (const line of ['流量不夠', '目前流量不足，請稍後再試', '流量用完', '沒有剩餘流量', '配額已用完', '超出配額', '資源耗盡', 'resource_exhausted', 'usage limit exceeded']) {
    assert.equal(classifyModelFailure(line), 'quota', line);
    assert.equal(replyIsProviderRefusal(line), 'quota', line);
  }
  assert.equal(classifyModelFailure('人流量不夠，不建議開店'), 'execution');
  assert.equal(replyIsProviderRefusal('人流量不夠，不建議開店'), '');
  assert.equal(replyIsProviderRefusal('網路流量不夠'), '');
  assert.equal(replyIsProviderRefusal('人數已達上限，今日不再接待'), '');
  assert.equal(classifyModelFailure('人數已達上限'), 'quota');
  assert.equal(replyIsProviderRefusal('好的，已打開頁面'), '');
  assert.equal(replyIsProviderRefusal('流量不夠', { files: 1 }), '');
  assert.equal(replyIsProviderRefusal('x'.repeat(900) + '流量不夠'), '');
  const hop = decideRoute({ kind: 'quota', tries: 0, chain: [{ id: 'gemini' }, { id: 'claude|opus' }, { id: 'codex' }], index: 0, now });
  assert.equal(hop.action, 'switch');
  assert.equal(hop.index, 1);
  assert.equal(hop.spend, true);
});

test('a missing AI on this computer skips to the next backup, and a code error still does not', () => {
  assert.equal(classifyModelFailure('⚠ 這台電腦沒有安裝 Claude Code。請到「AI 連線」安裝並登入'), 'unavailable');
  assert.equal(classifyModelFailure('⚠ 這台電腦的 Ollama 還沒有下載任何模型。'), 'unavailable');
  assert.equal(classifyModelFailure('command not found: git'), 'execution');
  const hop = decideRoute({ kind: 'unavailable', tries: 0, chain, index: 0, now });
  assert.equal(hop.action, 'switch');
  assert.equal(hop.index, 1);
  const done = decideRoute({ kind: 'unavailable', tries: 0, chain, index: 2, now });
  assert.equal(done.action, 'stop');
  assert.match(done.message, /還沒安裝/);
});

test('quota text on its own line is kept when a generic error line would hide it', () => {
  const kept = providerFailureText(['Error: request failed', '目前流量不夠，請稍後再試']);
  assert.match(kept, /流量不夠/);
  assert.equal(kept.includes('request failed'), false);
  assert.equal(providerFailureText(['Error: request failed', 'AssertionError test.js failed']), '');
});
