/**
 * Issue #2033 — authorization policy for `knowledge hive-quarantine`.
 *
 * The mutation must be unreachable by agents: swarm_command refusal, chat-fallback
 * refusal, shell-bypass guardrail (bunx/npx/bare/apply_patch embedded — exercised via the
 * REAL guardrail hook, following the #890 regression-suite pattern), and registry
 * toolPolicy. No env/config bypass exists.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	resolveCommand,
} from '../../../src/commands/registry.js';
import {
	classifySwarmCommandChatFallbackUse,
	classifySwarmCommandToolUse,
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../../../src/commands/tool-policy.js';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

const KEY = 'knowledge hive-quarantine';

function resolve(tokens: string[]) {
	const resolved = resolveCommand(tokens);
	expect(resolved).not.toBeNull();
	return resolved as NonNullable<ReturnType<typeof resolveCommand>>;
}

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		block_destructive_commands: true,
	};
}

async function expectShellBlocked(command: string): Promise<void> {
	const hooks = createGuardrailsHooks('/tmp', undefined, defaultConfig());
	await expect(
		hooks.toolBefore(
			{ tool: 'bash', sessionID: 'hq-session', callID: 'call-1' },
			{ args: { command } },
		),
	).rejects.toThrow(/human-only swarm command/);
}

describe('knowledge hive-quarantine policy (issue #2033)', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('hq-session', 'architect');
	});

	test('registry entry exists with toolPolicy human-only and knowledge parent', () => {
		const entry = COMMAND_REGISTRY[
			'knowledge hive-quarantine' as keyof typeof COMMAND_REGISTRY
		] as { toolPolicy?: string; subcommandOf?: string } | undefined;
		expect(entry).toBeDefined();
		expect(entry?.toolPolicy).toBe('human-only');
		expect(entry?.subcommandOf).toBe('knowledge');
	});

	test('resolveCommand maps the two-token compound key with remaining args', () => {
		const r = resolve(['knowledge', 'hive-quarantine', 'preview', 'id-1']);
		expect(r.key).toBe(KEY);
		expect(r.remainingArgs).toEqual(['preview', 'id-1']);
	});

	test('registry human-only bucket still contains exactly the expected 9 commands', () => {
		// Mirrors the no-regression bucket snapshot in registry.tool-policy.test.ts
		// (which cannot grow: FR-006 over-cap ratchet) — #2033's entry made it 9.
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as { toolPolicy?: string }).toolPolicy === 'human-only') {
				actual.add(name);
			}
		}
		expect([...actual].sort()).toEqual(
			[
				'review',
				'memory compact',
				'memory import',
				'memory migrate',
				'skill-opt run',
				'skill-opt approve',
				'skill-opt reject',
				'skill-opt rollback',
				'knowledge hive-quarantine',
			].sort(),
		);
	});

	test('excluded from the agent allowlist, present in human-only set and tool enum', () => {
		expect(SWARM_COMMAND_TOOL_ALLOWLIST.has(KEY)).toBe(false);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has(KEY)).toBe(true);
		// human-only commands ARE in the tool enum (they get the ask-the-user refusal).
		expect(SWARM_COMMAND_TOOL_COMMANDS.includes(KEY)).toBe(true);
	});

	test('swarm_command classification refuses agents with the human-only message', () => {
		const previewVerdict = classifySwarmCommandToolUse(
			resolve(['knowledge', 'hive-quarantine', 'preview']),
		);
		expect(previewVerdict.allowed).toBe(false);
		expect(previewVerdict.message).toContain('human-only');
		const commitVerdict = classifySwarmCommandToolUse(
			resolve(['knowledge', 'hive-quarantine', 'commit', '--token', 'x']),
		);
		expect(commitVerdict.allowed).toBe(false);
	});

	test('chat fallback classification refuses', () => {
		const verdict = classifySwarmCommandChatFallbackUse(
			resolve(['knowledge', 'hive-quarantine', 'commit', '--token', 'x']),
		);
		expect(verdict.allowed).toBe(false);
		expect(verdict.message).toContain('chat fallback');
	});

	test('shell-bypass guardrail blocks agent shells (bunx, npx, bare)', async () => {
		await expectShellBlocked(
			'bunx opencode-swarm run knowledge hive-quarantine commit --token x',
		);
		await expectShellBlocked(
			'npx opencode-swarm run "knowledge hive-quarantine" commit --token x',
		);
		await expectShellBlocked(
			'opencode-swarm run knowledge hive-quarantine rollback --latest',
		);
	});

	test('toolPolicy is a compile-time registry literal — no env/config knob can weaken it', () => {
		const before = process.env.SWARM_HIVE_QUARANTINE_ALLOW;
		process.env.SWARM_HIVE_QUARANTINE_ALLOW = '1';
		try {
			const verdict = classifySwarmCommandToolUse(
				resolve(['knowledge', 'hive-quarantine', 'commit', '--token', 'x']),
			);
			expect(verdict.allowed).toBe(false);
		} finally {
			if (before === undefined) delete process.env.SWARM_HIVE_QUARANTINE_ALLOW;
			else process.env.SWARM_HIVE_QUARANTINE_ALLOW = before;
		}
	});

	test('the bare knowledge parent remains agent-safe (list-only) and cannot reach the mutation', () => {
		const bare = classifySwarmCommandToolUse(resolve(['knowledge']));
		expect(bare.allowed).toBe(true);
		const sub = classifySwarmCommandToolUse(
			resolve(['knowledge', 'hive-quarantine']),
		);
		expect(sub.allowed).toBe(false);
	});
});
