/**
 * #3165 section B, review F-01..F-03: the snapshot-coordination registry, the
 * dashboard registry and the swarm.db health probe keyed a blank root by
 * `canonicalProjectKey('')`, which is the absolute cwd, so a blank root
 * started, reused or closed the cwd project's entry. Each test pins the cwd to
 * a sandbox.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents/index.js';
import { handleCloseCommand } from '../../../src/commands/close.js';
import { handleResetSessionCommand } from '../../../src/commands/reset-session.js';
import { listTrajectorySessions } from '../../../src/consensus/corpus.js';
import {
	closeDashboardServerForRoot,
	closeDashboardServerForRootIfOwner,
	type DashboardHandle,
	getDashboardHandle,
	startDashboardServer,
} from '../../../src/dashboard/index.js';
import { canonicalProjectKey } from '../../../src/db/canonical-project.js';
import { ProjectDbError } from '../../../src/db/db-errors.js';
import { getSwarmDbHealthSnapshot } from '../../../src/db/health.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import {
	beginSnapshotCoordinationReset,
	_snapshotCoordinationInternals as coordination,
	ensureSnapshotCoordinationReady,
	getSnapshotCoordinationStatus,
	markSnapshotCoordinationClosing,
	retrySnapshotCoordinationInitialization,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const BLANKS = ['', '   ', ' \n\t '];

let sandbox: string;
const originalCwd = process.cwd();
const originalInitialize = coordination.initialize;
let initializeCalls: string[] = [];

beforeEach(() => {
	sandbox = canonicalMkdtemp('blank-root-lifecycle-3165-');
	process.chdir(sandbox);
	initializeCalls = [];
	coordination.initialize = async (dir) => {
		initializeCalls.push(dir);
		return 'succeeded';
	};
});

afterEach(() => {
	process.chdir(originalCwd);
	try {
		coordination.initialize = originalInitialize;
		coordination.entries.delete(canonicalProjectKey(sandbox));
		closeAllProjectDbs();
	} finally {
		safeRmRecursive(sandbox);
	}
});

function cwdSwarmCreated(): boolean {
	return existsSync(path.join(sandbox, '.swarm'));
}

async function caughtFrom(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	return undefined;
}

function expectInvalidRoot(caught: unknown): void {
	expect(caught).toBeInstanceOf(ProjectDbError);
	expect((caught as ProjectDbError).category).toBe('invalid_root');
}

/** Install a settled readiness entry for the cwd project. */
function installCwdEntry() {
	const entry = {
		attemptId: 1,
		generation: 1,
		state: 'succeeded' as const,
		settled: true,
		underlying: Promise.resolve(),
	};
	coordination.entries.set(canonicalProjectKey(sandbox), entry as never);
	return entry;
}

describe('snapshot coordination — regression: a blank root initialized the cwd project (#3165 B F-01)', () => {
	test('ensureSnapshotCoordinationReady and startSnapshotCoordinationInitialization reject with invalid_root', async () => {
		// Previous code canonicalized '' to the cwd and ran (or reused) the cwd
		// project's initializer, leaving its readiness entry 'succeeded'.
		for (const blank of BLANKS) {
			expectInvalidRoot(
				await caughtFrom(() => ensureSnapshotCoordinationReady(blank)),
			);
			expectInvalidRoot(
				await caughtFrom(() => startSnapshotCoordinationInitialization(blank)),
			);
		}
		expect(initializeCalls).toEqual([]);
		expect(getSnapshotCoordinationStatus(sandbox).state).toBe('idle');
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('retrySnapshotCoordinationInitialization throws invalid_root and keeps the cwd entry', async () => {
		// Previous code deleted the cwd project's entry and re-initialized it.
		const entry = installCwdEntry();
		for (const blank of BLANKS) {
			expectInvalidRoot(
				await caughtFrom(() => retrySnapshotCoordinationInitialization(blank)),
			);
		}
		expect(coordination.entries.get(canonicalProjectKey(sandbox))).toBe(
			entry as never,
		);
		expect(initializeCalls).toEqual([]);
	});

	test('status, reset and closing are no-ops that never touch the cwd entry', async () => {
		// Previous code reported the cwd entry's state, replaced it with a
		// closing guard, and marked it closing for shutdown.
		const entry = installCwdEntry();
		for (const blank of BLANKS) {
			expect(getSnapshotCoordinationStatus(blank)).toEqual({
				state: 'idle',
				settled: true,
			});
			const guard = await beginSnapshotCoordinationReset(blank);
			expect(coordination.entries.get(canonicalProjectKey(sandbox))).toBe(
				entry as never,
			);
			expect(guard.markStranded()).toBe(false);
			guard.release();
			markSnapshotCoordinationClosing(blank);
		}
		expect(coordination.entries.get(canonicalProjectKey(sandbox))).toBe(
			entry as never,
		);
		expect(entry.state).toBe('succeeded');
	});
});

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

async function startOnFreePort(dir: string): Promise<DashboardHandle> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const handle = await startDashboardServer({
			port: await freePort(),
			directory: dir,
		});
		if (handle.listening) return handle;
		await handle.close();
	}
	throw new Error('no bindable ephemeral port after 3 attempts');
}

