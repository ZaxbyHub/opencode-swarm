/**
 * Issue #3405 — no raw console.warn on the plugin init path.
 *
 * In an in-process OpenCode TUI the host renders stderr writes as full-width
 * overlay blocks pasted over the UI/input area, corrupting the session
 * transcript. Before #3405 the init path emitted three UNCONDITIONAL raw
 * `console.warn` lines (src/index.ts):
 *
 *  1. the startup version banner `[opencode-swarm] running vX.Y.Z` (#2236),
 *  2. the project-root redirect ownership hint (#2679 AC1),
 *  3. the fail-closed ownership hint (#2679).
 *
 * After #3405:
 *  - the ownership hints reach the operator ONLY through the double-buffered
 *    channel (`addDeferredWarning` + `advisoryWarn` → /swarm diagnose), and
 *  - the banner rides the debug-gated logger, with the raw stderr leg kept
 *    behind the opt-in `OPENCODE_SWARM_VERSION_BANNER=1` for headless/CLI
 *    diagnosis.
 *
 * These tests boot the REAL plugin (src/index.ts default export's server(),
 * same hand-built host ctx idiom as index-bootstrap-root-ownership-2679.test.ts)
 * in an ordinary child of a claimed project root — the exact reproduction
 * shape from the issue — and assert both the absence of the raw stderr legs
 * and the presence of the replacement channels.
 *
 * Env isolation is XDG-only (HOME/USERPROFILE stay real) for the same reason
 * as the #2679 suite: the boundary walk's weak-container rule keys on the
 * REAL user home. OPENCODE_SWARM_DEBUG and OPENCODE_SWARM_VERSION_BANNER are
 * forced unset/restored so the default-boot assertions do not depend on the
 * invoking environment. Console capture is by reassignment with
 * finally-restore (no spyOn / mock.module).
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

/** Env roots redirected for boot isolation. HOME/USERPROFILE stay real (see header). */
const ISOLATED_ENV_KEYS = [
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'APPDATA',
	'LOCALAPPDATA',
] as const;

const fixtureRoots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
let isolatedEnvRoot = '';

function saveAndUnset(name: string): void {
	savedEnv.set(name, process.env[name]);
	delete process.env[name];
}

function restoreEnv(): void {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
}

beforeAll(() => {
	isolatedEnvRoot = canonicalMkdtemp('swarm3405-env-');
	for (const key of ISOLATED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = isolatedEnvRoot;
	}
	// Deterministic default-boot assertions regardless of the outer shell.
	saveAndUnset('OPENCODE_SWARM_DEBUG');
	saveAndUnset('OPENCODE_SWARM_VERSION_BANNER');
});

afterEach(async () => {
	// Release plugin-owned handles BEFORE removing fixtures (EBUSY, #2480).
	resetTelemetryForTesting();
	await closeAllProjectDbs();
	resetSwarmState();
	for (const dir of fixtureRoots.splice(0)) {
		try {
			safeRmRecursive(dir);
		} catch {
			// best-effort: a lingering detached writer handle must not fail the suite
		}
	}
});

afterAll(() => {
	restoreEnv();
	if (isolatedEnvRoot) {
		try {
			safeRmRecursive(isolatedEnvRoot);
		} catch {
			// best-effort
		}
		isolatedEnvRoot = '';
	}
});

/** tests/helpers/plugin-host.ts ctxFor shape — the hand-built host context. */
function ctxFor(directory: string) {
	return {
		client: {},
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	};
}

interface ConsoleCapture {
	warn: string[];
	log: string[];
}

function captureConsole(): { captured: ConsoleCapture; restore: () => void } {
	const captured: ConsoleCapture = { warn: [], log: [] };
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (...args: unknown[]) => {
		captured.warn.push(
			args
				.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
				.join(' '),
		);
	};
	console.log = (...args: unknown[]) => {
		captured.log.push(
			args
				.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
				.join(' '),
		);
	};
	return {
		captured,
		restore: () => {
			console.warn = originalWarn;
			console.log = originalLog;
		},
	};
}

/** Claimed-parent fixture: parent(.git + .swarm + quiet config) + ordinary child. */
function makeClaimedFixture(name: string) {
	const root = canonicalMkdtemp(`swarm3405-${name}-`);
	fixtureRoots.push(root);
	const parent = path.join(root, 'outer');
	const child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(child, { recursive: true });
	fs.mkdirSync(path.join(parent, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(parent, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	return { parent, child };
}

/**
 * Boot the real plugin. The banner and ownership hints are emitted inside
 * `initializeOpenCodeSwarm`, which `server()` awaits before resolving, so no
 * post-resolution settle is needed for the assertions in this file.
 */
async function boot(directory: string): Promise<{
	manifest: Record<string, unknown>;
	captured: ConsoleCapture;
}> {
	const { captured, restore } = captureConsole();
	try {
		const manifest = (await OpenCodeSwarm.server(
			ctxFor(directory) as never,
		)) as unknown as Record<string, unknown>;
		return { manifest, captured };
	} finally {
		restore();
	}
}

function norm(p: string): string {
	return p.toLowerCase().replace(/\\/g, '/');
}

describe('init-path console noise (#3405)', () => {
	test(
		'default boot: no raw stderr version banner, no raw stderr ownership hint; the hint still reaches /swarm diagnose',
		async () => {
			const { parent, child } = makeClaimedFixture('default');

			const { manifest, captured } = await boot(child);

			// Fail-open manifest: the boot still delivered the full tool surface.
			const toolCount = Object.keys(
				(manifest.tool ?? {}) as Record<string, unknown>,
			).length;
			expect(toolCount).toBeGreaterThanOrEqual(100);

			// The raw stderr legs are gone: neither the banner nor the
			// ownership hint appears on console.warn (the TUI-overlay leg)…
			const rawLines = [...captured.warn, ...captured.log];
			expect(rawLines.some((l) => l.includes('[opencode-swarm] running v'))).toBe(
				false,
			);
			expect(rawLines.some((l) => l.includes('project-root ownership'))).toBe(
				false,
			);

			// …while the ownership hint IS delivered through the always-on
			// buffered channel that /swarm diagnose replays (with the parent
			// root named, after masking child-path mentions; norm() lowercases
			// BOTH sides because mkdtemp suffixes are mixed-case).
			const buffered = getDeferredWarnings().map((l) => norm(l));
			expect(
				buffered.some(
					(l) =>
						l.includes('project-root ownership') &&
						l
							.split(norm(child))
							.join('<CHILD>')
							.includes(norm(parent)),
				),
			).toBe(true);
		},
		60_000,
	);

	test(
		'opt-in OPENCODE_SWARM_VERSION_BANNER=1 restores the raw stderr banner for headless/CLI diagnosis',
		async () => {
			const { child } = makeClaimedFixture('banner');

			process.env.OPENCODE_SWARM_VERSION_BANNER = '1';
			try {
				const { captured } = await boot(child);
				expect(
					captured.warn.some((l) =>
						/\[opencode-swarm\] running v\S+/.test(l),
					),
				).toBe(true);
			} finally {
				delete process.env.OPENCODE_SWARM_VERSION_BANNER;
			}
		},
		60_000,
	);
});
