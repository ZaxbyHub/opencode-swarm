/**
 * `extractTarget` command-target regression coverage (issue #2134).
 *
 * Before this fix, `extractTarget` returned a shell command's FIRST WORD as
 * the trajectory target ("git" from "git commit"). Every command sharing a
 * driver therefore collapsed onto one target, and PRM's `repetition_loop`
 * detector — which keys on the tuple `agent|action|target` at default
 * threshold 2 — read a coder doing ordinary, entirely different work as the
 * same action repeated over and over. Measured on this repo with twelve
 * completely distinct commands (`bun test src/prm/`, `bun run lint`,
 * `bunx tsc --noEmit`, `bun run build`, …): the escalation ladder reached
 * level 3 and armed the HARD STOP deny token by the seventh command.
 *
 * The fix adds `normalizeCommandTarget`: trim, collapse whitespace runs to a
 * single space, truncate to 200 chars with a trailing `...`. This file pins
 * that behavior directly against the `_test_exports.extractTarget` Tier 0
 * seam, and separately proves the fix is actually WIRED through the public
 * `toolAfter` hook end to end.
 *
 * Lives in its own file rather than extending `trajectory-logger.test.ts`,
 * which is already over the FR-006 500-line cap; growing it would trip the
 * diff-scoped ratchet (see `trajectory-logger-denied.test.ts` for the same
 * rationale).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	createTrajectoryLoggerHook,
} from '../../../src/hooks/trajectory-logger';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

const { extractTarget } = _test_exports;

/**
 * Mirrors `MAX_COMMAND_TARGET_LENGTH` in `src/hooks/trajectory-logger.ts`
 * (not exported via `_test_exports`, and this suite may not edit production
 * code to add it). Pinned here as a literal so a change to the production
 * constant without a matching test update fails loudly rather than silently
 * drifting.
 */
const MAX_COMMAND_TARGET_LENGTH = 200;

