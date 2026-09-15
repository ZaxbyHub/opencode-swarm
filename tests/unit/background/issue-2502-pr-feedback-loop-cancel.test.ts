/**
 * Issue #2502 — PR feedback loop cancellation, queue clearing, and wiring.
 *
 * Covers: cancelPrFeedbackLoop (operator stop: claimed-but-unsettled and
 * unclaimed queue events cleared with an atomic cleanup receipt, settled
 * correlations marked cancelled, idempotent re-cancel), the
 * clearPrFeedbackMonitorEvents unit surface, the notifyPrFeedbackLoop
 * fire-and-forget wiring (settles when enabled, performs nothing when
 * disabled).
 *
 * Isolation notes (mirrors issue-2502-pr-feedback-loop.test.ts):
 * - NO mock.module: the loop's `_internals` seam injects head evaluation,
 *   oversight dispatch, and the performer; ALL overrides are restored in
 *   afterEach (originals captured at module top). readState/writeState stay
 *  real — cancellation and restoration are durable-state behaviors.
 * - XDG_CONFIG_HOME is redirected to an empty temp dir so loadPluginConfig's
 *   user-config read cannot flip the triple gate on machines whose
 *   ~/.config/opencode/opencode-swarm.json already enables pr_monitor gates.
 * - The queued events use the public queue API; the claimed event is claimed
 *   via claimPrFeedbackMonitorEvents with instance 'wf-x' exactly as the idle
 *   hook would have.
 *
 * Mock coverage note (per writing-tests SKILL.md): dispatchOversight is mocked
 * to the allow outcome only (the notify test needs one full settle). Deny /
 * pending oversight branches are covered by the settle-pipeline test file.
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
	claimPrFeedbackMonitorEvents,
	clearPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	_internals as loopInternals,
	notifyPrFeedbackLoop,
	PR_FEEDBACK_LOOP_STATE_REL,
} from '../../../src/background/pr-feedback-loop.js';
import {
	buildCorrelationId,
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
const PR = 42;
const PR_URL = 'https://github.com/example/repo/pull/42';
const HEAD = 'h1';
const CORRELATION = buildCorrelationId(SESSION, REPO, PR);
const CANCEL_REASON = 'operator stop:CI flake';

const ENABLED_CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};

// Captured at module top; restored into the seam in afterEach.
const loopInternalsOriginals = { ...loopInternals };
const savedXdg = process.env.XDG_CONFIG_HOME;
let xdgIsolationDir = '';
const createdDirs: string[] = [];
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;
let releaseProcessEnv: (() => void) | null = null;

interface LoopStateFile {
	correlations?: Record<
		string,
		{ terminal?: { state?: string; reason?: string } | null }
	>;
	sessionTerminals?: Record<string, { state?: string; reason?: string }>;
}

interface CancelReceipt {
	sessionID?: string;
	reason?: string;
	clearedEvents?: string[];
}

beforeAll(async () => {
	releaseProcessEnv = await acquireProcessEnvLease();
	xdgIsolationDir = canonicalMkdtemp('issue-2502-cancel-xdg-');
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
	const dir = canonicalMkdtemp('issue-2502-cancel-');
	createdDirs.push(dir);
	if (config) {
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
			'utf-8',
		);
	}
	return dir;
}

async function primeSubscription(dir: string): Promise<void> {
	await subscribe(dir, {
		sessionID: SESSION,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: PR_URL,
	});
	await updateSnapshot(dir, CORRELATION, { headRefOid: HEAD });
}

async function enqueueEvent(
	dir: string,
	overrides: { type?: string; dedupToken?: string } = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: PR_URL,
		headRefOid: HEAD,
		message: 'ci check failed',
		dedupToken: 'tok-1',
		authorized: true,
		queuedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	});
}

/** Install the happy-path seams; returns the performer mock. */
function installLoopSeams(): ReturnType<typeof mock> {
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

/**
 * Resolve when the notify path durably records the targeted terminal state.
 * The test timeout remains the bounded failure path; successful synchronization
 * uses this write-state seam instead of wall-clock polling.
 */
function installSettlementSignal(directory: string): Promise<boolean> {
	let resolveSettlement!: (settled: boolean) => void;
	const settlementObserved = new Promise<boolean>((resolve) => {
		resolveSettlement = resolve;
	});
	loopInternals.writeState = async (writeDirectory, state) => {
		await loopInternalsOriginals.writeState(writeDirectory, state);
		if (
			writeDirectory === directory &&
			(state as LoopStateFile).correlations?.[CORRELATION]?.terminal?.state ===
				'completed'
		) {
			resolveSettlement(true);
		}
	};
	return settlementObserved;
}

function readLoopStateFile(dir: string): LoopStateFile {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf-8'),
	) as LoopStateFile;
}

/** Seed a settled correlation directly in the durable loop state file. */
function seedSettledCorrelation(dir: string): void {
	const file = path.join(dir, PR_FEEDBACK_LOOP_STATE_REL);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				schemaVersion: 1,
				updatedAt: '2026-09-01T00:00:00.000Z',
				oversightSeq: 0,
				correlations: {
					[CORRELATION]: {
						sessionID: SESSION,
						repoFullName: REPO,
						prNumber: PR,
						prActionsUsed: 1,
						processedDigests: [],
						circuit: { failures: 0, openUntil: 0, halfOpenProbes: 0 },
						inFlight: null,
						terminal: {
							state: 'completed',
							reason: 'seeded settled correlation',
						},
					},
				},
				sessionTerminals: {},
			},
			null,
			2,
		),
		'utf-8',
	);
}

