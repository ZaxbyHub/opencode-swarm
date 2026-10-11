/**
 * Issue #3095 — fix-PR details coverage, part 1 (F8 uncovered-branch
 * register): the candidate-inventory arms, the boundaries section, the
 * degradation contract, and the projection-absence branches. These are
 * ADDITIONAL assertions on top of the frozen acceptance suite; they pin the
 * inventory container directly because the frozen C3 smallest-subtree search
 * cannot discriminate it from the lanes subtree in the large run (plan N2 /
 * R3-2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewArtifactBoundary,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import type { ToolResult } from '../../../src/tools/create-tool.js';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const realReadGate = _internals.readPrWorkflowGateStateForRecovery;
const realInventory = _internals.readPrReviewCandidateInventoryForStatus;
const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;
const realClassify = _internals.classifyGitState;

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	_internals.resolveCurrentGitHeadAsync = async () => 'a'.repeat(40);
	_internals.resolveIsWorkingTreeCleanAsync = async () => true;
	_internals.classifyGitState = async () =>
		({ kind: 'clean' }) as unknown as Awaited<ReturnType<typeof realClassify>>;
	_internals.runGitCapture = async (_d: string, args: string[]) =>
		({ 'rev-parse': 'HEAD\n', status: '', remote: '' })[args[0] ?? ''] ?? null;
});

afterEach(async () => {
	_internals.readPrWorkflowGateStateForRecovery = realReadGate;
	_internals.readPrReviewCandidateInventoryForStatus = realInventory;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassify;
	await teardownPrWorkflowGateFixtures();
});

const statusExecute = (
	pr_workflow_status as unknown as {
		execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
	}
).execute;

async function runStatus(
	sessionID: string = SESSION_ID,
): Promise<Record<string, unknown>> {
	const result = await statusExecute({}, {
		directory: tempDir,
		sessionID,
	} as unknown as ToolContext);
	const text =
		typeof result === 'string' ? result : (result as ToolResult).output;
	return JSON.parse(text as string) as Record<string, unknown>;
}

type Projection = {
	candidateInventory: {
		state: string;
		inventory?: string[];
		total?: number;
		truncated?: boolean;
		truncationNote?: string | null;
		reason?: string;
	};
	boundaries: {
		boundaries: Array<{ boundary: string; status: string }>;
		checkpoint: { runId: string | null; findingsPath: string | null } | null;
		checkpointScope: string;
	};
};

async function runProjection(
	sessionID: string = SESSION_ID,
): Promise<Projection> {
	const gate = (await runStatus(sessionID)).gate as Record<string, unknown>;
	return gate.reviewProjection as unknown as Projection;
}

describe('candidate inventory arms', () => {
	test('F3: an unavailable read degrades to a bounded arm — never a throw, never an empty-array fail-open', async () => {
		await establishReviewPrerequisites();
		// Seam-level: the executor maps the accessor union faithfully.
		_internals.readPrReviewCandidateInventoryForStatus = async () => ({
			state: 'unavailable' as const,
			reason: 'fixture-forced unavailable read',
		});
		let gate = (await runStatus()).gate as Record<string, unknown>;
		let arm = (gate.reviewProjection as unknown as Projection)
			.candidateInventory;
		expect(gate.active).toBe(true);
		expect(arm.state).toBe('unavailable');
		expect(arm.reason).toBe('fixture-forced unavailable read');
		// No empty-array fail-open: the available-only fields are absent.
		expect('inventory' in arm).toBe(false);
		expect('total' in arm).toBe(false);
		// Real end-to-end degradation: corrupt the trigger-eval receipt so the
		// derivation itself throws BLOCKED; the accessor's uniform catch must
		// convert it instead of failing the whole tool response.
		_internals.readPrReviewCandidateInventoryForStatus = realInventory;
		const triggerAbsolute = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			'test-run',
			'trigger-eval.json',
		);
		await fs.promises.writeFile(triggerAbsolute, 'not json', 'utf-8');
		gate = (await runStatus()).gate as Record<string, unknown>;
		arm = (gate.reviewProjection as unknown as Projection).candidateInventory;
		expect(gate.active).toBe(true);
		expect(arm.state).toBe('unavailable');
		expect(typeof arm.reason).toBe('string');
		expect(arm.reason.length).toBeGreaterThan(0);
		expect(arm.reason.length).toBeLessThanOrEqual(241);
		expect(arm.reason).toContain('trigger');
		expect('inventory' in arm).toBe(false);
	});

	test('G1: the inventory still projects on a DIRTY working tree (checkout-free read)', async () => {
		await establishReviewPrerequisites();
		const realGateClean = _test_exports.resolveIsWorkingTreeClean;
		_test_exports.resolveIsWorkingTreeClean = () => false;
		try {
			const arm = (await runProjection()).candidateInventory;
			expect(arm.state).toBe('available');
			expect(arm.inventory).toEqual(['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5']);
		} finally {
			_test_exports.resolveIsWorkingTreeClean = realGateClean;
		}
	});

	test('P3-3: an empty derivation projects exactly the CLEAN-REVIEW sentinel, never an empty array', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const arm = (await runProjection()).candidateInventory;
		expect(arm.state).toBe('available');
		expect(arm.inventory).toEqual(['CLEAN-REVIEW']);
		expect(arm.total).toBe(1);
		expect(arm.truncated).toBe(false);
		expect(arm.truncationNote).toBe(null);
	});
});

/** The 336-id production-path run (same recipe as the frozen suite). */
const CANDIDATES_PER_FAMILY = 30;
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';

