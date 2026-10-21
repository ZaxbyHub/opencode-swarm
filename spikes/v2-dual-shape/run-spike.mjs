#!/usr/bin/env node
/**
 * Issue #2909 dual-shape spike harness (ADR-0003 evidence generator).
 *
 * Produces the live-host evidence for `spikes/v2-dual-shape/logs/`:
 *   - a real OpenCode 1 host (>= 1.18.29) loading the dual-shape plugin,
 *   - a real OpenCode 2 host loading the same build,
 *   - four ablation runs proving which entrypoint each host invokes,
 *   - first-turn window measurements (deferred bundled-skill sync vs the
 *     first prompt turn) for the ADR-0003 appendix.
 *
 * Load routes (validated live 2026-10-16, see docs/decisions/0003):
 *   v1: project `opencode.json` `{"plugin": ["file:<repo-root>"]}`
 *   v2: project `.opencode/plugins/local-spike.js` re-exporting
 *       `file:///<repo-root>/dist/index.js`
 *
 * Attribution is by ablation: each ablated package is a WRAPPER module
 * (spread-copy the pristine default export, delete exactly one key) that is
 * pre-validated in Node before any host run — a parse failure or a wrong
 * key-set aborts the run as a harness error, never a host verdict. Every
 * verdict additionally requires POSITIVE evidence that the host actually ran
 * (clean exit, no timeout, non-empty captured output) — an absent banner on a
 * never-spawned or timed-out host is a HARNESS ERROR, never a MATCH.
 *
 * All spawns are array-form with explicit cwd, `stdin: "ignore"`, a hard
 * timeout with a Windows tree-kill fallback, file-descriptor-backed bounded
 * capture, home-path redaction, and best-effort kill/cleanup
 * (AGENTS.md invariant 3).
 *
 * Usage: node spikes/v2-dual-shape/run-spike.mjs [--measure]
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist', 'index.js');
const LOGS_DIR = path.join(HERE, 'logs');

const V1_BIN = process.env.SPIKE_V1_BIN ?? 'C:\\OpenCode\\opencode.exe';
const V2_BIN =
  process.env.SPIKE_V2_BIN ??
  path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    '@opencode',
    'cli',
    'node_modules',
    '@opencode',
    'cli-windows-x64',
    'bin',
    'opencode.exe',
  );

const RUN_TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 300_000;
const MAX_CAPTURE = 4_000_000;

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  process.stdout.write(`[run-spike ${ts()}] ${msg}\n`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mkdtempUnder(base, name) {
  const dir = fs.mkdtempSync(path.join(base, `2909-${name}-`));
  return dir;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Redact the local user name from captured output before it reaches any
 * committed artifact. Only the home-directory segment is rewritten; the
 * surrounding evidence text is untouched. Handles single separators, JSON
 * escaped doubled separators, and both slash styles; idempotent. Documented
 * in README (Warnings). */
