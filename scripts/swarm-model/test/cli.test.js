import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Run cli.js as a child process. `keepStdinOpen` leaves the child's stdin pipe
// open (never .end()) so that a regressed eager-readline build — which holds
// stdin open and hangs — would time out instead of exiting. Closing stdin here
// would let even a hung build receive 'end' and exit, making the probe
// tautological, so the no-hang tests must keep it open.
function run(args, { env, keepStdinOpen = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} did not exit within ${timeoutMs}ms (hang)`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (!keepStdinOpen) child.stdin.end();
    // when keepStdinOpen: intentionally leave stdin open; child must still exit.
  });
}

// F-07: `help`/`list` must never open readline, so they exit cleanly even while
// stdin stays open. A regression to eager readline creation would hang here.
test('help exits 0 without hanging while stdin stays open (F-07)', async () => {
  const { code, stdout } = await run(['help'], { keepStdinOpen: true });
  assert.equal(code, 0);
  assert.match(stdout, /swarm-model/);
});

test('list exits 0 without hanging while stdin stays open (F-07)', async () => {
  const { code } = await run(['list'], { keepStdinOpen: true });
  assert.equal(code, 0);
});

// F-09: a value-less --swarm-config flag must fail fast with a clear message,
// not silently swallow the next arg or crash obscurely.
test('valueless --swarm-config exits 1 with a clear message (F-09)', async () => {
  const { code, stderr } = await run(['list', '--swarm-config']);
  assert.equal(code, 1);
  assert.match(stderr, /Missing value for --swarm-config/);
});

test('valueless --opencode-config exits 1 with a clear message (F-09)', async () => {
  const { code, stderr } = await run(['list', '--opencode-config']);
  assert.equal(code, 1);
  assert.match(stderr, /Missing value for --opencode-config/);
});

// F-13: with HOME and USERPROFILE both unset the module-level default paths
// must still resolve (os.homedir fallback), so the CLI starts instead of
// crashing at import with `path.join(undefined, ...)`.
test('starts with HOME and USERPROFILE unset (F-13)', async () => {
  const env = { ...process.env };
  delete env.HOME;
  delete env.USERPROFILE;
  const { code, stdout } = await run(['help'], { env });
  assert.equal(code, 0);
  assert.match(stdout, /swarm-model/);
});
