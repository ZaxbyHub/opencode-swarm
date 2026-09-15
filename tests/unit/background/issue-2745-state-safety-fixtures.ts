import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	mock,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
	PR_FEEDBACK_LOOP_STATE_REL,
	resetLoopInternalsForTests,
} from '../../../src/background/pr-feedback-loop.js';
import {
	listActive as productionListActive,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { withPrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import { acquireProcessEnvLease } from '../../../tests/helpers/process-env-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

export const SESSION = 'issue-2745-state-safety-session';
export const REPO = 'example/repo';
export const PR = 42;
export const URL = 'https://github.com/example/repo/pull/42';
export const HEAD = 'head-1';
export const CORRELATION = `${SESSION}::${REPO}::${PR}`;
export const NOW = 2_000_000;
const CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};
const oldXdg = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];
let releaseProcessEnv: (() => void) | null = null;

beforeAll(async () => {
	releaseProcessEnv = await acquireProcessEnvLease();
	const xdg = canonicalMkdtemp('issue-2745-state-safety-xdg-');
	dirs.push(xdg);
	process.env.XDG_CONFIG_HOME = xdg;
});

afterAll(() => {
	try {
		if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = oldXdg;
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		releaseProcessEnv?.();
		releaseProcessEnv = null;
	}
});

beforeEach(async () => {
	await withPrFeedbackQueueLease(() => queueInternals.resetQueueCache());
	gateInternals.resetTrackedStateCache();
});

afterEach(async () => {
	await withPrFeedbackQueueLease(() => queueInternals.resetQueueCache());
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
	for (const dir of dirs.splice(1))
		fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Bun can execute explicitly co-run test files in one process. The loop DI
 * object is intentionally mutable for single-file tests, so hold one shared
 * lease across each test body and restore the production bindings before the
 * next lease begins. This keeps a snapshot-only listActive mock from being
 * reset (or observed) by a sibling test while its async pipeline is pending.
 */
export { acquireLoopInternals };

/** Restore every loop seam, with an explicit production listActive binding. */
export function restoreProductionLoopInternals(): void {
	resetLoopInternalsForTests();
	loopInternals.listActive = productionListActive;
}

export function makeProject(): string {
	const dir = canonicalMkdtemp('issue-2745-state-safety-proj-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(CONFIG),
		'utf8',
	);
	return dir;
}

export async function prime(dir: string): Promise<void> {
	await subscribe(dir, {
		sessionID: SESSION,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: URL,
	});
	await updateSnapshot(dir, CORRELATION, { headRefOid: HEAD });
}

export async function enqueue(
	dir: string,
	options: { dedupToken?: string; type?: string } = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
		type: options.type ?? 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: URL,
		headRefOid: HEAD,
		message: 'ci failed',
		dedupToken: options.dedupToken ?? 'token',
		authorized: true,
		queuedAt: new Date(0).toISOString(),
	});
}

export function installHappySeams() {
	loopInternals.now = () => NOW;
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return { performer };
}

export function readState(dir: string): Record<string, any> {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf8'),
	) as Record<string, any>;
}

export function writeState(dir: string, state: Record<string, any>): void {
	fs.writeFileSync(
		path.join(dir, PR_FEEDBACK_LOOP_STATE_REL),
		JSON.stringify(state, null, 2),
		'utf8',
	);
}

export async function createCorrelation(dir: string): Promise<void> {
	await prime(dir);
	installHappySeams();
	await enqueue(dir, { dedupToken: 'seed' });
	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);
	expect(result.terminal?.state).toBe('completed');
}

export function setExpiredProbe(
	dir: string,
	marker: 'fresh' | 'stale' | 'legacy' | 'none',
): void {
	const state = readState(dir);
	const circuit = state.correlations[CORRELATION].circuit;
	circuit.openUntil = NOW - 1;
	circuit.halfOpenProbes = marker === 'none' ? 0 : 1;
	if (marker === 'fresh') {
		circuit.halfOpenProbeStartedAt = NOW - 1;
		circuit.halfOpenProbeOwnerToken = 'fresh-probe-owner';
		circuit.halfOpenProbeOwnerPid = process.pid;
	} else if (marker === 'stale') {
		circuit.halfOpenProbeStartedAt = NOW - 121_000;
		circuit.halfOpenProbeOwnerToken = 'dead-probe-owner';
		circuit.halfOpenProbeOwnerPid = 4_242;
	} else if (marker === 'legacy') {
		delete circuit.halfOpenProbeStartedAt;
		circuit.halfOpenProbeOwnerToken = 'legacy-dead-probe-owner';
		circuit.halfOpenProbeOwnerPid = 4_242;
	} else {
		delete circuit.halfOpenProbeStartedAt;
		delete circuit.halfOpenProbeOwnerToken;
		delete circuit.halfOpenProbeOwnerPid;
	}
	writeState(dir, state);
}

export function loopStateLockPath(dir: string): string {
	return path.join(dir, loopInternals.loopStateLockRelativePath());
}

export function writeLiveLock(dir: string): void {
	const lockPath = loopStateLockPath(dir);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(
		lockPath,
		JSON.stringify({ ownerToken: 'other-worker', pid: 4242, createdAtMs: NOW }),
		'utf8',
	);
}
