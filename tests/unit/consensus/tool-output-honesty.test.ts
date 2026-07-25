/**
 * Every string and number `consensus_mine` prints is read by a model as fact.
 *
 * `src/tools/consensus-mine.ts` claims "every string here is asserted by a
 * test". This file covers the three claims that were false or untested when that
 * comment was written:
 *
 * - the truncation guarantee, printed but never exercised anywhere in `tests/`;
 * - `summarized_count`, which claimed to "always agree with the `llm_summary`
 *   values echoed alongside it" while the two use different orderings;
 * - `retention.retained`, which printed `0` under `report_retention: 0` — a mode
 *   documented as DISABLING pruning, i.e. retaining everything.
 *
 * It lives beside the rest of the consensus suite because what it asserts is
 * consensus-subsystem behaviour surfaced through the tool, not tool
 * registration; `tests/unit/tools/consensus-mine.test.ts` owns the registration
 * surfaces.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ConsensusAttributeV1 } from '../../../src/consensus/contracts';
import {
	MIN_SUPPORT_FOR_PROPOSAL,
	MIN_TASK_DIVERSITY_FOR_PROPOSAL,
} from '../../../src/consensus/miner';
import { _test_exports } from '../../../src/tools/consensus-mine';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';

const { countSummaries, MAX_INLINE_ATTRIBUTES } = _test_exports;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-honesty-')),
	);
	roots.push(root);
	return root;
}

async function run(
	directory: string,
	args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const definition = TOOL_MANIFEST.consensus_mine() as unknown as {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return JSON.parse(await definition.execute(args, { directory })) as Record<
		string,
		unknown
	>;
}

function trajectoryLine(result: 'success' | 'failure', target: string): string {
	return JSON.stringify({
		step: 1,
		agent: 'coder',
		action: 'run',
		target,
		intent: '',
		timestamp: '2026-01-01T00:00:00.000Z',
		result,
		tool: 'test_runner',
		elapsed_ms: 5,
	});
}

/**
 * Six succeeding task-trajectory observations (corpus source 4) and four failing
 * PRM-session observations (source 5).
 *
 * The split is what makes the truncation guarantee observable: sources are
 * consumed in a fixed order, and once the budget is spent every later source is
 * dropped WHOLE. At `max_evidence_items: 6` the failures therefore vanish
 * entirely while the successes are untouched.
 */
function seedCorpus(root: string): string {
	for (const taskId of ['task-a', 'task-b', 'task-c']) {
		const taskDir = path.join(root, '.swarm', 'evidence', taskId);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			path.join(taskDir, 'trajectory.jsonl'),
			`${[trajectoryLine('success', ''), trajectoryLine('success', '')].join('\n')}\n`,
			'utf-8',
		);
	}
	const sessionDir = path.join(root, '.swarm', 'trajectories');
	mkdirSync(sessionDir, { recursive: true });
	for (const [index, sessionId] of ['ses-one', 'ses-two'].entries()) {
		writeFileSync(
			path.join(sessionDir, `${sessionId}.jsonl`),
			`${[
				trajectoryLine('failure', `file-${index}.ts`),
				trajectoryLine('failure', `other-${index}.ts`),
			].join('\n')}\n`,
			'utf-8',
		);
	}
	return root;
}

function attributesOf(result: Record<string, unknown>) {
	return result.attributes as Array<Record<string, unknown>>;
}

function storedReport(root: string): Record<string, unknown> {
	const dir = path.join(root, '.swarm', 'evolution', 'consensus');
	const files = readdirSync(dir).sort();
	const first = files[0];
	if (first === undefined) throw new Error('no consensus report was written');
	return JSON.parse(readFileSync(path.join(dir, first), 'utf-8')) as Record<
		string,
		unknown
	>;
}

const MINE = { min_support: 2, min_successful_runs: 0 };

describe('consensus_mine — the truncation guarantee is real', () => {
	test('prints the truncation guarantee', async () => {
		const result = await run(project());
		expect((result.guarantees as string[]).join(' | ')).toContain(
			'read failure_support 0 on a truncated report as "none survived the cut"',
		);
	});

	test('truncation is DECLARED on the persisted report, not just returned', async () => {
		const root = seedCorpus(project());
		const result = await run(root, { ...MINE, max_evidence_items: 6 });
		expect(result.corpus_truncated).toBe(true);
		const persisted = storedReport(root).truncation as Record<string, unknown>;
		expect(persisted.corpus).toBe(true);
		expect(persisted.observations).toBe(6);
	});

	test('the same evidence reports failures or none, depending only on the cut', async () => {
		// This is what the guarantee warns about. Both mines see the same tree; the
		// truncated one drops the whole failing source once the budget is spent, so
		// every attribute it carries reads `failure_support: 0`.
		const cut = await run(seedCorpus(project()), {
			...MINE,
			max_evidence_items: 6,
		});
		const whole = await run(seedCorpus(project()), {
			...MINE,
			max_evidence_items: 50,
		});

		expect(cut.corpus_truncated).toBe(true);
		expect(
			attributesOf(cut).every((attribute) => attribute.failure_support === 0),
		).toBe(true);

		expect(whole.corpus_truncated).toBe(false);
		expect(
			attributesOf(whole).some(
				(attribute) => (attribute.failure_support as number) > 0,
			),
		).toBe(true);
	});
});

