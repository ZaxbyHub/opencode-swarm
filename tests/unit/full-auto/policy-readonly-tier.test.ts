/**
 * Full-Auto classifier: the audited read-only swarm tools are allowed without
 * a critic dispatch; look-alikes that write stay escalated. Kept apart from
 * policy.test.ts, which is at the FR-006 line cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	classifyFullAutoToolAction,
	FULL_AUTO_AUDITED_READ_ONLY_SWARM_TOOLS,
	type FullAutoClassifierInput,
	isReadOnlyTool,
	isWriteLikeTool,
} from '../../../src/full-auto/policy';
import {
	pauseFullAutoRun,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { createFullAutoPermissionHook } from '../../../src/hooks/full-auto-permission';
import { _internals as stateInternals, swarmState } from '../../../src/state';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// The set under test is the real exported one. Pinning its exact membership
// here means a twelfth name cannot slip into the no-critic tier without a
// reviewer seeing this list change too.
const EXPECTED_AUDITED = [
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

function input(
	toolName: string,
	mode: 'supervised' | 'strict' = 'supervised',
): FullAutoClassifierInput {
	return {
		sessionID: 'sess-1',
		toolName,
		args: {},
		directory: '/repo/project',
		fullAutoConfig: {
			enabled: true,
			mode,
			permission_policy: { enabled: true, allow_defaults: true },
		},
	};
}

describe('Full-Auto read-only swarm tool tier', () => {
	test('the exported audited list is exactly the reviewed eleven names', () => {
		expect([...FULL_AUTO_AUDITED_READ_ONLY_SWARM_TOOLS].sort()).toEqual(
			[...EXPECTED_AUDITED].sort(),
		);
		for (const tool of FULL_AUTO_AUDITED_READ_ONLY_SWARM_TOOLS) {
			expect(isReadOnlyTool(tool)).toBe(true);
		}
	});

	test.each(
		EXPECTED_AUDITED,
	)('%s is allowed at the safe tier without a critic', (tool) => {
		for (const mode of ['supervised', 'strict'] as const) {
			expect(classifyFullAutoToolAction(input(tool, mode))).toEqual({
				action: 'allow',
				reason: 'read-only tool',
				tier: 'safe',
			});
		}
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

	test('the read-only and write-like sets stay disjoint for the audited names', () => {
		// suggest_patch used to sit in both sets, so the verdict depended on which
		// classifier branch ran first.
		for (const tool of FULL_AUTO_AUDITED_READ_ONLY_SWARM_TOOLS) {
			expect(isWriteLikeTool(tool)).toBe(false);
		}
	});

	test('a role limited to audited names delegates without a critic outside strict mode', () => {
		// The set also feeds resolveDelegationRisk: with a tool_filter override a
		// reviewer limited to read-only names is a read-only delegation.
		const delegate = (mode: 'supervised' | 'strict') =>
			classifyFullAutoToolAction({
				...input('task', mode),
				args: { subagent_type: 'reviewer' },
				pluginConfig: {
					tool_filter: {
						overrides: { reviewer: ['read', 'grep', 'suggest_patch'] },
					},
				},
			});
		expect(delegate('supervised')).toMatchObject({
			action: 'allow',
			tier: 'local',
		});
		expect(delegate('strict').action).toBe('escalate_critic');
	});

	test('every audited and look-alike name is a registered swarm tool', () => {
		// A rename upstream must fail here instead of silently dropping a tool
		// out of the tier (or turning a stale name into dead config).
		const registered = new Set<string>(TOOL_NAMES);
		for (const tool of [
			...FULL_AUTO_AUDITED_READ_ONLY_SWARM_TOOLS,
			...WRITES_ON_READ_PATH,
		]) {
			expect(registered.has(tool)).toBe(true);
		}
	});
});

// isReadOnlyTool is shared with the permission hook, so adding a name also
// lets it run while a run is paused. Pin that here so the widening is a
// reviewed decision, not an accident.
describe('Full-Auto permission hook with audited read-only names', () => {
	let tmpDir: string;
	let origClient: typeof stateInternals.swarmState.opencodeClient;

	function makeConfig(): PluginConfig {
		return {
			full_auto: {
				enabled: true,
				mode: 'supervised',
				fail_closed: true,
				permission_policy: { enabled: true, allow_defaults: true },
				denials: { max_consecutive: 3, max_total: 20, on_limit: 'pause' },
			},
			agents: {},
		} as unknown as PluginConfig;
	}

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('full-auto-tier-');
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		origClient = stateInternals.swarmState.opencodeClient;
		stateInternals.swarmState.opencodeClient = null;
		swarmState.activeAgent.set('sess-1', 'architect');
	});

	afterEach(() => {
		stateInternals.swarmState.opencodeClient = origClient;
		swarmState.activeAgent.delete('sess-1');
		swarmState.agentSessions.delete('sess-1');
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test.each(
		EXPECTED_AUDITED,
	)('%s still runs while the run is paused', async (tool) => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		await expect(
			hook.toolBefore(
				{ tool, sessionID: 'sess-1', callID: 'c1' },
				{ args: {} },
			),
		).resolves.toBeUndefined();
	});

	test.each(
		WRITES_ON_READ_PATH,
	)('%s is still blocked while the run is paused', async (tool) => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		await expect(
			hook.toolBefore(
				{ tool, sessionID: 'sess-1', callID: 'c1' },
				{ args: {} },
			),
		).rejects.toThrow(/FULL_AUTO_PAUSED/);
	});
});
