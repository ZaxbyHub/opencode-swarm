import { describe, expect, test } from 'bun:test';
import { resolveCommand } from './registry';
import {
	classifySwarmCommandChatFallbackUse,
	classifySwarmCommandToolUse,
	HUMAN_ONLY_SWARM_COMMANDS,
} from './tool-policy';

/**
 * Issue #890 — confirm chat-tool refusal message for human-only commands
 * points the agent at the user, not at the CLI bypass.
 */

function resolve(tokens: string[]) {
	const r = resolveCommand(tokens);
	if (!r) throw new Error(`resolveCommand failed for ${tokens.join(' ')}`);
	return r;
}

describe('tool-policy — human-only command refusal (issue #890)', () => {
	test('HUMAN_ONLY_SWARM_COMMANDS contains the issue-890 set', () => {
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('acknowledge-spec-drift')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('reset')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('reset-session')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('rollback')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('checkpoint')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('memory import')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('memory migrate')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('memory compact')).toBe(true);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('sdd project')).toBe(true);
	});

	describe('classifySwarmCommandToolUse — chat-tool path', () => {
		test('acknowledge-spec-drift returns human-only message (NOT the CLI-path message)', () => {
			const result = classifySwarmCommandToolUse(
				resolve(['acknowledge-spec-drift']),
			);
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
				expect(result.message).toContain('Present the situation to the user');
				expect(result.message).toContain('MUST NOT run it yourself');
				// The OLD message — must NOT appear for human-only commands
				expect(result.message).not.toContain(
					'is not available through the chat tool yet',
				);
			}
		});

		test('reset returns human-only message', () => {
			const result = classifySwarmCommandToolUse(resolve(['reset']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
		});

		test('rollback returns human-only message', () => {
			const result = classifySwarmCommandToolUse(resolve(['rollback']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
		});

		test('checkpoint returns human-only message', () => {
			const result = classifySwarmCommandToolUse(resolve(['checkpoint']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
		});

		test('dark-matter — non-human-only command retains the OLD message (no regression)', () => {
			const result = classifySwarmCommandToolUse(resolve(['dark-matter']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain(
					'is not available through the chat tool yet',
				);
				expect(result.message).toContain('bunx opencode-swarm run dark-matter');
				expect(result.message).not.toContain('human-only');
			}
		});

		test('simulate — non-human-only command retains the OLD message', () => {
			const result = classifySwarmCommandToolUse(resolve(['simulate']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain(
					'is not available through the chat tool yet',
				);
				expect(result.message).not.toContain('human-only');
			}
		});

		test('status — allowlisted command remains allowed', () => {
			const result = classifySwarmCommandToolUse(resolve(['status']));
			expect(result.allowed).toBe(true);
		});

		test('diagnose — allowlisted command remains allowed', () => {
			const result = classifySwarmCommandToolUse(resolve(['diagnose']));
			expect(result.allowed).toBe(true);
		});

		test('memory read-only diagnostics are allowed, but mutating commands are human-only', () => {
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'status'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'pending'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['memory', 'pending', '--limit', '5']),
				).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'recall-log'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['memory', 'recall-log', '--limit', '5']),
				).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'stale'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['memory', 'stale', '--limit', '5']),
				).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'stale', '--confirm']))
					.allowed,
			).toBe(false);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'evaluate'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['memory', 'evaluate', '--json']))
					.allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['memory', 'evaluate', '--fixtures', 'custom']),
				).allowed,
			).toBe(false);
			const result = classifySwarmCommandToolUse(resolve(['memory', 'import']));
			expect(result.allowed).toBe(false);
			if (result.allowed === false) {
				expect(result.message).toContain('human-only');
			}
			const compactResult = classifySwarmCommandToolUse(
				resolve(['memory', 'compact']),
			);
			expect(compactResult.allowed).toBe(false);
			if (compactResult.allowed === false) {
				expect(compactResult.message).toContain('human-only');
			}
		});

		test('sdd read-only diagnostics are allowed, but project is human-only', () => {
			expect(classifySwarmCommandToolUse(resolve(['sdd'])).allowed).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['sdd', 'status'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['sdd', 'status', '--json']))
					.allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['sdd', 'validate'])).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(resolve(['sdd', 'validate', '--json']))
					.allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['sdd', 'validate', '--change', 'add-login']),
				).allowed,
			).toBe(true);
			expect(
				classifySwarmCommandToolUse(
					resolve(['sdd', 'validate', '--change', '../escape']),
				).allowed,
			).toBe(false);
			const project = classifySwarmCommandToolUse(resolve(['sdd', 'project']));
			expect(project.allowed).toBe(false);
			if (project.allowed === false) {
				expect(project.message).toContain('human-only');
			}
		});
	});

	describe('classifySwarmCommandChatFallbackUse — user-typed slash path', () => {
		test('acknowledge-spec-drift remains ALLOWED through chat fallback (legitimate user path)', () => {
			const result = classifySwarmCommandChatFallbackUse(
				resolve(['acknowledge-spec-drift']),
			);
			expect(result.allowed).toBe(true);
		});

		test('reset remains ALLOWED through chat fallback', () => {
			const result = classifySwarmCommandChatFallbackUse(resolve(['reset']));
			expect(result.allowed).toBe(true);
		});

		test('rollback remains ALLOWED through chat fallback', () => {
			const result = classifySwarmCommandChatFallbackUse(resolve(['rollback']));
			expect(result.allowed).toBe(true);
		});

		test('knowledge migrate stays blocked (pre-existing rule)', () => {
			const result = classifySwarmCommandChatFallbackUse(
				resolve(['knowledge', 'migrate']),
			);
			expect(result.allowed).toBe(false);
		});

		test('memory migrate stays blocked because it mutates .swarm state', () => {
			const result = classifySwarmCommandChatFallbackUse(
				resolve(['memory', 'migrate']),
			);
			expect(result.allowed).toBe(false);
		});

		test('memory compact stays blocked because it mutates .swarm state', () => {
			const result = classifySwarmCommandChatFallbackUse(
				resolve(['memory', 'compact']),
			);
			expect(result.allowed).toBe(false);
		});

		test('sdd project stays blocked because it mutates .swarm spec state', () => {
			const result = classifySwarmCommandChatFallbackUse(
				resolve(['sdd', 'project']),
			);
			expect(result.allowed).toBe(false);
		});
	});
});