describe('consensus_mine — the printed thresholds are every proposal gate', () => {
	test('prints the support gate, sourced from the miner rather than restated', async () => {
		// `min_support: 1` is an accepted argument, so the request thresholds alone
		// do not describe proposal eligibility: `buildAttributes` also requires
		// `support >= MIN_SUPPORT_FOR_PROPOSAL`. While that gate was unprinted, an
		// attribute could clear every number in this block and still be forced to
		// `proposed_target: 'none'` with nothing in the output explaining why. The
		// BEHAVIOUR is pinned in `miner-gating.test.ts` ("support from a single run
		// is a note even when diverse tasks appear"); what is pinned here is that
		// the number the model is told is the number the miner applies.
		const result = await run(project(), { min_support: 1 });
		const thresholds = result.thresholds as Record<string, unknown>;
		expect(thresholds.min_support).toBe(1);
		expect(thresholds.min_support_for_proposal).toBe(MIN_SUPPORT_FOR_PROPOSAL);
		expect(thresholds.min_task_diversity).toBe(MIN_TASK_DIVERSITY_FOR_PROPOSAL);
	});

	test('the investigation-note guarantee names both gates', async () => {
		const result = await run(project());
		expect((result.guarantees as string[]).join(' | ')).toContain(
			`attributes below task diversity ${MIN_TASK_DIVERSITY_FOR_PROPOSAL} or below support ${MIN_SUPPORT_FOR_PROPOSAL} are investigation notes, never proposals`,
		);
	});
});

describe('consensus_mine — summarized_count does not overclaim', () => {
	function attribute(id: string, llmSummary?: string): ConsensusAttributeV1 {
		return {
			v: 1,
			id,
			statement: `statement ${id}`,
			...(llmSummary ? { llmSummary } : {}),
			support: 2,
			successSupport: 2,
			failureSupport: 0,
			taskDiversity: 2,
			modelDiversity: 0,
			evidenceRefs: [],
			counterexampleRefs: [],
			confidence: 0.5,
			proposedTarget: 'none',
		};
	}

	test('counts a summary that the inline echo cannot show', () => {
		// The reproduction: restatements go to the top 20 by CONFIDENCE, the echo is
		// the first 25 in SIGNAL order. Invert one against the other and
		// `summarized_count: 20` prints beside zero visible `llm_summary` values.
		const attributes = [
			...Array.from({ length: MAX_INLINE_ATTRIBUTES }, (_, index) =>
				attribute(`cattr_shown_${index}`),
			),
			...Array.from({ length: 20 }, (_, index) =>
				attribute(`cattr_hidden_${index}`, 'Restated finding.'),
			),
		];
		expect(countSummaries(attributes, MAX_INLINE_ATTRIBUTES)).toEqual({
			total: 20,
			hidden: 20,
		});
	});

	test('nothing is hidden when every summary is inside the echo', () => {
		const attributes = [
			attribute('cattr_a', 'Restated finding.'),
			attribute('cattr_b'),
		];
		expect(countSummaries(attributes, MAX_INLINE_ATTRIBUTES)).toEqual({
			total: 1,
			hidden: 0,
		});
	});

	test('the tool prints both counters, and they agree with the echo', async () => {
		// No dispatcher is wired here, so every count is zero — the assertion that
		// matters is that `summarized_but_not_shown` exists at all, since without it
		// a non-zero `summarized_count` beside an empty echo is unreadable.
		const result = await run(seedCorpus(project()), MINE);
		expect(result.summarized_count).toBe(0);
		expect(result.summarized_but_not_shown).toBe(0);
		expect(
			attributesOf(result).filter(
				(attribute) => attribute.llm_summary !== undefined,
			),
		).toHaveLength(
			(result.summarized_count as number) -
				(result.summarized_but_not_shown as number),
		);
	});
});

describe('consensus_mine — retention reporting under a disabled retention', () => {
	function withRetention(root: string, retention: number): string {
		const configDir = path.join(root, '.opencode');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({ consensus: { report_retention: retention } }),
			'utf-8',
		);
		return root;
	}

	test('report_retention 0 declares pruning off instead of printing retained 0', async () => {
		// `pruneConsensusReports` returns three empty arrays in this mode: nothing
		// was deleted and nothing was enumerated. Printing `retained: 0` told the
		// model every report had been discarded — the exact opposite of the truth.
		const root = withRetention(seedCorpus(project()), 0);
		const first = await run(root, MINE);
		const second = await run(root, MINE);
		expect(second.report_id).not.toBe(first.report_id as string);

		const retention = second.retention as Record<string, unknown>;
		expect(retention).toEqual({
			configured: 0,
			pruning_enabled: false,
			deleted: 0,
			failed: 0,
		});
		expect(retention.retained).toBeUndefined();
		// `corrupt` is omitted for the same reason as `retained`: this mode
		// enumerates nothing, so printing `corrupt: 0` would assert a clean store
		// that was never inspected.
		expect(retention.corrupt).toBeUndefined();
		// Both reports really are still on disk, which is what `retained: 0` denied.
		expect(
			readdirSync(path.join(root, '.swarm', 'evolution', 'consensus')),
		).toHaveLength(2);
	});

	test('an enabled retention still reports the count it actually kept', async () => {
		const root = withRetention(seedCorpus(project()), 1);
		await run(root, MINE);
		const second = await run(root, MINE);
		expect(second.retention).toEqual({
			configured: 1,
			pruning_enabled: true,
			deleted: 1,
			retained: 1,
			failed: 0,
			corrupt: 0,
		});
		expect(
			readdirSync(path.join(root, '.swarm', 'evolution', 'consensus')),
		).toHaveLength(1);
	});
});
