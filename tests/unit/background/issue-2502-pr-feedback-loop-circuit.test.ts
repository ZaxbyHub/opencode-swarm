/**
 * Issue #2502 — transient/permanent performer failures and half-open recovery.
 *
 * The root hooks intentionally mirror the settle-pipeline suite: both test
 * files mutate the same loop and queue seams, so they acquire the same leases
 * and retain per-file XDG/config and temp-directory cleanup.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import { _internals as queueInternals } from '../../../src/background/pr-feedback-event-queue.js';
import { claimAndProcessPrFeedbackEvent } from '../../../src/background/pr-feedback-loop.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	CORRELATION,
	makeProject as createProject,
	enqueueEvent,
	installLoopSeams,
	loopInternals,
	primeSubscription,
	readLoopStateFile,
	SESSION,
	T0,
} from '../../../tests/helpers/issue-2502-pr-feedback-loop-fixtures';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import { acquireProcessEnvLease } from '../../../tests/helpers/process-env-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const loopInternalsOriginals = { ...loopInternals };
const savedXdg = process.env.XDG_CONFIG_HOME;
let xdgIsolationDir = '';
const createdDirs: string[] = [];
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;
let releaseProcessEnv: (() => void) | null = null;

function makeProject(): string {
	return createProject(createdDirs);
}

beforeAll(async () => {
	// XDG_CONFIG_HOME is process-wide; hold the shared lease for the whole file
	// so a co-running suite cannot observe this test's isolated config root.
	releaseProcessEnv = await acquireProcessEnvLease();
	xdgIsolationDir = canonicalMkdtemp('issue-2502-loop-xdg-');
	process.env.XDG_CONFIG_HOME = xdgIsolationDir;
});

afterAll(() => {
	try {
		if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdg;
		if (xdgIsolationDir) {
			fs.rmSync(xdgIsolationDir, { recursive: true, force: true });
		}
	} finally {
		releaseProcessEnv?.();
		releaseProcessEnv = null;
	}
});

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
	releaseQueue = await acquirePrFeedbackQueueLease();
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
});

afterEach(() => {
	try {
		Object.assign(loopInternals, loopInternalsOriginals);
		queueInternals.resetQueueCache();
		gateInternals.resetTrackedStateCache();
		closeAllProjectDbs();
		for (const dir of createdDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		releaseQueue?.();
		releaseQueue = null;
		releaseLoopInternals?.();
		releaseLoopInternals = null;
	}
});

describe('issue #2502 circuit breaker recovery', () => {
	test('transient performer failure: degraded terminal + future circuit openUntil', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		loopInternals.now = () => T0;
		const flaky = installLoopSeams({
			performer: async () => {
				throw new Error('HTTP 503 Service Unavailable');
			},
		});
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.terminal?.state).toBe('degraded');
		expect(result.terminal?.reason).toMatch(/circuit open/i);
		// 1 initial attempt + 2 bounded transient retries.
		expect(flaky).toHaveBeenCalledTimes(3);
		const circuit = readLoopStateFile(dir).correlations?.[CORRELATION]?.circuit;
		expect(circuit?.openUntil ?? 0).toBeGreaterThan(T0);
	});

	test('permanent performer failure: paused_for_human, exactly one attempt', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const permanent = installLoopSeams({
			performer: async () => {
				throw new Error('ReferenceError: x is not defined');
			},
		});
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.terminal?.state).toBe('paused_for_human');
		expect(result.terminal?.reason).toMatch(/permanent action failure/);
		expect(result.action?.performed).toBe(false);
		expect(permanent).toHaveBeenCalledTimes(1);
	});

	test('half-open probe: post-cooldown event is admitted and closes the circuit', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		loopInternals.now = () => T0;
		installLoopSeams({
			performer: async () => {
				throw new Error('HTTP 503 Service Unavailable');
			},
		});
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const degraded = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(degraded.terminal?.state).toBe('degraded');

		// Advance the injected clock past openUntil (+ cooldown margin).
		loopInternals.now = () => T0 + 60_000 + 1_000;
		const performer = installLoopSeams();
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		const recovered = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(performer).toHaveBeenCalledTimes(1);
		expect(recovered.terminal?.state).toBe('completed');
		const circuit = readLoopStateFile(dir).correlations?.[CORRELATION]?.circuit;
		expect(circuit?.openUntil).toBe(0);
	});
});
