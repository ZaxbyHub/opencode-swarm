/**
 * Tests for shell-write-detection integration in guardrails toolBefore hook
 * @jest-environment node
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

const TEST_DIR = os.tmpdir();

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session', callID = 'call-1') {
	return { tool: 'bash' as const, sessionID, callID };
}

function makeShellInput(sessionID = 'test-session', callID = 'call-1') {
	return { tool: 'shell' as const, sessionID, callID };
}

function makeOutput(command: string) {
	return { args: { command } };
}

function coderSession(id: string): void {
	startAgentSession(id, 'coder');
}

function setDeclaredScope(sessionId: string, scope: string[]): void {
	const session = getAgentSession(sessionId);
	if (session) {
		session.declaredCoderScope = scope;
	}
}

describe('guardrails shell write scope enforcement', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// POSIX bash: in-scope writes should be allowed
	// -------------------------------------------------------------------------

	describe('POSIX bash writes — allowed when in declared scope', () => {
		it('allows output redirect to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s1');
			setDeclaredScope('s1', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s1'),
					makeOutput('echo hello > src/output.txt'),
				),
			).resolves.toBeUndefined();
		});

		it('allows append redirect to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s2');
			setDeclaredScope('s2', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s2'),
					makeOutput('echo world >> src/log.txt'),
				),
			).resolves.toBeUndefined();
		});

		it('allows cp (copy) to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s3');
			setDeclaredScope('s3', ['src/', 'scripts/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s3'),
					makeOutput('cp utils.ts src/utils.ts'),
				),
			).resolves.toBeUndefined();
		});

		it('allows mv (move) to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s4');
			setDeclaredScope('s4', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s4'),
					makeOutput('mv old.ts src/new.ts'),
				),
			).resolves.toBeUndefined();
		});

		it('allows sed -i (in-place edit) on file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s5');
			setDeclaredScope('s5', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s5'),
					makeOutput("sed -i 's/foo/bar/g' src/file.ts"),
				),
			).resolves.toBeUndefined();
		});

		it('allows install command to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s6');
			setDeclaredScope('s6', ['bin/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s6'),
					makeOutput('install -m 755 script.sh bin/script.sh'),
				),
			).resolves.toBeUndefined();
		});

		it('allows tar extraction to directory inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s7');
			setDeclaredScope('s7', ['vendor/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s7'),
					makeOutput('tar -xzf package.tar.gz -C vendor/'),
				),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// POSIX bash: out-of-scope writes should be blocked
	// -------------------------------------------------------------------------

	describe('POSIX bash writes — rejected when outside declared scope', () => {
		it('blocks output redirect to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s10');
			setDeclaredScope('s10', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s10'),
					makeOutput('echo hello > outside.txt'),
				),
			).rejects.toThrow('bash write detected outside declared scope:');
		});

		it('blocks append redirect to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s11');
			setDeclaredScope('s11', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s11'),
					makeOutput('echo world >> /tmp/log.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks cp to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s12');
			setDeclaredScope('s12', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s12'),
					makeOutput('cp file.txt /etc/config.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks mv to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s13');
			setDeclaredScope('s13', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s13'),
					makeOutput('mv file.txt /home/user/file.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks sed -i on file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s14');
			setDeclaredScope('s14', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s14'),
					makeOutput("sed -i 's/foo/bar/g' outside.txt"),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks tar extraction to directory outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s15');
			setDeclaredScope('s15', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s15'),
					makeOutput('tar -xzf package.tar.gz -C /tmp/extract/'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks ln -s creating symlink outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s16');
			setDeclaredScope('s16', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s16'),
					makeOutput('ln -s target.txt /tmp/link.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks truncate on file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s17');
			setDeclaredScope('s17', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s17'),
					makeOutput('truncate -s 0 /tmp/log.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('blocks dd output to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s18');
			setDeclaredScope('s18', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s18'),
					makeOutput('dd if=/dev/zero of=/tmp/out.bin bs=1M count=1'),
				),
				// dd is blocked by checkDestructiveCommand first (dev/zero is a destructive pattern)
			).rejects.toThrow(
				/data wipe operation|bash write detected outside declared scope:/,
			);
		});
	});

	// -------------------------------------------------------------------------
	// Read-only bash commands should always be allowed
	// -------------------------------------------------------------------------

	describe('POSIX read-only commands — always allowed regardless of scope', () => {
		it('allows ls (read-only)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s20');
			setDeclaredScope('s20', ['src/']); // scope is narrow

			await expect(
				hooks.toolBefore(makeBashInput('s20'), makeOutput('ls -la')),
			).resolves.toBeUndefined();
		});

		it('allows cat (read-only)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s21');
			setDeclaredScope('s21', ['src/']);

			await expect(
				hooks.toolBefore(makeBashInput('s21'), makeOutput('cat package.json')),
			).resolves.toBeUndefined();
		});

		it('allows grep (read-only)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s22');
			setDeclaredScope('s22', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s22'),
					makeOutput("grep -r 'TODO' src/"),
				),
			).resolves.toBeUndefined();
		});

		it('allows find (read-only)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s23');
			setDeclaredScope('s23', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s23'),
					makeOutput('find . -name "*.ts"'),
				),
			).resolves.toBeUndefined();
		});

		it('allows echo without redirect (no write)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s24');
			setDeclaredScope('s24', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s24'),
					makeOutput('echo "hello world"'),
				),
			).resolves.toBeUndefined();
		});

		it('allows git status (read-only)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s25');
			setDeclaredScope('s25', ['src/']);

			await expect(
				hooks.toolBefore(makeBashInput('s25'), makeOutput('git status')),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Windows PowerShell: in-scope writes allowed, out-of-scope blocked
	// -------------------------------------------------------------------------

	describe('Windows PowerShell writes — scope enforcement', () => {
		it('allows Out-File to path inside scope via shell tool', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s30');
			setDeclaredScope('s30', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s30'),
					makeOutput(
						'powershell -Command "echo hello | Out-File src/output.txt"',
					),
				),
			).resolves.toBeUndefined();
		});

		it('blocks Out-File to path outside scope via shell tool', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s31');
			setDeclaredScope('s31', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s31'),
					makeOutput(
						'powershell -Command "echo hello | Out-File C:\\temp\\out.txt"',
					),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows redirect > to file inside scope via shell tool', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s32');
			setDeclaredScope('s32', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s32'),
					makeOutput('powershell -Command "echo data > src/out.txt"'),
				),
			).resolves.toBeUndefined();
		});

		it('blocks redirect > to file outside scope via shell tool', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s33');
			setDeclaredScope('s33', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s33'),
					makeOutput('powershell -Command "echo data > C:\\outside.txt"'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows Copy-Item to path inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s34');
			setDeclaredScope('s34', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s34'),
					makeOutput('Copy-Item src.txt src\\copy.txt'),
				),
			).resolves.toBeUndefined();
		});

		it('blocks Copy-Item to path outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s35');
			setDeclaredScope('s35', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s35'),
					makeOutput('Copy-Item src.txt C:\\temp\\dest.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});
	});

	// -------------------------------------------------------------------------
	// Windows cmd.exe: in-scope writes allowed, out-of-scope blocked
	// -------------------------------------------------------------------------

	describe('Windows cmd.exe writes — scope enforcement', () => {
		it('allows copy to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s40');
			setDeclaredScope('s40', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s40'),
					makeOutput('cmd /c "copy src.txt src\\copy.txt"'),
				),
			).resolves.toBeUndefined();
		});

		it('blocks copy to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s41');
			setDeclaredScope('s41', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s41'),
					makeOutput('cmd /c "copy file.txt C:\\temp\\file.txt"'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows echo redirect > to file inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s42');
			setDeclaredScope('s42', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s42'),
					makeOutput('cmd /c "echo hello > src\\out.txt"'),
				),
			).resolves.toBeUndefined();
		});

		it('blocks echo redirect > to file outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s43');
			setDeclaredScope('s43', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s43'),
					makeOutput('cmd /c "echo hello > C:\\temp\\out.txt"'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows move to path inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s44');
			setDeclaredScope('s44', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s44'),
					makeOutput('cmd /c "move old.txt src\\new.txt"'),
				),
			).resolves.toBeUndefined();
		});

		it('blocks move to path outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s45');
			setDeclaredScope('s45', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s45'),
					makeOutput('cmd /c "move file.txt C:\\temp\\file.txt"'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases: no declared scope = allow all writes (backward compat)
	// -------------------------------------------------------------------------

	describe('edge case: no declared scope — backward compatibility', () => {
		it('allows write when session has no declared scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s50');
			// No setDeclaredScope call — declaredCoderScope remains null

			await expect(
				hooks.toolBefore(
					makeBashInput('s50'),
					makeOutput('echo hello > /etc/config.txt'),
				),
			).resolves.toBeUndefined();
		});

		it('allows write when declared scope is empty array', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s51');
			setDeclaredScope('s51', []); // empty scope

			await expect(
				hooks.toolBefore(
					makeBashInput('s51'),
					makeOutput('echo hello > /tmp/out.txt'),
				),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Fail-closed on parse errors and null paths
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Fail-closed on parse errors — regression: malformed bash commands
	// must be rejected, not silently allowed
	// -------------------------------------------------------------------------

	describe('fail-closed on parse errors — regression: malformed bash commands', () => {
		it('blocks malformed bash command with declared scope (parse error)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s1-parse-err');
			setDeclaredScope('s1-parse-err', ['src/']);

			// This is syntactically invalid bash (unclosed quote) — bash-parser will throw
			await expect(
				hooks.toolBefore(
					makeBashInput('s1-parse-err'),
					makeOutput("echo 'unclosed quote"),
				),
			).rejects.toThrow(
				'BLOCKED: bash write detection failed to parse command — rejecting for safety',
			);
		});

		it('blocks malformed shell command with declared scope (parse error via shell tool)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s2-parse-err');
			setDeclaredScope('s2-parse-err', ['src/']);

			// Unclosed quote in a command detectShellType classifies as bash (starts with bash)
			// — so it routes to detectPosixWrites which throws parse error
			await expect(
				hooks.toolBefore(
					makeShellInput('s2-parse-err'),
					makeOutput('bash -c "unclosed quote'),
				),
			).rejects.toThrow(
				'BLOCKED: bash write detection failed to parse command — rejecting for safety',
			);
		});
	});

	// -------------------------------------------------------------------------
	// Fail-closed on undetectable paths
	// -------------------------------------------------------------------------

	describe('fail-closed on undetectable paths', () => {
		it('blocks python -c eval (path is null — cannot verify scope)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s60');
			setDeclaredScope('s60', ['src/']);

			// python -c with inline code has null path because the file being
			// written is not statically determinable
			await expect(
				hooks.toolBefore(
					makeBashInput('s60'),
					makeOutput(`python -c "import os; os.write(1, b'data')"`),
				),
			).rejects.toThrow(
				/bash write detected outside declared scope|unresolvable path/,
			);
		});

		it('blocks node -e eval (path is null)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s61');
			setDeclaredScope('s61', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s61'),
					makeOutput(
						`node -e "require('fs').writeFileSync('out.txt', 'data')"`,
					),
				),
			).rejects.toThrow(
				/bash write detected outside declared scope|unresolvable path/,
			);
		});

		it('blocks bun -e eval (path is null)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s62');
			setDeclaredScope('s62', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s62'),
					makeOutput(`bun -e "Deno.writeTextFile('out.txt', 'data')"`),
				),
			).rejects.toThrow(
				/bash write detected outside declared scope|unresolvable path/,
			);
		});
	});

	// -------------------------------------------------------------------------
	// Non-bash/shell tools: should not be affected by this check
	// -------------------------------------------------------------------------
	// Non-bash/shell tools: should not be affected by this check
	// -------------------------------------------------------------------------

	describe('non-shell tools — not affected', () => {
		it('write tool is not affected by shell write check', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s70');
			setDeclaredScope('s70', ['src/']);

			// write tool should not be blocked by shell write scope check
			// (it has its own authority check)
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 's70', callID: 'c1' },
					{ args: { filePath: 'outside.txt', content: 'hello' } },
				),
			).resolves.toBeUndefined();
		});

		it('read tool is not affected', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s71');

			await expect(
				hooks.toolBefore(
					{ tool: 'read', sessionID: 's71', callID: 'c2' },
					{ args: { filePath: 'src/file.ts' } },
				),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Command with no command string — no-op, not blocked
	// -------------------------------------------------------------------------

	describe('empty/missing command — no-op', () => {
		it('allows bash with no command string', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s80');

			await expect(
				hooks.toolBefore(makeBashInput('s80'), { args: {} }),
			).resolves.toBeUndefined();
		});

		it('allows shell with empty command string', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s81');

			await expect(
				hooks.toolBefore(makeShellInput('s81'), { args: { command: '' } }),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Compound commands with mixed read/write
	// -------------------------------------------------------------------------

	describe('compound commands — only write portion is blocked', () => {
		it('blocks compound command with out-of-scope write component', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s90');
			setDeclaredScope('s90', ['src/']);

			// ls is read-only (allowed), but echo > outside is a write (blocked)
			await expect(
				hooks.toolBefore(
					makeBashInput('s90'),
					makeOutput('ls && echo hello > outside.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows compound command with all in-scope write components', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s91');
			setDeclaredScope('s91', ['src/', 'tests/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s91'),
					makeOutput('cat src/file.ts && echo done > tests/output.txt'),
				),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Network download commands — scope enforcement
	// -------------------------------------------------------------------------

	describe('network downloads — scope enforcement', () => {
		it('blocks curl -o download to path outside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s100');
			setDeclaredScope('s100', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s100'),
					makeOutput('curl https://example.com/file.txt -o /tmp/download.txt'),
				),
			).rejects.toThrow(/bash write detected outside declared scope:/);
		});

		it('allows curl -o download to path inside scope', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s101');
			setDeclaredScope('s101', ['vendor/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s101'),
					makeOutput('curl https://example.com/file.txt -o vendor/lib.js'),
				),
			).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Interactive/session tools — always blocked regardless of scope
	// -------------------------------------------------------------------------

	describe('interactive/session tools — always blocked regardless of scope', () => {
		it('blocks watch ls even with declared scope (posix)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s110');
			setDeclaredScope('s110', ['src/']); // scope covers the world

			await expect(
				hooks.toolBefore(makeBashInput('s110'), makeOutput('watch ls')),
			).rejects.toThrow(/BLOCKED: interactive\/session tool detected/);
		});

		it('blocks screen even with declared scope (posix)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s111');
			setDeclaredScope('s111', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s111'),
					makeOutput('screen -S mysession'),
				),
			).rejects.toThrow(/BLOCKED: interactive\/session tool detected/);
		});

		it('blocks tmux new-session even with declared scope (posix)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s112');
			setDeclaredScope('s112', ['src/']);

			await expect(
				hooks.toolBefore(
					makeBashInput('s112'),
					makeOutput('tmux new-session -s myname'),
				),
			).rejects.toThrow(/BLOCKED: interactive\/session tool detected/);
		});

		it('blocks Start-Process even with declared scope (powershell)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			coderSession('s113');
			setDeclaredScope('s113', ['src/']);

			await expect(
				hooks.toolBefore(
					makeShellInput('s113'),
					makeOutput('Start-Process notepad'),
				),
			).rejects.toThrow(/BLOCKED: interactive\/session tool detected/);
		});
	});

	// -------------------------------------------------------------------------
	// mut-026: dcCheckJunctionCreation — operator-swap mutant (|| → &&)
	// -------------------------------------------------------------------------

	describe('dcCheckJunctionCreation — regression: operator-swap mutant (mut-026)', () => {
		// The original condition: rel.startsWith('..') || path.isAbsolute(rel)
		// Mutant swapped || to && — this test ensures rel startsWith('..') alone
		// still blocks even when rel is NOT absolute.
		it('blocks relative parent paths (mklink /J)', () => {
			const { dcCheckJunctionCreation } = _internals;
			// '..\\parent' starts with '..' but resolves to a relative path
			// that is NOT absolute — original OR would block, AND mutant would allow
			const result = dcCheckJunctionCreation(
				'mklink /J link ..\\parent',
				'/home/user',
			);
			expect(result).toContain('BLOCKED');
		});

		it('blocks relative parent paths (New-Item Junction)', () => {
			const { dcCheckJunctionCreation } = _internals;
			const result = dcCheckJunctionCreation(
				'New-Item -ItemType Junction -Target "..\\sibling" -Path link',
				'/home/user/project',
			);
			expect(result).toContain('BLOCKED');
		});

		it('blocks relative parent paths (ln -s POSIX)', () => {
			const { dcCheckJunctionCreation } = _internals;
			const result = dcCheckJunctionCreation(
				'ln -s ../outside link',
				'/home/user',
			);
			expect(result).toContain('BLOCKED');
		});
	});

	// -------------------------------------------------------------------------
	// mut-029: extractErrorSignal — branch-swap mutant (instanceof negation)
	// -------------------------------------------------------------------------

	describe('extractErrorSignal — regression: branch-swap mutant (mut-029)', () => {
		// The original condition: errorContent instanceof Error
		// Mutant negated it — this test ensures non-Error objects still
		// produce signal extraction (code/message fields are still captured)
		it('extracts signal from plain objects', () => {
			const { extractErrorSignal } = _internals;
			const result = extractErrorSignal({
				code: 'ENOENT',
				message: 'file not found',
			});
			expect(result).toContain('ENOENT');
			expect(result).toContain('file not found');
		});

		it('extracts signal from objects with nested error', () => {
			const { extractErrorSignal } = _internals;
			const result = extractErrorSignal({
				code: 'ETIMEDOUT',
				message: 'connection timed out',
				error: { code: 'ENETUNREACH', message: 'network unreachable' },
			});
			expect(result).toContain('ETIMEDOUT');
			expect(result).toContain('connection timed out');
		});

		it('returns empty string for null/undefined', () => {
			const { extractErrorSignal } = _internals;
			expect(extractErrorSignal(null)).toBe('');
			expect(extractErrorSignal(undefined)).toBe('');
		});

		it('returns input string as-is', () => {
			const { extractErrorSignal } = _internals;
			expect(extractErrorSignal('simple string error')).toBe(
				'simple string error',
			);
		});

		it('extracts name and message from actual Error instances', () => {
			const { extractErrorSignal } = _internals;
			const err = new Error('something broke');
			(err as any).code = 'ECONNREFUSED';
			const result = extractErrorSignal(err);
			expect(result).toContain('Error');
			expect(result).toContain('something broke');
			expect(result).toContain('ECONNREFUSED');
		});
	});
});
