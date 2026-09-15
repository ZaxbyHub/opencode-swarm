/**
 * Issue #2502 review-round-2 coverage gaps (RF-2502-003/004/002) — split out of
 * issue-2502-pr-feedback-loop.test.ts for FR-006. Self-contained helpers.
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
} from '../../../src/background/pr-feedback-event-queue.js';
import {
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

const SESSION = 'sess-loop';
const REPO = 'example/repo';
const PR_URL = 'https://github.com/example/repo/pull/42';
const HEAD = 'h1';

const ENABLED_CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};

const loopInternalsOriginals = { ...loopInternals };
const savedXdg = process.env.XDG_CONFIG_HOME;
let xdgIsolationDir = '';
const createdDirs: string[] = [];
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;
let releaseProcessEnv: (() => void) | null = null;

beforeAll(async () => {
	releaseProcessEnv = await acquireProcessEnvLease();
	xdgIsolationDir = canonicalMkdtemp('issue-2502-gaps-xdg-');
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

function makeProject(
	config: Record<string, unknown> | null = ENABLED_CONFIG,
): string {
	const dir = canonicalMkdtemp('issue-2502-gaps-proj-');
	createdDirs.push(dir);
	if (config !== null) {
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, '\t'),
			'utf8',
		);
	}
	return dir;
}

async function primeSubscription(
	dir: string,
	prNumber = 42,
	prUrl = PR_URL,
): Promise<void> {
	await subscribe(dir, {
		sessionID: SESSION,
		prNumber,
		repoFullName: REPO,
		prUrl,
	});
	await updateSnapshot(dir, `${SESSION}::${REPO}::${prNumber}`, {
		headRefOid: HEAD,
	});
}

async function enqueueEvent(
	dir: string,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: 42,
		prUrl: PR_URL,
		headRefOid: HEAD,
		message: 'ci check failed',
		dedupToken: 'tok-1',
		authorized: true,
		queuedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	});
}

function installLoopSeams(
	opts: { head?: string | null } = {},
): ReturnType<typeof mock> {
	loopInternals.evaluateCurrentHead = mock(async () =>
		opts.head === undefined ? HEAD : opts.head,
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

describe('session budget across multiple PRs (RF-2502-003)', () => {
	test('a fresh PR is refused paused_for_human once the session cap is exhausted', async () => {
		const dir = makeProject({
			pr_monitor: { enabled: true, auto_pr_feedback: true },
			pr_feedback_loop: { enabled: true, max_session_actions: 1 },
		});
		await primeSubscription(dir);
		await primeSubscription(dir, 43, 'https://github.com/example/repo/pull/43');
		const performer = installLoopSeams();

		// First settle on PR 42 consumes the session budget (cap 1).
		await enqueueEvent(dir, { dedupToken: 'tok-a' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');
		expect(performer).toHaveBeenCalledTimes(1);

		// Second event for a DIFFERENT PR (fresh correlation, also subscribed so
		// it is not foreign) must hit the session-wide cap even though that
		// correlation's per-PR counter is 0.
		await enqueueEvent(dir, {
			dedupToken: 'tok-b',
			prNumber: 43,
			prUrl: 'https://github.com/example/repo/pull/43',
		});
		const second = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(second.authorization?.budget?.exhausted).toBe(true);
		expect(second.terminal?.state).toBe('paused_for_human');
		expect(second.terminal?.reason).toMatch(/budget/i);
		expect(performer).toHaveBeenCalledTimes(1);
	});
});

describe('oversight denial and dispatch-failure branches (RF-2502-004)', () => {
	test('a deny verdict refuses the action and pauses for a human', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'deny',
		})) as unknown as typeof loopInternals.dispatchOversight;

		await enqueueEvent(dir, { dedupToken: 'tok-deny' });
		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.oversight?.decision).toBe('deny');
		expect(result.action?.performed).toBe(false);
		expect(performer).toHaveBeenCalledTimes(0);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(result.terminal?.reason).toMatch(/oversight/i);
	});

	test('an oversight dispatch infrastructure failure fails closed (no action)', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		loopInternals.dispatchOversight = mock(async () => {
			throw new Error('opencode client unavailable');
		}) as unknown as typeof loopInternals.dispatchOversight;

		await enqueueEvent(dir, { dedupToken: 'tok-fail' });
		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.oversight?.dispatched).toBe(false);
		expect(result.action?.performed).toBe(false);
		expect(performer).toHaveBeenCalledTimes(0);
		expect(result.terminal?.state).toBe('paused_for_human');
	});
});

describe('corrupt state fail-closed (RF-2502-002/007 fix)', () => {
	test('an unparseable state file pauses instead of silently wiping the ledger', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		// Settle once to establish a real ledger.
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		await claimAndProcessPrFeedbackEvent(dir, SESSION);
		// Corrupt the state file.
		fs.writeFileSync(
			path.join(dir, PR_FEEDBACK_LOOP_STATE_REL),
			'{not json',
			'utf-8',
		);
		await enqueueEvent(dir, { dedupToken: 'tok-2' });

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(result.terminal?.reason).toMatch(/corrupt/i);
		// Fail-closed: no stateless write may land (the corrupt bytes stay).
		expect(
			fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf-8'),
		).toBe('{not json');
		expect(performer).toHaveBeenCalledTimes(1);
	});
});
