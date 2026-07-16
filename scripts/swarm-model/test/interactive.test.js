import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { runInteractive } from '../src/interactive.js';
import { setIo, close } from '../src/ui.js';

// Deterministic prompt/response pairing: console.log output goes to stdout,
// but readline writes each prompt to the *injected* output stream. So every
// write here is a prompt — feed the next scripted answer line in response,
// which synchronizes input delivery with each question exactly.
function makeIo(lines) {
  const input = new Readable({ read() {} });
  let i = 0;
  const output = new Writable({
    write(_chunk, _enc, cb) {
      queueMicrotask(() => {
        if (i < lines.length) input.push(lines[i++] + '\n');
      });
      cb();
    },
  });
  return { input, output };
}

function setup(swarm, opencode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-model-int-'));
  const swarmPath = path.join(dir, 'opencode-swarm.json');
  const openCodePath = path.join(dir, 'opencode.json');
  fs.writeFileSync(swarmPath, JSON.stringify(swarm, null, 2));
  fs.writeFileSync(openCodePath, JSON.stringify(opencode, null, 2));
  return { swarmPath, openCodePath };
}

async function drive(lines, swarmPath, openCodePath) {
  const { input, output } = makeIo(lines);
  setIo(input, output);
  try {
    await runInteractive(swarmPath, openCodePath);
  } finally {
    close();
    setIo(process.stdin, process.stdout);
  }
}

const OPENCODE = { provider: { wolfai: { models: { 'glm-5': {}, 'gpt-5.2': {} } } } };

// F-01: the whole flow reaches Step 4 (temperature) + confirm + write without
// `ReferenceError: ask is not defined`. Also proves schema preservation.
test('interactive edit writes model+temperature and preserves nested fields (F-01, schema)', async () => {
  const { swarmPath, openCodePath } = setup(
    { agents: { architect: { model: 'wolfai/glm-5', temperature: 0.1, fallback_models: ['wolfai/gpt-5.2'], reasoning: { effort: 'high' } } } },
    OPENCODE,
  );
  // agent=1, provider=1(wolfai), model=2(gpt-5.2), temp=0.5, confirm=y, next=2(quit)
  await drive(['1', '1', '2', '0.5', 'y', '2'], swarmPath, openCodePath);

  const cfg = JSON.parse(fs.readFileSync(swarmPath, 'utf8'));
  assert.equal(cfg.agents.architect.model, 'wolfai/gpt-5.2');
  assert.equal(cfg.agents.architect.temperature, 0.5);
  assert.deepEqual(cfg.agents.architect.fallback_models, ['wolfai/gpt-5.2']);
  assert.deepEqual(cfg.agents.architect.reasoning, { effort: 'high' });
});

// F-04: quit is offered at Step 1 and aborts without writing.
test('quit at Step 1 makes no change (F-04)', async () => {
  const { swarmPath, openCodePath } = setup(
    { agents: { architect: { model: 'wolfai/glm-5', temperature: 0.1 } } },
    OPENCODE,
  );
  const before = fs.readFileSync(swarmPath, 'utf8');
  // one agent -> list is [architect, quit]; pick 2 = quit
  await drive(['2'], swarmPath, openCodePath);
  assert.equal(fs.readFileSync(swarmPath, 'utf8'), before);
});

// F-06 / F-15: selecting an agent with no `model` field must not crash, and
// keeping the temperature (empty input) must leave it intact.
test('selecting a model-less agent does not crash and keeps temperature (F-06, F-15)', async () => {
  const { swarmPath, openCodePath } = setup(
    { agents: { nomodel: { temperature: 0.5 } } },
    OPENCODE,
  );
  // agent=1(nomodel), provider=1(wolfai), model=1(glm-5), temp=<enter>, confirm=y, next=2(quit)
  await drive(['1', '1', '1', '', 'y', '2'], swarmPath, openCodePath);

  const cfg = JSON.parse(fs.readFileSync(swarmPath, 'utf8'));
  assert.equal(cfg.agents.nomodel.model, 'wolfai/glm-5');
  assert.equal(cfg.agents.nomodel.temperature, 0.5);
});
