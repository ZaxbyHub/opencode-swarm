/**
 * #3354 AC4 (acceptance check C4): the raw config read behind
 * `readSddSourceSetting` / `loadPluginConfigWithMeta` must never OPEN a
 * non-regular file at a config path (no FIFO hang, no readFileSync attempt on
 * directories/devices), and the result must stay fail-secure.
 *
 * Leg 1 (all platforms) — a DIRECTORY at the project config path: no deferred
 * warning may carry the read error (EISDIR — the observable that proves the
 * loader attempted to open the path), the load is still classified as errored,
 * and guardrails stay forced on. RED at base, GREEN after the fix.
 *
 * Leg 2 (POSIX only, skipped on win32) — a FIFO at the project config path: a
 * child `bun -e` process calling `readSddSourceSetting` on that fixture must
 * exit promptly (NO-OPEN) instead of blocking on the open and being killed by
 * the 3 s timeout. RED at base, GREEN after the fix. Skipped with a printed
 * reason when `mkfifo` is unavailable on the POSIX host.
 *
 * Fixtures adapted from the trace probe
 * (.agents/issue-traces/3105-3354-3355-3356-config-loader-sdd/repro/probe-3354-specialfile.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	_internals,
	loadPluginConfigWithMeta,
	loadPluginConfigWithMetaAsync,
	readSddSourceSetting,
} from '../../../src/config/loader';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const repoRoot = path.join(import.meta.dir, '..', '..', '..');
const IS_WIN32 = process.platform === 'win32';

// Probe mkfifo availability once (POSIX only): a successful spawn (even with a
// nonzero exit for BSD mkfifo's --version) proves the binary exists; an
// ENOENT-style spawn error means unavailable.
const mkfifoProbe = IS_WIN32
	? undefined
	: child_process.spawnSync('mkfifo', ['--version'], {
			timeout: 5000,
			encoding: 'utf-8',
		});
const MKFIFO_AVAILABLE =
	!IS_WIN32 && mkfifoProbe !== undefined && mkfifoProbe.error === undefined;
if (!IS_WIN32 && !MKFIFO_AVAILABLE) {
	console.log(
		`C4 leg 2 skip: mkfifo unavailable on this ${process.platform} host (${String(
			mkfifoProbe?.error,
		).slice(0, 80)})`,
	);
}

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-special-file-');
	xdgDir = path.join(tempDir, '.xdg-config');
	fs.mkdirSync(path.join(xdgDir, 'opencode'), { recursive: true });
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = xdgDir;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3354 AC4: non-regular files at config paths are never opened', () => {
	test('leg 1 (all platforms): a DIRECTORY at the project config path is not opened — no EISDIR read error, load still fail-secure', () => {
		// Liveness positive control (PRR-002): the counter counts a REAL
		// regular-file read — otherwise the zero assertion below could pass
		// vacuously with a counter that never counts.
		const liveDir = path.join(tempDir, 'project-live');
		fs.mkdirSync(path.join(liveDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(liveDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
			'utf-8',
		);
		_internals.resetRawConfigReadAttempts?.();
		loadPluginConfigWithMeta(liveDir);
		expect(_internals.getRawConfigReadAttempts?.() ?? 0).toBeGreaterThan(0);

		const projDir = path.join(tempDir, 'project');
		const cfgPath = path.join(projDir, '.opencode', 'opencode-swarm.json');
		fs.mkdirSync(cfgPath, { recursive: true }); // cfgPath is a DIRECTORY
		expect(fs.statSync(cfgPath).isDirectory()).toBe(true);

		_internals.resetRawConfigReadAttempts?.();
		const meta = loadPluginConfigWithMeta(projDir);
		const warnings = [...getDeferredWarnings()];

		// The discriminating observable: at base the loader statSync-then-
		// readFileSync the directory and the caught EISDIR message lands in the
		// buffered CONFIG LOAD FAILURE warning. Post-fix the path is never
		// opened, so no read error can appear.
		const readErrors = warnings.filter((w) => w.includes('EISDIR'));
		expect(readErrors).toEqual([]);

		// Fail-secure posture must hold either way.
		expect(meta.configHadErrors).toBe(true);
		expect(
			(meta.config as { guardrails?: { enabled?: boolean } }).guardrails
				?.enabled,
		).toBe(true);

		// The lightweight SDD read also returns no setting (and no rejected
		// info) from a directory at the config path.
		const setting = readSddSourceSetting(projDir);
		expect(setting.source).toBeUndefined();
		expect(setting.rejected).toBeUndefined();
	});

	test('leg 1b (critic round-1 finding 6): the ASYNC loader also refuses to open a directory at the config path', async () => {
		const projDir = path.join(tempDir, 'project-async');
		const cfgPath = path.join(projDir, '.opencode', 'opencode-swarm.json');
		fs.mkdirSync(cfgPath, { recursive: true });

		_internals.resetRawConfigReadAttempts?.();
		const meta = await loadPluginConfigWithMetaAsync(projDir);
		// B3-M2: the async no-open claim is observed through the same counter.
		expect(_internals.getRawConfigReadAttempts?.() ?? 0).toBe(0);
		const warnings = [...getDeferredWarnings()];
		expect(warnings.filter((w) => w.includes('EISDIR'))).toEqual([]);
		expect(meta.configHadErrors).toBe(true);
	});

	test('leg 1c (critic round-1 finding 6): no read ATTEMPT is made on a non-regular config path (platform-independent no-open proof)', () => {
		const attempts = _internals as {
			resetRawConfigReadAttempts?: () => void;
			getRawConfigReadAttempts?: () => number;
		};
		// The seam is fix surface (plan D2): absent at base, so this leg is RED
		// at base for seam absence AND for the base behavior (it opens).
		expect(typeof attempts.resetRawConfigReadAttempts).toBe('function');
		expect(typeof attempts.getRawConfigReadAttempts).toBe('function');

		const projDir = path.join(tempDir, 'project-counter');
		fs.mkdirSync(path.join(projDir, '.opencode', 'opencode-swarm.json'), {
			recursive: true,
		});

		attempts.resetRawConfigReadAttempts?.();
		loadPluginConfigWithMeta(projDir);
		expect(attempts.getRawConfigReadAttempts?.()).toBe(0);
		// And the SDD read on the same directory stays at zero too.
		readSddSourceSetting(projDir);
		expect(attempts.getRawConfigReadAttempts?.()).toBe(0);
	});

	test.skipIf(IS_WIN32 || !MKFIFO_AVAILABLE)(
		'leg 2 (POSIX): a FIFO at the project config path does not block readSddSourceSetting (child exits with NO-OPEN)',
		() => {
			const fifoProjDir = path.join(tempDir, 'fifo-project');
			fs.mkdirSync(path.join(fifoProjDir, '.opencode'), { recursive: true });
			const fifoPath = path.join(
				fifoProjDir,
				'.opencode',
				'opencode-swarm.json',
			);
			const created = child_process.spawnSync('mkfifo', [fifoPath], {
				timeout: 5000,
				encoding: 'utf-8',
			});
			if (created.error !== undefined || created.status !== 0) {
				console.log(
					`C4 leg 2 skip: mkfifo creation failed: ${String(
						created.error ?? created.stderr,
					).slice(0, 120)}`,
				);
				return;
			}
			expect(fs.statSync(fifoPath).isFIFO()).toBe(true);

			// Child: fresh `bun -e` so a blocking open cannot hang the test
			// runner itself. XDG_CONFIG_HOME points at an empty dir (no user
			// config); SWARM_SDD_SOURCE is removed from the child env.
			const loaderUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'config', 'loader.ts'),
			).href;
			const script =
				`import { readSddSourceSetting } from ${JSON.stringify(loaderUrl)}; ` +
				`const r = readSddSourceSetting(${JSON.stringify(fifoProjDir)}); ` +
				`console.log('NO-OPEN ' + JSON.stringify(r));`;
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env.SWARM_SDD_SOURCE;
			env.XDG_CONFIG_HOME = xdgDir;

			let out = '';
			let failure: string | undefined;
			try {
				out = child_process.execFileSync(process.execPath, ['-e', script], {
					env,
					timeout: 3000,
					encoding: 'utf-8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (err) {
				const killed = (err as { killed?: boolean; signal?: string }).killed;
				failure = killed
					? `child blocked on the FIFO open and was killed (${(err as { signal?: string }).signal ?? 'timeout'})`
					: String(err).slice(0, 200);
			}
			if (failure !== undefined) {
				throw new Error(
					`readSddSourceSetting opened a non-regular config file: ${failure}`,
				);
			}
			expect(out).toContain('NO-OPEN');
		},
	);
});
