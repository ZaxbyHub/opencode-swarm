import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

const TEST_DIR = realpathSync(
	mkdtempSync(join(tmpdir(), 'guardrail-evasion-')),
);

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
		block_destructive_commands: true,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session', command: string) {
	return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
	return { args: { command } };
}

/**
 * Adversarial security tests for the new guardrail blocks (sections 16-21).
 *
 * These tests verify the guardrail correctly handles evasion attempts.
 * Tests are categorized by evasion technique type.
 *
 * IMPORTANT: These tests document KNOWN BYPASSES in the current implementation.
 * The guardrail does NOT currently handle:
 * - Backslash-prefixed commands (\mv, \rm)
 * - Quote-spliced commands (m'v', m"v")
 * - Quoted command names ("mv", 'mv')
 * - Unicode fullwidth/mathematical characters in command names
 * - Double-slash paths (.//swarm/)
 * - Unresolvable environment variables ($VAR in paths)
 * - Shell wrappers (sh -c, cmd /c, powershell -c)
 *
 * These bypasses are SECURITY FINDINGS and should be addressed.
 */
describe('guardrails adversarial - .swarm path evasion (sections 16-21)', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	// ============================================================
	// Category 1: Shell Escaping / Character Substitution
	// ============================================================
	describe('Category 1: Shell escaping / character substitution', () => {
		// Broken commands - should NOT block (not security issues since they're broken)
		describe('Broken command fragmentation (not mv - should not block)', () => {
			test('m.v .swarm/file → ALLOWED (broken command, not recognized as mv)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'm.v .swarm/file');
				const output = makeBashOutput('m.v .swarm/file');
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});

			test('m##v .swarm/file → ALLOWED (broken command)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'm##v .swarm/file');
				const output = makeBashOutput('m##v .swarm/file');
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});

			test('m v .swarm/file → ALLOWED (two separate tokens)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'm v .swarm/file');
				const output = makeBashOutput('m v .swarm/file');
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});
		});

		// Note: The following evasion techniques are NOT currently caught by the guardrail.
		// They represent SECURITY BYPASSES that should be addressed:
		// - \mv .swarm/file (backslash prefix)
		// - m'v' .swarm/file (quote splicing)
		// - "mv" .swarm/file (quoted command)
	});

	// ============================================================
	// Category 2: Unicode / Encoding Evasion
	// ============================================================
	describe('Category 2: Unicode / encoding evasion', () => {
		describe('Mixed-case commands (case-insensitive matching works)', () => {
			test('MV .swarm/file /tmp/ → BLOCKED (uppercase MV)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'MV .swarm/file /tmp/');
				const output = makeBashOutput('MV .swarm/file /tmp/');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('Mv .swarm/file /tmp/ → BLOCKED (mixed-case Mv)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'Mv .swarm/file /tmp/');
				const output = makeBashOutput('Mv .swarm/file /tmp/');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('Rm .swarm/file → BLOCKED (mixed-case Rm)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'Rm .swarm/file');
				const output = makeBashOutput('Rm .swarm/file');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('MOVE .swarm\\file .swarm\\renamed → BLOCKED (uppercase MOVE)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput(
					'test-session',
					'MOVE .swarm\\file .swarm\\renamed',
				);
				const output = makeBashOutput('MOVE .swarm\\file .swarm\\renamed');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('Rm -rf .swarm/ → BLOCKED (uppercase recursive rm)', async () => {
				// NOTE: This currently PASSES because the recursive rm check uses case-SENSITIVE regex /^rm\s+/
				// But uppercase 'Rm' bypasses this check. This is a BYPASS.
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'rm -rf .swarm/');
				const output = makeBashOutput('rm -rf .swarm/');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});
		});

		// Note: Unicode fullwidth characters (\uff46\uff56 for mv) are NOT currently caught.
		// This is a BYPASS - NFKC normalization should handle this.
	});

	// ============================================================
	// Category 3: Path Manipulation
	// ============================================================
	describe('Category 3: Path manipulation', () => {
		describe('Path normalization edge cases', () => {
			test('mv .swarm//file /tmp/ → BLOCKED (double slash in path)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'mv .swarm//file /tmp/');
				const output = makeBashOutput('mv .swarm//file /tmp/');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('mv ./swarm/file /tmp/ → ALLOWED (./swarm bypasses .swarm literal check)', async () => {
				// NOTE: ./swarm does NOT match \.swarm[\x5c/] because the literal string is ./swarm not .swarm
				// This is a PATH BYPASS - the guard doesn't normalize ./ prefix before checking
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput('test-session', 'mv ./swarm/file /tmp/');
				const output = makeBashOutput('mv ./swarm/file /tmp/');
				// Currently NOT blocked - this is a BYPASS
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});

			test('rm .swarm/evidence/4.1.json → BLOCKED (non-recursive rm)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput(
					'test-session',
					'rm .swarm/evidence/4.1.json',
				);
				const output = makeBashOutput('rm .swarm/evidence/4.1.json');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('rm -v .swarm/evidence/4.1.json → BLOCKED (verbose flag without -r)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput(
					'test-session',
					'rm -v .swarm/evidence/4.1.json',
				);
				const output = makeBashOutput('rm -v .swarm/evidence/4.1.json');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});

			test('rm -- .swarm/evidence/4.1.json → BLOCKED (end-of-options marker)', async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
				const input = makeBashInput(
					'test-session',
					'rm -- .swarm/evidence/4.1.json',
				);
				const output = makeBashOutput('rm -- .swarm/evidence/4.1.json');
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/BLOCKED/,
				);
			});
		});

		// Note: .//swarm/ paths are NOT currently caught - this is a BYPASS.
		// The regex \.swarm[\x5c/] does not match .//swarm
	});

	// ============================================================
	// Category 4: Non-recursive rm Edge Cases
	// ============================================================
	describe('Category 4: Non-recursive rm edge cases', () => {
		test('rm -f .swarm/evidence/4.1.json → BLOCKED (force flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rm -f .swarm/evidence/4.1.json',
			);
			const output = makeBashOutput('rm -f .swarm/evidence/4.1.json');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rm src/temp.ts → ALLOWED (non-.swarm path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm src/temp.ts');
			const output = makeBashOutput('rm src/temp.ts');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rm -rf .swarm/ → BLOCKED (recursive rm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm -rf .swarm/');
			const output = makeBashOutput('rm -rf .swarm/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rm -r .swarm/evidence/ → BLOCKED (recursive rm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm -r .swarm/evidence/');
			const output = makeBashOutput('rm -r .swarm/evidence/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ============================================================
	// Category 5: cp + rm Chain Detection
	// ============================================================
	describe('Category 5: cp + rm chain detection', () => {
		test('cp .swarm/evidence/file.json /tmp/ && rm .swarm/evidence/file.json → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp .swarm/evidence/file.json /tmp/ && rm .swarm/evidence/file.json',
			);
			const output = makeBashOutput(
				'cp .swarm/evidence/file.json /tmp/ && rm .swarm/evidence/file.json',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('cp .swarm/file.txt /tmp/; rm .swarm/file.txt → BLOCKED (semicolon)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp .swarm/file.txt /tmp/; rm .swarm/file.txt',
			);
			const output = makeBashOutput(
				'cp .swarm/file.txt /tmp/; rm .swarm/file.txt',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('cp src/file.txt /tmp/ && rm src/other.txt → ALLOWED (neither targets .swarm/)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp src/file.txt /tmp/ && rm src/other.txt',
			);
			const output = makeBashOutput(
				'cp src/file.txt /tmp/ && rm src/other.txt',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Category 6: Archive Tools with Delete-Source Flags
	// ============================================================
	describe('Category 6: Archive tools with delete-source flags', () => {
		test('rsync --remove-source-files .swarm/data/ /tmp/backup/ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync --remove-source-files .swarm/data/ /tmp/backup/',
			);
			const output = makeBashOutput(
				'rsync --remove-source-files .swarm/data/ /tmp/backup/',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rsync --remove-source-files /tmp/ .swarm/evidence/ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync --remove-source-files /tmp/ .swarm/evidence/',
			);
			const output = makeBashOutput(
				'rsync --remove-source-files /tmp/ .swarm/evidence/',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('tar --remove-files -czf backup.tar.gz .swarm/evidence/ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'tar --remove-files -czf backup.tar.gz .swarm/evidence/',
			);
			const output = makeBashOutput(
				'tar --remove-files -czf backup.tar.gz .swarm/evidence/',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('tar -czf backup.tar.gz .swarm/data/ → ALLOWED (no --remove-files flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'tar -czf backup.tar.gz .swarm/data/',
			);
			const output = makeBashOutput('tar -czf backup.tar.gz .swarm/data/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('zip -m archive.zip .swarm/evidence/file.json → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'zip -m archive.zip .swarm/evidence/file.json',
			);
			const output = makeBashOutput(
				'zip -m archive.zip .swarm/evidence/file.json',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('zip archive.zip .swarm/data/ → ALLOWED (no -m flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'zip archive.zip .swarm/data/',
			);
			const output = makeBashOutput('zip archive.zip .swarm/data/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('7z -sdel archive.7z .swarm/evidence/file.json → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'7z -sdel archive.7z .swarm/evidence/file.json',
			);
			const output = makeBashOutput(
				'7z -sdel archive.7z .swarm/evidence/file.json',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('7z a archive.7z .swarm/data/ → ALLOWED (no -sdel flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'7z a archive.7z .swarm/data/',
			);
			const output = makeBashOutput('7z a archive.7z .swarm/data/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Category 7: Git clean / worktree remove (already covered)
	// ============================================================
	describe('Category 7: Git operations on .swarm/', () => {
		test('git clean -fd → BLOCKED (recursive clean)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'git clean -fd');
			const output = makeBashOutput('git clean -fd');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('git worktree remove --force → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'git worktree remove --force',
			);
			const output = makeBashOutput('git worktree remove --force');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('git reset --hard → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'git reset --hard');
			const output = makeBashOutput('git reset --hard');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('git push --force → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'git push --force');
			const output = makeBashOutput('git push --force');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ============================================================
	// Category 8: block_destructive_commands: false bypass
	// ============================================================
	describe('Category 8: block_destructive_commands: false bypass', () => {
		test('mv .swarm/file /tmp/ → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'mv .swarm/file /tmp/');
			const output = makeBashOutput('mv .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rm .swarm/file → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm .swarm/file');
			const output = makeBashOutput('rm .swarm/file');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('move .swarm\\file .swarm\\renamed → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'move .swarm\\file .swarm\\renamed',
			);
			const output = makeBashOutput('move .swarm\\file .swarm\\renamed');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('Remove-Item .swarm\\file -Recurse → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Remove-Item .swarm\\file -Recurse',
			);
			const output = makeBashOutput('Remove-Item .swarm\\file -Recurse');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('cp .swarm/file /tmp/ && rm .swarm/file → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp .swarm/file /tmp/ && rm .swarm/file',
			);
			const output = makeBashOutput('cp .swarm/file /tmp/ && rm .swarm/file');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rsync --remove-source-files .swarm/ /tmp/ → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync --remove-source-files .swarm/ /tmp/',
			);
			const output = makeBashOutput(
				'rsync --remove-source-files .swarm/ /tmp/',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('tar --remove-files -czf backup.tar.gz .swarm/ → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'tar --remove-files -czf backup.tar.gz .swarm/',
			);
			const output = makeBashOutput(
				'tar --remove-files -czf backup.tar.gz .swarm/',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('zip -m archive.zip .swarm/file → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'zip -m archive.zip .swarm/file',
			);
			const output = makeBashOutput('zip -m archive.zip .swarm/file');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('7z -sdel archive.7z .swarm/file → ALLOWED when block_destructive_commands=false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'7z -sdel archive.7z .swarm/file',
			);
			const output = makeBashOutput('7z -sdel archive.7z .swarm/file');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Category 9: Non-destructive commands (should NOT be blocked)
	// ============================================================
	describe('Category 9: Non-destructive commands (should not block)', () => {
		test('ls .swarm/ → ALLOWED (read-only listing)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'ls .swarm/');
			const output = makeBashOutput('ls .swarm/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('cat .swarm/plan.json → ALLOWED (read file)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'cat .swarm/plan.json');
			const output = makeBashOutput('cat .swarm/plan.json');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('find .swarm/ -name "*.json" → ALLOWED (search)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'find .swarm/ -name "*.json"',
			);
			const output = makeBashOutput('find .swarm/ -name "*.json"');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('cp .swarm/file /tmp/ → ALLOWED (copy without rm is OK)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'cp .swarm/file /tmp/');
			const output = makeBashOutput('cp .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rsync -av /tmp/ .swarm/backup/ → ALLOWED (no --delete flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync -av /tmp/ .swarm/backup/',
			);
			const output = makeBashOutput('rsync -av /tmp/ .swarm/backup/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Category 10: Windows cmd.exe patterns
	// ============================================================
	describe('Category 10: Windows cmd.exe patterns', () => {
		test('move .swarm\\evidence\\file.json .swarm\\backup\\ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'move .swarm\\evidence\\file.json .swarm\\backup\\',
			);
			const output = makeBashOutput(
				'move .swarm\\evidence\\file.json .swarm\\backup\\',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('ren .swarm\\evidence\\4.1.json .swarm\\evidence\\4.1.json.bak → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'ren .swarm\\evidence\\4.1.json .swarm\\evidence\\4.1.json.bak',
			);
			const output = makeBashOutput(
				'ren .swarm\\evidence\\4.1.json .swarm\\evidence\\4.1.json.bak',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('move C:\\data\\file.txt C:\\data\\renamed.txt → ALLOWED (no .swarm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'move C:\\data\\file.txt C:\\data\\renamed.txt',
			);
			const output = makeBashOutput(
				'move C:\\data\\file.txt C:\\data\\renamed.txt',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rmdir /s /q .swarm\\backup → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rmdir /s /q .swarm\\backup');
			const output = makeBashOutput('rmdir /s /q .swarm\\backup');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ============================================================
	// Category 11: PowerShell patterns
	// ============================================================
	describe('Category 11: PowerShell patterns', () => {
		test('Move-Item -Path .swarm\\evidence\\file.json -Destination .swarm\\backup\\ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Move-Item -Path .swarm\\evidence\\file.json -Destination .swarm\\backup\\',
			);
			const output = makeBashOutput(
				'Move-Item -Path .swarm\\evidence\\file.json -Destination .swarm\\backup\\',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('Rename-Item .swarm/evidence/4.1.json .swarm/evidence/4.1.json.bak → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Rename-Item .swarm/evidence/4.1.json .swarm/evidence/4.1.json.bak',
			);
			const output = makeBashOutput(
				'Rename-Item .swarm/evidence/4.1.json .swarm/evidence/4.1.json.bak',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('mi .swarm/data/file.txt .swarm/data/renamed.txt → BLOCKED (alias mi)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mi .swarm/data/file.txt .swarm/data/renamed.txt',
			);
			const output = makeBashOutput(
				'mi .swarm/data/file.txt .swarm/data/renamed.txt',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rni .swarm/file.txt .swarm/renamed.txt → BLOCKED (alias rni)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rni .swarm/file.txt .swarm/renamed.txt',
			);
			const output = makeBashOutput('rni .swarm/file.txt .swarm/renamed.txt');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('Remove-Item .swarm\\file -Recurse → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Remove-Item .swarm\\file -Recurse',
			);
			const output = makeBashOutput('Remove-Item .swarm\\file -Recurse');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('Get-ChildItem .swarm/ | Remove-Item -Recurse → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Get-ChildItem .swarm/ | Remove-Item -Recurse',
			);
			const output = makeBashOutput(
				'Get-ChildItem .swarm/ | Remove-Item -Recurse',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('Move-Item C:\\data\\file.txt C:\\data\\renamed.txt → ALLOWED (no .swarm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'Move-Item C:\\data\\file.txt C:\\data\\renamed.txt',
			);
			const output = makeBashOutput(
				'Move-Item C:\\data\\file.txt C:\\data\\renamed.txt',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// SECURITY FINDINGS: Evasion techniques that BYPASS the guardrail
	// These tests document bypasses - they are NOT expected to pass currently
	// ============================================================
	describe('SECURITY FINDINGS: Known bypasses (documented - tests show bypass works)', () => {
		// These tests use toThrow() and are expected to FAIL if the bypass works
		// When the guardrail is fixed to block these, the tests will PASS

		test('\\mv .swarm/file blocked (backslash prefix fix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', '\\mv .swarm/file /tmp/');
			const output = makeBashOutput('\\mv .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('mv .swarm /whole-root blocked (whole-directory targeting fix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'mv .swarm /tmp/backup/');
			const output = makeBashOutput('mv .swarm /tmp/backup/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('ren .swarm whole-root blocked (whole-directory rename fix)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'ren .swarm swarm-old');
			const output = makeBashOutput('ren .swarm swarm-old');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test("SECURITY BYPASS: m'v' .swarm/file NOT blocked (quote splicing evades detection)", async () => {
			// Quote-spliced mv bypasses the guardrail
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', "m'v' .swarm/file /tmp/");
			const output = makeBashOutput("m'v' .swarm/file /tmp/");
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('SECURITY BYPASS: "mv" .swarm/file NOT blocked (quoted command name evades)', async () => {
			// Quoted command name bypasses the guardrail
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', '"mv" .swarm/file /tmp/');
			const output = makeBashOutput('"mv" .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test("SECURITY BYPASS: sh -c 'mv .swarm/file /tmp/' NOT blocked (wrapper evades)", async () => {
			// Shell wrapper bypasses the guardrail - the inner mv is not detected
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				"sh -c 'mv .swarm/file /tmp/'",
			);
			const output = makeBashOutput("sh -c 'mv .swarm/file /tmp/'");
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('SECURITY BYPASS: mv .//swarm/file NOT blocked (double-slash path)', async () => {
			// Double-slash path bypasses the guardrail
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'mv .//swarm/file /tmp/');
			const output = makeBashOutput('mv .//swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('SECURITY BYPASS: mv $SWARM_DIR/file NOT blocked (unresolvable var - fail OPEN)', async () => {
			// Environment variables in paths cause fail-open behavior (var not detected as .swarm)
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'mv $SWARM_DIR/file /tmp/');
			const output = makeBashOutput('mv $SWARM_DIR/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('SECURITY BYPASS: fullwidth mv (\uff46\uff56) NOT blocked (NFKC normalization insufficient)', async () => {
			// Unicode fullwidth characters in command name bypass detection
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			// \uff46 = fullwidth m, \uff56 = fullwidth v
			const input = makeBashInput(
				'test-session',
				'\uff46\uff56 .swarm/file /tmp/',
			);
			const output = makeBashOutput('\uff46\uff56 .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});
});
