/**
 * Issue #3095 — CHECK-AUTHORING acceptance checks (RED at base).
 *
 * `pr_workflow_status` projects PR_REVIEW gate state as COUNTS ONLY today;
 * the controller's per-boundary settlement, per-lane coverage, and candidate/
 * review finding-ID inventory are not surfaced — every test below asserts
 * that projection, fails at base for that reason, and seeds via production
 * mutators only. AC5 is owned by the existing status suite. KEY-NAME-TOLERANT
 * assertions target DATA via smallest-subtree search, never hard-coded keys.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewArtifactBoundary,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
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

async function runStatus(): Promise<Record<string, unknown>> {
	const result = await statusExecute({}, {
		directory: tempDir,
		sessionID: SESSION_ID,
	} as unknown as ToolContext);
	const text =
		typeof result === 'string' ? result : (result as ToolResult).output;
	return (JSON.parse(text as string) as Record<string, unknown>).gate;
}

/* KEY-NAME-TOLERANT discovery: locate the smallest object/array subtree of
 * `gate` whose JSON holds the DATA tokens (the projected row/map itself);
 * totals via numeric-value scan. */
function mentionsAll(node: unknown, names: readonly string[]): boolean {
	const json = JSON.stringify(node);
	return !!json && names.every((name) => json.includes(name));
}

type Located = { node: unknown; parent: unknown };

function locateSmallest(
	node: unknown,
	names: readonly string[],
	parent: unknown = null,
): Located {
	if (node === null || typeof node !== 'object' || !mentionsAll(node, names))
		return { node: null, parent: null };
	for (const child of Object.values(node)) {
		if (child === null || typeof child !== 'object') continue;
		const deeper = locateSmallest(child, names, node);
		if (deeper.node !== null) return deeper;
	}
	return { node, parent };
}

function isolateBoundaryEntry(tree: unknown, boundary: string): unknown {
	if (Array.isArray(tree)) {
		for (const el of tree)
			if (el === boundary || mentionsAll(el, [boundary])) return el;
		return null;
	}
	if (tree !== null && typeof tree === 'object') {
		const record = tree as Record<string, unknown>;
		if (boundary in record) return record[boundary];
		for (const value of Object.values(record))
			if (value === boundary || mentionsAll(value, [boundary])) return value;
	}
	return null;
}

// One boundary's projected entry must read settled (and not pending) or
// pending (the word, or an explicit null/false marker).
function boundaryReads(
	tree: unknown,
	boundary: string,
	settled: boolean,
): void {
	const entry = isolateBoundaryEntry(tree, boundary);
	const json = jsonOf(entry);
	if (settled)
		expect(
			/settled/i.test(json) && !/pending/i.test(json),
			`${boundary} settled`,
		).toBe(true);
	else
		expect(
			/pending/i.test(json) || entry === null || entry === false,
			`${boundary} pending`,
		).toBe(true);
}

// Every finite number and digit-only string anywhere under `node`.
function collectNumericValues(
	node: unknown,
	out = new Set<string>(),
): Set<string> {
	if (typeof node === 'number' && Number.isFinite(node)) out.add(String(node));
	else if (typeof node === 'string' && /^\d+$/.test(node)) out.add(node);
	else if (node !== null && typeof node === 'object')
		for (const value of Object.values(node)) collectNumericValues(value, out);
	return out;
}