function readCancelReceipts(dir: string): CancelReceipt[] {
	const cleanupDir = path.join(dir, '.swarm', 'pr-feedback-loop-cleanups');
	if (!fs.existsSync(cleanupDir)) return [];
	return fs
		.readdirSync(cleanupDir)
		.filter((name) => name.endsWith('.json'))
		.map(
			(name) =>
				JSON.parse(
					fs.readFileSync(path.join(cleanupDir, name), 'utf-8'),
				) as CancelReceipt,
		);
}

describe('issue #2502 cancelPrFeedbackLoop', () => {
	test('operator stop clears queued + claimed events with a receipt and is idempotent', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		seedSettledCorrelation(dir);
		await enqueueEvent(dir, { dedupToken: 'tok-a' });
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-b',
		});
		// One event claimed by an earlier workflow instance (the idle hook's
		// claim); a claim alone never settles or removes it.
		const claimed = await claimPrFeedbackMonitorEvents(
			dir,
			SESSION,
			'wf-x',
			PR_URL,
			['tok-a'],
		);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.dedupToken).toBe('tok-a');

		const result = await cancelPrFeedbackLoop(dir, SESSION, CANCEL_REASON);

		expect(result.terminalState).toBe('cancelled');
		expect(result.reason).toBe(CANCEL_REASON);
		const state = readLoopStateFile(dir);
		expect(state.sessionTerminals?.[SESSION]?.state).toBe('cancelled');
		expect(state.correlations?.[CORRELATION]?.terminal?.state).toBe(
			'cancelled',
		);
		const queue = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queue?.events ?? []).toHaveLength(0);
		const receipts = readCancelReceipts(dir);
		expect(receipts.length).toBeGreaterThanOrEqual(1);
		const full = receipts.filter(
			(r) =>
				(r.clearedEvents ?? []).includes('tok-a') &&
				(r.clearedEvents ?? []).includes('tok-b'),
		);
		expect(full).toHaveLength(1);
		expect(full[0]?.sessionID).toBe(SESSION);
		expect(full[0]?.reason).toBe(CANCEL_REASON);

		// Idempotent re-cancel: same terminal, queue stays empty, and no
		// receipt duplicates the cleared tokens. (Sleep > 1ms so the second
		// receipt's ms-precision stamp differs from the first.)
		await new Promise((resolve) => setTimeout(resolve, 5));
		const again = await cancelPrFeedbackLoop(dir, SESSION, CANCEL_REASON);
		expect(again.terminalState).toBe('cancelled');
		expect(again.reason).toBe(CANCEL_REASON);
		const queueAfter = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queueAfter?.events ?? []).toHaveLength(0);
		const receiptsAfter = readCancelReceipts(dir);
		expect(
			receiptsAfter.filter((r) => (r.clearedEvents ?? []).includes('tok-a')),
		).toHaveLength(1);
	});
});

describe('issue #2502 clearPrFeedbackMonitorEvents', () => {
	test('clears exactly the selected token and advances the revision', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		let queue = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queue?.revision).toBe(2);

		const removed = await clearPrFeedbackMonitorEvents(dir, SESSION, ['tok-1']);

		expect(removed).toEqual(['tok-1']);
		queue = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queue?.events.map((e) => e.dedupToken)).toEqual(['tok-2']);
		expect(queue?.revision).toBe(3);
	});

	test('empty token list is a no-op', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		const before = await readPrFeedbackMonitorQueue(dir, SESSION);

		const removed = await clearPrFeedbackMonitorEvents(dir, SESSION, []);

		expect(removed).toEqual([]);
		const after = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(after?.revision).toBe(before?.revision);
		expect(after?.events).toHaveLength(2);
	});
});

describe('issue #2502 notify wiring', () => {
	test(
		'notifyPrFeedbackLoop settles a queued event when the loop is enabled',
		{ timeout: 10_000 },
		async () => {
			const dir = makeProject();
			await primeSubscription(dir);
			installLoopSeams();
			await enqueueEvent(dir);
			const settlementObserved = installSettlementSignal(dir);

			// Fire-and-forget: the call returns immediately. The write-state seam
			// signals the targeted durable completion without polling.
			notifyPrFeedbackLoop(dir, SESSION);
			expect(await settlementObserved).toBe(true);
		},
	);

	test('notifyPrFeedbackLoop performs nothing when the loop is disabled', async () => {
		const dir = makeProject(null);
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir);

		await notifyPrFeedbackLoop(dir, SESSION);

		expect(fs.existsSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL))).toBe(
			false,
		);
		expect(performer).not.toHaveBeenCalled();
		const queue = await readPrFeedbackMonitorQueue(dir, SESSION);
		expect(queue?.events[0]?.dedupToken).toBe('tok-1');
		expect(queue?.events[0]?.claimedWorkflowInstanceId).toBeUndefined();
	});
});