describe('dashboard registry — regression: a blank root reached the cwd listener (#3165 B F-01)', () => {
	test('startDashboardServer refuses a whitespace root without binding or writing', async () => {
		// Previous code only refused '' (falsy): '   ' bound a listener and wrote
		// `<cwd>/   /.swarm/dashboard-status.json`.
		for (const blank of BLANKS) {
			const handle = await startDashboardServer({
				port: await freePort(),
				directory: blank,
			});
			if (handle.listening) await handle.close();
			expect(handle.status).toBe('disabled_invalid_options');
			expect(handle.listening).toBe(false);
		}
		expect(readdirSync(sandbox)).toEqual([]);
		expect(cwdSwarmCreated()).toBe(false);
	});

	test('lookup and close on a blank root leave the cwd listener running', async () => {
		// Previous code returned, and closed, the cwd project's listener.
		const handle = await startOnFreePort(sandbox);
		try {
			for (const blank of BLANKS) {
				expect(getDashboardHandle(blank)).toBeNull();
				closeDashboardServerForRoot(blank);
				expect(closeDashboardServerForRootIfOwner(blank, handle)).toBe(false);
			}
			expect(getDashboardHandle(sandbox)).toBe(handle);
		} finally {
			await handle.close();
		}
	});
});

describe('swarm.db health — regression: a blank root reported a healthy absent DB (#3165 B F-02)', () => {
	test('getSwarmDbHealthSnapshot reports the invalid_root error, not absent', () => {
		// Previous code swallowed projectDbPath's refusal in a bare catch and
		// returned { kind: 'absent' }, which callers render as healthy.
		for (const blank of BLANKS) {
			expect(getSwarmDbHealthSnapshot(blank)).toMatchObject({
				kind: 'error',
				category: 'invalid_root',
			});
		}
		expect(getSwarmDbHealthSnapshot(sandbox)).toEqual({ kind: 'absent' });
		expect(cwdSwarmCreated()).toBe(false);
	});
});

describe('blank-root diagnostics — regression: the raw root was echoed unbounded (#3165 B F-03)', () => {
	const huge = 'r'.repeat(2_000);
	const hugeBlank = ' \n'.repeat(1_000);

	test('getProjectDb, the corpus guard and diagnose bound the echoed root', async () => {
		// Previous code embedded JSON.stringify(directory) verbatim, so a
		// 2,000-character root produced a 2,000-character message.
		let dbError: unknown;
		try {
			getProjectDb(hugeBlank);
		} catch (err) {
			dbError = err;
		}
		expect((dbError as Error).message.length).toBeLessThan(200);
		const corpusError = await caughtFrom(() => listTrajectorySessions(huge));
		expect((corpusError as Error).message).toContain('non-blank absolute');
		expect((corpusError as Error).message.length).toBeLessThan(250);
		const detail = (await getDiagnoseData(huge)).checks[0]?.detail ?? '';
		expect(detail).toContain('Not a usable project root');
		expect(detail.length).toBeLessThan(250);
	});
});

describe('commands and init — regression: a blank root acted on the cwd project (#3165 B)', () => {
	function seedCwdSession(): string {
		const session = path.join(sandbox, '.swarm', 'session');
		mkdirSync(session, { recursive: true });
		writeFileSync(path.join(session, 'state.json'), '{}');
		return session;
	}

	test('/swarm reset-session refuses a blank root and keeps the cwd session files', async () => {
		// Previous code backed up and deleted <cwd>/.swarm/session/*.
		const session = seedCwdSession();
		for (const blank of BLANKS) {
			expect(await handleResetSessionCommand(blank, [])).toContain(
				'project directory is blank',
			);
		}
		expect(readdirSync(session)).toEqual(['state.json']);
		expect(existsSync(path.join(sandbox, '.swarm', 'reset-backups'))).toBe(
			false,
		);
	});

	test('/swarm close refuses a blank root and keeps the cwd session files', async () => {
		const session = seedCwdSession();
		for (const blank of BLANKS) {
			expect(await handleCloseCommand(blank, [])).toContain(
				'project directory is blank',
			);
		}
		expect(readdirSync(session)).toEqual(['state.json']);
	});

	test('getAgentConfigs writes no evidence snapshot under a whitespace root', async () => {
		// Previous code checked `if (directory)`, so '   ' wrote
		// <cwd>/   /.swarm/evidence/agent-tools-*.json (asynchronously).
		for (const blank of BLANKS) getAgentConfigs(undefined, blank, 'blank-3165');
		getAgentConfigs(undefined, sandbox, 'control-3165');
		const evidence = path.join(sandbox, '.swarm', 'evidence');
		for (let i = 0; i < 50 && !existsSync(evidence); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// The control's write landed, so the blank ones had the same time.
		expect(readdirSync(evidence)).toEqual(['agent-tools-control-3165.json']);
		expect(readdirSync(sandbox)).toEqual(['.swarm']);
	});
});
