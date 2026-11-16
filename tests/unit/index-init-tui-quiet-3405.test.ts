/**
 * Issue #3405 — no raw console output on the plugin init path.
 *
 * The OpenCode TUI renders plugin stderr as a full-width overlay over the
 * UI (the #1249 class; contract: src/services/warning-buffer.ts advisoryWarn
 * docblock), so the init path must not write raw console.warn/console.log
 * for the startup version banner or the project-root ownership hints. This
 * is the shipped form of the frozen acceptance checks C1-C3
 * (.agents/issue-traces/3405-tui-raw-console-warn-init-overlay/repro/):
 * REAL plugin boots (src/index.ts default export's server()) with a
 * hand-built host ctx under XDG-only env isolation (the #2679 suite's
 * idiom — HOME/USERPROFILE stay real so the boundary walk's weak-container
 * rule keys on the real home).
 *
 * Contracts pinned:
 * - redirect hint: absent from BOTH captured console streams, present in the
 *   deferred-warning buffer (/swarm diagnose channel), ownership outcome
 *   unchanged (state lands in the owning parent).
 * - fail-closed hint: absent from both streams, present in the buffer.
 * - banner: silent by default on both streams; OPENCODE_SWARM_VERSION_BANNER=1
 *   restores exactly one raw stderr line; OPENCODE_SWARM_DEBUG=1 logs exactly
 *   one stdout line (never stderr).
 * - debug-mode hint leg: under OPENCODE_SWARM_DEBUG=1 the redirect hint text
 *   reaches console.log exactly once (advisoryWarn's log() leg) — the
 *   behavioral kill for partial advisoryWarn deletion.
 * - AC5 non-deletion pin: the retargeted #2679 suite still asserts the
 *   buffered hint (call-site count of expect(hasParentRootHint(...) >= 2).
 *
 * Env isolation is deliberately XDG-only (plus APPDATA/LOCALAPPDATA), NOT
 * createIsolatedTestEnv(): the boundary walk's weak-container rule keys on
 * the REAL user home (see index-bootstrap-root-ownership-2679.test.ts
 * header). Console capture is by reassignment with finally-restore. No
 * clock usage.
 *
 * The two banner/debug env vars this suite mutates are SAVED on entry and
 * RESTORED on exit (never deleted): deleting them would strip the caller's
 * ambient value for every later suite in a shared bun process, and an ambient
 * OPENCODE_SWARM_DEBUG=1 would otherwise make the silence assertions fail
 * (the advisoryWarn debug leg legitimately writes the hint to stdout — a
 * channel this PR KEEPS, pinned by the debug-mode test below).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db';
import OpenCodeSwarm from '../../src/index';
import { getDeferredWarnings } from '../../src/services/warning-buffer';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { safeRmRecursive } from '../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/** Fixed drain (ms) after server() resolves, for the wrapper-owned post-resolution writer queue. */
const SETTLE_MS = 3500;
/**
 * Drain for boots whose assertions are satisfied by INIT-SYNCHRONOUS emissions
 * only (the version banner is written during initializeOpenCodeSwarm, before
 * server() resolves). Keeps each such test under bun's default 5s per-test
 * timeout without weakening what it asserts.
 */
const BANNER_SETTLE_MS = 800;
/**
 * Explicit per-test timeout. This file boots the real plugin, which is slower
 * than bun's default 5s budget on a cold/slow host; the repo's own per-file
 * runner passes --timeout 120000 (scripts/ci/repository-validation.ts), and
 * this keeps a bare `bun test <file>` run from failing on a timeout that is
 * not a product regression (repo precedent:
 * tests/unit/index-primary-session-model-fallback.test.ts).
 */
const TEST_TIMEOUT_MS = 30_000;

const ISOLATED_ENV_KEYS = [
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'APPDATA',
	'LOCALAPPDATA',
] as const;

/**
 * Env vars this suite MUTATES. They are saved on entry and RESTORED (not
 * deleted) on exit: deleting them would destroy the caller's ambient value
 * for every later suite in a shared bun process, and an ambient
 * OPENCODE_SWARM_DEBUG=1 would otherwise make the silence assertions fail.
 */
const MANAGED_ENV_KEYS = [
	'OPENCODE_SWARM_DEBUG',
	'OPENCODE_SWARM_VERSION_BANNER',
] as const;

const fixtureRoots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
let isolatedEnvRoot = '';
let restoreEnv: (() => void) | null = null;