function jsonOf(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// The full inventory the fixture's production paths derive (precondition).
async function derivedInventory(): Promise<string[]> {
	return _test_exports.derivePrReviewCandidateInventory(tempDir, SESSION_ID);
}

/** Like establishReviewPrerequisites, but each micro family's lane artifact
 * carries 30 [CANDIDATE] rows: a 6+330=336-id run via real dispatch writes. */
const CANDIDATES_PER_FAMILY = 30;
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';

async function establishLargeInventoryRun(): Promise<string[]> {
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
	const ids = lanes.map((_lane, index) => `C-${index}`);
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
		ids.push(...rows.map((_row, j) => `BIG-${index}-${j}`));
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
	return ids;
}

const BOUNDARIES = ['post_explorer', 'post_reviewer', 'post_critic'] as const;

describe('AC1 — pr_workflow_status projects per-boundary settlement phase', () => {
	test('settlement phases read settled or pending per boundary with the shared run reference', async () => {
		await establishReviewPrerequisites();
		// Precondition (GREEN at base): six base candidates derived.
		const inventory = await derivedInventory();
		expect(inventory).toEqual(['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5']);
		const state = await markPrReviewArtifactBoundary(
			tempDir,
			SESSION_ID,
			'test-run',
			'post_explorer',
			'.swarm/pr-review/test-run/findings.jsonl',
			inventory,
			false,
		);
		expect(state.prReviewArtifactBoundaries).toEqual(['post_explorer']);
		let gate = await runStatus();
		// KEY-NAME-TOLERANT: all three boundary names must coexist in one
		// projected structure; the fix picks its own container keys.
		let tree = locateSmallest(gate, [...BOUNDARIES]);
		expect(tree.node !== null, 'gate must project the 3 boundary phases').toBe(
			true,
		);
		boundaryReads(tree.node, 'post_explorer', true);
		boundaryReads(tree.node, 'post_reviewer', false);
		boundaryReads(tree.node, 'post_critic', false);
		// KEY-NAME-TOLERANT: the settled boundary's checkpoint reference is the
		// SHARED run/path (prReviewArtifactRunId / prReviewFindingsPath).
		expect(JSON.stringify(gate)).toContain('test-run');

		// All-three-settled case, seeded via the gate-state read seam with the
		// EXACT bytes the real mutator persists, on the REAL on-disk state
		// (later boundaries need fully settled reviewer/critic waves).
		const diskState = await readPrWorkflowGateState(tempDir, SESSION_ID);
		_internals.readPrWorkflowGateStateForRecovery = async () =>
			({
				salvaged: false,
				schemaErrors: [],
				revisionSalvageable: true,
				armedShapeUnreadable: false,
				state: {
					...diskState,
					prReviewArtifactBoundaries: [
						'post_explorer',
						'post_reviewer',
						'post_critic',
					],
					prReviewArtifactRunId: 'test-run',
					prReviewFindingsPath: 'pr-review/test-run/findings.jsonl',
				},
			}) as unknown as Awaited<ReturnType<typeof realReadGate>>;
		gate = await runStatus();
		tree = locateSmallest(gate, [...BOUNDARIES]);
		expect(tree.node !== null, 'gate must project the 3 boundary phases').toBe(
			true,
		);
		for (const boundary of BOUNDARIES) boundaryReads(tree.node, boundary, true);
		expect(JSON.stringify(gate)).toContain('findings.jsonl');
	});
	test('negative: with no boundary settled, all three read as pending', async () => {
		await establishReviewPrerequisites();
		const gate = await runStatus();
		const tree = locateSmallest(gate, [...BOUNDARIES]);
		expect(tree.node !== null, 'unsettled run still projects 3 phases').toBe(
			true,
		);
		for (const boundary of BOUNDARIES)
			boundaryReads(tree.node, boundary, false);
	});
});

/* AC2 DISCLOSED DEVIATION: "accepted/rejected item counts" are not literally
 * satisfiable — no per-item verdict exists in state or receipts
 * (`reviewItemIds` is a plain string[]). Asserted instead: lane id, workflow
 * lane, batch id (co-located in one row), and the finding-or-clean marker. */
describe('AC2 — pr_workflow_status projects per-lane coverage rows', () => {
	test('base and micro lanes that ran appear as rows with lane id, workflow lane, batch id, and a finding-or-clean marker', async () => {
		await establishReviewPrerequisites();
		const gate = await runStatus();
		// KEY-NAME-TOLERANT: locate the base lane row by co-occurrence of its
		// lane id (= workflow lane 'intent-architecture') and its batch id.
		const baseRow = locateSmallest(gate, ['intent-architecture', 'base-all']);
		expect(baseRow.node !== null, 'gate must project the base lane row').toBe(
			true,
		);
		expect(
			/C-0|finding|candidate|clean/i.test(jsonOf(baseRow.node)),
			'base lane row needs finding-or-clean marker',
		).toBe(true);
		// Micro row: distinct lane id vs workflow lane, plus its batch id.
		const microRow = locateSmallest(gate, [
			'micro-lane-0',
			'auth-identity-secrets',
		]);
		expect(microRow.node !== null, 'gate must project the micro lane row').toBe(
			true,
		);
		expect(
			jsonOf(microRow.node).includes('micro-0'),
			'micro lane row needs its batch id',
		).toBe(true);
		expect(
			/clean|no finding/i.test(jsonOf(microRow.node)),
			'micro lane row needs a clean marker',
		).toBe(true);
	});
});

describe('AC3 — pr_workflow_status projects the candidate inventory with a size bound', () => {
	test('small run: the derived candidate ids and a separate total are projected', async () => {
		await establishReviewPrerequisites();
		const inventory = await derivedInventory();
		expect(inventory).toEqual(['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5']);
		const gate = await runStatus();
		// KEY-NAME-TOLERANT: the inventory container is located by first and
		// last candidate ids co-occurring, not by a field name.
		const located = locateSmallest(gate, ['C-0', 'C-5']);
		expect(located.node !== null, 'gate must project the inventory ids').toBe(
			true,
		);
		for (const id of inventory)
			expect(jsonOf(located.node).includes(id)).toBe(true);
		// Total reported separately from rows: a numeric 6 in the container's
		// parent (rows are id strings, so 6 is a count field).
		expect(
			collectNumericValues(located.parent ?? gate).has('6'),
			'total reported separately from rows',
		).toBe(true);
	});
	test('large run: the projection is capped with an explicit truncation signal and reports the full total', async () => {
		const expectedIds = await establishLargeInventoryRun();
		expect((await derivedInventory()).length).toBe(336);
		const gate = await runStatus();
		// Locate the container by ANY TWO expected ids co-occurring, so a
		// correctly capped projection (which cannot hold every id) still is.
		let located = { node: null as unknown, parent: null as unknown };
		for (let i = 0; i < expectedIds.length && located.node === null; i += 1)
			for (
				let j = i + 1;
				j < expectedIds.length && located.node === null;
				j += 1
			)
				located = locateSmallest(gate, [expectedIds[i], expectedIds[j]]);
		expect(located.node !== null, 'gate must project a bounded inventory').toBe(
			true,
		);
		const containerJson = jsonOf(located.node);
		const listed = expectedIds.filter((id) =>
			containerJson.includes(`"${id}"`),
		).length;
		expect(
			listed > 0 && listed < expectedIds.length,
			`rows must be listed but capped, not unrolled (listed ${listed} of ${expectedIds.length})`,
		).toBe(true);
		// Explicit truncation disclosure ('+N more'/truncated/ellipsis) in the
		// container or its immediate parent.
		expect(
			/\+\s*\d+\s*more|\bmore\b|truncat|…/i.test(
				jsonOf(located.parent ?? gate),
			),
			'the capped projection must disclose the truncation explicitly (e.g. "+N more")',
		).toBe(true);
		// The full total is still reported, separately from the capped rows.
		expect(
			collectNumericValues(gate).has('336'),
			'full total (336) still reported',
		).toBe(true);
	});
});

function snapshotSwarmTree(): string[] {
	const root = path.join(tempDir, '.swarm');
	const out: string[] = [];
	for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
		const stat = fs.statSync(path.join(root, rel));
		if (stat.isFile()) out.push(`${rel}|${stat.size}|${stat.mtimeMs}`);
	}
	return out.sort();
}