function redact(text) {
  return text.replace(
    /((?:[\\/]{1,2})Users(?:[\\/]{1,2}))([^\\/"'\s:,}]{1,64})/g,
    '$1<user>',
  );
}

/** Positive evidence that a spawned host actually ran to completion: clean
 * exit, not killed by the timeout, and something was captured. Averdict on
 * top of a run that fails this check is a harness error, never a MATCH. */
function hostRan(r) {
  return r.code === 0 && !r.timedOut && (r.out + r.err).trim().length > 0;
}

/** Run a command with bounded file-backed output, a hard timeout with a
 * Windows tree-kill fallback, and best-effort cleanup. Output is captured
 * through file descriptors, not Node pipes: the v2 CLI spawns a nested
 * `serve --stdio` child whose long-form output does not reliably flush
 * through Node pipes on Windows (observed 2026-10-16: 300s hang with zero
 * captured bytes), while the same run redirected to a file completes in
 * ~30s. Captured output is home-path-redacted at capture time. */
function run(argv, { cwd, env, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const outPath = path.join(os.tmpdir(), `2909-spike-out-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const errPath = `${outPath}.err`;
    let outFd;
    let errFd;
    try {
      outFd = fs.openSync(outPath, 'a');
      errFd = fs.openSync(errPath, 'a');
    } catch (e) {
      // Partial-failure cleanup: if the second openSync threw, close the
      // first fd and remove the first temp file before bailing.
      try {
        if (outFd !== undefined) fs.closeSync(outFd);
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(outPath, { force: true });
      } catch {
        /* best effort */
      }
      resolve({ code: -1, out: '', err: `capture setup failed: ${String(e)}`, timedOut: false, spawnError: String(e) });
      return;
    }
    const childEnv = { ...env };
    // Git Bash exports PWD and the v2 CLI prefers $PWD over the process cwd
    // for project-directory resolution (observed 2026-10-16: with a stale
    // PWD pointing at the repo, the v2 server resolved the project to the
    // repo and never discovered the temp project's .opencode/plugins shim).
    delete childEnv.OLDPWD;
    childEnv.PWD = cwd;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: childEnv,
        stdin: 'ignore',
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      });
    } catch (e) {
      closeAndCleanup();
      resolve({ code: -1, out: '', err: `spawn failed: ${String(e)}`, timedOut: false, spawnError: String(e) });
      return;
    }
    let killed = false;
    let finished = false;
    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, timeoutMs);
    function closeAndCleanup() {
      // Per-operation guards: a double closeSync must not skip the rmSyncs.
      try {
        fs.closeSync(outFd);
      } catch {
        /* already closed */
      }
      try {
        fs.closeSync(errFd);
      } catch {
        /* already closed */
      }
      try {
        fs.rmSync(outPath, { force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(errPath, { force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* best effort */
      }
    }
    const finish = (code, errMsg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child);
      let out = '';
      let err = errMsg ?? '';
      try {
        out = redact(fs.readFileSync(outPath, 'utf8')).slice(0, MAX_CAPTURE);
        const errText = redact(fs.readFileSync(errPath, 'utf8'));
        err = errMsg ? `${errMsg}\n${errText}`.slice(0, MAX_CAPTURE) : errText.slice(0, MAX_CAPTURE);
      } catch {
        /* files may be unreadable if nothing was written */
      }
      closeAndCleanup();
      resolve({ code, out, err, timedOut: killed });
    };
    child.on('error', (e) => finish(-1, `spawn error: ${String(e)}`));
    child.on('close', (code) => finish(code ?? -1));
  });

  function killTree(child) {
    try {
      child.kill();
    } catch {
      /* best effort */
    }
    if (process.platform === 'win32' && child.pid) {
      // The v2 CLI nests a `serve --stdio` grandchild that inherits the
      // capture fds; TerminateProcess on the parent alone would leave it
      // holding them. taskkill /T walks the tree.
      try {
        // taskkill exits in milliseconds; Node's spawn takes no timeout
        // option — the leg timer above governs the overall budget.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          cwd: os.tmpdir(),
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => {});
      } catch {
        /* best effort */
      }
    }
  }
}

function isolatedEnv(scratchRoot) {
  const cfg = path.join(scratchRoot, 'cfg', 'opencode');
  ensureDir(cfg);
  const configFile = path.join(cfg, 'config.json');
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, '{}\n');
  return {
    ...process.env,
    OPENCODE_SWARM_DEBUG: '1',
    // Issue #3405: the version banner's raw-stderr leg is opt-in now. The
    // spike greps the exact `[opencode-swarm] running v…` format from
    // stdout+stderr as its positive plugin-load evidence; the debug-logger
    // leg prepends a timestamp that breaks that regex, so opt the harness in.
    OPENCODE_SWARM_VERSION_BANNER: '1',
    XDG_CONFIG_HOME: path.join(scratchRoot, 'cfg'),
  };
}

function writeLog(name, headerLines, body) {
  const file = path.join(LOGS_DIR, name);
  // Redaction covers the header lines too: HOST:/PLUGIN: embed the host
  // binary path under the user home.
  const text = redact(
    headerLines.join('\n') + '\n--- host output below, filtered to decision-relevant lines and home-path-redacted (not the full stream) ---\n' + body,
  );
  fs.writeFileSync(file, text);
  log(`wrote ${name} (${text.length} bytes)`);
}

function excerpt(text, patterns, { maxLines = 60, perPatternCap = 8 } = {}) {
  const lines = text.split(/\r?\n/);
  const keep = [];
  let lastPushed;
  const perPattern = new Map();
  const keptIndex = new Set();
  // Round 1 keeps decision-relevant patterns first, each pattern capped, so
  // no noisy pattern family can starve the decisive markers out of the
  // budget (feedback regression 1: 39 alternating config-noise lines
  // consumed the whole budget via a loose /error/i match before the banner
  // was reached). Round 2 fills any remaining budget with uncapped matches.
  for (const round of [0, 1]) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (keptIndex.has(i) || keep.length >= maxLines) continue;
      for (let pIdx = 0; pIdx < patterns.length; pIdx += 1) {
        if (!patterns[pIdx].test(line)) continue;
        if (round === 0) {
          const n = perPattern.get(pIdx) ?? 0;
          if (n >= perPatternCap) break;
          perPattern.set(pIdx, n + 1);
        }
        if (line !== lastPushed) {
          keep.push(line);
          keptIndex.add(i);
          lastPushed = line;
        }
        break;
      }
    }
  }
  return keep.join('\n');
}

async function prevalidateAblation(scratchPkg, removeKey) {
  const mod = await import(pathToFileURL(path.join(scratchPkg, 'dist', 'index.js')).href);
  const pristine = await import(pathToFileURL(DIST).href);
  const got = Object.keys(mod.default).sort().join(',');
  const want = Object.keys(pristine.default)
    .filter((k) => k !== removeKey)
    .sort()
    .join(',');
  const removedStillThere = removeKey in mod.default;
  if (got !== want || removedStillThere || !('id' in mod.default)) {
    throw new Error(
      `ablation pre-validation failed for remove=${removeKey}: keys=${got} expected=${want} removedStillPresent=${removedStillThere}`,
    );
  }
  return { got, want };
}

function makeAblatedPackage(scratchRoot, label, removeKey) {
  const pkg = path.join(scratchRoot, `pkg-${label}`);
  ensureDir(path.join(pkg, 'dist'));
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    `${JSON.stringify({ name: `opencode-swarm-spike-${label}`, version: '0.0.0', type: 'module', main: 'dist/index.js' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(pkg, 'dist', 'index.js'),
    [
      `import pristine from ${JSON.stringify(pathToFileURL(DIST).href)};`,
      `const ablated = { ...pristine };`,
      `delete ablated.${removeKey};`,
      `export default ablated;`,
      '',
    ].join('\n'),
  );
  return pkg;
}

function v1Project(scratchRoot, pluginDir) {
  const proj = mkdtempUnder(scratchRoot, 'v1proj');
  fs.writeFileSync(
    path.join(proj, 'opencode.json'),
    `${JSON.stringify({ plugin: [`file:${pluginDir.replaceAll('\\', '/')}`] }, null, 2)}\n`,
  );
  return proj;
}

function v2Project(scratchRoot, pluginDistOrPkgUrl) {
  const proj = mkdtempUnder(scratchRoot, 'v2proj');
  const plugins = path.join(proj, '.opencode', 'plugins');
  ensureDir(plugins);
  fs.writeFileSync(
    path.join(plugins, 'local-spike.js'),
    `import plugin from ${JSON.stringify(pluginDistOrPkgUrl)};\nexport default plugin;\n`,
  );
  return proj;
}

/** Host-exclusive v1 config-hook evidence: the HOST `agent list` table (not
 * plugin-internal debug lines) carries the swarm agents as `(primary)` /
 * `(subagent)` entries. */
function hasSwarmAgents(out) {
  return /architect \(primary\)/.test(out) && /(coder|reviewer|explorer)[^\n]*\(subagent\)/.test(out);
}

function sessionStateDir(proj) {
  return path.join(proj, '.swarm', 'session');
}

async function hostVersion(bin) {
  const r = await run([bin, '--version'], { cwd: os.tmpdir(), env: process.env, timeoutMs: 30_000 });
  const version = (r.out + r.err).trim().split(/\r?\n/)[0] ?? '';
  if (r.code !== 0 || !version) {
    throw new Error(`host version probe failed for ${bin}: exit=${r.code} timedOut=${r.timedOut} err=${r.err.slice(-300)}`);
  }
  return version;
}

async function main() {
  const measure = process.argv.includes('--measure');
  ensureDir(LOGS_DIR);
  if (!fs.existsSync(DIST)) {
    log('dist/index.js missing — building (bun run build)');
    const b = await run(['bun', 'run', 'build'], { cwd: REPO_ROOT, env: process.env, timeoutMs: BUILD_TIMEOUT_MS });
    if (b.code !== 0) throw new Error(`build failed: exit=${b.code} timedOut=${b.timedOut} err=${(b.out + b.err).slice(-2000)}`);
  }
  const distSha = sha256(DIST);
  const v1Version = await hostVersion(V1_BIN);
  const v2Version = await hostVersion(V2_BIN);
  log(`v1: ${v1Version} (${V1_BIN})`);
  log(`v2: ${v2Version} (${V2_BIN})`);
  log(`dist sha256: ${distSha}`);

  const scratch = mkdtempUnder(os.tmpdir(), 'scratch');
  const failures = [];

  // ---------- v1 main run ----------
  {
    const proj = v1Project(scratch, REPO_ROOT);
    const env = isolatedEnv(scratch);
    const r = await run([V1_BIN, 'agent', 'list', '--print-logs'], { cwd: proj, env });
    const full = r.out + r.err;
    const banner = /\[opencode-swarm\] running v\S+/.exec(full);
    const ran = hostRan(r);
    const fired = ran && hasSwarmAgents(full);
    const warnings = [];
    if (/Ignored \d+ invalid/.test(full)) warnings.push('config-advisory: ignored invalid config keys (user-config carry-over absent under isolated XDG; see log)');
    const header = [
      `HOST: opencode ${v1Version} | ${V1_BIN}`,
      `PLUGIN: file:${REPO_ROOT.replaceAll('\\', '/')} | dist sha256 ${distSha}`,
      `RUN: ${ts()} | args: agent list --print-logs | env: OPENCODE_SWARM_DEBUG=1, isolated XDG_CONFIG_HOME | exit=${r.code} | host-ran=${ran}`,
      `ENTRYPOINT: server() — the v1 host consulted id/server only; see v1-nosetup-ablation.log / v1-noserver-ablation.log for the ablation proof that setup() is inert on v1`,
      `HOOK-FIRED: config hook — host agent table lists the swarm agents (host output lines, not plugin debug): ${fired ? 'YES (architect (primary) + subagent entries present)' : 'NO'}`,
      `WARNINGS: ${warnings.length ? warnings.join('; ') : 'none observed'}`,
    ];
    if (!ran) failures.push(`v1 main run: host did not run cleanly (exit=${r.code} timedOut=${r.timedOut})`);
    else if (!banner || !fired) failures.push(`v1 main run: banner=${!!banner} agents=${fired} exit=${r.code}`);
    writeLog(
      'v1-host.log',
      header,
      excerpt(full, [
        /loading plugin/i,
        /\[opencode-swarm\] running v/,
        /architect \(primary\)/,
        /\(subagent\)/,
        /synchronized bundled skill/,
        /Ignored \d+ invalid/,
        /init-path I\/O completed/,
      ], { maxLines: 80 }),
    );
  }

  // ---------- v1 ablations ----------
  const ablations = [
    { label: 'nosetup', removeKey: 'setup', expectLoads: true },
    { label: 'noserver', removeKey: 'server', expectLoads: false },
  ];
  for (const ab of ablations) {
    try {
      const pkg = makeAblatedPackage(scratch, `v1-${ab.label}`, ab.removeKey);
      const pre = await prevalidateAblation(pkg, ab.removeKey);
      const proj = v1Project(scratch, pkg);
      const env = isolatedEnv(scratch);
      const r = await run([V1_BIN, 'agent', 'list', '--print-logs'], { cwd: proj, env });
      const full = r.out + r.err;
      const ran = hostRan(r);
      const banner = /\[opencode-swarm\] running v\S+/.test(full);
      // Positive-evidence gating: a verdict requires proof the host ran; the
      // "dropped" leg additionally requires the host's own failed-to-load
      // record so absence of a banner is never the sole evidence.
      const dropRecorded = /failed to load plugin|must default export an object with server/i.test(full);
      const loaded = ran && banner && !dropRecorded;
      const dropped = ran && !banner && (ab.label === 'noserver' ? dropRecorded : true);
      const observed = !ran
        ? `host did not run (exit=${r.code} timedOut=${r.timedOut})`
        : loaded
          ? 'plugin loaded (banner present, no drop record)'
          : dropped
            ? 'plugin dropped (no banner; host drop record present)'
            : 'no banner and no drop record';
      const verdict = !ran
        ? 'MISMATCH'
        : ab.expectLoads
          ? (loaded ? 'MATCH' : 'MISMATCH')
          : (dropped ? 'MATCH' : 'MISMATCH');
      if (!ran) failures.push(`v1 ablation ${ab.label}: HARNESS — host did not run cleanly`);
      else if (verdict === 'MISMATCH') failures.push(`v1 ablation ${ab.label}: expected load=${ab.expectLoads} observed=${observed}`);
      writeLog(
        `v1-${ab.label}-ablation.log`,
        [
          `HOST: opencode ${v1Version} | ${V1_BIN}`,
          `ABLATION: removed export key '${ab.removeKey}' (wrapper module; pre-validated keys=${pre.got})`,
          `ABLATION: expected=${ab.expectLoads ? 'loads (key is inert on v1)' : 'dropped (v1 requires server; host drop record required)'} observed=${observed} — ${verdict}`,
          `RUN: ${ts()} | exit=${r.code} | host-ran=${ran} | dist sha256 ${distSha}`,
        ],
        excerpt(full, [/loading plugin/i, /running v/, /failed to load plugin/i, /must default export/i, /level=ERROR/, /architect \(primary\)/], { maxLines: 40 }),
      );
    } catch (e) {
      failures.push(`v1 ablation ${ab.label}: harness error ${String(e)}`);
      writeLog(`v1-${ab.label}-ablation.log`, [`ABLATION: HARNESS ERROR — ${String(e)}`], '');
    }
  }

  // ---------- v2 main run ----------
  {
    const proj = v2Project(scratch, pathToFileURL(DIST).href);
    const env = isolatedEnv(scratch);
    const r = await run([V2_BIN, 'run', '--standalone', '--print-logs', 'Reply with the single word: loaded'], {
      cwd: proj,
      env,
      timeoutMs: 300_000,
    });
    const full = r.out + r.err;
    const banner = /\[opencode-swarm\] running v\S+/.test(full);
    const loadedLocalShim = /loading plugin[^\n]*local-spike\.js/.test(full);
    const sessionDir = sessionStateDir(proj);
    const sessionState = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
    const replied = /loaded/.test(r.out.trim().split(/\r?\n/).pop() ?? '');
    const ran = hostRan(r);
    const warnings = [];
    const sqlite = /sqlite-vec extension not available[^\n]*/.exec(full);
    if (sqlite) warnings.push(sqlite[0].slice(0, 200));
    const header = [
      `HOST: ${v2Version} | ${V2_BIN} (npm @opencode/cli platform binary; the .cmd shim's blocked postinstall is bypassed by invoking the platform exe directly)`,
      `PLUGIN: .opencode/plugins/local-spike.js re-export ${pathToFileURL(DIST).href} | dist sha256 ${distSha}`,
      `RUN: ${ts()} | args: run --standalone --print-logs (tool-free prompt) | env: OPENCODE_SWARM_DEBUG=1, isolated XDG_CONFIG_HOME | exit=${r.code} | host-ran=${ran}`,
      `ENTRYPOINT: setup(ctx) — the v2 host decodes the default export against {id, setup|effect}; see v2-noserver-ablation.log / v2-nosetup-ablation.log for the ablation proof that server() is inert on v2`,
      `HOOK-FIRED: session hook family — ${sessionState ? `.swarm/session state written during the tool-free prompt turn; attributable to the registered session hooks on that turn (the context hook via seedV1SessionState and/or the prompt hook via cacheCohortIdAtMessage -> ensureAgentSession — v2 does not relay plugin stdout, so the writer is not disambiguated host-side; both are registrations proved by setup() running)` : 'NOT OBSERVED (.swarm/session empty)'}; model reply received: ${replied ? 'yes ("loaded")' : 'no'}`,
      `WARNINGS: ${warnings.length ? warnings.join('; ') : 'none observed'}`,
    ];
    if (!ran) failures.push(`v2 main run: host did not run cleanly (exit=${r.code} timedOut=${r.timedOut})`);
    else if (!banner || !loadedLocalShim || !sessionState) failures.push(`v2 main run: banner=${banner} shimLoad=${loadedLocalShim} sessionState=${sessionState} exit=${r.code}`);
    writeLog(
      'v2-host.log',
      header,
      excerpt(full, [
        /loading plugin/i,
        /\[opencode-swarm\] running v/,
        /sqlite-vec/,
        /session/i,
        /message=event/i,
        /loaded/,
      ], { maxLines: 80 }),
    );
    // v2 first-turn TIMING is not machine-measurable through this harness:
    // the v2 CLI's --print-logs output carries no session lifecycle lines at
    // the default level and does not relay plugin stdout (so the per-skill
    // sync timestamps are invisible too). The v2 spike legs above prove the
    // load/attribution/hook-firing behavior; the window itself is measured on
    // v1, which relays both surfaces.
  }

  // ---------- v2 ablations ----------
  for (const ab of [
    { label: 'noserver', removeKey: 'server', expectLoads: true },
    { label: 'nosetup', removeKey: 'setup', expectLoads: false },
  ]) {
    try {
      const pkg = makeAblatedPackage(scratch, `v2-${ab.label}`, ab.removeKey);
      const pre = await prevalidateAblation(pkg, ab.removeKey);
      const proj = v2Project(scratch, pathToFileURL(path.join(pkg, 'dist', 'index.js')).href);
      const env = isolatedEnv(scratch);
      const r = await run([V2_BIN, 'run', '--standalone', '--print-logs', 'hi'], { cwd: proj, env, timeoutMs: 300_000 });
      const full = r.out + r.err;
      const banner = /\[opencode-swarm\] running v\S+/.test(full);
      const decodeError = /Plugin must export a default definition with an id and an effect or setup function\./.test(full);
      const ran = hostRan(r);
      const loaded = ran && banner && !decodeError;
      const observed = !ran
        ? `host did not run (exit=${r.code} timedOut=${r.timedOut})`
        : decodeError
          ? 'host decode error (verbatim literal present)'
          : loaded
            ? 'plugin loaded (banner present)'
            : `no banner and no decode error (exit=${r.code})`;
      const verdict = loaded === ab.expectLoads && (!ab.expectLoads ? decodeError : true) ? 'MATCH' : 'MISMATCH';
      if (!ran) failures.push(`v2 ablation ${ab.label}: HARNESS — host did not run cleanly`);
      else if (verdict === 'MISMATCH') failures.push(`v2 ablation ${ab.label}: expected load=${ab.expectLoads} observed=${observed}`);
      writeLog(
        `v2-${ab.label}-ablation.log`,
        [
          `HOST: ${v2Version} | ${V2_BIN}`,
          `ABLATION: removed export key '${ab.removeKey}' (wrapper module; pre-validated keys=${pre.got})`,
          `ABLATION: expected=${ab.expectLoads ? 'loads (key is inert on v2)' : `dropped with the literal decode error (${ab.removeKey} required by the v2 schema)`} observed=${observed} — ${verdict}`,
          `RUN: ${ts()} | exit=${r.code} | host-ran=${ran} | dist sha256 ${distSha}`,
        ],
        excerpt(full, [/loading plugin/i, /running v/, /Plugin must export/i, /failed to load plugin/i, /level=ERROR/], { maxLines: 40 }),
      );
    } catch (e) {
      failures.push(`v2 ablation ${ab.label}: harness error ${String(e)}`);
      writeLog(`v2-${ab.label}-ablation.log`, [`ABLATION: HARNESS ERROR — ${String(e)}`], '');
    }
  }

  if (measure) {
    for (let i = 1; i <= 3; i += 1) {
      await measureOnce(V1_BIN, v1Version, distSha, scratch, `v1-run${i}`, failures);
    }
  }

  // Print the failures report BEFORE scratch cleanup: an EBUSY on tree
  // removal must not hide the per-leg diagnostics.
  if (failures.length) {
    log(`FAILURES:\n  ${failures.join('\n  ')}`);
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    log(`scratch cleanup incomplete (non-fatal): ${String(e)}`);
  }
  if (failures.length) {
    process.exit(1);
  }
  log('all spike runs green');
}

function parseTs(line) {
  const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)Z)/.exec(line);
  return m ? Date.parse(m[1]) : undefined;
}

async function measureOnce(bin, version, distSha, scratch, label, failures) {
  let last;
  // A cold host occasionally loses a startup race (observed 2026-10-16 on
  // v2: fast exit with no session events while the identical command a
  // minute earlier ran green) — retry once when the measurement's own
  // target quantities did not parse before recording.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    last = await measureAttempt(bin, version, distSha, scratch, label, attempt);
    if (last.row.exit === 0 && last.row.syncCompletionVisible && last.sessionCreated !== undefined) break;
    log(`measure ${label}: attempt ${attempt} incomplete (exit=${last.row.exit}, syncVisible=${last.row.syncCompletionVisible}, session=${last.sessionCreated !== undefined}); ${attempt < 2 ? 'retrying' : 'recording as-is'}`);
  }
  if (last.row.exit !== 0 || last.sessionCreated === undefined || !last.row.syncCompletionVisible) {
    failures.push(`measure ${label}: incomplete parse (exit=${last.row.exit}, sessionCreated=${last.sessionCreated}, syncVisible=${last.row.syncCompletionVisible})`);
  }
  return last.row;
}

async function measureAttempt(bin, version, distSha, scratch, label, attemptNo) {
  const proj = v1Project(scratch, REPO_ROOT);
  const env = isolatedEnv(scratch);
  const argv = [bin, 'run', '--print-logs', 'hi'];
  const t0 = Date.now();
  const r = await run(argv, { cwd: proj, env, timeoutMs: 300_000 });
  const wallMs = Date.now() - t0;
  const full = r.out + r.err;
  const lines = full.split(/\r?\n/);
  let sessionCreated;
  let syncFirst;
  let syncLast;
  let modelStream;
  for (const ln of lines) {
    const t = parseTs(ln);
    if (t === undefined) continue;
    if (sessionCreated === undefined && /(message=created id=ses_|event\.type=session\.created|message=created )/.test(ln)) sessionCreated = t;
    if (/synchronized bundled skill/.test(ln)) {
      if (syncFirst === undefined) syncFirst = t;
      syncLast = t;
    }
    if (modelStream === undefined && /message=stream |message="stream/.test(ln)) modelStream = t;
  }
  // The plugin-init banner (`[opencode-swarm] running v…`) is an untimed
  // console.warn, so no plugin-init-derived delta exists; the row records
  // only the relative windows that parse from timestamped host lines.
  const syncCompletionVisible = syncLast !== undefined;
  const row = {
    label,
    host: version,
    distSha,
    attempt: attemptNo,
    capturedAt: ts(),
    exit: r.code,
    wallMs,
    sessionCreatedToSyncLastMs: sessionCreated !== undefined && syncLast !== undefined ? syncLast - sessionCreated : null,
    syncDurationMs: syncFirst !== undefined && syncLast !== undefined ? syncLast - syncFirst : null,
    sessionCreatedToModelStreamMs: sessionCreated !== undefined && modelStream !== undefined ? modelStream - sessionCreated : null,
    firstTurnArrivedBeforeSyncDone: sessionCreated !== undefined && syncLast !== undefined ? sessionCreated < syncLast : null,
    syncCompletionVisible,
  };
  fs.writeFileSync(path.join(LOGS_DIR, `first-turn-window-${label}.json`), `${JSON.stringify(row, null, 2)}\n`);
  log(`measure ${label} (attempt ${attemptNo}): ${JSON.stringify(row)}`);
  return { row, sessionCreated };
}

main().catch((e) => {
  process.stderr.write(`[run-spike] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