describe('extractTarget — command target normalization (issue #2134)', () => {
	// ───────────────────────────────────────────────────────────────────────
	// 1. The regression: different commands sharing a first word must diverge.
	// ───────────────────────────────────────────────────────────────────────
	test('two different bash commands sharing a first word produce DIFFERENT targets', () => {
		const testTarget = extractTarget('bash', {
			command: 'bun test src/a.test.ts',
		});
		const lintTarget = extractTarget('bash', { command: 'bun run lint' });

		// Pre-fix (first-word extraction) both of these collapsed to "bun" —
		// this is the exact assertion that fails against the old behavior.
		expect(testTarget).not.toBe(lintTarget);
		expect(testTarget).toBe('bun test src/a.test.ts');
		expect(lintTarget).toBe('bun run lint');
	});

	test('twelve distinct bun/git-style commands all produce distinct targets', () => {
		const commands = [
			'bun test src/prm/',
			'bun run lint',
			'bunx tsc --noEmit',
			'bun run build',
			'bun run check:test-file-cap',
			'git status',
			'git diff --stat',
			'git add -A',
			'git commit -m "wip"',
			'git log --oneline -5',
			'git push origin HEAD',
			'bun run format',
		];
		const targets = commands.map((c) => extractTarget('bash', { command: c }));
		const uniqueTargets = new Set(targets);
		// Pre-fix, every "bun …" command collapsed to "bun" and every "git …"
		// command collapsed to "git" — only 2 unique targets from 12 commands.
		expect(uniqueTargets.size).toBe(commands.length);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 2. Guard against over-fixing: a genuine repeat must still look identical.
	// ───────────────────────────────────────────────────────────────────────
	test('the SAME command run twice produces the SAME target (stuck-loop signal preserved)', () => {
		const first = extractTarget('bash', { command: 'bun test src/a.test.ts' });
		const second = extractTarget('bash', {
			command: 'bun test src/a.test.ts',
		});
		expect(first).toBe(second);
		expect(first).toBe('bun test src/a.test.ts');
	});

	test('same command with shell tool alias ("shell") normalizes identically to "bash"', () => {
		const bashTarget = extractTarget('bash', { command: 'bun run lint' });
		const shellTarget = extractTarget('shell', { command: 'bun run lint' });
		expect(bashTarget).toBe(shellTarget);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 3. Whitespace normalization.
	// ───────────────────────────────────────────────────────────────────────
	test('a line-continued multi-line command normalizes to its single-line equivalent', () => {
		// The literal backslash line-continuation characters are preserved (only
		// WHITESPACE runs collapse) — so the single-line equivalent must include
		// them too for the two to match post-normalization.
		const multiline = 'bun test \\\n  src/a.test.ts \\\n  --watch';
		const singleLine = 'bun test \\ src/a.test.ts \\ --watch';

		const multilineTarget = extractTarget('bash', { command: multiline });
		const singleLineTarget = extractTarget('bash', { command: singleLine });

		expect(multilineTarget).toBe(singleLineTarget);
		expect(multilineTarget).toBe('bun test \\ src/a.test.ts \\ --watch');
	});

	test('a multi-line command WITHOUT line-continuation backslashes normalizes to its true single-line form', () => {
		const multiline = 'bun\n  test\n  src/a.test.ts';
		const singleLine = 'bun test src/a.test.ts';

		expect(extractTarget('bash', { command: multiline })).toBe(
			extractTarget('bash', { command: singleLine }),
		);
		expect(extractTarget('bash', { command: multiline })).toBe(
			'bun test src/a.test.ts',
		);
	});

	test('a heredoc-style command with tabs and repeated blank lines collapses to single spaces', () => {
		const messy = '  git   commit\t\t-m\n\n\n"multi   word\tmessage"  ';
		const target = extractTarget('bash', { command: messy });
		expect(target).toBe('git commit -m "multi word message"');
		// No run of 2+ whitespace characters should survive normalization.
		expect(target).not.toMatch(/\s{2,}/);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 4. Truncation boundary.
	// ───────────────────────────────────────────────────────────────────────
	test('a command longer than 200 chars truncates to exactly 200 chars ending in "..."', () => {
		const longCommand = `echo ${'a'.repeat(250)}`;
		expect(longCommand.length).toBeGreaterThan(MAX_COMMAND_TARGET_LENGTH);

		const target = extractTarget('bash', { command: longCommand });

		expect(target.length).toBe(MAX_COMMAND_TARGET_LENGTH);
		expect(target.endsWith('...')).toBe(true);
		expect(target).toBe(
			`${longCommand.slice(0, MAX_COMMAND_TARGET_LENGTH - 3)}...`,
		);
	});

	test('a command exactly at the 200-char boundary is left untouched (no truncation)', () => {
		const exactCommand = `echo ${'b'.repeat(195)}`; // "echo " (5) + 195 = 200
		expect(exactCommand.length).toBe(MAX_COMMAND_TARGET_LENGTH);

		const target = extractTarget('bash', { command: exactCommand });

		expect(target).toBe(exactCommand);
		expect(target.endsWith('...')).toBe(false);
		expect(target.length).toBe(MAX_COMMAND_TARGET_LENGTH);
	});

	test('a command one char over the boundary (201 chars) IS truncated', () => {
		const overByOne = `echo ${'c'.repeat(196)}`; // 5 + 196 = 201
		expect(overByOne.length).toBe(MAX_COMMAND_TARGET_LENGTH + 1);

		const target = extractTarget('bash', { command: overByOne });

		expect(target.length).toBe(MAX_COMMAND_TARGET_LENGTH);
		expect(target.endsWith('...')).toBe(true);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 5. Non-shell tools are unaffected by the command-target normalization.
	// ───────────────────────────────────────────────────────────────────────
	test('a read/edit-style call still targets the file path, not a normalized command', () => {
		expect(extractTarget('read', { filePath: '/src/app.ts' })).toBe(
			'/src/app.ts',
		);
		expect(extractTarget('edit', { filePath: '/src/app.ts' })).toBe(
			'/src/app.ts',
		);
	});

	test('a task call still targets its subagent_type, ignoring any command-shaped fields', () => {
		expect(
			extractTarget('task', {
				subagent_type: 'coder',
				// A command field on a non-shell tool must never be consulted.
				command: 'bun test should-be-ignored',
			}),
		).toBe('coder');
	});

	test('a bash call with a filePath field prefers filePath over command (targetFields checked first)', () => {
		// Documents existing precedence: targetFields are checked BEFORE the
		// bash-specific command fallback, regardless of tool name.
		expect(
			extractTarget('bash', {
				filePath: '/src/app.ts',
				command: 'bun test src/a.test.ts',
			}),
		).toBe('/src/app.ts');
	});

	// ───────────────────────────────────────────────────────────────────────
	// 6. The `args`-string fallback is normalized the same way as `command`.
	// ───────────────────────────────────────────────────────────────────────
	test('the args-string fallback (no command field) is whitespace-normalized, not reduced to a first word', () => {
		const target = extractTarget('bash', {
			args: 'ls   -la   /tmp',
		});
		expect(target).toBe('ls -la /tmp');
		expect(target).not.toBe('ls');
	});

	test('two different args-string fallback invocations sharing a first word produce distinct targets', () => {
		const a = extractTarget('bash', { args: 'python script_a.py --flag' });
		const b = extractTarget('bash', { args: 'python script_b.py --other' });
		expect(a).not.toBe(b);
	});

	test('args-string fallback truncates at 200 chars like the command field', () => {
		const longArgs = 'd'.repeat(250);
		const target = extractTarget('bash', { args: longArgs });
		expect(target.length).toBe(MAX_COMMAND_TARGET_LENGTH);
		expect(target.endsWith('...')).toBe(true);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 7. Empty / whitespace-only command falls through rather than emitting a
	//    blank or whitespace target.
	// ───────────────────────────────────────────────────────────────────────
	test('whitespace-only command falls through to the description fallback', () => {
		const target = extractTarget('bash', {
			command: '   ',
			description: 'run the test suite',
		});
		expect(target).toBe('run the test suite');
		expect(target).not.toBe('');
		expect(target).not.toBe(' ');
	});

	test('whitespace-only command with no description falls through to the args fallback', () => {
		const target = extractTarget('bash', {
			command: '\t\n',
			args: 'echo   hello',
		});
		expect(target).toBe('echo hello');
	});

	test('empty command, no description, no args produces an empty-string target (pinned real behavior)', () => {
		const target = extractTarget('bash', { command: '' });
		expect(target).toBe('');
	});

	test('command absent entirely (undefined) with no fallback fields also produces empty string', () => {
		const target = extractTarget('bash', {});
		expect(target).toBe('');
	});

	// ───────────────────────────────────────────────────────────────────────
	// End-to-end wiring: prove the fix is actually reachable through the
	// public toolAfter hook, not just the pure-function seam.
	// ───────────────────────────────────────────────────────────────────────
	describe('end-to-end via createTrajectoryLoggerHook', () => {
		let tempDir: string;

		beforeEach(() => {
			resetSwarmState();
			tempDir = path.join(
				tmpdir(),
				`test-trajectory-target-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
			resetSwarmState();
		});

		function readTargets(taskId: string): string[] {
			const trajectoryPath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				taskId,
				'trajectory.jsonl',
			);
			return fs
				.readFileSync(trajectoryPath, 'utf-8')
				.split('\n')
				.filter((l) => l.trim().length > 0)
				.map((l) => (JSON.parse(l) as { target: string }).target);
		}

		test('two different bash tool calls through toolAfter write DIFFERENT target fields to the trajectory', async () => {
			const sessionId = 'session-target-regression';
			startAgentSession(sessionId, 'coder');
			const session = swarmState.agentSessions.get(sessionId);
			if (!session) throw new Error('session not created');
			session.delegationActive = true;
			session.currentTaskId = 'target-e2e';

			const hook = createTrajectoryLoggerHook(
				{ enabled: true, max_lines: 500 },
				tempDir,
			);

			const output = {
				title: 'ok',
				output: 'done',
				metadata: { success: true },
			};

			await hook.toolAfter(
				{
					tool: 'bash',
					sessionID: sessionId,
					callID: 'call-1',
					args: { command: 'bun test src/a.test.ts' },
				},
				output,
			);
			await hook.toolAfter(
				{
					tool: 'bash',
					sessionID: sessionId,
					callID: 'call-2',
					args: { command: 'bun run lint' },
				},
				output,
			);

			const targets = readTargets('target-e2e');
			expect(targets.length).toBe(2);
			// Pre-fix this reads ['bun', 'bun'] — the exact collapse issue #2134
			// describes, which is what fed the false repetition_loop escalation.
			expect(targets[0]).not.toBe(targets[1]);
			expect(targets[0]).toBe('bun test src/a.test.ts');
			expect(targets[1]).toBe('bun run lint');
		});
	});
});
