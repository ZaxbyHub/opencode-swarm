import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  splitModelName,
  getAllModels,
  getProviders,
  mergeProviderModels,
  getOpenCodeProviders,
  readSwarmConfig,
  writeSwarmConfig,
} from '../src/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-model-test-'));
}

test('splitModelName splits on the last slash', () => {
  assert.deepEqual(splitModelName('wolfai/glm-5'), { provider: 'wolfai', model: 'glm-5' });
  // 3-segment provider/model/variant: keep the variant with the model tail.
  assert.deepEqual(splitModelName('anthropic/claude/high'), { provider: 'anthropic/claude', model: 'high' });
  assert.deepEqual(splitModelName('bareword'), { provider: '', model: 'bareword' });
});

test('getAllModels collects model + fallback_models, tolerating missing model', () => {
  const models = getAllModels({
    agents: {
      a: { model: 'wolfai/glm-5', fallback_models: ['wolfai/gpt-5.2'] },
      b: { temperature: 0.5 }, // no model — must not throw
    },
  });
  assert.ok(models['wolfai/glm-5']);
  assert.ok(models['wolfai/gpt-5.2']);
});

test('getProviders skips empty-provider entries and dedups', () => {
  const providers = getProviders({
    'wolfai/glm-5': { provider: 'wolfai', model: 'glm-5' },
    'wolfai/glm-5-dup': { provider: 'wolfai', model: 'glm-5' },
    '/bare': { provider: '', model: 'bare' },
  });
  assert.deepEqual(providers, { wolfai: ['glm-5'] });
});

test('mergeProviderModels unions, sorts, dedups, and keeps swarm-only keys', () => {
  const merged = mergeProviderModels(
    { wolfai: ['glm-5'], only: ['x'] },
    { wolfai: ['gpt-5.2', 'glm-5'], extra: ['y'] },
  );
  assert.deepEqual(merged.wolfai, ['glm-5', 'gpt-5.2']);
  assert.deepEqual(merged.only, ['x']);
  assert.deepEqual(merged.extra, ['y']);
});

test('getOpenCodeProviders returns {} on missing file and on malformed JSON', () => {
  const dir = tmpDir();
  assert.deepEqual(getOpenCodeProviders(path.join(dir, 'nope.json')), {});
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json ');
  assert.deepEqual(getOpenCodeProviders(bad), {}); // F-08: no throw
});

test('getOpenCodeProviders reads provider models sorted', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'opencode.json');
  fs.writeFileSync(p, JSON.stringify({ provider: { wolfai: { models: { 'gpt-5.2': {}, 'glm-5': {} } } } }));
  assert.deepEqual(getOpenCodeProviders(p), { wolfai: ['glm-5', 'gpt-5.2'] });
});

test('readSwarmConfig throws a clear error on malformed JSON (F-08)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'swarm.json');
  fs.writeFileSync(p, '{ broken ');
  assert.throws(() => readSwarmConfig(p), /Failed to parse swarm config/);
});

test('writeSwarmConfig backup filename is full-resolution and never overwrites the first .bak (F-02)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'swarm.json');
  fs.writeFileSync(p, JSON.stringify({ agents: { a: { model: 'x/y' } } }));

  // First write -> .bak
  writeSwarmConfig({ agents: { a: { model: 'x/z' } } }, p);
  assert.ok(fs.existsSync(p + '.bak'), 'first backup is .bak');

  // Second write -> timestamped .bak, 14-digit YYYYMMDDHHMMSS, no separators
  writeSwarmConfig({ agents: { a: { model: 'x/w' } } }, p);
  const stamped = fs.readdirSync(dir).filter((f) => /^swarm\.json\.\d{14}\.bak$/.test(f));
  assert.equal(stamped.length, 1, 'exactly one 14-digit timestamped backup');
  assert.ok(fs.existsSync(p + '.bak'), 'original .bak still present (not overwritten)');
});

test('writeSwarmConfig preserves non-edited nested fields (schema integrity)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'swarm.json');
  const cfg = {
    agents: {
      a: {
        model: 'wolfai/glm-5',
        temperature: 0.2,
        disabled: false,
        variant: 'high',
        fallback_models: ['wolfai/gpt-5.2'],
        reasoning: { effort: 'high' },
        thinking: { type: 'enabled', budget_tokens: 1000 },
      },
    },
  };
  writeSwarmConfig(cfg, p);
  const back = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(back.agents.a.fallback_models, ['wolfai/gpt-5.2']);
  assert.deepEqual(back.agents.a.reasoning, { effort: 'high' });
  assert.deepEqual(back.agents.a.thinking, { type: 'enabled', budget_tokens: 1000 });
  assert.equal(back.agents.a.variant, 'high');
});
