/**
 * Issue #2745 safety regressions: durable claim admission, producer
 * authorization, exact oversight verdicts, and cancellation barriers.
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
	clearPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
	PR_FEEDBACK_LOOP_STATE_REL,
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
const CORRELATION = `${SESSION}::${REPO}::${PR}`;
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
	const xdg = canonicalMkdtemp('issue-2745-safety-xdg-');
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
	const dir = canonicalMkdtemp('issue-2745-safety-proj-');
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
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return performer;
}

function readState(dir: string): Record<string, any> {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf8'),
	) as Record<string, any>;
}

describe('issue #2745 loop admission', () => {
	test('does not perform from the pre-claim peek when durable claim fails', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		await enqueue(dir);
		queueInternals.beforeQueueLockWrite = async () => {
			throw new Error('injected claim failure');
		};

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.reason).toBe('claim-not-acquired');
		expect(performer).not.toHaveBeenCalled();
		const queue = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queue?.events[0]?.claimedWorkflowInstanceId).toBeUndefined();
	});

	test('claims unauthorized events without blocking a later authorized event', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		await enqueue(dir, { dedupToken: 'unauthorized', authorized: false });
		await enqueue(dir, { dedupToken: 'authorized', authorized: true });

		const refused = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		const settled = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(refused.authorization?.authorized).toBe(false);
		expect(refused.authorization?.reason).toMatch(/not authorized/i);
		expect(refused.action?.performed).toBe(false);
		expect(settled.authorization?.authorized).toBe(true);
		expect(settled.action?.performed).toBe(true);
		expect(performer).toHaveBeenCalledTimes(1);
	});

	test('rejects a disapproved verdict even when it contains approved text', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			verdict: 'DISAPPROVED',
		})) as unknown as typeof loopInternals.dispatchOversight;
		await enqueue(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(performer).not.toHaveBeenCalled();
	});

	test('requires an explicit mapped decision for an APPROVED verdict', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			verdict: 'APPROVED',
		})) as unknown as typeof loopInternals.dispatchOversight;
		await enqueue(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(performer).not.toHaveBeenCalled();
	});

	test('fails closed when oversight evidence cannot be written', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		const evidencePath = path.join(dir, '.swarm', 'pr-feedback-evidence');
		fs.writeFileSync(evidencePath, 'not a directory', 'utf8');
		await enqueue(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/evidence/i);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(performer).not.toHaveBeenCalled();
	});
});

describe('issue #2745 cancellation admission barrier', () => {
	test('stop requested during oversight prevents the performer', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		loopInternals.dispatchOversight = mock(async () => {
			signalStarted();
			await gate;
			return { dispatched: true, decision: 'allow' };
		}) as unknown as typeof loopInternals.dispatchOversight;
		await enqueue(dir);

		const processing = claimAndProcessPrFeedbackEvent(dir, SESSION);
		await started;
		const cancellation = cancelPrFeedbackLoop(dir, SESSION, 'operator stop');
		release();
		const result = await processing;
		await cancellation;

		expect(result.terminal?.state).toBe('cancelled');
		expect(performer).not.toHaveBeenCalled();
		expect(readState(dir).sessionTerminals[SESSION].state).toBe('cancelled');
	});

	test('stop during an in-flight action preserves cancelled terminal state', async () => {
		const dir = makeProject();
		await prime(dir);
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		installHappySeams();
		const performer = mock(async () => {
			signalStarted();
			await gate;
			return { performed: true };
		});
		loopInternals.performAuthorizedAction = mock(async () => {
			return performer();
		}) as unknown as typeof loopInternals.performAuthorizedAction;
		await enqueue(dir);

		const processing = claimAndProcessPrFeedbackEvent(dir, SESSION);
		await started;
		const cancellation = cancelPrFeedbackLoop(
			dir,
			SESSION,
			'stop during action',
		);
		release();
		const result = await processing;
		await cancellation;

		expect(result.action?.performed).toBe(true);
		// The action-side settlement merges only a cancellation that is already
		// durable. The stop request waits behind this session's settlement lock;
		// it then persists the real cancelled terminal for subsequent work.
		expect(result.terminal?.state).toBe('completed');
		expect(readState(dir).correlations[CORRELATION].terminal.state).toBe(
			'cancelled',
		);
		expect(performer).toHaveBeenCalledTimes(1);
	});

	test('queue clearance during oversight loses action admission', async () => {
		const dir = makeProject();
		await prime(dir);
		const performer = installHappySeams();
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		loopInternals.dispatchOversight = mock(async () => {
			signalStarted();
			await gate;
			return { dispatched: true, decision: 'allow' };
		}) as unknown as typeof loopInternals.dispatchOversight;
		await enqueue(dir);

		const processing = claimAndProcessPrFeedbackEvent(dir, SESSION);
		await started;
		await clearPrFeedbackMonitorEvents(dir, SESSION, ['token']);
		release();
		const result = await processing;

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/claim/i);
		expect(performer).not.toHaveBeenCalled();
	});
});