describe('AC4 — lane finding summaries are derived at read time from stored receipts', () => {
	test('a receipt-published lane finding is summarized on every status call and no artifact is written between calls', async () => {
		await establishReviewPrerequisites();
		// Dispatch a realistic retry lane; publish a receipt via the REAL publisher.
		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[{ laneId: 'base-retry-ia', workflowLane: 'intent-architecture' }],
			{
				batchId: 'base-retry-ia',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		const instanceId = state.workflowInstanceId;
		const revision = state.revision;
		// The delegation record, envelope, and receipt are schema-complete JSON
		// literals (typed call sites consume plain objects).
		await recordPendingDelegation(
			tempDir,
			JSON.parse(
				`{"correlationId":"receipt-child","jobId":"${encodePrReviewWorkflowBinding(instanceId)}",` +
					`"subagentSessionId":"receipt-child","parentSessionId":"${SESSION_ID}",` +
					`"callID":"call-receipt-child","normalizedAgent":"reviewer","swarmPrefixedAgent":"reviewer",` +
					`"planTaskId":null,"evidenceTaskId":null,"batchId":"base-retry-ia","laneId":"base-retry-ia",` +
					`"mode":"swarm-pr-review:base","workflowLane":"intent-architecture",` +
					`"workflowGeneration":${revision},"generation":1,` +
					`"workspace":{"directory":${JSON.stringify(tempDir)},"gitHead":"${HEAD_SHA}",` +
					`"dirtyHash":null,"prHeadSha":"${HEAD_SHA}","scope":null}}`,
			),
		);
		const envelope = JSON.parse(
			'{"schemaVersion":1,"outcome":"FINDINGS","creditedLanes":["intent-architecture"],' +
				'"findings":[{"id":"FIND-AC4","workflowLane":"intent-architecture","severity":"HIGH",' +
				'"riskImpact":"HIGH_IMPACT","riskTags":["SECURITY"],"title":"AC4 receipt finding title",' +
				'"body":"The lane found a reachable defect within the reviewed scope.",' +
				'"evidence":"Confirmed from the changed path and reviewer-visible state.",' +
				'"location":{"kind":"local","file":"src/review.ts","line":12}}],' +
				'"cleanAttestations":[],"unresolved":[]}',
		) as PrReviewLaneResultEnvelope;
		const digest = prReviewLaneResultEnvelopeDigest(envelope);
		const receipt = JSON.parse(
			`{"schemaVersion":1,"mode":"swarm-pr-review:base","workflowInstanceId":"${instanceId}",` +
				`"workflowRevision":${revision},"batchId":"base-retry-ia","laneId":"base-retry-ia",` +
				`"workflowLane":"intent-architecture","ownedWorkflowLanes":["intent-architecture"],` +
				`"baseSha":"def456","headSha":"${HEAD_SHA}","dispatchRevisionDigest":"${'d'.repeat(64)}",` +
				`"childSessionId":"receipt-child","generation":1,` +
				`"semanticEnvelopeDigest":"${digest}","envelope":${JSON.stringify(envelope)}}`,
		);
		const outcome = await publishPrReviewResultReceipt(tempDir, {
			parentSessionId: SESSION_ID,
			childSessionId: 'receipt-child',
			batchId: 'base-retry-ia',
			laneId: 'base-retry-ia',
			expectedWorkflowInstanceId: instanceId,
			expectedWorkflowRevision: revision,
			expectedBaseSha: 'def456',
			receipt,
		});
		expect(['recorded', 'duplicate']).toContain(outcome.status);
		// Warm-up: the FIRST delegation-store read performs a one-time legacy
		// import (base behavior) — isolates AC4: summaries must not write to disk.
		await runStatus();
		const before = snapshotSwarmTree();
		const firstGate = await runStatus();
		const mid = snapshotSwarmTree();
		const secondGate = await runStatus();
		const after = snapshotSwarmTree();
		// Read-only: nothing duplicated to disk (GREEN at base; the RED is below).
		expect(mid).toEqual(before);
		expect(after).toEqual(before);
		// KEY-NAME-TOLERANT: the receipt's finding id must surface at read time.
		expect(
			JSON.stringify(firstGate).includes('FIND-AC4'),
			'read-time summary from receipt (FIND-AC4)',
		).toBe(true);
		expect(JSON.stringify(secondGate).includes('FIND-AC4')).toBe(true);
	});
});
