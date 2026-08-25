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

	test('registry human-only bucket still contains exactly the expected 11 commands', () => {
		// Mirrors the no-regression bucket snapshot in tool-policy.human-only.test.ts
		// (moved out of the FR-006 over-capped registry.tool-policy.test.ts) —
		// #2033's entry made it 9; #2268's /swarm recover made it 10.
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as { toolPolicy?: string }).toolPolicy === 'human-only') {
				actual.add(name);
			}
		}
		expect([...actual].sort()).toEqual(
			[
				'full-auto',
				'review',
				'memory compact',
				'memory import',
				'memory migrate',
				'skill-opt run',
				'skill-opt approve',
				'skill-opt reject',
				'skill-opt rollback',
				'knowledge hive-quarantine',
				'recover',
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

	test('shell-bypass guardrail blocks variable-indirection and partial-quote shapes (PR feedback PRR-001/CC-3)', async () => {
		await expectShellBlocked(
			"CMD='knowledge hive-quarantine commit --token x' && bunx opencode-swarm run $CMD",
		);
		await expectShellBlocked(
			'CMD=knowledge; bunx opencode-swarm run "$CMD hive-quarantine" commit',
		);
		await expectShellBlocked(
			"bunx opencode-swarm run knowledge 'hive-quarantine' commit --token x",
		);
		await expectShellBlocked(
			'/usr/local/bin/bunx opencode-swarm run knowledge hive-quarantine commit',
		);
		await expectShellBlocked(
			'./node_modules/.bin/opencode-swarm run "knowledge hive-quarantine" commit',
		);
		await expectShellBlocked(
			'node dist/cli/index.js run knowledge hive-quarantine rollback --latest',
		);
	});

	test('shell-bypass guardrail does not false-block legitimate variable and path commands', async () => {
		const hooks = createGuardrailsHooks('/tmp', undefined, defaultConfig());
		for (const command of [
			'bunx opencode-swarm run status',
			'CMD=status && bunx opencode-swarm run $CMD',
			'bunx opencode-swarm run knowledge list',
			'CMD=knowledge; bunx opencode-swarm run "$CMD list"',
			'/usr/local/bin/git log --oneline -5',
			'./scripts/build.sh --fast',
		]) {
			await expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'hq-session', callID: 'c1' },
					{ args: { command } },
				),
			).resolves.toBeUndefined();
		}
	});

	test('guardrail blocks quoted-assignment, alias, and unresolvable-substitution shapes (review N2/N3 backstop)', async () => {
		// Quoted leading assignment used to defeat the runner anchor before the
		// quoted-value strip landed; the dash alias used to defeat the CLI gate
		// before aliasOf resolution landed; $(…) substitution is unresolvable so
		// the guard fails closed and demands a literal subcommand.
		await expectShellBlocked(
			"JUNK='a b' bunx opencode-swarm run memory-import",
		);
		await expectShellBlocked(
			"JUNK='x y' bunx opencode-swarm run knowledge hive-quarantine commit --token t",
		);
		// Command substitution is unresolvable — the guard fails closed with the
		// literal-subcommand demand rather than the human-only message.
		const hooks = createGuardrailsHooks('/tmp', undefined, defaultConfig());
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'hq-session', callID: 'c1' },
				{
					args: {
						command:
							"CMD=$(echo 'knowledge hive-quarantine') && bunx opencode-swarm run $CMD",
					},
				},
			),
		).rejects.toThrow(/unresolvable shell variable/);
	});

	test('CLI refuses the alias of a human-only command from a non-interactive shell (review finding 1)', async () => {
		const { run } = await import('../../../src/cli/index.js');
		const prev = process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
		delete process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
		try {
			// 'memory-import' is a deprecated alias of human-only 'memory import'.
			await expect(run(['memory-import'])).resolves.toBe(1);
		} finally {
			if (prev === undefined) delete process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
			else process.env.SWARM_ALLOW_HUMAN_ONLY_CLI = prev;
		}
	});

	test('guardrail still allows legitimate quoted assignments and resolved allowed commands', async () => {
		const hooks = createGuardrailsHooks('/tmp', undefined, defaultConfig());
		for (const command of [
			'FOO="a b" ./scripts/build.sh --fast',
			"CMD='knowledge list' && bunx opencode-swarm run $CMD",
			'bunx opencode-swarm run knowledge',
		]) {
			await expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'hq-session', callID: 'c1' },
					{ args: { command } },
				),
			).resolves.toBeUndefined();
		}
	});

	test('CLI refuses human-only commands from non-interactive shells (CC-2)', async () => {
		const { run } = await import('../../../src/cli/index.js');
		const prev = process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
		delete process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
		try {
			await expect(
				run(['knowledge', 'hive-quarantine', 'status']),
			).resolves.toBe(1);
			await expect(run(['reset'])).resolves.toBe(1);
		} finally {
			if (prev === undefined) delete process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
			else process.env.SWARM_ALLOW_HUMAN_ONLY_CLI = prev;
		}
	});

	test('SWARM_ALLOW_HUMAN_ONLY_CLI=1 is the explicit automation opt-in (CC-2)', async () => {
		const { run } = await import('../../../src/cli/index.js');
		const prev = process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
		process.env.SWARM_ALLOW_HUMAN_ONLY_CLI = '1';
		try {
			// 'reset' is restricted: with the opt-in the CLI dispatches it (the
			// handler itself is mocked nowhere — the real reset handler runs on a
			// temp cwd and reports its usage/confirmation message; exit code 0).
			const code = await run(['reset']);
			expect(code).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.SWARM_ALLOW_HUMAN_ONLY_CLI;
			else process.env.SWARM_ALLOW_HUMAN_ONLY_CLI = prev;
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
