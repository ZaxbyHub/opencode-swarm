/**
 * Issue #2679 — bootstrap project-root ownership, REAL plugin boots.
 *
 * Adapts the frozen acceptance-check idioms from
 * .agents/issue-traces/2679-project-root-ownership-bootstrap/repro/
 * (c1 ordinary-child redirect, c3 nested-root independence, c4 standalone,
 * c8 indicator-only parent) into bun:test: boot the REAL plugin
 * (src/index.ts default export's server()) with a hand-built host ctx
 * (tests/helpers/plugin-host.ts ctxFor shape) inside an isolated XDG env
 * and assert the FILESYSTEM outcome — an ordinary child of a project root
 * that owns `.swarm/` never receives its own runtime-state tree; the owning
 * parent does.
 *
 * Env isolation is deliberately XDG-only (plus APPDATA/LOCALAPPDATA), NOT
 * createIsolatedTestEnv(): the boundary walk's weak-container rule keys on
 * the REAL user home and raw OS temp root. Redirecting HOME/USERPROFILE (which
 * bun test honors, unlike plain `bun`) makes the resolver treat the real
 * home as a claiming ancestor for C4/C8 fixtures whose walk escapes the
 * temp tree, flipping them from root to redirect-to-home. The frozen repro
 * scripts isolate the same way (XDG_CONFIG_HOME only).
 *
 * Console capture is by reassignment with finally-restore (no spyOn /
 * mock.module). No clock usage: waits are fixed drains or bounded condition
 * polls with attempt counters.
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
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { safeRmRecursive } from '../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/** Fixed drain (ms) after server() resolves, for the wrapper-owned post-resolution writer queue. */
const SETTLE_MS = 3500;

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
let restoreEnv: (() => void) | null = null;

beforeAll(() => {
	isolatedEnvRoot = canonicalMkdtemp('swarm2679-own-env-');
	for (const key of ISOLATED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = isolatedEnvRoot;
	}
	restoreEnv = () => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
});

