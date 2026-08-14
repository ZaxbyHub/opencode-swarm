import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	CANDIDATE_HEADERS,
	CLEAN_TEMPLATES,
} from '../../../src/background/candidate-contract.js';
import {
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store.js';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { retrieve_lane_output } from '../../../src/tools/retrieve-lane-output.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PARENT = 'collection-validation-parent';
const HEAD = 'abc123';
const REVISION = 'revision-test';
const SCOPE = 'complete PR diff def456...abc123';
const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';

const originalInternals = { ..._internals };
let directory = '';
let outputs = new Map<string, string>();

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-collect-');
	outputs = new Map();
	_test_exports.resetDeliveredLaneOutputs();
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION;
	const ops: SessionOps = {
		create: mock(async () => ({ data: { id: 'unused' }, error: undefined })),
		prompt: mock(async () => ({ data: null, error: undefined })),
		messages: mock(async ({ path: sessionPath }) => ({
			data: [
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: outputs.get(sessionPath.id) ?? '' }],
				},
			],
			error: undefined,
		})),
	};
	_internals.getSessionOps = () => ops;
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
	_test_exports.resetDeliveredLaneOutputs();
	fs.rmSync(directory, { recursive: true, force: true });
});

async function recordLane(args: {
	batch: string;
	lane: string;
	mode?: string;
	workflowLane?: string;
	ownedWorkflowLanes?: string[];
	agent?: string;
	text: string;
}): Promise<void> {
	const session = `session-${args.batch}-${args.lane}`;
	outputs.set(session, args.text);
	const recorded = await recordPendingDelegation(directory, {
		correlationId: session,
		jobId: null,
		subagentSessionId: session,
		parentSessionId: PARENT,
		callID: args.batch,
		normalizedAgent: args.agent ?? 'explorer',
		swarmPrefixedAgent: args.agent ?? 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batch,
		laneId: args.lane,
		...(args.mode ? { mode: args.mode } : {}),
		...(args.workflowLane ? { workflowLane: args.workflowLane } : {}),
		...(args.ownedWorkflowLanes
			? { ownedWorkflowLanes: args.ownedWorkflowLanes }
			: {}),
		promptHash: 'prompt-hash',
		workspace: {
			directory,
			gitHead: HEAD,
			dirtyHash: REVISION,
			prHeadSha: HEAD,
			scope: SCOPE,
		},
		generation: 1,
	});
	expect(recorded).not.toBeNull();
}

async function collect(batch: string) {
	return executeCollectLaneResults(
		{ batch_id: batch, wait: false },
		directory,
		{ sessionID: PARENT },
	);
}

