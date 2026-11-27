#!/usr/bin/env node
/**
 * Issue #2910 residual scope item 1 — the pinned-host AUTH-FREE load proof
 * for the v2 CI lane. Companion of scripts/repro-2910-v2.mjs: that script
 * proves the dual shape and bounded setup against a fake v2 ctx; THIS script
 * proves the REAL pinned OpenCode 2 host loads the plugin and emits its
 * registration events. Modeled on the v2 leg of
 * spikes/v2-dual-shape/run-spike.mjs (load route, fd-backed capture,
 * PWD/OLDPWD handling), but self-contained and auth-free:
 *
 *   (a) `npm install --prefix <tmpdir> @opencode/cli@2.0.29 --no-save`
 *       (array-form spawn, 300s timeout, bounded fd-backed output, stdin
 *       ignore), then the PLATFORM binary is resolved: win32 ->
 *       <tmp>/node_modules/@opencode/cli/node_modules/@opencode/
 *       cli-windows-x64/bin/opencode.exe (the .cmd shim's postinstall
 *       bypass), else <tmp>/node_modules/.bin/opencode.
 *   (b) dist/index.js is auto-built when missing (same rule as
 *       repro-2910-v2.mjs — this script never depends on a pre-existing
 *       dist). Scratch project with .opencode/plugins/local-v2-smoke.js
 *       re-exporting file:///<repo>/dist/index.js.
 *   (c) Child env: isolated XDG_CONFIG_HOME (scratch dir with an empty
 *       opencode/config.json), OLDPWD DELETED, PWD set to the project dir
 *       (the v2 host resolves the project from PWD — load-bearing, observed
 *       2026-10-16 in the spike), auth/data dirs untouched.
 *   (d) `<bin> run --standalone --print-logs "Reply with the single word:
 *       loaded"` — cwd = project, 120s timeout, file-descriptor capture
 *       (fs.openSync temp files, stdio ['ignore', outFd, errFd] — NOT
 *       pipes: the v2 CLI's nested serve child does not reliably flush
 *       through Node pipes on Windows).
 *   (e) AUTH-FREE evidence only (CI has no model auth — the model reply is
 *       NOT asserted): a `loading plugin` line naming local-v2-smoke.js,
 *       the /[opencode-swarm] running v/ banner, at least one
 *       agent.updated or command.updated event line, and `.swarm/`
 *       materialization under the project dir. An expired/absent API key
 *       does not affect any of these.
 *
 * Tokens: `host-load: banner=1 events=<n> swarm-dir=1`, then
 * `result=PASS` / `result=FAIL` (exit 0 / 1). Home paths are redacted in
 * every printed line; scratch cleanup is best-effort.
 */

import { spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist', 'index.js');

const V2_HOST_VERSION = '2.0.29';
const INSTALL_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;
const MAX_CAPTURE = 4_000_000;

export function redact(text) {
	// Redact the local user name (home-directory segment) from any printed
	// or captured text — handles both slash styles; idempotent.
	// NOTE: this runs over the WHOLE capture that classifyHostRun scans, so it
	// is deliberately kept narrow and verdict-neutral. The broader privacy
	// rules for the (public) timeout dump live in redactLogLine below and are
	// applied at print time only.
	return text.replace(
		/((?:[\\/]{1,2})Users(?:[\\/]{1,2}))([^\\/"'\s:,}]{1,64})/g,
		'$1<user>',
	);
}

/**
 * Print-time-only home-path redaction for the timeout dump (never applied to
 * the text classifyHostRun reads): the home segment in any case, POSIX
 * /home/<user>, and a space-containing user name when a path separator or
 * quote follows it (`C:\Users\John Smith\x`, `"C:\Users\John Smith"`).
 * Continuation words exclude `=` so key=value log tokens are never absorbed.
 * A multi-word name with no following separator or quote is a documented,
 * accepted residual (taking it would swallow free text); CI runner accounts
 * (runner / runneradmin) contain no spaces. Idempotent.
 */
export function redactLogLine(text) {
	return text.replace(
		/((?:[\\/]{1,2})(?:Users|home)(?:[\\/]{1,2}))((?:[^\\/"'\s:,}=]{1,64}(?: [^\\/"'\s:,}=]{1,64}){1,2}(?=[\\/"']))|[^\\/"'\s:,}]{1,64})/gi,
		'$1<user>',
	);
}

// Bounded per-stream tail kept by run() (chars of already-redacted text),
// independent of the MAX_CAPTURE HEAD that classification scans, so the
// timeout dump shows where the run actually ended even when the capture
// exceeds MAX_CAPTURE.
const TAIL_CAPTURE = 262_144;
const TAIL_LINES_PER_STREAM = 30;
const TAIL_LINE_CAP = 300;

/**
 * Strip ANSI CSI sequences and C0/DEL control characters (tab kept) from one
 * captured line so child output cannot overwrite, recolor, or spoof the CI
 * log. A lone CR is turned into a line break by the caller's split.
 */
function stripControls(line) {
	return line
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f\u2028\u2029]/g, '');
}

/** Token-shaped secret scrub for lines that reach the (public) CI log. */
function scrubSecrets(line) {
	return line
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<redacted>')
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted>')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<redacted>')
		.replace(/\bnpm_[A-Za-z0-9]{20,}/g, '<redacted>')
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
		.replace(
			/\b((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
			'$1<redacted>',
		);
}

function tailLines(text, count) {
	const lines = text
		.split(/\r\n|\r|\n/)
		.map(stripControls)
		.filter((ln) => ln.trim() !== '');
	return { total: lines.length, tail: lines.slice(-count) };
}

/**
 * PURE builder for the timeout diagnostic dump. Tails EACH stream separately
 * (stdout and stderr are separate fd captures, so no chronological interleave
 * exists to preserve — the header says so), strips control characters,
 * scrubs token shapes, caps every line at TAIL_LINE_CAP, and gives every line
 * a fixed prefix. Uses the stream tails run() preserved (the true end of a
 * capture larger than MAX_CAPTURE) and falls back to `out`/`err`. Returns the
 * lines to print, bounded by 2 * TAIL_LINES_PER_STREAM tail lines plus two
 * headers.
 */
export function formatCaptureTail(r) {
	const prefix = '[repro-2910-v2-host]';
	const lines = [];
	for (const [label, full, tailText, truncated, windowed] of [
		['stdout', r.out ?? '', r.outTail, r.outTruncated, r.outWindowed],
		['stderr', r.err ?? '', r.errTail, r.errTruncated, r.errWindowed],
	]) {
		let source = typeof tailText === 'string' ? tailText : full;
		if (windowed) {
			// The window is a strict suffix of the stream, so its first line
			// may be cut mid-token (which would defeat the prefix-based
			// scrub): drop it.
			const nl = source.search(/\r\n|\r|\n/);
			source = nl === -1 ? '' : source.slice(nl).replace(/^(?:\r\n|\r|\n)/, '');
		}
		const { total, tail } = tailLines(source, TAIL_LINES_PER_STREAM);
		const partial = truncated || windowed;
		const trunc = truncated
			? `; capture exceeded ${MAX_CAPTURE} chars, showing the true end of the stream`
			: windowed
				? `; counted within the last ${TAIL_CAPTURE} chars only`
				: '';
		lines.push(
			`${prefix} captured ${label} tail (redacted, last ${tail.length} of ${total}${partial ? '+' : ''} non-empty lines${trunc}; stdout and stderr are separate captures, not interleaved):`,
		);
		for (const line of tail) {
			lines.push(
				`${prefix}   ${label}: ${scrubSecrets(redactLogLine(redact(line))).slice(0, TAIL_LINE_CAP)}`,
			);
		}
	}
	return lines;
}

/** Best-effort child-tree kill (direct kill + Windows taskkill /T walk). */
function killTree(child) {
	try {
		child.kill();
	} catch {
		/* best effort */
	}
	if (process.platform === 'win32' && child.pid) {
		// The v2 CLI nests a serve grandchild that inherits the capture fds;
		// TerminateProcess on the parent alone would leave it holding them.
		try {
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

/**
 * Spawn argv with fd-backed bounded capture (NOT pipes), a hard timeout, and
 * best-effort kill on every exit path. Captured output is home-path
 * redacted at read time and truncated to MAX_CAPTURE.
 */
function run(argv, { cwd, env, timeoutMs }) {
	return new Promise((resolve) => {
		const outPath = path.join(
			os.tmpdir(),
			`repro-2910-v2-host-${process.pid}-${Math.random().toString(36).slice(2)}.out`,
		);
		const errPath = `${outPath}.err`;
		let outFd;
		let errFd;
		try {
			outFd = openSync(outPath, 'a');
			errFd = openSync(errPath, 'a');
		} catch (e) {
			resolve({
				code: -1,
				out: '',
				err: `capture setup failed: ${String(e)}`,
				timedOut: false,
			});
			return;
		}
		let killed = false;
		let finished = false;
		const closeAndCleanup = () => {
			try {
				closeSync(outFd);
			} catch {
				/* already closed */
			}
			try {
				closeSync(errFd);
			} catch {
				/* already closed */
			}
			try {
				rmSync(outPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
			try {
				rmSync(errPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
		};
		const finish = (code, note) => {
			if (finished) return;
			finished = true;
			let out = '';
			let err = note ?? '';
			let outTail = '';
			let errTail = note ?? '';
			let outTruncated = false;
			let errTruncated = false;
			let outWindowed = false;
			let errWindowed = false;
			try {
				const outText = redact(readFileSync(outPath, 'utf8'));
				out = outText.slice(0, MAX_CAPTURE);
				outTail = outText.slice(-TAIL_CAPTURE);
				outTruncated = outText.length > MAX_CAPTURE;
				outWindowed = outText.length > TAIL_CAPTURE;
				const errText = redact(readFileSync(errPath, 'utf8'));
				const errAll = note ? `${note}\n${errText}` : errText;
				err = errAll.slice(0, MAX_CAPTURE);
				errTail = errAll.slice(-TAIL_CAPTURE);
				errTruncated = errAll.length > MAX_CAPTURE;
				errWindowed = errAll.length > TAIL_CAPTURE;
			} catch {
				/* nothing written */
			}
			closeAndCleanup();
			resolve({
				code,
				out,
				err,
				outTail,
				errTail,
				outTruncated,
				errTruncated,
				outWindowed,
				errWindowed,
				timedOut: killed,
			});
		};
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				env,
				stdin: 'ignore',
				stdio: ['ignore', outFd, errFd],
				windowsHide: true,
			});
		} catch (e) {
			finish(-1, `spawn failed: ${String(e)}`);
			return;
		}
		const timer = setTimeout(() => {
			killed = true;
			killTree(child);
		}, timeoutMs);
		child.on('error', (e) => {
			clearTimeout(timer);
			killTree(child);
			finish(-1, `spawn error: ${String(e)}`);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			killTree(child);
			finish(code ?? -1);
		});
	});
}

/** `bun run build` (repro-2910-v2.mjs auto-build leg, same rules). */
function runBuild() {
	return new Promise((resolveRun) => {
		const outPath = path.join(
			os.tmpdir(),
			`repro-2910-v2-host-build-${process.pid}-${Math.random().toString(36).slice(2)}.out`,
		);
		const errPath = `${outPath}.err`;
		let outFd;
		let errFd;
		try {
			outFd = openSync(outPath, 'a');
			errFd = openSync(errPath, 'a');
		} catch (err) {
			resolveRun({ code: -1, out: '', err: String(err) });
			return;
		}
		let killed = false;
		const finish = (code, note) => {
			let out = '';
			let err = note ?? '';
			try {
				out = readFileSync(outPath, 'utf8').slice(0, MAX_CAPTURE);
				const errText = readFileSync(errPath, 'utf8');
				err = note ? `${note}\n${errText}` : errText;
			} catch {
				/* nothing written */
			}
			try {
				closeSync(outFd);
			} catch {
				/* already closed */
			}
			try {
				closeSync(errFd);
			} catch {
				/* already closed */
			}
			try {
				rmSync(outPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
			try {
				rmSync(errPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
			resolveRun({ code, out: out.slice(0, MAX_CAPTURE), err: err.slice(0, MAX_CAPTURE), timedOut: killed });
		};
		let child;
		try {
			child = spawn('bun', ['run', 'build'], {
				cwd: ROOT,
				env: process.env,
				stdin: 'ignore',
				stdio: ['ignore', outFd, errFd],
				windowsHide: true,
			});
		} catch (err) {
			finish(-1, `spawn failed: ${String(err)}`);
			return;
		}
		const timer = setTimeout(() => {
			killed = true;
			killTree(child);
		}, BUILD_TIMEOUT_MS);
		child.on('error', (err) => {
			clearTimeout(timer);
			killTree(child);
			finish(-1, `spawn error: ${String(err)}`);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			killTree(child);
			finish(code ?? -1);
		});
	});
}

/** Auto-build: never depend on a pre-existing dist. */
async function ensureDist() {
	if (existsSync(DIST)) return;
	console.log(
		'[repro-2910-v2-host] dist/index.js missing — auto-build (bun run build, 300s budget)',
	);
	const build = await runBuild();
	if (build.code !== 0 || !existsSync(DIST)) {
		console.error(
			`[repro-2910-v2-host] FAILED auto-build: exit=${build.code} timedOut=${build.timedOut}`,
		);
		console.error((build.err || build.out || '').slice(-2000));
		console.error('result=FAIL');
		process.exit(1);
	}
	console.log('[repro-2910-v2-host] auto-build complete');
}

/**
 * Resolve an npm argv that is array-form-spawnable: prefer the npm CLI JS
 * bundled with the running Node (spawning npm.cmd without a shell is
 * refused by Node on Windows), then $npm_execpath. A bare `npm` is a last
 * resort ONLY off win32 — on win32 `npm` is a .cmd shim Node cannot
 * array-form-spawn, so the win32 fallback stays on the bundled npm-cli.js
 * idiom (same as scripts/package-smoke.mjs npmInvocation; review PRR-030).
 */
function resolveNpmArgv() {
	const candidates = [
		path.join(
			path.dirname(process.execPath),
			'node_modules',
			'npm',
			'bin',
			'npm-cli.js',
		),
	];
	const execPath = process.env.npm_execpath;
	if (execPath && /\.(m?js|cjs)$/.test(execPath)) candidates.push(execPath);
	for (const cliJs of candidates) {
		if (existsSync(cliJs)) return [process.execPath, cliJs];
	}
	if (process.platform === 'win32') {
		// The existence probes missed, but win32 still cannot array-form-spawn
		// a bare `npm` — return the bundled CLI JS argv unconditionally (the
		// package-smoke idiom) so a genuinely missing file surfaces as a clear
		// spawn error instead of an unconditional spawn failure on `npm`.
		return [
			process.execPath,
			path.join(
				path.dirname(process.execPath),
				'node_modules',
				'npm',
				'bin',
				'npm-cli.js',
			),
		];
	}
	return ['npm'];
}

/** The pinned host's platform binary inside the temp install prefix. */
function resolveHostBinary(tmpInstall) {
	if (process.platform === 'win32') {
		// The platform package nested under @opencode/cli (spike-observed
		// layout; invoking the exe directly bypasses the .cmd shim's blocked
		// postinstall).
		const nested = path.join(
			tmpInstall,
			'node_modules',
			'@opencode',
			'cli',
			'node_modules',
			'@opencode',
			'cli-windows-x64',
			'bin',
			'opencode.exe',
		);
		if (existsSync(nested)) return nested;
		// npm's flat hoisting may lift the platform package one level.
		const hoisted = path.join(
			tmpInstall,
			'node_modules',
			'@opencode',
			'cli-windows-x64',
			'bin',
			'opencode.exe',
		);
		if (existsSync(hoisted)) return hoisted;
		return nested;
	}
	return path.join(tmpInstall, 'node_modules', '.bin', 'opencode');
}

function childEnv(scratchRoot, proj) {
	const cfgRoot = path.join(scratchRoot, 'cfg');
	const opencodeDir = path.join(cfgRoot, 'opencode');
	mkdirSync(opencodeDir, { recursive: true });
	const configFile = path.join(opencodeDir, 'config.json');
	if (!existsSync(configFile)) writeFileSync(configFile, '{}\n');
	const env = {
		...process.env,
		OPENCODE_SWARM_DEBUG: '1',
		// The init banner's raw stderr leg is opt-in since #3405 (the default
		// leg is the debug-gated logger's stdout line, which the v2 host does
		// not relay) — required for the banner evidence below.
		OPENCODE_SWARM_VERSION_BANNER: '1',
		XDG_CONFIG_HOME: cfgRoot,
	};
	// Git Bash exports PWD and the v2 CLI prefers $PWD over the process cwd
	// for project-directory resolution — load-bearing: a stale PWD makes the
	// host resolve the wrong project and never discover the plugins shim.
	delete env.OLDPWD;
	env.PWD = proj;
	// Auth/data dirs are deliberately untouched — the assertions below are
	// auth-free and must not depend on whatever auth the environment has.
	return env;
}

function printEvidenceLines(label, lines, cap) {
	const shown = lines.slice(0, cap);
	for (const line of shown) {
		console.log(`[repro-2910-v2-host]   ${label}: ${redact(line).slice(0, 300)}`);
	}
	if (lines.length > shown.length) {
		console.log(
			`[repro-2910-v2-host]   ${label}: ... ${lines.length - shown.length} more`,
		);
	}
}

/**
 * PURE evidence classification for the host run — the SINGLE SOURCE of the
 * script's pass/fail decision (exported for
 * tests/unit/scripts/repro-2910-v2-host-classify.test.ts). Rules, exactly as
 * main() applies them:
 *
 *   - a TIMEOUT is an UNCONDITIONAL failure (plan-critic round 2: a host can
 *     emit full load evidence and then hang to the 120s kill — evidence
 *     alone must not pass a run whose process never exited);
 *   - an install/binary failure (priorFailures, recorded before the host
 *     run) fails — the script skips the run entirely and the classifier
 *     mirrors that short-circuit (no evidence reasons are invented for a
 *     run that never happened);
 *   - each AUTH-FREE evidence condition missing from `output` fails: a
 *     `loading plugin` line naming local-v2-smoke.js, the
 *     /[opencode-swarm] running v/ banner, an agent.updated or
 *     command.updated event line, and `.swarm/` materialization
 *     (swarmDirExists = the directory exists AND is populated);
 *   - `exitCode` is NOT itself a verdict input: an AUTH-ERROR exit
 *     (exitCode 1) with FULL evidence PASSES — every evidence condition is
 *     auth-free by design (CI has no model auth).
 *
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function classifyHostRun({
	timedOut,
	exitCode,
	output,
	swarmDirExists,
	priorFailures = [],
}) {
	if (priorFailures.length > 0) {
		return { pass: false, reasons: [...priorFailures] };
	}
	const reasons = [];
	if (timedOut) {
		reasons.push('host run timed out');
	}
	const lines = String(output ?? '').split(/\r?\n/);
	if (
		!lines.some(
			(ln) => /loading plugin/i.test(ln) && /local-v2-smoke\.js/.test(ln),
		)
	) {
		reasons.push(
			'no `loading plugin` line naming local-v2-smoke.js in the host output',
		);
	}
	if (!lines.some((ln) => /\[opencode-swarm\] running v\S+/.test(ln))) {
		reasons.push('no /[opencode-swarm] running v/ banner in the host output');
	}
	if (
		!lines.some((ln) =>
			/event\.type=(agent\.updated|command\.updated)\b/.test(ln),
		)
	) {
		reasons.push(
			'no agent.updated or command.updated event line in the host output',
		);
	}
	if (!swarmDirExists) {
		reasons.push('.swarm/ not materialized under the project dir');
	}
	return { pass: reasons.length === 0, reasons };
}

async function main() {
	await ensureDist();

	const tmpInstall = mkdtempSync(
		path.join(os.tmpdir(), 'repro-2910-v2-host-install-'),
	);
	const scratch = mkdtempSync(
		path.join(os.tmpdir(), 'repro-2910-v2-host-scratch-'),
	);
	// Install/binary failures recorded BEFORE the host run (the run is then
	// skipped): handed to classifyHostRun as priorFailures — the classifier
	// is the single source of the pass/fail decision.
	const priorFailures = [];
	const failures = [];
	try {
		// (a) Install the pinned host into the temp prefix (no global install).
		console.log(
			`[repro-2910-v2-host] installing @opencode/cli@${V2_HOST_VERSION} into temp prefix (300s budget)`,
		);
		const npmArgv = resolveNpmArgv();
		const install = await run(
			[
				...npmArgv,
				'install',
				'--prefix',
				tmpInstall,
				`@opencode/cli@${V2_HOST_VERSION}`,
				'--no-save',
			],
			{
				cwd: os.tmpdir(),
				env: process.env,
				timeoutMs: INSTALL_TIMEOUT_MS,
			},
		);
		if (install.code !== 0) {
			priorFailures.push(
				`npm install failed: exit=${install.code} timedOut=${install.timedOut} tail=${redact((install.err || install.out || '').slice(-500))}`,
			);
		}
		const bin = resolveHostBinary(tmpInstall);
		console.log(`[repro-2910-v2-host] host binary: ${redact(bin)}`);
		if (!existsSync(bin)) {
			priorFailures.push(`host binary not found at ${redact(bin)}`);
		}

		// (b) Scratch project with the local plugin shim re-exporting dist.
		const proj = path.join(scratch, 'proj');
		const pluginsDir = path.join(proj, '.opencode', 'plugins');
		mkdirSync(pluginsDir, { recursive: true });
		writeFileSync(
			path.join(pluginsDir, 'local-v2-smoke.js'),
			`import plugin from ${JSON.stringify(pathToFileURL(DIST).href)};\nexport default plugin;\n`,
		);

		let full = '';
		let bannerCount = 0;
		let eventCount = 0;
		let swarmDirPopulated = false;
		let runTimedOut = false;
		let runExitCode;
		if (priorFailures.length === 0) {
			// (c)+(d) Run the pinned host against the scratch project with
			// fd-backed capture. The model reply is NOT part of the verdict.
			const r = await run(
				[
					bin,
					'run',
					'--standalone',
					'--print-logs',
					'Reply with the single word: loaded',
				],
				{
					cwd: proj,
					env: childEnv(scratch, proj),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);
			full = r.out + r.err;
			runTimedOut = r.timedOut;
			runExitCode = r.code;
			console.log(
				`[repro-2910-v2-host] host run: exit=${r.code} timedOut=${r.timedOut} captured=${full.length} bytes`,
			);
			if (runTimedOut) {
				// 2026-11-26 (#3921 merge-queue kick-outs, two in a row): a
				// timed-out host run printed only the SELECTED evidence lines,
				// hiding where the run actually hung — the fd-backed capture is
				// the only forensic artifact and the scratch dir is deleted
				// right after. Dump a bounded, redacted, control-stripped tail of
				// EACH stream (formatCaptureTail) so the next timeout is
				// diagnosable from the job log alone (the assertions themselves
				// had already passed when the queue kicked these runs out).
				for (const line of formatCaptureTail(r)) {
					console.log(line);
				}
			}

			// (e) AUTH-FREE evidence.
			const loadingShimLines = full
				.split(/\r?\n/)
				.filter((ln) => /loading plugin/i.test(ln) && /local-v2-smoke\.js/.test(ln));
			const bannerLines = full
				.split(/\r?\n/)
				.filter((ln) => /\[opencode-swarm\] running v\S+/.test(ln));
			const eventLines = full
				.split(/\r?\n/)
				.filter((ln) => /event\.type=(agent\.updated|command\.updated)\b/.test(ln));
			const swarmDirPath = path.join(proj, '.swarm');
			const swarmDirExists = existsSync(swarmDirPath);
			swarmDirPopulated =
				swarmDirExists && safeReaddirEntries(swarmDirPath).length > 0;
			bannerCount = bannerLines.length;
			eventCount = eventLines.length;

			printEvidenceLines('loading-plugin', loadingShimLines, 3);
			printEvidenceLines('banner', bannerLines, 3);
			printEvidenceLines('event', eventLines, 5);
			console.log(
				`host-load: banner=${bannerCount > 0 ? 1 : 0} events=${eventCount} swarm-dir=${swarmDirPopulated ? 1 : 0}`,
			);
		} else {
			console.log(
				`host-load: banner=0 events=0 swarm-dir=0 (host run skipped: ${priorFailures.length} earlier failure(s))`,
			);
		}

		// SINGLE SOURCE decision: classifyHostRun applies the script's rules
		// (timeout ALWAYS fails, prior install/binary failures fail, each
		// missing auth-free evidence condition fails; exitCode alone never
		// fails — an auth-error exit with full evidence passes).
		const verdict = classifyHostRun({
			timedOut: runTimedOut,
			exitCode: runExitCode,
			output: full,
			swarmDirExists: swarmDirPopulated,
			priorFailures,
		});
		failures.push(...verdict.reasons);

		if (failures.length > 0) {
			for (const f of failures) {
				console.error(`[repro-2910-v2-host] FAILED: ${f}`);
			}
		}
	} finally {
		// Best-effort scratch cleanup AFTER the diagnostics are printed.
		for (const dir of [scratch, tmpInstall]) {
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			} catch (e) {
				console.error(`[repro-2910-v2-host] scratch cleanup incomplete (non-fatal): ${String(e)}`);
			}
		}
	}

	if (failures.length > 0) {
		console.error('result=FAIL');
		process.exitCode = 1;
		return;
	}
	console.log('result=PASS');
	process.exitCode = 0;
}

function safeReaddirEntries(dirPath) {
	try {
		return readdirSync(dirPath);
	} catch {
		return [];
	}
}

/**
 * Main-entry guard: `node scripts/repro-2910-v2-host.mjs` (and
 * `bun scripts/repro-2910-v2-host.mjs`) run main(); IMPORTING the module —
 * tests/unit/scripts/repro-2910-v2-host-classify.test.ts — is inert.
 *
 * `import.meta.main` is Bun-only: under Node it is `undefined` (falsy), so a
 * bare `if (import.meta.main)` would break the Node invocation. Prefer
 * Bun's flag when it is a boolean; otherwise compare the entry URL, which
 * works under both runtimes (case-insensitive on win32, where drive-letter
 * case can differ between argv and import.meta.url).
 */
function invokedAsMain() {
	if (typeof import.meta.main === 'boolean') return import.meta.main;
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		const entryUrl = pathToFileURL(path.resolve(entry)).href;
		return process.platform === 'win32'
			? import.meta.url.toLowerCase() === entryUrl.toLowerCase()
			: import.meta.url === entryUrl;
	} catch {
		return false;
	}
}

if (invokedAsMain()) {
	main().catch((err) => {
		console.error('[repro-2910-v2-host] uncaught:', err);
		console.error('result=FAIL');
		process.exit(1);
	});
}
