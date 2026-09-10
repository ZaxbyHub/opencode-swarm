/**
 * Issue #2585 (Roadmap H8) — C10 / AC6 / R12 CONTROLLED-FAILURE registered
 * fixture: an ordinary PR_REVIEW recovery abort settles the intended state
 * under live-lane rules, RETURNS restoration receipts, stops the wakes, and
 * types every settled lane as 'liveness' — all within the FROZEN LIMITS.
 *
 * Scenario (registered host, real plugin boot, real git checkout):
 * 1. A real repository with a committed tracked change; the workflow is
 *    activated unbound, the dirty change is preserved through the REAL
 *    `prepare_pr_workflow_checkout` (a real git stash + durable receipt), and
 *    the PR head is bound.
 * 2. All six base dimensions dispatch through `dispatch_lanes_async` on the
 *    registered host (six real host session launches) and stay pending.
 * 3. Live-lane rule: a recovery abort while the lanes are FRESH is refused and
 *    names the in-flight lanes.
 * 4. Past the staleness horizon, the recovery abort settles the intended
 *    state: gate cleared, `checkout_restore_required: true` with REAL
 *    `checkout_restore_receipts` (the stash from step 1, present), every lane
 *    presumed-stale with the typed 'liveness' failure class.
 * 5. Wakes stop: the production recovery scan (`scanDelegationsForRecovery`,
 *    the same predicate `prepare_pr_workflow_checkout` uses to refuse a new
 *    checkout) finds ZERO pending/running `swarm-pr-*` lanes for the session.
 * 6. Measured totals (abort attempts, host launches, wall clock) are asserted
 *    against the frozen ceilings (tests/helpers/pr-review-frozen-limits.ts).
 *
 * No mock.module. Gate/dispatch seams restored in afterEach.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	findByCorrelationId,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrWorkflowHead,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	MAX_ABORT_RECOVERY_ATTEMPTS,
	MAX_ABORT_RECOVERY_HOST_LAUNCHES,
	MAX_ABORT_RECOVERY_WALL_CLOCK_MS,
} from '../../helpers/pr-review-frozen-limits.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION_ID = 'ses_r12_controller';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_PREFIX = 'r12-abort-recovery';
/** 30-minute stale-lane horizon + one minute (DEFAULT_STALE_DELEGATION_TIMEOUT_MS). */
const HORIZON_ADVANCE_MS = 31 * 60_000;
const FIXED_NOW = 1_800_000_000_000;
const GIT_TIMEOUT_MS = 30_000;
const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	revisionDetailed: gateInternals.resolvePrWorkflowRevisionDigestDetailed,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	sessionOps: gateInternals.getSessionOps,
	dispatchRevision: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	dispatchBase: dispatchInternals.resolveExactMergeBaseAsync,
	dispatchConfig: dispatchInternals.loadPluginConfig,
	agents: dispatchInternals.getGeneratedAgentNames,
};

let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let restoreClock: (() => void) | null = null;
let nextChild = 0;
let hostLaunches = 0;

function parsed(
	value: unknown,
): Record<string, unknown> & { success: boolean } {
	return JSON.parse(String(value)) as Record<string, unknown> & {
		success: boolean;
	};
}

/**
 * Bounded recursive cleanup. On Windows, a just-killed git child or a closing
 * SQLite handle can hold the temp directory for a few milliseconds; retry a
 * bounded number of times instead of failing the suite on the race.
 */
async function removeTempDir(): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 4) {
				throw error;
			}
			await Bun.sleep(100);
		}
	}
}

/** Bounded, non-interactive git for the real-repository fixture (AGENTS.md #3). */
async function expectGitSuccess(args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
		return stdout;
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort; git may already have exited.
		}
	}
}

async function abort(): Promise<
	ReturnType<typeof parsed> & {
		message?: string;
		open_lanes?: number;
		presumed_stale_lanes?: string[];
		gate_cleared?: boolean;
		checkout_restore_required?: boolean;
		checkout_restore_receipts?: Array<{
			stash_oid: string;
			stash_present: boolean | null;
		}>;
	}