describe('PR-review discovery validation during collection', () => {
	test('fails malformed base output immediately while retaining retrievable evidence', async () => {
		await recordLane({
			batch: 'malformed-base',
			lane: 'intent-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			text: 'I reviewed the lane and found nothing concerning.',
		});

		const first = await collect('malformed-base');
		expect(first.success).toBe(false);
		expect(first.completed).toBe(0);
		expect(first.failed).toBe(1);
		expect(first.lane_results[0]).toMatchObject({
			status: 'failed',
			output: 'I reviewed the lane and found nothing concerning.',
			output_chars: 49,
		});
		const error = first.lane_results[0].error!;
		expect(error).toContain('batch=malformed-base');
		expect(error).toContain('lane=intent-lane');
		expect(error).toContain('workflow_lane=intent-architecture');
		expect(error).toContain('predicate=discovery.header');
		expect(error).toContain('expected=');
		expect(error).toContain('actual=');
		expect(error).toContain(CANDIDATE_HEADERS.base_explorer);
		expect(error).toContain(CLEAN_TEMPLATES.base_explorer);
		expect(first.lane_results[0].error!.length).toBeLessThanOrEqual(1_024);
		expect(first.lane_results[0].output_digest).toMatch(/^[a-f0-9]{64}$/);
		expect(first.lane_results[0].output_ref).toMatch(/^L1:/);
		expect(
			readLaneOutput(directory, first.lane_results[0].output_ref!)?.artifact
				.text,
		).toBe('I reviewed the lane and found nothing concerning.');
		const retrieved = await retrieve_lane_output.execute(
			{ ref: first.lane_results[0].output_ref },
			{ directory } as never,
		);
		expect(retrieved).toContain('Batch: malformed-base');
		expect(retrieved).toContain(
			'I reviewed the lane and found nothing concerning.',
		);

		const repeat = await collect('malformed-base');
		expect(repeat.failed).toBe(1);
		expect(repeat.lane_results[0].status).toBe('failed');
		expect(repeat.lane_results[0].error).toBe(first.lane_results[0].error);
		expect(repeat.lane_results[0].output_ref).toBe(
			first.lane_results[0].output_ref,
		);
		expect(repeat.lane_results[0].output_omitted_repeat).toBe(true);
		expect(repeat.lane_results[0].output).toBeUndefined();
	});

	test('fails malformed micro output with the micro-lane recovery contract', async () => {
		await recordLane({
			batch: 'malformed-micro',
			lane: 'auth-lane',
			mode: 'swarm-pr-review:micro',
			workflowLane: 'auth-boundary',
			text: 'plain micro-lane prose',
		});

		const result = await collect('malformed-micro');
		expect(result.success).toBe(false);
		expect(result.failed).toBe(1);
		const error = result.lane_results[0].error!;
		expect(error).toContain('predicate=discovery.header');
		expect(error).toContain(CANDIDATE_HEADERS.micro_lane);
		expect(error).toContain(CLEAN_TEMPLATES.micro_lane);
	});

	test('keeps strict rejection for a hybrid ten-field micro candidate', async () => {
		const batch = 'production-hybrid-micro';
		const workflowLane = 'auth-identity-secrets';
		await recordLane({
			batch,
			lane: `${batch}-lane`,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			text: `${MICRO_HEADER}\n[CANDIDATE] | auth-identity-secrets-001 | auth-identity-secrets | LOW | security | src/auth.ts:10 | authorization claim | least-privilege invariant | direct code evidence | downstream impact copied from the base schema | MEDIUM`,
		});
		const result = await collect(batch);
		expect(result.success).toBe(false);
		expect(result.failed).toBe(1);
		expect(result.lane_results[0].status).toBe('failed');
		expect(result.lane_results[0].error).toContain(
			'exactly 9 candidate fields',
		);
	});

	test('recovers the recorded trailing CLEAN confidence and records salvage', async () => {
		const batch = 'production-clean-confidence';
		const lane = `${batch}-lane`;
		const workflowLane = 'dependencies-build-release';
		await recordLane({
			batch,
			lane,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			text: `${MICRO_HEADER}\n[CLEAN] | dependencies-build-release | complete dependency and release review | no unsafe dependency or release path found | HIGH`,
		});
		const result = await collect(batch);
		expect(result.success).toBe(true);
		expect(result.lane_results[0].status).toBe('completed');
		const record = findByCorrelationId(directory, `session-${batch}-${lane}`);
		expect(record?.result?.salvagedWorkflowLanes).toEqual([workflowLane]);
	});

	test.each([
		{
			name: 'base candidate',
			batch: 'valid-base',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			text: `${BASE_HEADER}\nC-1 | intent-architecture | HIGH | correctness | src/a.ts:1 | incorrect state transition | source proves the transition skips validation | user-visible invalid state | HIGH`,
		},
		{
			name: 'base CLEAN attestation',
			batch: 'valid-clean',
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			text: `${BASE_HEADER}\n[CLEAN] | correctness-state | complete changed-state review | no finding after tracing every changed state transition`,
		},
		{
			name: 'micro candidate',
			batch: 'valid-micro',
			mode: 'swarm-pr-review:micro',
			workflowLane: 'auth-boundary',
			text: `${MICRO_HEADER}\nM-1 | auth-boundary | HIGH | security | src/auth.ts:1 | missing authorization check | authorization invariant | request reaches protected state | HIGH`,
		},
		{
			name: 'framed base candidate',
			batch: 'valid-framed',
			mode: 'swarm-pr-review:base',
			workflowLane: 'tests-falsifiability',
			text: `Focused review notes follow.\n${BASE_HEADER}\nC-2 | tests-falsifiability | MEDIUM | testing | tests/a.test.ts:1 | missing falsifier | changed behavior lacks a negative probe | false green risk | HIGH`,
		},
	])('completes a valid $name', async ({ batch, mode, workflowLane, text }) => {
		await recordLane({
			batch,
			lane: `${batch}-lane`,
			mode,
			workflowLane,
			text,
		});
		const result = await collect(batch);
		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.lane_results[0].status).toBe('completed');
		expect(result.lane_results[0].error).toBeUndefined();
	});

	test('recovers a strict terminal protocol fence and records salvage', async () => {
		await recordLane({
			batch: 'fenced-base',
			lane: 'fenced-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			text: `\`\`\`text\n${BASE_HEADER}\nC-3 | security-trust | HIGH | security | src/a.ts:1 | claim text | evidence summary text | impact context text | HIGH\n\`\`\``,
		});
		const result = await collect('fenced-base');
		expect(result.success).toBe(true);
		expect(result.lane_results[0].status).toBe('completed');
		const record = findByCorrelationId(
			directory,
			'session-fenced-base-fenced-lane',
		);
		expect(record?.result?.salvagedWorkflowLanes).toEqual(['security-trust']);
	});

	test('persists validator-proven salvage for repaired council output', async () => {
		const batch = 'repaired-council';
		const lane = 'generalist-lane';
		const workflowLane = 'council-generalist';
		await recordLane({
			batch,
			lane,
			mode: 'swarm-pr-review:council',
			workflowLane,
			agent: 'council_generalist',
			text: `\`\`\`text\n${MICRO_HEADER}\n[CLEAN] | ${workflowLane} | complete council review scope | no candidate survived council checks | HIGH\n\`\`\``,
		});

		const result = await collect(batch);
		expect(result.success).toBe(true);
		expect(result.lane_results[0].status).toBe('completed');
		const record = findByCorrelationId(directory, `session-${batch}-${lane}`);
		expect(record?.result?.salvagedWorkflowLanes).toEqual([workflowLane]);
	});

	test('does not mark well-formed council output as salvaged', async () => {
		const batch = 'well-formed-council';
		const lane = 'skeptic-lane';
		const workflowLane = 'council-skeptic';
		await recordLane({
			batch,
			lane,
			mode: 'swarm-pr-review:council',
			workflowLane,
			agent: 'council_skeptic',
			text: `${MICRO_HEADER}\n[CLEAN] | ${workflowLane} | complete skeptical council review | no candidate survived skeptical checks`,
		});

		const result = await collect(batch);
		expect(result.success).toBe(true);
		expect(result.lane_results[0].status).toBe('completed');
		const record = findByCorrelationId(directory, `session-${batch}-${lane}`);
		expect(record?.result?.salvagedWorkflowLanes).toBeUndefined();
	});

	test('keeps council row ownership validation fail-closed', async () => {
		const batch = 'wrong-council-owner';
		await recordLane({
			batch,
			lane: 'owner-lane',
			mode: 'swarm-pr-review:council',
			workflowLane: 'council-generalist',
			agent: 'council_generalist',
			text: `${MICRO_HEADER}\n[CLEAN] | council-skeptic | complete council review scope | no candidate survived council checks`,
		});

		const result = await collect(batch);
		expect(result.success).toBe(false);
		expect(result.lane_results[0].status).toBe('failed');
		expect(result.lane_results[0].error).toContain('discovery.row');
	});

	test('fails duplicate evidence in a consolidated discovery lane', async () => {
		await recordLane({
			batch: 'duplicate-evidence',
			lane: 'consolidated-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			ownedWorkflowLanes: ['intent-architecture', 'correctness-state'],
			text: `${BASE_HEADER}\n[CLEAN] | intent-architecture | complete reviewed scope | identical evidence copied across both owned dimensions\n[CLEAN] | correctness-state | complete reviewed scope | identical evidence copied across both owned dimensions`,
		});
		const result = await collect('duplicate-evidence');
		expect(result.success).toBe(false);
		expect(result.lane_results[0].status).toBe('failed');
		expect(result.lane_results[0].error).toMatch(/duplicate|evidence/i);
	});

	test('preserves best inline evidence when artifact storage degrades without a ref', async () => {
		const text = 'malformed output whose durable ref collides';
		storeLaneOutput(directory, {
			batchId: 'degraded-ref',
			laneId: 'degraded-lane',
			agent: 'different-agent',
			role: 'different-role',
			sessionId: 'different-session',
			parentSessionId: PARENT,
			mode: 'swarm-pr-review:base',
			workflowLane: 'reliability-performance',
			prHeadSha: HEAD,
			gitHead: HEAD,
			revisionDigest: REVISION,
			scope: SCOPE,
			source: 'collect_lane_results',
			text,
		});
		await recordLane({
			batch: 'degraded-ref',
			lane: 'degraded-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'reliability-performance',
			text,
		});

		const result = await collect('degraded-ref');
		expect(result.success).toBe(false);
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			output_degraded: true,
		});
		expect(result.lane_results[0].output).toContain(text);
		expect(result.lane_results[0].output_ref).toBeUndefined();
		expect(result.lane_results[0].output_artifact_error).toMatch(/collision/i);
		expect(result.lane_results[0].error).toMatch(
			/artifact|output|ref|degraded/i,
		);
	});

	test('leaves ordinary advisory prose behavior unchanged', async () => {
		await recordLane({
			batch: 'advisory',
			lane: 'advisory-lane',
			mode: 'advisory',
			text: 'ordinary advisory prose',
		});
		const result = await collect('advisory');
		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.lane_results[0].output).toBe('ordinary advisory prose');
	});

	test('persists salvagedWorkflowLanes to the ledger through the real collect path', async () => {
		// End-to-end wiring guard. The pending-delegations round-trip test passes the
		// field straight to appendDelegationTransition, so it cannot catch a break in
		// the assignment inside collectOnce that actually derives it from
		// validation.salvaged — this test drives the real collect path instead.
		const session = 'session-salvage-ledger-salvage-lane';
		await recordLane({
			batch: 'salvage-ledger',
			lane: 'salvage-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			// Headerless but salvageable: one valid row, canonical header absent.
			text: 'prose the explorer wrote first\n[CANDIDATE] | S-1 | intent-architecture | HIGH | correctness | src/a.ts:1 | claim text | evidence text | impact text | HIGH',
		});

		const result = await collect('salvage-ledger');
		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);

		const record = findByCorrelationId(directory, session);
		expect(record?.status).toBe('completed');
		expect(record?.result?.salvagedWorkflowLanes).toEqual([
			'intent-architecture',
		]);
	});
});
