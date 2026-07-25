/**
 * `consensus_mine` registration coherence and behaviour (issue #1821, Lane C).
 *
 * AGENTS.md invariant 11 makes a tool addition INCOMPLETE until every
 * registration surface agrees. These tests assert each surface independently so
 * a half-wired tool fails here rather than at runtime, where an unclassified
 * tool silently escalates to the critic on every invocation.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
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
import {
	AGENT_TOOL_MAP,
	WRITE_TOOL_NAMES,
} from '../../../src/config/constants';
import { classifyFullAutoToolAction } from '../../../src/full-auto/policy';
import { _test_exports as dispatchLaneInternals } from '../../../src/tools/dispatch-lanes';
import * as tools from '../../../src/tools/index';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../../src/tools/tool-names';

const TOOL = 'consensus_mine';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-tool-')),
	);
	roots.push(root);
	return root;
}

describe('consensus_mine — registration surfaces', () => {
	test('is exported from src/tools/index.ts', () => {
		expect((tools as Record<string, unknown>).consensus_mine).toBeDefined();
	});

	test('has a TOOL_METADATA entry with a description', () => {
		expect(TOOL_METADATA[TOOL]).toBeDefined();
		expect(TOOL_METADATA[TOOL].description.length).toBeGreaterThan(0);
	});

	test('is granted to architect, curator_phase, and curator_postmortem', () => {
		// `curator` is NOT an AgentName — using it here would be a compile error.
		expect([...TOOL_METADATA[TOOL].agents].sort()).toEqual([
			'architect',
			'curator_phase',
			'curator_postmortem',
		]);
	});

	test('appears in the agent tool map for each granted agent', () => {
		for (const agent of ['architect', 'curator_phase', 'curator_postmortem']) {
			expect(AGENT_TOOL_MAP[agent as keyof typeof AGENT_TOOL_MAP]).toContain(
				TOOL,
			);
		}
	});

	test('is absent from an agent it was not granted to', () => {
		expect(AGENT_TOOL_MAP.coder).not.toContain(TOOL);
	});

	test('has a handler in TOOL_MANIFEST that resolves to a tool definition', () => {
		const handler = TOOL_MANIFEST[TOOL];
		expect(handler).toBeDefined();
		expect(typeof handler).toBe('function');
		expect(handler()).toBeDefined();
	});

	test('is derived into TOOL_NAMES and TOOL_NAME_SET', () => {
		// tool-names.ts is a pure re-export facade over TOOL_METADATA, so this
		// asserts the derivation actually happened rather than a hand-edit.
		expect(TOOL_NAMES).toContain(TOOL);
		expect(TOOL_NAME_SET.has(TOOL)).toBe(true);
	});

	test('omits prWorkflow metadata so it stays fail-closed in PR modes', () => {
		// Deliberate: a mining tool writes .swarm state, which a review-only
		// workflow must not do. Omission is the fail-closed default.
		expect(TOOL_METADATA[TOOL].prWorkflow).toBeUndefined();
	});
});

describe('consensus_mine — full-auto policy classification', () => {
	const classify = (toolName: string) =>
		classifyFullAutoToolAction({
			sessionID: 'session-1',
			toolName,
			args: {},
			directory: '/project',
			fullAutoConfig: undefined,
		});

	test('is allowed as a pathless write-like tool, not escalated', () => {
		// The regression this guards: an unclassified tool falls through to the
		// unknown-tool branch and returns `escalate_critic` on EVERY invocation.
		const decision = classify(TOOL);
		expect(decision.action).toBe('allow');
		expect(decision.reason).toContain('pathless');
	});

	test('is not left to the unknown-tool fallback', () => {
		const decision = classify(TOOL);
		expect(decision.reason).not.toContain('not deterministically classifiable');
	});

	test('is classified exactly like write_retro and knowledge_add', () => {
		const consensus = classify(TOOL);
		const retro = classify('write_retro');
		const knowledge = classify('knowledge_add');
		expect(consensus.action).toBe(retro.action);
		expect(consensus.action).toBe(knowledge.action);
		expect(consensus.reason).toBe(retro.reason.replace('write_retro', TOOL));
	});

	test('is NOT in WRITE_TOOL_NAMES — it writes no project file contents', () => {
		// WRITE_TOOL_NAMES drives the scope guard for PROJECT FILE writes.
		// knowledge_add and write_retro are deliberately absent for the same
		// reason; adding consensus_mine would also force a hardcoded
		// count-assertion change elsewhere.
		expect(WRITE_TOOL_NAMES).not.toContain(TOOL);
		expect(WRITE_TOOL_NAMES).not.toContain('knowledge_add');
		expect(WRITE_TOOL_NAMES).not.toContain('write_retro');
	});
});

describe('consensus_mine — read-only lane denylist', () => {
	test('is disabled in a read-only dispatch lane', () => {
		// It persists a report under .swarm/, so a read-only lane must not be
		// able to invoke it.
		const permissions = dispatchLaneInternals.buildReadOnlyTools() as Record<
			string,
			boolean
		>;
		expect(permissions[TOOL]).toBe(false);
	});

	test('shares the denylist with the other .swarm-writing tools', () => {
		const permissions = dispatchLaneInternals.buildReadOnlyTools() as Record<
			string,
			boolean
		>;
		expect(permissions.knowledge_add).toBe(false);
		expect(permissions.write_retro).toBe(false);
	});
});

describe('consensus_mine — execution', () => {
	async function run(
		directory: string,
		args: Record<string, unknown> = {},
		sessionID?: string,
	): Promise<Record<string, unknown>> {
		const definition = TOOL_MANIFEST[TOOL]() as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: { directory: string; sessionID?: string },
			) => Promise<string>;
		};
		const output = await definition.execute(args, {
			directory,
			...(sessionID ? { sessionID } : {}),
		});
		return JSON.parse(output) as Record<string, unknown>;
	}

	/**
	 * A real, mineable corpus: three task trajectories that all end in the same
	 * failing action.
	 *
	 * This exists because every execution test used to run against an EMPTY temp
	 * project, where 0 observations ⇒ 0 attributes ⇒ 0 proposals. That made the
	 * assertions below unfalsifiable — "idempotent" was true only because there
	 * was nothing to propose, and the AC21 ledger mapping never executed at all.
	 */
	function seedCorpus(root: string, tasks = ['task-a', 'task-b', 'task-c']) {
		const line = (step: number) =>
			JSON.stringify({
				step,
				agent: 'coder',
				action: 'run',
				target: '',
				intent: '',
				timestamp: '2026-01-01T00:00:00.000Z',
				result: 'failure',
				tool: 'test_runner',
				elapsed_ms: 5,
			});
		for (const taskId of tasks) {
			const taskDir = path.join(root, '.swarm', 'evidence', taskId);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, 'trajectory.jsonl'),
				`${[line(1), line(2)].join('\n')}\n`,
				'utf-8',
			);
		}
		return root;
	}

	const MINE_ARGS = { min_support: 2, min_successful_runs: 0 };

	function ledgerPath(root: string): string {
		return path.join(root, '.swarm', 'learning', 'recommendation-ledger.jsonl');
	}

	function reportsIn(root: string): string[] {
		const dir = path.join(root, '.swarm', 'evolution', 'consensus');
		return existsSync(dir) ? readdirSync(dir).sort() : [];
	}

	test('mines an empty project without writing outside .swarm', async () => {
		const root = project();
		const result = await run(root);
		expect(result.success).toBe(true);
		expect(String(result.report_path)).toStartWith(
			'.swarm/evolution/consensus/',
		);
		expect(result.attribute_count).toBe(0);
		expect(result.proposal_count).toBe(0);
		expect(readdirSync(root)).toEqual(['.swarm']);
	});

	test('mines a real corpus into attributes and proposals', async () => {
		const root = seedCorpus(project());
		const result = await run(root, MINE_ARGS);
		expect(result.success).toBe(true);
		expect(result.attribute_count).toBe(1);
		expect(result.proposal_count).toBe(1);
		expect(result.input_run_count).toBe(3);
	});

	test('records every mined proposal in the shared dedup ledger (#1821 AC21)', async () => {
		// The AC21 mapping (`buildMinerRecommendationCandidates`) only runs when
		// there ARE proposals. Asserting the ledger is ABSENT on an empty project
		// asserted that the mapping never executed.
		const root = seedCorpus(project());
		const result = await run(root, MINE_ARGS);
		expect(result.cross_producer_duplicate_count).toBe(0);
		expect(existsSync(ledgerPath(root))).toBe(true);
		const entries = readFileSync(ledgerPath(root), 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe('miner');
		expect(entries[0]?.target).toBe('orchestration');
		expect(entries[0]?.emittedAt).toBe(result.generated_at as string);
	});

	test('BEHAVIOUR behind the reproducibility guarantee: the session does not move the id', async () => {
		// The guarantee string is printed into the model's context, so it needs a
		// test of the BEHAVIOUR, not of its own wording. `sessionID` reaches
		// `provenance.writeOrigin`; while that was hashed, two sessions mining an
		// identical corpus produced two different reports — and no tool test could
		// see it, because none of them passed a sessionID.
		const rootA = seedCorpus(project());
		const rootB = seedCorpus(project());
		const fromA = await run(rootA, MINE_ARGS, 'ses_AAAAAAAA');
		const fromB = await run(rootB, MINE_ARGS, 'ses_BBBBBBBB');
		expect(fromA.proposal_count).toBe(1);
		expect(fromB.report_id).toBe(fromA.report_id as string);
		expect(fromB.integrity_hash).toBe(fromA.integrity_hash as string);
	});

	test('summarized_count describes the report actually returned', async () => {
		// With no dispatcher wired there are no restatements at all, so both
		// counters agree at zero. The field exists so a re-mine that returns an
		// already-stored artifact cannot print a count from a different run.
		const root = seedCorpus(project());
		const result = await run(root, MINE_ARGS);
		expect(result.summarized_count).toBe(0);
		expect(result.restatements_accepted_this_run).toBe(0);
		const inlined = result.attributes as Array<Record<string, unknown>>;
		expect(
			inlined.filter((entry) => entry.llm_summary !== undefined),
		).toHaveLength(result.summarized_count as number);
	});

	test('an empty project claims nothing, so it leaves no ledger behind', async () => {
		const root = project();
		const result = await run(root);
		// The field must still exist, or a caller cannot distinguish "no overlap"
		// from "the ledger was never consulted".
		expect(result.cross_producer_duplicate_count).toBe(0);
		expect(existsSync(ledgerPath(root))).toBe(false);
	});

	test('degrades gracefully with no LLM client wired', async () => {
		// On a real corpus this reaches the `no_dispatcher` branch the test is
		// named for. Against an empty project it reported `no_attributes`, because
		// `summarizeStatements` checks the empty-attribute case first — so the
		// branch under test was unreachable.
		const root = seedCorpus(project());
		const result = await run(root, MINE_ARGS);
		expect(result.attribute_count).toBeGreaterThan(0);
		expect(result.summarized_count).toBe(0);
		expect(result.summarization_skipped_reason).toBe('no_dispatcher');
	});

	test('surfaces the thresholds it actually applied', async () => {
		const root = project();
		const result = await run(root, {
			min_support: 7,
			min_successful_runs: 3,
			max_evidence_items: 11,
		});
		expect(result.thresholds).toEqual({
			min_support: 7,
			min_successful_runs: 3,
			max_evidence_items: 11,
			min_task_diversity: 2,
		});
	});

	test('surfaces the truncation record from the persisted report', async () => {
		const root = seedCorpus(project());
		const result = await run(root, MINE_ARGS);
		expect(result.truncation).toEqual({
			corpus: false,
			observations_tallied: 6,
			input_ids_truncated: false,
			total_input_ids: 3,
			attributes_dropped: 0,
		});
	});

	test('a corpus cut is reported rather than hidden', async () => {
		const root = seedCorpus(project());
		const result = await run(root, { ...MINE_ARGS, max_evidence_items: 2 });
		expect(result.corpus_truncated).toBe(true);
		expect((result.truncation as Record<string, unknown>).corpus).toBe(true);
		expect(
			(result.truncation as Record<string, unknown>).observations_tallied,
		).toBe(2);
	});

	test('reports the proposals-only and diversity guarantees', async () => {
		const root = project();
		const result = await run(root);
		const guarantees = (result.guarantees as string[]).join(' | ');
		expect(guarantees).toContain('proposals only');
		expect(guarantees).toContain('not measurable from this corpus');
		expect(guarantees).toContain('investigation notes, never proposals');
		expect(guarantees).toContain('no mutation of any evidence read');
		expect(guarantees).toContain('excluded from integrity_hash');
		expect(guarantees).toContain('always carries counterexample refs');
		expect(guarantees).toContain('same integrity_hash and report_id');
		// The two guarantees that must stay QUALIFIED. An earlier revision of this
		// tool printed unqualified versions of both, and they were false: the
		// truncation balance is per source, and `config_hash` is hashed content.
		expect(guarantees).toContain(
			'drops whole sources once the budget is spent',
		);
		expect(guarantees).toContain('config_hash');
		expect(guarantees).not.toContain(
			'negative evidence and counterexamples are always retained',
		);
	});

	test('re-mining an unchanged corpus proposes nothing new and conflicts with nothing', async () => {
		// The ACTUAL behaviour, which "idempotent — same report id" misdescribed.
		// Mine 2 dedupes every proposal against mine 1's stored fingerprints, so
		// its content genuinely differs: zero proposals. A content-addressed report
		// with different content necessarily has a different id, and BOTH reports
		// are retained. This is correct — it is the record that a second run found
		// nothing new — but it is not idempotence.
		const root = seedCorpus(project());
		const first = await run(root, MINE_ARGS);
		expect(first.proposal_count).toBe(1);

		const second = await run(root, MINE_ARGS);
		expect(second.success).toBe(true);
		expect(second.proposal_count).toBe(0);
		expect(second.deduped_proposal_count).toBe(1);
		// Same evidence, so the attributes are unchanged...
		expect(second.attribute_count).toBe(first.attribute_count as number);
		// ...but the report is a different artifact, and both are on disk.
		expect(second.report_id).not.toBe(first.report_id as string);
		expect(reportsIn(root)).toHaveLength(2);
	});

	test('a third mine adds nothing further — the dedup reaches a fixed point', async () => {
		const root = seedCorpus(project());
		await run(root, MINE_ARGS);
		const second = await run(root, MINE_ARGS);
		const third = await run(root, MINE_ARGS);
		// Once proposals are exhausted the content stops changing, so the report
		// id stabilises and re-mining really is idempotent from here on.
		expect(third.report_id).toBe(second.report_id as string);
		expect(third.proposal_count).toBe(0);
		expect(reportsIn(root)).toHaveLength(2);
	});

	test('an empty project re-mines to the same report id', async () => {
		// With nothing to propose there is nothing to dedupe, so the degenerate
		// case really is idempotent — which is exactly why it proved nothing.
		const root = project();
		const first = await run(root);
		const second = await run(root);
		expect(second.report_id).toBe(first.report_id as string);
		expect(reportsIn(root)).toHaveLength(1);
	});
});