beforeAll(() => {
	isolatedEnvRoot = canonicalMkdtemp('swarm3405-quiet-env-');
	for (const key of ISOLATED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = isolatedEnvRoot;
	}
	for (const key of MANAGED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
	}
	restoreEnv = () => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
});

afterEach(async () => {
	// Release plugin-owned handles BEFORE removing fixtures (EBUSY on Windows).
	resetTelemetryForTesting();
	await closeAllProjectDbs();
	resetSwarmState();
	// Restore (never delete) the managed vars: an ambient value set by the
	// caller must survive the suite, and each test pins its own precondition.
	for (const key of MANAGED_ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of fixtureRoots.splice(0)) {
		try {
			safeRmRecursive(dir);
		} catch {
			/* best-effort */
		}
	}
});

afterAll(() => {
	restoreEnv?.();
	restoreEnv = null;
	if (isolatedEnvRoot) {
		try {
			safeRmRecursive(isolatedEnvRoot);
		} catch {
			/* best-effort */
		}
		isolatedEnvRoot = '';
	}
});

/**
 * Every console method the plugin could use to emit a message. The silence
 * contract is "no raw console output on the init path", so the oracle must
 * observe every stream a message could arrive on — not just warn/log.
 * (process.stdout/stderr.write are deliberately NOT wrapped: the test runner
 * writes its own report there; the source-shape pin in plugin-tui-safety
 * covers those two forms for the ownership hints.)
 */
const CONSOLE_METHODS = [
	'warn',
	'error',
	'log',
	'info',
	'debug',
	'trace',
] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

interface ConsoleCapture {
	warn: string[];
	error: string[];
	log: string[];
	info: string[];
	debug: string[];
	trace: string[];
	/** Every captured stream, concatenated. */
	all: string[];
}

function captureConsole(): { captured: ConsoleCapture; restore: () => void } {
	const captured: ConsoleCapture = {
		warn: [],
		error: [],
		log: [],
		info: [],
		debug: [],
		trace: [],
		all: [],
	};
	const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
	for (const method of CONSOLE_METHODS) {
		originals.set(method, console[method] as (...args: unknown[]) => void);
		const sink = captured[method];
		console[method] = (...args: unknown[]) => {
			const line = args.map((a) => String(a)).join(' ');
			sink.push(line);
			captured.all.push(line);
		};
	}
	return {
		captured,
		restore: () => {
			for (const method of CONSOLE_METHODS) {
				const original = originals.get(method);
				if (original) {
					(console[method] as (...args: unknown[]) => void) = original;
				}
			}
		},
	};
}

function ctxFor(directory: string) {
	return {
		client: {},
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	} as never;
}

function fixtureRoot(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fixtureRoots.push(dir);
	return dir;
}

async function bootAndSettle(
	directory: string,
	settleMs: number = SETTLE_MS,
): Promise<ConsoleCapture> {
	const { captured, restore } = captureConsole();
	try {
		const manifest = (await OpenCodeSwarm.server(ctxFor(directory))) as Record<
			string,
			unknown
		>;
		expect(typeof manifest).toBe('object');
		await Bun.sleep(settleMs);
		return captured;
	} finally {
		restore();
	}
}

/** Entries in a directory, or -1 when it cannot be read. */
function dirEntryCount(dir: string): number {
	try {
		return fs.readdirSync(dir).length;
	} catch {
		return -1;
	}
}

function hintLines(captured: ConsoleCapture): string[] {
	return captured.all.filter((l) => l.includes('project-root ownership'));
}

function bufferedHintLines(): string[] {
	return getDeferredWarnings().filter((l) =>
		l.includes('project-root ownership'),
	);
}

function bannerWarnLines(captured: ConsoleCapture): string[] {
	return captured.warn.filter((l) => l.includes('[opencode-swarm] running v'));
}

function bannerLogLines(captured: ConsoleCapture): string[] {
	return captured.log.filter((l) => l.includes('[opencode-swarm] running v'));
}

/** The banner on ANY captured stream. */
function bannerLines(captured: ConsoleCapture): string[] {
	return captured.all.filter((l) => l.includes('[opencode-swarm] running v'));
}

/** parent(.git + .swarm + .opencode config) + ordinary child. */
function makeClaimedFixture(name: string) {
	const root = fixtureRoot(`swarm3405-quiet-${name}-`);
	const parent = path.join(root, 'outer');
	const child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(parent, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	fs.mkdirSync(child, { recursive: true });
	return { parent, child };
}

/** A standalone root (its own package.json + .opencode config). */
function makeBannerFixture(): string {
	const root = fixtureRoot('swarm3405-quiet-banner-');
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify(
			{ name: 'swarm3405-banner', version: '0.0.0', private: true },
			null,
			2,
		),
	);
	fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	return root;
}

