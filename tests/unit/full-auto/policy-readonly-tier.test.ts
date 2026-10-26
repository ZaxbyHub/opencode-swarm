/**
 * Full-Auto classifier: the audited read-only swarm tools are allowed without
 * a critic dispatch; look-alikes that write stay escalated. Kept apart from
 * policy.test.ts, which is at the FR-006 line cap.
 */
import { describe, expect, test } from 'bun:test';
import {
	classifyFullAutoToolAction,
	type FullAutoClassifierInput,
	isReadOnlyTool,
} from '../../../src/full-auto/policy';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata';

const AUDITED_READ_ONLY = [
	'skill_list',
	'skill_inspect',
	'external_skill_list',
	'external_skill_inspect',
	'knowledge_receipt_status',
	'retrieve_lane_output',
	'lean_turbo_plan_lanes',
	'plan_conflict_check',
	'scope_validate',
	'context_status',
	'suggest_patch',
] as const;

// Read-shaped names that write or mutate state on their read path.
const WRITES_ON_READ_PATH = [
	'lean_turbo_status',
	'lean_turbo_runner_status',
	'export_pr_review_partial_results',
	'convene_general_council',
] as const;

function input(toolName: string): FullAutoClassifierInput {
	return {
		sessionID: 'sess-1',
		toolName,
		args: {},
		directory: '/repo/project',
		fullAutoConfig: {
			enabled: true,
			mode: 'supervised',
			permission_policy: { enabled: true, allow_defaults: true },
		},
	};
}

describe('Full-Auto read-only swarm tool tier', () => {
	test.each(AUDITED_READ_ONLY)('%s is allowed without a critic', (tool) => {
		const verdict = classifyFullAutoToolAction(input(tool));
		expect(verdict.action).toBe('allow');
		expect(isReadOnlyTool(tool)).toBe(true);
	});

	test.each(
		WRITES_ON_READ_PATH,
	)('%s still escalates (negative control)', (tool) => {
		expect(isReadOnlyTool(tool)).toBe(false);
		expect(classifyFullAutoToolAction(input(tool)).action).toBe(
			'escalate_critic',
		);
	});

	test('an unknown tool name still escalates', () => {
		expect(classifyFullAutoToolAction(input('not_a_tool')).action).toBe(
			'escalate_critic',
		);
	});

	test('every audited and look-alike name is a registered swarm tool', () => {
		// A rename upstream must fail here instead of silently dropping a tool
		// out of the tier (or turning a stale name into dead config).
		const registered = new Set<string>(TOOL_NAMES);
		for (const tool of [...AUDITED_READ_ONLY, ...WRITES_ON_READ_PATH]) {
			expect(registered.has(tool)).toBe(true);
		}
	});
});
