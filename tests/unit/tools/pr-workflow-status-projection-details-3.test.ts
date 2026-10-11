/**
 * Issue #3095 — fix-PR details coverage, part 3. Two regressions found by the
 * independent implementation review:
 *
 *  - F1: a lane that PROMISES evidence via `outputRef` but whose artifact cannot
 *    be read must report UNKNOWN evidence, never an absence claim.
 *    `readLaneOutput` folds "never written" and "corrupt/unreadable" into the
 *    same `null`, so a bare `if (!loaded) continue` turned a failed read into
 *    `marker: 'no-evidence'` with `readState: 'ok'` — the exact fail-open the
 *    tool's own doc comment forbids.
 *  - F2: the truncated-inventory arithmetic (`total` / `truncationNote`) was
 *    pinned to exactly one fixture size, so a hardcoded plausible value
 *    survived every suite. A second, differently-sized truncation closes that.
 *
 * Additional to the frozen acceptance suite — never a replacement for it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
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
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassify;
	await teardownPrWorkflowGateFixtures();
});

type LaneRow = {
	laneId: string;
	workflowLane: string;
	batchId: string;
	marker: string;
	findings: Array<{ id: string }>;
};

type InventorySection = {
	state: string;
	inventory?: string[];
	total?: number;
	truncated?: boolean;
	truncationNote?: string | null;
};

type Projection = {
	candidateInventory: InventorySection;
	lanes: {
		lanes: LaneRow[];
		sourceState: Record<string, string>;
	};
};

const statusExecute = (
	pr_workflow_status as unknown as {
		execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
	}
).execute;

async function runProjection(): Promise<Projection> {
	const result = await statusExecute({}, {
		directory: tempDir,
		sessionID: SESSION_ID,
	} as unknown as ToolContext);
	const text =
		typeof result === 'string' ? result : (result as ToolResult).output;
	const gate = (JSON.parse(text as string) as Record<string, unknown>)
		.gate as Record<string, unknown>;
	return gate.reviewProjection as Record<string, unknown> as Projection;
}

/** Corrupt every stored lane artifact so a promised outputRef cannot be read. */
function corruptEveryLaneArtifact(): number {
	const root = path.join(tempDir, '.swarm', 'lane-results');
	let touched = 0;
	const walk = (dir: string) => {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.json')) {
				fs.writeFileSync(full, '{"not":"a lane artifact"}', 'utf-8');
				touched += 1;
			}
		}
	};
	walk(root);
	return touched;
}

describe('F1 — a promised but unreadable lane artifact is unknown, not absent', () => {
	test('a corrupt referenced artifact never reports an absence claim', async () => {
		await establishReviewPrerequisites();
		const before = await runProjection();
		// Control: with intact artifacts the base lane genuinely HAS a finding.
		expect(
			before.lanes.lanes.find((r) => r.workflowLane === 'intent-architecture')
				?.marker,
		).toBe('finding');

		const corrupted = corruptEveryLaneArtifact();
		expect(corrupted).toBeGreaterThan(0);

		const after = await runProjection();
		const row = after.lanes.lanes.find(
			(r) => r.workflowLane === 'intent-architecture',
		);
		expect(row).toBeDefined();
		// The lane still PROMISES evidence via outputRef, so its evidence is
		// UNKNOWN. Reporting 'no-evidence' here would assert an absence that the
		// read never established.
		expect(row?.marker).toBe('unknown-evidence');
		expect(row?.marker).not.toBe('no-evidence');
		expect(row?.marker).not.toBe('clean');
		expect(row?.findings).toEqual([]);
		// The source is disclosed as uncertain, not 'ok'.
		expect(['uncertain', 'unavailable']).toContain(
			after.lanes.sourceState.base,
		);
	});

	test('the tool still returns successfully on a corrupt artifact (never throws)', async () => {
		await establishReviewPrerequisites();
		corruptEveryLaneArtifact();
		const result = await statusExecute({}, {
			directory: tempDir,
			sessionID: SESSION_ID,
		} as unknown as ToolContext);
		const text =
			typeof result === 'string' ? result : (result as ToolResult).output;
		const parsed = JSON.parse(text as string) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
	});
});

describe('F2 — truncated inventory arithmetic is pinned at two sizes', () => {
	/**
	 * Seed ONE base lane carrying `count` distinct [CANDIDATE] rows. Using one
	 * lane with many rows (rather than many lanes of one dimension) keeps the
	 * fixture legal: the gate rejects duplicate workflow-lane ids, so a
	 * many-lane seed of a single dimension would be rejected outright.
	 */
	async function seedCandidatesInOneLane(count: number): Promise<void> {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[{ laneId: 'cap-lane', workflowLane: 'intent-architecture' }],
			{
				batchId: 'base-cap',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		const rows = Array.from(
			{ length: count },
			(_v, i) =>
				`CAP-${String(i).padStart(3, '0')} | intent-architecture | HIGH | correctness | file.ts:${i + 1} | claim-${i} | evidence-${i} | impact-${i} | HIGH | ORDINARY | `,
		);
		await persistBatch(
			'base-cap',
			'swarm-pr-review:base',
			[{ laneId: 'cap-lane', workflowLane: 'intent-architecture' }],
			{
				textOverride: [
					'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags',
					...rows,
				].join('\n'),
			},
		);
	}

	test('a small, untruncated run reports its real size, not a constant', async () => {
		await seedCandidatesInOneLane(3);
		const small = await runProjection();
		expect(small.candidateInventory.state).toBe('available');
		expect(small.candidateInventory.truncated).toBe(false);
		expect(small.candidateInventory.total).toBe(3);
		expect(small.candidateInventory.inventory?.length).toBe(3);
		expect(small.candidateInventory.truncationNote ?? null).toBeNull();
	});

	test('a second, different truncation size reports its own numbers', async () => {
		// Over the 50-item cap but nowhere near the frozen fixture's 336, so a
		// hardcoded 336 / '+286 more' cannot satisfy both cases.
		await seedCandidatesInOneLane(60);
		const big = await runProjection();
		expect(big.candidateInventory.state).toBe('available');
		expect(big.candidateInventory.truncated).toBe(true);
		expect(big.candidateInventory.total).toBe(60);
		expect(big.candidateInventory.truncated === true).toBe(true);
		expect(big.candidateInventory.truncationNote).toBe('+10 more');
		expect(big.candidateInventory.inventory?.length).toBe(50);
		expect(big.candidateInventory.total).not.toBe(336);
		expect(big.candidateInventory.truncationNote).not.toBe('+286 more');
	});

	test('the projected inventory is exactly the capped head of the real derivation', async () => {
		await seedCandidatesInOneLane(60);
		const projection = await runProjection();
		const listed = projection.candidateInventory.inventory ?? [];
		expect(listed.length).toBe(50);
		// Every projected id must be one this fixture actually seeded.
		expect(listed.every((id) => id.startsWith('CAP-'))).toBe(true);
		// Sorted and duplicate-free, matching the controller's own contract.
		expect(listed).toEqual([...listed].sort());
		expect(new Set(listed).size).toBe(listed.length);
	});
});