afterEach(async () => {
	// Release plugin-owned handles BEFORE removing fixtures: an open telemetry
	// stream or sqlite WAL lock makes Windows rmSync fail EBUSY (#2480).
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
	restoreEnv?.();
	restoreEnv = null;
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

function fixtureRoot(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fixtureRoots.push(dir);
	return dir;
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

function norm(p: string): string {
	return p.toLowerCase().replace(/\\/g, '/');
}

/**
 * The redirect-hint contract: some console line mentions BOTH the
 * 'project-root ownership' marker AND the owning parent root — after masking
 * occurrences of the CHILD path, so a child-path mention (which lexically
 * contains the parent) cannot fake a parent-root hint (c1 hygiene).
 */
function hasParentRootHint(
	captured: ConsoleCapture,
	parent: string,
	child: string,
): boolean {
	const lines = [...captured.warn, ...captured.log].map((line) => norm(line));
	return lines.some(
		(line) =>
			line.includes('project-root ownership') &&
			line.split(norm(child)).join('<CHILD>').includes(norm(parent)),
	);
}

function swarmExists(dir: string): boolean {
	return fs.existsSync(path.join(dir, '.swarm'));
}

function dirEntryCount(dir: string): number {
	try {
		return fs.readdirSync(dir).length;
	} catch {
		return -1;
	}
}

/** Bounded condition poll — no clock read, attempt-counter bounded. */
async function waitFor(
	condition: () => boolean,
	attempts = 50,
	stepMs = 100,
): Promise<boolean> {
	for (let i = 0; i < attempts; i += 1) {
		if (condition()) return true;
		await Bun.sleep(stepMs);
	}
	return condition();
}

async function bootAndSettle(
	directory: string,
	settleMs = SETTLE_MS,
): Promise<{
	manifest: Record<string, unknown>;
	captured: ConsoleCapture;
}> {
	const { captured, restore } = captureConsole();
	try {
		const manifest = (await OpenCodeSwarm.server(
			ctxFor(directory) as never,
		)) as unknown as Record<string, unknown>;
		await Bun.sleep(settleMs);
		return { manifest, captured };
	} finally {
		restore();
	}
}

/** Claimed-parent fixture: parent(.git + .swarm [+ .opencode config]) + ordinary child. */
function makeClaimedFixture(
	name: string,
	parentConfig: Record<string, unknown> | null = {
		version_check: false,
		quiet: true,
	},
) {
	const root = fixtureRoot(`swarm2679-${name}-`);
	const parent = path.join(root, 'outer');
	const child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(child, { recursive: true });
	if (parentConfig) {
		fs.mkdirSync(path.join(parent, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(parent, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(parentConfig, null, 2),
		);
	}
	return { parent, child };
}

describe('bootstrap project-root ownership — ordinary child redirect (#2679, AC1 / C1)', () => {
	test('boot in an ordinary child lands state in the owning parent, never in the child', async () => {
		const { parent, child } = makeClaimedFixture('c1');

		const { manifest, captured } = await bootAndSettle(child);

		// Fail-open manifest: the boot still delivered the full tool surface.
		const toolCount = Object.keys(
			(manifest.tool ?? {}) as Record<string, unknown>,
		).length;
		expect(toolCount).toBeGreaterThanOrEqual(100);

		// Filesystem outcome: child tree absent, owning parent populated.
		expect(swarmExists(child)).toBe(false);
		const parentEntries = dirEntryCount(path.join(parent, '.swarm'));
		expect(parentEntries).toBeGreaterThanOrEqual(1);

		// Operator hint: one console line names the parent root.
		expect(hasParentRootHint(captured, parent, child)).toBe(true);

		// Durable redirect record under the owning parent.
		const advisoryPath = path.join(
			parent,
			'.swarm',
			'advisories',
			'bootstrap-root-redirect.json',
		);
		expect(fs.existsSync(advisoryPath)).toBe(true);
		const record = JSON.parse(fs.readFileSync(advisoryPath, 'utf-8')) as {
			project_root?: string;
		};
		expect(record.project_root).toBe(parent);
	});
});

describe('bootstrap project-root ownership — nested roots stay independent (#2679, AC2 / C3)', () => {
	const variants = [
		{ marker: 'git-directory' as const, label: 'git-dir' },
		{ marker: 'git-file' as const, label: 'git-file-worktree' },
		{ marker: 'opencode' as const, label: 'opencode-dir' },
	];

	for (const variant of variants) {
		test(`nested root declaring ${variant.label} keeps its own .swarm; outer stays empty`, async () => {
			const root = fixtureRoot(`swarm2679-c3-${variant.label}-`);
			const outer = path.join(root, 'outer');
			const nested = path.join(outer, 'nested');
			fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
			fs.mkdirSync(path.join(outer, '.swarm'), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });
			if (variant.marker === 'git-directory') {
				fs.mkdirSync(path.join(nested, '.git'));
			} else if (variant.marker === 'git-file') {
				fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../git-data\n');
			} else {
				fs.mkdirSync(path.join(nested, '.opencode'));
			}
			// A declared nested root may carry its own project config; also keeps the boot offline.
			fs.mkdirSync(path.join(nested, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(nested, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({ version_check: false }, null, 2),
			);

			await bootAndSettle(nested);

			expect(swarmExists(nested)).toBe(true);
			expect(dirEntryCount(path.join(outer, '.swarm'))).toBe(0);
		});
	}
});

describe('bootstrap project-root ownership — standalone and indicator-only roots (#2679, C4/C8)', () => {
	test('standalone root (package.json, no markers, no ancestor .swarm) keeps its own .swarm', async () => {
		const standalone = fixtureRoot('swarm2679-c4-root-');
		fs.writeFileSync(
			path.join(standalone, 'package.json'),
			JSON.stringify(
				{ name: 'swarm2679-standalone', version: '0.0.0', private: true },
				null,
				2,
			),
		);
		fs.mkdirSync(path.join(standalone, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(standalone, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ version_check: false }, null, 2),
		);

		await bootAndSettle(standalone);

		expect(swarmExists(standalone)).toBe(true);
	});

	test('indicator-only parent (.git + package.json, NO .swarm) does not capture an ordinary child', async () => {
		const root = fixtureRoot('swarm2679-c8-');
		const parent = path.join(root, 'outer');
		const child = path.join(parent, 'child');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(parent, 'package.json'),
			JSON.stringify({ name: 'swarm2679-outer', version: '0.0.0' }, null, 2),
		);
		fs.mkdirSync(child, { recursive: true });

		await bootAndSettle(child);

		expect(swarmExists(child)).toBe(true);
		expect(swarmExists(parent)).toBe(false);
	});
});

describe('bootstrap project-root ownership — rehydration and attribution (#2679)', () => {
	test('a parent that already owns swarm session state receives the child boot state (rehydration regression)', async () => {
		const { parent, child } = makeClaimedFixture('rehydr', null);
		// Minimal pre-existing snapshot under the OWNING parent so
		// hasSwarmState(parent) is true and the snapshot-load path targets the
		// parent. Fixture shape mirrors tests/unit/session/hydration-plugin-instance.test.ts.
		fs.mkdirSync(path.join(parent, '.swarm', 'session'), { recursive: true });
		fs.writeFileSync(
			path.join(parent, '.swarm', 'session', 'state.json'),
			JSON.stringify({
				version: 3,
				writtenAt: 1,
				toolAggregates: {},
				activeAgent: { 'ses-2679-parent-owned': 'coder' },
				delegationChains: {},
				agentSessions: {},
			}),
		);

		await bootAndSettle(child);

		// OBSERVABLE assertions only: the boot's state went to the parent
		// (redirect record + telemetry latch). Deep rehydration semantics
		// (in-memory swarmState after loadSnapshot) are covered by the
		// dedicated hydration suite; asserting them here would couple this
		// ownership test to unrelated snapshot-coordination timing.
		expect(swarmExists(child)).toBe(false);
		const advisoryPath = path.join(
			parent,
			'.swarm',
			'advisories',
			'bootstrap-root-redirect.json',
		);
		expect(fs.existsSync(advisoryPath)).toBe(true);
		expect(fs.existsSync(path.join(parent, '.swarm', 'telemetry.jsonl'))).toBe(
			true,
		);
	});

	test('guardrails config read from the parent stays attributable via the redirect hint', async () => {
		// The parent's .opencode config disables guardrails; the boot in the
		// child still surfaces the parent-root hint, so any parent-config
		// warning is traceable to the root that owns the config. The
		// guardrails warning text itself is NOT asserted (fragile); the hint
		// naming the parent IS the attribution contract.
		const { parent, child } = makeClaimedFixture('guardrails', {
			version_check: false,
			guardrails: { enabled: false },
		});

		const { captured } = await bootAndSettle(child);

		expect(hasParentRootHint(captured, parent, child)).toBe(true);
	});

	test('telemetry latches to the owning parent, never to the ordinary child', async () => {
		const { parent, child } = makeClaimedFixture('telemetry');

		await bootAndSettle(child);

		expect(fs.existsSync(path.join(child, '.swarm', 'telemetry.jsonl'))).toBe(
			false,
		);
		await waitFor(() =>
			fs.existsSync(path.join(parent, '.swarm', 'telemetry.jsonl')),
		);
		expect(fs.existsSync(path.join(parent, '.swarm', 'telemetry.jsonl'))).toBe(
			true,
		);
	});
});
