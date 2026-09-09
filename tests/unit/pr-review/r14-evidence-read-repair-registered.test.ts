/**
 * Issue #2585 (Roadmap H8) — C9 / AC5 / R14 CONTROLLED-FAILURE registered
 * fixture: an uncertain evidence read for one dimension is reported UNKNOWN,
 * blocks completion (never counted as zero work), and the bounded repair path
 * ends in recovery or a typed INCOMPLETE with the disclosed reason.
 *
 * Scenario (registered host, real plugin boot, real production store writers):
 * 1. One base dimension is dispatched through `dispatch_lanes_async` on the
 *    registered host (a real host session launch, a real pending delegation in
 *    the SQLite coordination authority).
 * 2. CONTROLLED FAILURE: the dimension's coordination row is torn on disk
 *    (status column no longer matches the payload's authority binding), so the
 *    authoritative store read stays uncertain after its bounded retry.
 * 3. Unknown, not zero work: `derivePrReviewDimensionSettlement` fails CLOSED,
 *    the registered `complete_pr_workflow` refuses with the typed unreadable
 *    reason (open lanes are UNKNOWN, not absent), the gate stays active, the
 *    typed completion lookup reports `source: 'uncertain'`, and
 *    `pr_workflow_status` discloses the uncertain read with a repair next step.
 * 4. Bounded repair within the FROZEN LIMITS (tests/helpers/pr-review-frozen-
 *    limits.ts): a measured attempt loop heals the store, lets the still-live
 *    lane settle past the staleness horizon (typed 'liveness' — the #2615
 *    producer), and completes as a FORCED INCOMPLETE whose terminal report
 *    discloses every unresolved dimension with its typed reason.
 *
 * No mock.module. Gate/dispatch seams restored in afterEach.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	findByCorrelationId,
	findDelegationForCompletion,
	readDelegationsDetailed,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { derivePrReviewDimensionSettlement } from '../../../src/pr-review/completion.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	MAX_EVIDENCE_REPAIR_ATTEMPTS,
	MAX_EVIDENCE_REPAIR_HOST_LAUNCHES,
	MAX_EVIDENCE_REPAIR_WALL_CLOCK_MS,
} from '../../helpers/pr-review-frozen-limits.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION_ID = 'ses_r14_controller';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_PREFIX = 'r14-evidence-repair';
const DIMENSION = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
/** 30-minute stale-lane horizon + one minute (DEFAULT_STALE_DELEGATION_TIMEOUT_MS). */
const HORIZON_ADVANCE_MS = 31 * 60_000;
const FIXED_NOW = 1_800_000_000_000;
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
 * Bounded recursive cleanup. On Windows, a closing SQLite handle or a
 * just-killed git child can hold the temp directory for a few milliseconds;
 * retry a bounded number of times instead of failing the suite on the race.
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

async function complete(): Promise<
	ReturnType<typeof parsed> & {
		message?: string;
		terminal_report?: Record<string, unknown>;
	}
> {
	return parsed(
		await plugin.tool.complete_pr_workflow.execute(
			{
				mode: 'PR_REVIEW',
				pr_head_sha: HEAD_SHA,
				report_verdict: 'INCOMPLETE',
			},
			{ directory, sessionID: SESSION_ID },
		),
	) as ReturnType<typeof complete>;
}

/**
 * Private coordination namespace of the delegation store
 * (`DELEGATION_COORDINATION_NAMESPACE` in src/background/pending-delegations.ts
 * — module-private, so pinned here as a literal). The test's own uncertainty
 * assertion guards the literal: if the namespace ever changes, the tear below
 * stops matching any row, the read stays healthy, and this fixture FAILS
 * instead of silently passing.
 */
const DELEGATION_COORDINATION_NAMESPACE = 'background.pending-delegation';

/**
 * CONTROLLED FAILURE: tear the dimension's coordination row so the payload's
 * authority binding no longer matches the row — the exact corruption class the
 * reader's schema/binding validation rejects as uncertainty (never as "no
 * record"). Restoring the payload's own status heals the row.
 */
function tearDimensionRow(childSessionId: string): void {
	getProjectDb(directory).run(
		`UPDATE coordination_state
		 SET status = 'r14-torn-evidence-read'
		 WHERE namespace = ? AND entity_key = ?`,
		[DELEGATION_COORDINATION_NAMESPACE, childSessionId],
	);
}