describe('init-path raw console silence (#3405)', () => {
	test(
		'redirect boot: no hint on any raw stream, hint buffered, ownership unchanged',
		async () => {
			// Pin the precondition: with DEBUG on, advisoryWarn's log leg
			// legitimately writes the hint to stdout, which is a channel this
			// PR KEEPS (see the debug-hint test below). The silence contract
			// is about the raw stderr leg.
			delete process.env.OPENCODE_SWARM_DEBUG;
			delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			const { parent, child } = makeClaimedFixture('redirect');

			const captured = await bootAndSettle(child);

			expect(hintLines(captured)).toEqual([]);
			expect(bufferedHintLines().length).toBeGreaterThanOrEqual(1);
			expect(fs.existsSync(path.join(child, '.swarm'))).toBe(false);
			// Non-vacuous: the fixture CREATES the parent .swarm, so assert
			// the boot actually populated it (the sibling #2679 suite uses the
			// same dirEntryCount form).
			expect(dirEntryCount(path.join(parent, '.swarm'))).toBeGreaterThanOrEqual(
				1,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'fail-closed boot: no hint on any raw stream, hint buffered with the state-disabled reason',
		async () => {
			delete process.env.OPENCODE_SWARM_DEBUG;
			delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			const root = fixtureRoot('swarm3405-quiet-failclosed-');
			const missing = path.join(root, 'does', 'not', 'exist');

			const captured = await bootAndSettle(missing);

			expect(hintLines(captured)).toEqual([]);
			expect(bufferedHintLines().length).toBeGreaterThanOrEqual(1);
			// The fail-closed CONTENT matters: it is the only operator-facing
			// sentence that says runtime state writes are disabled.
			expect(
				bufferedHintLines().some((l) =>
					l.includes('runtime state is disabled'),
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'banner: silent on every raw stream by default',
		async () => {
			delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			delete process.env.OPENCODE_SWARM_DEBUG;
			const root = makeBannerFixture();

			const captured = await bootAndSettle(root, BANNER_SETTLE_MS);

			expect(bannerLines(captured)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'banner: raw stderr restored exactly once via the opt-in env var',
		async () => {
			delete process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_VERSION_BANNER = '1';
			const root = makeBannerFixture();

			const captured = await bootAndSettle(root, BANNER_SETTLE_MS);

			expect(bannerWarnLines(captured)).toHaveLength(1);
			expect(bannerLines(captured)).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'banner: stdout log leg only under OPENCODE_SWARM_DEBUG=1',
		async () => {
			delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			process.env.OPENCODE_SWARM_DEBUG = '1';
			const root = makeBannerFixture();

			const captured = await bootAndSettle(root, BANNER_SETTLE_MS);

			expect(bannerLogLines(captured)).toHaveLength(1);
			expect(bannerLines(captured)).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'debug-mode hint leg: under OPENCODE_SWARM_DEBUG=1 the redirect hint reaches console.log once',
		async () => {
			delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			process.env.OPENCODE_SWARM_DEBUG = '1';
			const { child } = makeClaimedFixture('debug-hint');

			const captured = await bootAndSettle(child);

			expect(
				captured.warn.filter((l) => l.includes('project-root ownership')),
			).toEqual([]);
			expect(
				captured.log.filter((l) => l.includes('project-root ownership')),
			).toHaveLength(1);
			// Exactly one raw emission overall: the debug stdout leg only.
			expect(
				captured.all.filter((l) => l.includes('project-root ownership')),
			).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'AC5 pin: the #2679 suite still asserts the buffered hint at both call sites',
		() => {
			const source = fs.readFileSync(
				path.resolve(
					import.meta.dir,
					'index-bootstrap-root-ownership-2679.test.ts',
				),
				'utf8',
			);
			// Comment lines cannot satisfy this pin: strip them before
			// counting, so commenting an assertion out drops the count.
			const code = source
				.split(/\r?\n/)
				.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join('\n');
			const callSites = code.match(/expect\(\s*hasParentRootHint\(/g) ?? [];
			expect(callSites.length).toBeGreaterThanOrEqual(2);
			// The retarget itself must still be in place: the sibling reads
			// the deferred-warning buffer, not the raw console capture.
			expect(code).toContain('getDeferredWarnings(');
		},
		TEST_TIMEOUT_MS,
	);
});
