/**
 * Issue #2679 — bootstrap project-root ownership under racy writers, REAL
 * plugin boots. Bun:test adaptation of the frozen acceptance checks
 * .agents/issue-traces/2679-project-root-ownership-bootstrap/repro/
 * c5-concurrent-boot-race.ts and c6-late-writer.ts:
 *
 *  - C5 (AC3 first-write race): TWO CONCURRENT server() boots on the SAME
 *    ordinary child under a claiming parent (.git + .swarm) must never leave
 *    a child .swarm tree; the state converges on the parent. The project-root
 *    decision is resolved once per boot before any writer, so a racy
 *    check-then-create child writer cannot leak through.
 *  - C6 (AC3 late writer): after a boot has settled, a LATE optional writer
 *    invoked with the CHILD directory — the registered 'tool.execute.after'
 *    hook (its snapshot writer materializes project state) — must not create
 *    child .swarm either; state lands in the resolved project root.
 *
 * Env isolation is XDG-only (+ APPDATA/LOCALAPPDATA), matching the frozen
 * scripts: HOME/USERPROFILE stay real so the boundary walk's weak-container
 * rule keeps recognizing the real home/tmpdir. No mock.module, no clock.
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

import { closeAllProjectDbs, closeProjectDb } from '../../src/db/project-db';
import OpenCodeSwarm from '../../src/index';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { safeRmRecursive } from '../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../helpers/tmpdir';

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
	isolatedEnvRoot = canonicalMkdtemp('swarm2679-late-env-');
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
	// Release plugin-owned handles BEFORE removing fixtures (Windows EBUSY, #2480).
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

/** Claimed-parent fixture: parent(.git + .swarm) + ordinary child, no markers on the child. */
function makeClaimedFixture(prefix: string): { parent: string; child: string } {
	const root = canonicalMkdtemp(prefix);
	fixtureRoots.push(root);
	const parent = path.join(root, 'outer');
	const child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(child, { recursive: true });
	// Keep the boot offline and quiet; the config is read from the PARENT
	// (the bootstrap root after the redirect), never from the ordinary child.
	fs.mkdirSync(path.join(parent, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(parent, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	return { parent, child };
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
	attempts = 60,
	stepMs = 100,
): Promise<boolean> {
	for (let i = 0; i < attempts; i += 1) {
		if (condition()) return true;
		await Bun.sleep(stepMs);
	}
	return condition();
}

describe('bootstrap project-root ownership — concurrent boots on one ordinary child (#2679, C5)', () => {
	test('two concurrent server() boots never leave a child .swarm; state converges on the parent', async () => {
		const { parent, child } = makeClaimedFixture('swarm2679-c5-');

		// Start BOTH boots before awaiting either so the two initialization
		// paths interleave at their await points (the first-write race window).
		const settled = await Promise.allSettled([
			OpenCodeSwarm.server(ctxFor(child) as never),
			OpenCodeSwarm.server(ctxFor(child) as never),
		]);
		// Boot rejections are recorded, non-fatal: the frozen contract is the
		// filesystem outcome, not boot success.
		const resolvedBoots = settled.filter(
			(o) => o.status === 'fulfilled',
		).length;
		expect(resolvedBoots).toBeGreaterThanOrEqual(1);

		// Fixed macrotask drain for the wrapper-owned post-resolution queue.
		await Bun.sleep(4000);

		expect(swarmExists(child)).toBe(false);
		const parentEntries = dirEntryCount(path.join(parent, '.swarm'));
		expect(parentEntries).toBeGreaterThanOrEqual(1);
	});
});

describe('bootstrap project-root ownership — late writer after settle (#2679, C6)', () => {
	test('the registered tool.execute.after snapshot writer respects the resolved project root', async () => {
		const { parent, child } = makeClaimedFixture('swarm2679-c6-');

		const manifest = (await OpenCodeSwarm.server(
			ctxFor(child) as never,
		)) as unknown as Record<string, unknown>;
		expect(
			Object.keys((manifest.tool ?? {}) as Record<string, unknown>).length,
		).toBeGreaterThanOrEqual(100);
		await Bun.sleep(4000);

		// Isolate the late-writer probe (c6 idiom): close plugin-owned handles on
		// the child, then best-effort remove any boot-created child tree so a
		// post-probe tree is attributable to the late writer alone. On the fixed
		// tree the boot never creates the child tree, so this is a no-op guard.
		if (swarmExists(child)) {
			try {
				closeProjectDb(child);
			} catch {
				// non-fatal: no cached handle for this directory
			}
			resetTelemetryForTesting();
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					fs.rmSync(path.join(child, '.swarm'), {
						recursive: true,
						force: true,
					});
					break;
				} catch {
					await Bun.sleep(200);
				}
			}
		}

		const afterHook = manifest['tool.execute.after'] as
			| ((input: unknown, output: unknown) => Promise<unknown>)
			| undefined;
		expect(typeof afterHook).toBe('function');
		try {
			await afterHook(
				{
					tool: 'read',
					sessionID: 'ses-swarm2679-late-writer',
					callID: 'call-swarm2679-late-writer-1',
				},
				{
					title: '',
					output: 'late-writer probe payload (issue 2679)',
					metadata: null,
				},
			);
		} catch {
			// Failing closed with a bounded error is an acceptable late-writer
			// outcome; the filesystem verdict decides (c6 contract).
		}

		await Bun.sleep(2000);

		// The only forbidden outcome is a child .swarm tree.
		expect(swarmExists(child)).toBe(false);
		// The writer landed in the owning parent: session state is present there
		// (project DB and/or the snapshot projection under parent/.swarm).
		const parentHasSessionState = await waitFor(
			() =>
				fs.existsSync(path.join(parent, '.swarm', 'swarm.db')) ||
				fs.existsSync(path.join(parent, '.swarm', 'session')),
		);
		expect(parentHasSessionState).toBe(true);
		expect(dirEntryCount(path.join(parent, '.swarm'))).toBeGreaterThanOrEqual(
			1,
		);
	});
});