function healDimensionRow(childSessionId: string): void {
	const db = getProjectDb(directory);
	const row = db
		.query<{ payload: string }, [string, string]>(
			`SELECT payload FROM coordination_state
			 WHERE namespace = ? AND entity_key = ?`,
		)
		.get(DELEGATION_COORDINATION_NAMESPACE, childSessionId);
	if (!row) throw new Error('torn coordination row disappeared');
	const recordedStatus = (JSON.parse(row.payload) as { status: string }).status;
	db.run(
		`UPDATE coordination_state
		 SET status = ?
		 WHERE namespace = ? AND entity_key = ?`,
		[recordedStatus, DELEGATION_COORDINATION_NAMESPACE, childSessionId],
	);
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
	// No host session ops: the presumed-stale settlement probe must not wait.
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

describe('R14 uncertain evidence read — unknown, never zero work (registered, issue #2585 C9)', () => {
	test('controlled failure and bounded repair end in a typed INCOMPLETE with disclosed reasons', async () => {
		const startedAt = performance.now();
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
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
		const childSessionId = `${RUN_PREFIX}-child-1`;
		expect(findByCorrelationId(directory, childSessionId)?.workflowLane).toBe(
			DIMENSION,
		);

		// --- Controlled failure: the dimension's evidence read becomes uncertain.
		tearDimensionRow(childSessionId);
		expect(readDelegationsDetailed(directory).status).toBe('uncertain');
		const typedLookup = await findDelegationForCompletion(
			directory,
			childSessionId,
		);
		expect(typedLookup?.source).toBe('uncertain');
		expect(typedLookup?.uncertain).toMatch(/unreadable after 2 attempts/);

		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prHeadSha).toBe(HEAD_SHA);
		// Settlement fails CLOSED: the dimension is never relabeled NOT_LAUNCHED
		// and never counted as zero work.
		expect(() =>
			derivePrReviewDimensionSettlement(directory, state!, REVISION_DIGEST),
		).toThrow(/delegation store is unreadable/i);

		const refused = await complete();
		expect(refused.success).toBe(false);
		expect(String(refused.message)).toMatch(
			/completion refused while the delegation store is unreadable after 2 attempts/i,
		);
		expect(String(refused.message)).toContain('UNKNOWN, not absent');
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();

		const statusDuringUncertainty = parsed(
			await plugin.tool.pr_workflow_status.execute(
				{},
				{ directory, sessionID: SESSION_ID },
			),
		) as { recovery: { delegationRead: { state: string }; nextStep: string } };
		expect(statusDuringUncertainty.recovery.delegationRead.state).toBe(
			'uncertain',
		);
		expect(statusDuringUncertainty.recovery.nextStep).toMatch(
			/^Delegation store read is uncertain: repair the store/,
		);

		// --- Bounded repair loop, measured against the frozen ceilings.
		let attempts = 0;
		let outcome = refused;
		while (attempts < MAX_EVIDENCE_REPAIR_ATTEMPTS) {
			attempts += 1;
			const message = String(outcome.message);
			if (/delegation store is unreadable/i.test(message)) {
				// Repair action: heal the torn row, then re-run completion.
				healDimensionRow(childSessionId);
				outcome = await complete();
				continue;
			}
			if (/still has live lanes|unsettled PR workflow lane/i.test(message)) {
				// Store is readable again; the dispatched lane is genuinely live.
				// Let it settle past the staleness horizon (typed liveness), then
				// re-run completion — a sequential freeze cycle, never nested.
				restoreClock?.();
				restoreClock = freezeClock({
					fixedNow: FIXED_NOW + HORIZON_ADVANCE_MS,
				});
				outcome = await complete();
				continue;
			}
			break;
		}

		// Frozen-limit assertions (AC12): measured totals within the ceilings.
		expect(attempts).toBeLessThanOrEqual(MAX_EVIDENCE_REPAIR_ATTEMPTS);
		expect(hostLaunches).toBeLessThanOrEqual(MAX_EVIDENCE_REPAIR_HOST_LAUNCHES);
		const wallClockMs = performance.now() - startedAt;
		expect(wallClockMs).toBeLessThanOrEqual(MAX_EVIDENCE_REPAIR_WALL_CLOCK_MS);

		// Recovery or typed INCOMPLETE — here: forced INCOMPLETE (NO_COVERAGE)
		// with every unresolved dimension disclosed and typed.
		expect(attempts).toBe(3);
		expect(outcome.success).toBe(true);
		expect(outcome).toMatchObject({
			status: 'completed',
			gate_cleared: true,
			checkout_restore_required: false,
		});
		const terminalReport = outcome.terminal_report as {
			kind: string;
			covered_dimensions: string[];
			unresolved_dimensions: Array<{
				dimension: string;
				terminal_state: string;
				reason_kind: string;
				failure_class?: string;
			}>;
			live_dimensions: string[];
			allowed_verdicts: string[];
			report_verdict: string;
		};
		expect(terminalReport.kind).toBe('NO_COVERAGE');
		expect(terminalReport.covered_dimensions).toEqual([]);
		expect(terminalReport.live_dimensions).toEqual([]);
		expect(terminalReport.allowed_verdicts).toEqual(['INCOMPLETE']);
		expect(terminalReport.report_verdict).toBe('INCOMPLETE');
		const torn = terminalReport.unresolved_dimensions.find(
			(entry) => entry.dimension === DIMENSION,
		);
		expect(torn).toEqual({
			dimension: DIMENSION,
			terminal_state: 'FAILED',
			reason_kind: 'lane_failure',
			failure_class: 'liveness',
		});
		// Every dispatched dimension settles as a typed liveness failure — none
		// is ever labeled NOT_LAUNCHED or counted as zero work.
		expect(terminalReport.unresolved_dimensions).toHaveLength(
			PR_REVIEW_BASE_DIMENSION_IDS.length,
		);
		for (const entry of terminalReport.unresolved_dimensions) {
			expect(entry.terminal_state).toBe('FAILED');
			expect(entry.reason_kind).toBe('lane_failure');
			expect(entry.failure_class).toBe('liveness');
		}
		// The settled lane carries the typed liveness failure class durably.
		expect(
			findByCorrelationId(directory, childSessionId)?.result
				?.workflowLaneFailureClass,
		).toBe('liveness');
		// The gate cleared: the repair path is terminal, not wedged.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});
});