> {
	return parsed(
		await plugin.tool.abort_pr_workflow.execute(
			{
				mode: 'PR_REVIEW',
				kind: 'recovery',
				reason: 'lanes wedged past every bounded recovery attempt',
			},
			{ directory, sessionID: SESSION_ID },
		),
	) as ReturnType<typeof abort>;
}

beforeEach(async () => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp(`${RUN_PREFIX}-`);
	await initializeGitRepository(directory);
	nextChild = 0;
	hostLaunches = 0;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => ({
		ok: true,
		digest: REVISION_DIGEST,
	});
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	// No host session ops: the settlement probe must not wait on a real host.
	gateInternals.getSessionOps = () => null;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchInternals.loadPluginConfig = () => ({
		pr_review_resilience: {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: false,
		},
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => {
				hostLaunches += 1;
				return `${RUN_PREFIX}-child-${++nextChild}`;
			},
			onPrompt: () => {},
		}),
	);
	// A real baseline commit (the plugin's own .opencode config rides along;
	// .swarm/ is git-excluded), then a real dirty tracked change to preserve.
	await fs.writeFile(path.join(directory, 'user-notes.txt'), 'base\n', 'utf-8');
	await expectGitSuccess([
		'-c',
		'user.email=r12@example.com',
		'-c',
		'user.name=R12 Fixture',
		'add',
		'--',
		'user-notes.txt',
		'.opencode',
	]);
	await expectGitSuccess([
		'-c',
		'user.email=r12@example.com',
		'-c',
		'user.name=R12 Fixture',
		'commit',
		'-m',
		'baseline',
	]);
	await fs.writeFile(
		path.join(directory, 'user-notes.txt'),
		'preserved user change\n',
		'utf-8',
	);
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = ORIGINALS.head;
	gateInternals.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed =
		ORIGINALS.revisionDetailed;
	gateInternals.resolveIsWorkingTreeClean = ORIGINALS.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	gateInternals.resolvePrReviewDiffStats = ORIGINALS.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = ORIGINALS.diffStatsAsync;
	gateInternals.getSessionOps = ORIGINALS.sessionOps;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		ORIGINALS.dispatchRevision;
	dispatchInternals.resolveExactMergeBaseAsync = ORIGINALS.dispatchBase;
	dispatchInternals.loadPluginConfig = ORIGINALS.dispatchConfig;
	dispatchInternals.getGeneratedAgentNames = ORIGINALS.agents;
	closeAllProjectDbs();
	await removeTempDir();
	restoreClock?.();
});

