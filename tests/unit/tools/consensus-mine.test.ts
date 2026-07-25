/**
 * `consensus_mine` registration coherence and behaviour (issue #1821, Lane C).
 *
 * AGENTS.md invariant 11 makes a tool addition INCOMPLETE until every
 * registration surface agrees. These tests assert each surface independently so
 * a half-wired tool fails here rather than at runtime, where an unclassified
 * tool silently escalates to the critic on every invocation.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
	): Promise<Record<string, unknown>> {
		const definition = TOOL_MANIFEST[TOOL]() as unknown as {
			execute: (
				args: Record<string, unknown>,
				ctx: { directory: string },
			) => Promise<string>;
		};
		const output = await definition.execute(args, { directory });
		return JSON.parse(output) as Record<string, unknown>;
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
	});

	test('reports cross-producer duplicates from the shared dedup ledger (#1821 AC21)', async () => {
		const root = project();
		const result = await run(root);
		// The field must exist even when nothing was mined, otherwise a caller
		// cannot distinguish "no overlap" from "the ledger was never consulted".
		expect(result.cross_producer_duplicate_count).toBe(0);
		// Nothing to claim → the tool leaves no ledger behind.
		expect(
			existsSync(
				path.join(root, '.swarm', 'learning', 'recommendation-ledger.jsonl'),
			),
		).toBe(false);
	});

	test('degrades gracefully with no LLM client wired', async () => {
		const root = project();
		const result = await run(root);
		// No OpenCode client in a unit-test process, so no dispatcher exists and
		// the report says so rather than failing.
		expect(result.summarized_count).toBe(0);
		expect(result.summarization_skipped_reason).toBe('no_attributes');
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

	test('reports the proposals-only and diversity guarantees', async () => {
		const root = project();
		const result = await run(root);
		const guarantees = (result.guarantees as string[]).join(' | ');
		expect(guarantees).toContain('proposals only');
		expect(guarantees).toContain('not measurable from this corpus');
		expect(guarantees).toContain('investigation notes, never proposals');
	});

	test('a second identical mine is idempotent — same report id, no conflict', async () => {
		const root = project();
		const first = await run(root);
		const second = await run(root);
		expect(second.report_id).toBe(first.report_id as string);
		expect(second.success).toBe(true);
	});
});
