/**
 * Issue #2745 activation-capacity and cancellation-saturation regressions.
 *
 * These cases are kept separate from the general admission barriers so the
 * high-cardinality coordination coverage stays below the test-file cap.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
	MAX_CANCELLATION_REQUESTS,
	MAX_IN_FLIGHT_SESSIONS,
} from '../../../src/background/pr-feedback-loop.js';
import {
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import { acquireProcessEnvLease } from '../../../tests/helpers/process-env-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const SESSION = 'issue-2745-session';
const REPO = 'example/repo';
const PR = 42;
const URL = 'https://github.com/example/repo/pull/42';
const HEAD = 'head-1';
const CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};
const originals = { ...loopInternals };
const oldXdg = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;
let releaseProcessEnv: (() => void) | null = null;

beforeAll(async () => {
	releaseProcessEnv = await acquireProcessEnvLease();
	const xdg = canonicalMkdtemp('issue-2745-capacity-xdg-');
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
	releaseLoopInternals = await acquireLoopInternals();
	releaseQueue = await acquirePrFeedbackQueueLease();
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
});

afterEach(() => {
	try {
		Object.assign(loopInternals, originals);
		queueInternals.resetQueueCache();
		gateInternals.resetTrackedStateCache();
		closeAllProjectDbs();
		for (const dir of dirs.splice(1))
			fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		releaseQueue?.();
		releaseQueue = null;
		releaseLoopInternals?.();
		releaseLoopInternals = null;
	}
});

function makeProject(): string {
	const dir = canonicalMkdtemp('issue-2745-capacity-proj-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(CONFIG),
		'utf8',
	);
	return dir;
}

async function prime(dir: string, sessionID = SESSION): Promise<void> {
	await subscribe(dir, {
		sessionID,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: URL,
	});
	await updateSnapshot(dir, `${sessionID}::${REPO}::${PR}`, {
		headRefOid: HEAD,
	});
}

async function enqueue(
	dir: string,
	options: {
		dedupToken?: string;
		authorized?: boolean;
		sessionID?: string;
	} = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, options.sessionID ?? SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: URL,
		headRefOid: HEAD,
		message: 'ci failed',
		dedupToken: options.dedupToken ?? 'token',
		authorized: options.authorized ?? true,
		queuedAt: new Date(0).toISOString(),
	});
}

function installHappySeams(): ReturnType<typeof mock> {
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	}));
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return performer;
}

describe('issue #2745 cancellation admission barrier — capacity regressions', () => {
	test('cancellation overflow fails closed without evicting active stops', async () => {
		const blockedRoot = makeProject();
		const blockedSessions = Array.from(
			{ length: MAX_CANCELLATION_REQUESTS + 1 },
			(_, index) => `overflow-session-${index}`,
		);
		let releaseStateLock!: () => void;
		const stateLockGate = new Promise<void>((resolve) => {
			releaseStateLock = resolve;
		});
		let markStateLockHeld!: () => void;
		const stateLockHeld = new Promise<void>((resolve) => {
			markStateLockHeld = resolve;
		});
		loopInternals.beforeLoopStateLockWrite = async () => {
			markStateLockHeld();
			await stateLockGate;
		};
		const stops = blockedSessions.map((sessionID) =>
			cancelPrFeedbackLoop(blockedRoot, sessionID, 'overflow stop'),
		);
		// Cancellation admission is recorded synchronously before each stop waits
		// for durable state. Holding the first state lock keeps all 65 requests
		// active while the overflow branch is exercised, without blocking reads.
		await stateLockHeld;

		// The overflow marker belongs to the root whose request could not enter
		// the bounded registry; it must not pause an unrelated project root.
		const performer = installHappySeams();
		const blocked = await claimAndProcessPrFeedbackEvent(
			blockedRoot,
			'overflow-admission-session',
		);

		expect(blocked.reason).toMatch(
			/cancellation admission capacity exhausted/i,
		);
		// Prior bug (R1): registry overflow was reported as a fabricated
		// operator cancellation and could overwrite a completed action.
		expect(blocked.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		const unrelatedRoot = makeProject();
		const unrelated = await claimAndProcessPrFeedbackEvent(
			unrelatedRoot,
			'unrelated-admission-session',
		);
		expect(unrelated.reason).not.toMatch(/cancellation admission capacity/i);
		releaseStateLock();
		await Promise.all(stops);
	});

	test('active action stop stays targeted when ordinary cancellation registry is full', async () => {
		const activeDir = makeProject();
		const activeSession = 'active-stop';
		await prime(activeDir, activeSession);
		await enqueue(activeDir, { sessionID: activeSession });
		let markHeadStarted!: () => void;
		const headStarted = new Promise<void>((resolve) => {
			markHeadStarted = resolve;
		});
		let releaseHead!: () => void;
		const headGate = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		loopInternals.evaluateCurrentHead = mock(async () => {
			markHeadStarted();
			await headGate;
			return HEAD;
		}) as unknown as typeof loopInternals.evaluateCurrentHead;
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'allow',
		})) as unknown as typeof loopInternals.dispatchOversight;
		const performer = mock(async () => ({ performed: true }));
		loopInternals.performAuthorizedAction =
			performer as unknown as typeof loopInternals.performAuthorizedAction;
		const processing = claimAndProcessPrFeedbackEvent(activeDir, activeSession);
		await headStarted;

		let reads = 0;
		let markSaturated!: () => void;
		const saturated = new Promise<void>((resolve) => {
			markSaturated = resolve;
		});
		let releaseReads!: () => void;
		const readsGate = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		loopInternals.readState = mock(async () => {
			reads += 1;
			if (reads === MAX_CANCELLATION_REQUESTS) markSaturated();
			await readsGate;
			return {
				schemaVersion: 1,
				updatedAt: new Date(0).toISOString(),
				oversightSeq: 0,
				correlations: {},
				sessionTerminals: {},
			};
		}) as unknown as typeof loopInternals.readState;
		const ordinaryDirs = Array.from({ length: MAX_CANCELLATION_REQUESTS }, () =>
			makeProject(),
		);
		const ordinaryStops = ordinaryDirs.map((dir, index) =>
			cancelPrFeedbackLoop(dir, `ordinary-${index}`, 'ordinary stop'),
		);
		await saturated;

		const targetedStop = cancelPrFeedbackLoop(
			activeDir,
			activeSession,
			'targeted stop',
		);
		releaseHead();
		releaseReads();
		const [result] = await Promise.all([processing, targetedStop]);
		await Promise.all(ordinaryStops);

		// The targeted active stop remains effective even when unrelated
		// cancellation requests fill the bounded registry.
		expect(result.terminal?.state).toBe('cancelled');
		expect(result.reason).toMatch(/cancelled: targeted stop/);
		expect(performer).not.toHaveBeenCalled();
	});

	test('leaves the 65th action unclaimed, admits a stop, and retries after capacity frees', async () => {
		const sessions = Array.from(
			{ length: MAX_IN_FLIGHT_SESSIONS },
			(_, index) => `busy-${index}`,
		);
		const busyDirs = sessions.map(() => makeProject());
		// This case only exercises settlement admission. Supply the durable
		// subscription view through the existing DI seam so the 64-fixture setup
		// does not repeatedly migrate/open one SQLite database per project.
		const activeSubscriptions = sessions.map((sessionID) => ({
			correlationId: `${sessionID}::${REPO}::${PR}`,
			sessionID,
			prNumber: PR,
			repoFullName: REPO,
			prUrl: URL,
			headRefOid: HEAD,
			lastCheckedAt: 0,
			isWatching: true,
			hasUnaddressedEvents: false,
			status: 'active' as const,
			createdAt: 0,
			updatedAt: 0,
			errorCount: 0,
		}));
		loopInternals.listActive = mock(async () => activeSubscriptions);
		let started = 0;
		let markAllStarted!: () => void;
		const allStarted = new Promise<void>((resolve) => {
			markAllStarted = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		loopInternals.evaluateCurrentHead = mock(async () => {
			started += 1;
			if (started === sessions.length) markAllStarted();
			await gate;
			return HEAD;
		}) as unknown as typeof loopInternals.evaluateCurrentHead;
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'allow',
		}));
		loopInternals.performAuthorizedAction = mock(async () => ({
			performed: true,
		}));
		await Promise.all(
			sessions.map((sessionID, index) =>
				enqueue(busyDirs[index]!, {
					dedupToken: `token-${sessionID}`,
					sessionID,
				}),
			),
		);
		const busy = sessions.map((sessionID, index) =>
			claimAndProcessPrFeedbackEvent(busyDirs[index]!, sessionID),
		);
		await allStarted;

		const dir = makeProject();
		const retrySession = 'retry-after-capacity';
		activeSubscriptions.push({
			correlationId: `${retrySession}::${REPO}::${PR}`,
			sessionID: retrySession,
			prNumber: PR,
			repoFullName: REPO,
			prUrl: URL,
			headRefOid: HEAD,
			lastCheckedAt: 0,
			isWatching: true,
			hasUnaddressedEvents: false,
			status: 'active',
			createdAt: 0,
			updatedAt: 0,
			errorCount: 0,
		});
		await enqueue(dir, { dedupToken: 'retry-token', sessionID: retrySession });
		const blocked = await claimAndProcessPrFeedbackEvent(dir, retrySession);
		expect(blocked.reason).toMatch(/settlement capacity exhausted/i);
		expect(started).toBe(MAX_IN_FLIGHT_SESSIONS);
		expect(
			(await readPrFeedbackMonitorQueue(dir, retrySession))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();

		// A same-key cancellation replaces the serialization tail while the
		// action is still evaluating. It must not remove that action key from
		// the independent capacity accounting.
		const tailCancellation = cancelPrFeedbackLoop(
			busyDirs[0]!,
			sessions[0]!,
			'tail stop',
		);
		const blockedAfterTail = await claimAndProcessPrFeedbackEvent(
			dir,
			retrySession,
		);
		expect(blockedAfterTail.reason).toMatch(/settlement capacity exhausted/i);

		const stopped = await cancelPrFeedbackLoop(
			dir,
			'cancel-at-capacity',
			'stop',
		);
		expect(stopped.terminalState).toBe('cancelled');
		release();
		await Promise.all(busy);
		await tailCancellation;

		const retried = await claimAndProcessPrFeedbackEvent(dir, retrySession);
		expect(retried.action?.performed).toBe(true);
	}, 60_000);
});