describe('R12 abort recovery — settles, returns receipts, stops wakes (registered, issue #2585 C10)', () => {
	test('ordinary recovery abort over stale lanes clears the gate with restoration receipts and typed liveness', async () => {
		const startedAt = performance.now();

		// Unbound activation -> REAL checkout preservation -> bind the PR head.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		// prepare requires the EXACT dirty tracked set; the plugin may or may
		// not rewrite its committed config during this boot, so derive the set
		// from the real porcelain status instead of guessing its membership.
		const porcelain = await expectGitSuccess([
			'status',
			'--porcelain=v1',
			'--untracked-files=all',
		]);
		const dirtyPaths = porcelain
			.split('\n')
			.map((line) => line.replace(/\r$/, ''))
			.filter((line) => line.length >= 4)
			.filter((line) => !line.startsWith('??'))
			.map((line) => line.slice(3).trim())
			.filter((line) => line.length > 0);
		expect(dirtyPaths).toContain('user-notes.txt');
		const prepare = parsed(
			await plugin.tool.prepare_pr_workflow_checkout.execute(
				{ paths: dirtyPaths },
				{ directory, sessionID: SESSION_ID },
			),
		);
		expect(prepare.success).toBe(true);
		const stashOid = String(prepare.stash_oid);
		expect(stashOid).toMatch(/^[0-9a-f]{40,64}$/i);
		await bindPrWorkflowHead(directory, SESSION_ID, HEAD_SHA);

		// All six base dimensions dispatched through the registered host.
		const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((dimension) => ({
			id: `${RUN_PREFIX}-lane-${dimension}`,
			agent: 'explorer',
			prompt: `Review ${dimension} on the exact bound diff.`,
			workflow_lane: dimension,
		}));
		const dispatch = parsed(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: `${RUN_PREFIX}-base`,
					mode: 'swarm-pr-review:base',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					lanes,
				},
				{ directory, sessionID: SESSION_ID },
			),
		);
		expect(dispatch).toMatchObject({ success: true, pending: lanes.length });
		const childIds = lanes.map(
			(_lane, index) => `${RUN_PREFIX}-child-${index + 1}`,
		);
		const laneIds = lanes.map((lane) => lane.id);
		for (const childId of childIds) {
			const record = findByCorrelationId(directory, childId);
			// The registered host accepted promptAsync: the lanes are live.
			expect(['pending', 'running']).toContain(record?.status);
			expect(record?.mode).toBe('swarm-pr-review:base');
		}

		let abortAttempts = 0;

		// --- Live-lane rule: a FRESH in-flight lane still blocks the abort.
		const refused = await abort();
		abortAttempts += 1;
		expect(refused.success).toBe(false);
		expect(String(refused.message)).toMatch(
			/abort refused while \d+ PR workflow lane\(s\) are still in flight/i,
		);
		expect(String(refused.message)).toContain(laneIds[0]!);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();

		// --- Past the staleness horizon the recovery abort settles the state.
		restoreClock?.();
		restoreClock = freezeClock({ fixedNow: FIXED_NOW + HORIZON_ADVANCE_MS });
		const settled = await abort();
		abortAttempts += 1;

		// Frozen-limit assertions (AC12): measured totals within the ceilings.
		expect(abortAttempts).toBeLessThanOrEqual(MAX_ABORT_RECOVERY_ATTEMPTS);
		expect(hostLaunches).toBeLessThanOrEqual(MAX_ABORT_RECOVERY_HOST_LAUNCHES);
		const wallClockMs = performance.now() - startedAt;
		expect(wallClockMs).toBeLessThanOrEqual(MAX_ABORT_RECOVERY_WALL_CLOCK_MS);

		expect(abortAttempts).toBe(2);
		expect(settled).toMatchObject({
			success: true,
			mode: 'PR_REVIEW',
			pr_head_sha: HEAD_SHA,
			open_lanes: 0,
			gate_cleared: true,
		});
		// The presumed-stale settlement is disclosed on the tool surface.
		expect(settled.presumed_stale_lanes?.sort()).toEqual([...laneIds].sort());
		// Restoration receipts: the REAL preserved change from prepare, present.
		expect(settled.checkout_restore_required).toBe(true);
		expect(settled.checkout_restore_receipts).toEqual([
			{ stash_oid: stashOid, stash_present: true },
		]);

		// Wakes stop: the production recovery scan (the same predicate
		// prepare_pr_workflow_checkout uses) finds zero open PR lanes.
		const scan = scanDelegationsForRecovery(directory);
		expect(scan.status).toBe('ok');
		if (scan.status !== 'ok') throw new Error('unreachable');
		const stillOpen = scan.owners.filter(
			(record) =>
				record.parentSessionId === SESSION_ID &&
				typeof record.mode === 'string' &&
				record.mode.startsWith('swarm-pr-') &&
				(record.status === 'pending' || record.status === 'running'),
		);
		expect(stillOpen).toEqual([]);

		// Settled lanes carry the typed 'liveness' terminal class (#2615 shape).
		for (const childId of childIds) {
			const record = findByCorrelationId(directory, childId);
			expect(record?.status).toBe('stale');
			expect(record?.result?.workflowLaneFailureClass).toBe('liveness');
		}

		// The intended state is settled: the durable gate is gone and the abort
		// is on the audit trail.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
		const events = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
		)
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const aborted = events.find(
			(event) =>
				event.type === 'pr_workflow_aborted' && event.sessionID === SESSION_ID,
		);
		expect(aborted).toMatchObject({
			mode: 'PR_REVIEW',
			kind: 'recovery',
			openLanes: 0,
		});
	});
});