async function establishLargeInventoryRun(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, lanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistBatch('base-all', 'swarm-pr-review:base', lanes);
	const triggerRows: Array<Record<string, string>> = [];
	for (const [index, family] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		const rows = Array.from(
			{ length: CANDIDATES_PER_FAMILY },
			(_v, j) =>
				`BIG-${index}-${j} | ${family} | HIGH | correctness | file.ts:${j} | claim | invariant | evidence | HIGH | ORDINARY | `,
		);
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane: family }],
			{ textOverride: [MICRO_HEADER, ...rows].join('\n') },
		);
		triggerRows.push({
			trigger_id: family,
			result: 'MATCHED',
			evidence: `Fixture evidence for ${family}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.promises.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.promises.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		'test-run',
		triggerRelative,
	);
}

describe('inventory container pin (N2 / R3-2)', () => {
	test('the capped arm carries state, the first 50 sorted ids, the full total, and the literal +N more on ONE object; candidateInventory is the first key', async () => {
		await establishLargeInventoryRun();
		const gate = (await runStatus()).gate as Record<string, unknown>;
		const projection = gate.reviewProjection as unknown as Projection &
			Record<string, unknown>;
		// Key-order smoke assertion: the contract survives refactors.
		expect(Object.keys(projection)[0]).toBe('candidateInventory');
		const arm = projection.candidateInventory;
		const sorted = await _test_exports.derivePrReviewCandidateInventory(
			tempDir,
			SESSION_ID,
		);
		expect(sorted.length).toBe(336);
		expect(arm.state).toBe('available');
		expect(arm.inventory?.length).toBe(50);
		expect(arm.inventory).toEqual(sorted.slice(0, 50));
		expect(arm.total).toBe(336);
		expect(arm.truncated).toBe(true);
		expect(arm.truncationNote).toBe('+286 more');
	});
});

describe('boundaries section (F8 / F6)', () => {
	test('with nothing settled: all three pending, checkpoint null, no scope claim', async () => {
		await establishReviewPrerequisites();
		const section = (await runProjection()).boundaries;
		expect(section.boundaries).toEqual([
			{ boundary: 'post_explorer', status: 'pending' },
			{ boundary: 'post_reviewer', status: 'pending' },
			{ boundary: 'post_critic', status: 'pending' },
		]);
		expect(section.checkpoint).toBe(null);
	});

	test('with a settled boundary: literal settled/pending words, both shared checkpoint fields, and the checkpointScope literal', async () => {
		await establishReviewPrerequisites();
		await markPrReviewArtifactBoundary(
			tempDir,
			SESSION_ID,
			'test-run',
			'post_explorer',
			'.swarm/pr-review/test-run/findings.jsonl',
			['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'],
			false,
		);
		const section = (await runProjection()).boundaries;
		expect(section.boundaries).toEqual([
			{ boundary: 'post_explorer', status: 'settled' },
			{ boundary: 'post_reviewer', status: 'pending' },
			{ boundary: 'post_critic', status: 'pending' },
		]);
		expect(section.checkpoint).toEqual({
			runId: 'test-run',
			findingsPath: '.swarm/pr-review/test-run/findings.jsonl',
		});
		expect(section.checkpointScope).toBe('shared-last-write-wins');
	});
});

describe('projection absence (C5 hardening)', () => {
	test('no gate, PR_FEEDBACK, and chain-uncertain responses carry no reviewProjection at all', async () => {
		// No gate.
		expect('reviewProjection' in ((await runStatus()).gate as object)).toBe(
			false,
		);
		// PR_FEEDBACK gate.
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		expect('reviewProjection' in ((await runStatus()).gate as object)).toBe(
			false,
		);
		// Delegation-chain-uncertain: a cyclic ancestry cannot resolve an owner.
		for (const [cycleA, cycleB] of [
			['cycle-a', 'cycle-b'],
			['cycle-b', 'cycle-a'],
		] as const) {
			await recordPendingDelegation(tempDir, {
				correlationId: cycleA,
				jobId: null,
				subagentSessionId: cycleA,
				parentSessionId: cycleB,
				callID: `call-${cycleA}`,
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
			});
		}
		const cycleGate = (await runStatus('cycle-a').then(
			(r) => r.gate,
		)) as Record<string, unknown>;
		expect(cycleGate.active).toBe(false);
		expect(cycleGate.reason).toBe('delegation-chain-uncertain');
		expect('reviewProjection' in cycleGate).toBe(false);
	});
});

describe('delegated child resolution (G2)', () => {
	test("a dispatched child session sees the gate OWNER's reviewProjection", async () => {
		await establishReviewPrerequisites();
		await recordPendingDelegation(tempDir, {
			correlationId: 'status-child',
			jobId: null,
			subagentSessionId: 'status-child',
			parentSessionId: SESSION_ID,
			callID: 'call-status-child',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		const childGate = (await runStatus('status-child')) as Record<
			string,
			unknown
		>;
		const projection = (childGate.gate as Record<string, unknown>)
			.reviewProjection as unknown as Projection;
		expect(projection).toBeDefined();
		expect(projection.candidateInventory.state).toBe('available');
		expect(projection.candidateInventory.inventory).toEqual([
			'C-0',
			'C-1',
			'C-2',
			'C-3',
			'C-4',
			'C-5',
		]);
	});
});
