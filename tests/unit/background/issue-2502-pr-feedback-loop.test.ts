/**
 * Issue #2502 — PR feedback settling loop: claim → classify → authorize →
 * oversight → act → settle (the completion-fixture unit).
 *
 * Covers the disabled no-op, queue-empty, full settle (M4 completion-scope
 * terminal reason), idempotent replay, stale/foreign/unsupported/ambiguous
 * refusals, corrupt-state cancellation, the per-PR budget pause, and
 * interrupted-settlement restoration. Circuit failure and recovery cases are
 * in issue-2502-pr-feedback-loop-circuit.test.ts.
 *
 * Isolation notes:
 * - NO mock.module: the loop's own `_internals` seam injects head evaluation,
 *   oversight dispatch, and the authorized-action performer. ALL overrides are
 *   restored in afterEach (originals captured at module top, Object.assign
 *   back). readState/writeState/now keep their real implementations here.
 * - XDG_CONFIG_HOME is redirected to an empty temp dir for the whole file so
 *   loadPluginConfig's USER-config read cannot flip the triple gate on a
 *   machine whose ~/.config/opencode/opencode-swarm.json already sets
 *   pr_monitor.enabled + auto_pr_feedback (deterministic disabled paths).
 * - The seeded subscription is a REAL pr-subscriptions record (subscribe +
 *   updateSnapshot headRefOid 'h1') in a canonicalMkdtemp project root, so the
 *   loop's listActive foreign/stale checks run against the real store.
 *
 * Mock coverage note (per writing-tests SKILL.md): dispatchOversight is mocked
 * to the allow outcome only. Untested branches: oversight deny / pending /
 * dispatch-failure pauses — not part of the #2502 unit list pinned here.
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
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
} from '../../../src/background/pr-feedback-loop.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	CORRELATION,
	makeProject as createProject,
	ENABLED_CONFIG,
	enqueueEvent,
	HEAD,
	installLoopSeams,
	type LoopStateFile,
	loopInternals,
	PR_FEEDBACK_LOOP_STATE_REL,
	primeSubscription,
	readLoopStateFile,
	SESSION,
} from '../../../tests/helpers/issue-2502-pr-feedback-loop-fixtures';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import { acquireProcessEnvLease } from '../../../tests/helpers/process-env-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

// Captured at module top; restored into the seam in afterEach.
const loopInternalsOriginals = { ...loopInternals };
const savedXdg = process.env.XDG_CONFIG_HOME;
let xdgIsolationDir = '';
const createdDirs: string[] = [];
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;
let releaseProcessEnv: (() => void) | null = null;

function makeProject(config: Record<string, unknown> | null = ENABLED_CONFIG) {
	return createProject(createdDirs, config);
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

describe('issue #2502 pr-feedback-loop settle pipeline', () => {
	test('disabled without a config file: no-op with authorization disabled', async () => {
		const dir = makeProject(null);
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.ran).toBe(false);
		expect(result.reason).toMatch(/disabled/);
		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/disabled/);
		expect(performer).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL))).toBe(
			false,
		);
	});

	test('enabled with an empty queue: queue-empty no-op', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		installLoopSeams();

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.ran).toBe(false);
		expect(result.reason).toBe('queue-empty');
		expect(result.terminal).toBeNull();
	});

	describe('FB-040 regression: truthful completion wording', () => {
		test('full settle: authorized action performed + recorded + single wake', async () => {
			const dir = makeProject();
			await primeSubscription(dir);
			const performer = installLoopSeams();
			await enqueueEvent(dir);

			const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

			expect(result.ran).toBe(true);
			expect(result.authorization?.authorized).toBe(true);
			expect(result.action).toMatchObject({ kind: 'fix_ci', performed: true });
			expect(performer).toHaveBeenCalledTimes(1);
			expect(result.terminal?.state).toBe('completed');
			// FB-040: completion records the authorized workflow action only; it must
			// not claim acceptance by a prompt/advisory delivery channel.
			expect(result.terminal?.reason).toMatch(
				/authorized PR workflow action performed and recorded/i,
			);
			expect(result.terminal?.reason).not.toMatch(
				/accepted by .*?(prompt|advisory).*channel/i,
			);
			const state = readLoopStateFile(dir);
			expect(state.correlations?.[CORRELATION]?.terminal?.state).toBe(
				'completed',
			);
			expect(result.authorization?.budget?.prActionsUsed).toBe(1);
		});
	});

	test('idempotency: re-enqueued dedup token replays without re-performing', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const replay = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(replay.authorization?.replay).toBe(true);
		expect(replay.authorization?.authorized).toBe(false);
		expect(performer).toHaveBeenCalledTimes(1);
		expect(replay.terminal).toEqual(first.terminal);
	});

	test('stale head: event head must match the freshly evaluated head', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams({ head: 'h2' }); // subscription says 'h1'
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.stale).toBe(false);
		expect(result.authorization?.reason).toMatch(
			/snapshot synchronization|retryable/,
		);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();
	});

	test('foreign event: no matching subscription correlation is refused', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, {
			repoFullName: 'other/repo',
			prNumber: 7,
			prUrl: 'https://github.com/other/repo/pull/7',
			dedupToken: 'tok-foreign',
		});

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.foreign).toBe(true);
		expect(result.authorization?.reason).toMatch(/foreign/);
		expect(result.action?.performed).toBe(false);
		expect(performer).not.toHaveBeenCalled();
	});

	test('unsupported event type: refused terminal, no action', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { type: 'pr.merged', dedupToken: 'tok-merged' });

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.classification?.supported).toBe(false);
		expect(result.classification?.reason).toMatch(/unsupported/);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal?.state).toBe('refused');
		expect(performer).not.toHaveBeenCalled();
	});

	test('ambiguous head evaluation: remains pending, no write-class action', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams({ head: null });
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.classification?.ambiguous).toBe(true);
		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/ambiguous/);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();
	});

	test('cancellation refuses corrupt state without overwriting the queue', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		await enqueueEvent(dir);
		loopInternals.readState = mock(async () => ({
			corrupt: true,
		})) as unknown as typeof loopInternals.readState;

		const result = await cancelPrFeedbackLoop(dir, SESSION, 'operator stop');

		expect(result.terminalState).toBe('paused_for_human');
		expect(result.reason).toMatch(/could not be durably recorded/);
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]?.dedupToken,
		).toBe('tok-1');
	});

	test('budget: max_actions_per_pr 1 pauses the second event for a human', async () => {
		const dir = makeProject({
			pr_monitor: { enabled: true, auto_pr_feedback: true },
			pr_feedback_loop: { enabled: true, max_actions_per_pr: 1 },
		});
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		// Different action class (pr.merge.conflict) -> a distinct digest, so
		// this is a NEW event, not a replay of tok-1.
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		const second = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(second.terminal?.state).toBe('paused_for_human');
		expect(second.terminal?.reason).toMatch(/budget/);
		expect(second.authorization?.budget?.exhausted).toBe(true);
		expect(performer).toHaveBeenCalledTimes(1);
	});

	test('restoration: stripped terminal is re-recorded without re-performing', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		// Simulate an interrupted settlement: digest persisted, terminal lost.
		const statePath = path.join(dir, PR_FEEDBACK_LOOP_STATE_REL);
		const raw = readLoopStateFile(dir) as Record<string, unknown> &
			LoopStateFile;
		const correlation = raw.correlations?.[CORRELATION] as Record<
			string,
			unknown
		>;
		delete correlation.terminal;
		delete correlation.inFlight;
		fs.writeFileSync(statePath, JSON.stringify(raw, null, 2), 'utf-8');

		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const restored = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(restored.terminal?.state).toBe('completed');
		expect(restored.terminal?.reason).toMatch(/restored after interruption/i);
		expect(restored.authorization?.replay).toBe(true);
		expect(performer).toHaveBeenCalledTimes(1);
	});
});
