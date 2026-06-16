import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

const TEST_DIR = realpathSync(
	mkdtempSync(join(tmpdir(), 'guardrail-swarm-path-')),
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

describe('destructive command guard - .swarm path protection (sections 16-21)', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	// ============================================================
	// Section 16: POSIX mv targeting .swarm/ paths
	// ============================================================
	describe('Section 16: POSIX mv targeting .swarm/ paths', () => {
		test('mv .swarm/evidence/file.json /tmp/ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv .swarm/evidence/file.json /tmp/',
			);
			const output = makeBashOutput('mv .swarm/evidence/file.json /tmp/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/mv.*targeting .swarm.*detected/,
			);
		});

		test('mv /tmp/file.json .swarm/evidence/ → BLOCKED (destination)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv /tmp/file.json .swarm/evidence/',
			);
			const output = makeBashOutput('mv /tmp/file.json .swarm/evidence/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/mv.*targeting .swarm.*detected/,
			);
		});

		test('mv .swarm/evidence/4.1.json .swarm/backup/ → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv .swarm/evidence/4.1.json .swarm/backup/',
			);
			const output = makeBashOutput(
				'mv .swarm/evidence/4.1.json .swarm/backup/',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/mv.*targeting .swarm.*detected/,
			);
		});

		test('mv "quoted/.swarm/file.json" /tmp/ → BLOCKED (quoted path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv ".swarm/evidence/file.json" /tmp/',
			);
			const output = makeBashOutput('mv ".swarm/evidence/file.json" /tmp/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/mv.*targeting .swarm.*detected/,
			);
		});

		test('mv src/file.ts src/renamed.ts → ALLOWED (non-.swarm path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv src/file.ts src/renamed.ts',
			);
			const output = makeBashOutput('mv src/file.ts src/renamed.ts');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('ls .swarm/evidence/ → ALLOWED (read-only)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'ls .swarm/evidence/');
			const output = makeBashOutput('ls .swarm/evidence/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('cat .swarm/evidence/1.1.json → ALLOWED (read-only)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cat .swarm/evidence/1.1.json',
			);
			const output = makeBashOutput('cat .swarm/evidence/1.1.json');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Section 17: Windows cmd move/ren targeting .swarm\\ paths
	// ============================================================
	describe('Section 17: Windows cmd move/ren targeting .swarm\\ paths', () => {
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/move.*ren.*targeting .swarm.*detected/,
			);
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/move.*ren.*targeting .swarm.*detected/,
			);
		});

		test('move .swarm\\file.txt .swarm\\renamed.txt → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'move .swarm\\file.txt .swarm\\renamed.txt',
			);
			const output = makeBashOutput(
				'move .swarm\\file.txt .swarm\\renamed.txt',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/move.*ren.*targeting .swarm.*detected/,
			);
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
	});

	// ============================================================
	// Section 18: PowerShell Move-Item/Rename-Item targeting .swarm/
	// ============================================================
	describe('Section 18: PowerShell Move-Item/Rename-Item targeting .swarm/', () => {
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/Move-Item.*Rename-Item.*targeting .swarm.*detected/,
			);
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/Move-Item.*Rename-Item.*targeting .swarm.*detected/,
			);
		});

		test('move .swarm/file.txt .swarm/renamed.txt → BLOCKED (PS alias)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'move .swarm/file.txt .swarm/renamed.txt',
			);
			const output = makeBashOutput('move .swarm/file.txt .swarm/renamed.txt');
			// move is caught by Section 17 (Windows cmd) before Section 18 (PowerShell)
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/move.*ren.*targeting .swarm.*detected/,
			);
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/Move-Item.*Rename-Item.*targeting .swarm.*detected/,
			);
		});

		test('ren .swarm/file.txt .swarm/renamed.txt → BLOCKED (alias ren)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'ren .swarm/file.txt .swarm/renamed.txt',
			);
			const output = makeBashOutput('ren .swarm/file.txt .swarm/renamed.txt');
			// ren is caught by Section 17 (Windows cmd) before Section 18 (PowerShell)
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/move.*ren.*targeting .swarm.*detected/,
			);
		});

		test('rni .swarm/file.txt .swarm/renamed.txt → BLOCKED (alias rni)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rni .swarm/file.txt .swarm/renamed.txt',
			);
			const output = makeBashOutput('rni .swarm/file.txt .swarm/renamed.txt');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/Move-Item.*Rename-Item.*targeting .swarm.*detected/,
			);
		});

		test('mv .swarm/file.txt .swarm/renamed.txt → BLOCKED (mv alias for Move-Item)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'mv .swarm/file.txt .swarm/renamed.txt',
			);
			const output = makeBashOutput('mv .swarm/file.txt .swarm/renamed.txt');
			// mv in bash context is caught by Section 16 (POSIX mv), not Section 18 (PowerShell Move-Item)
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/mv.*targeting .swarm.*detected/,
			);
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
	// Section 19: Non-recursive rm targeting .swarm/ paths
	// ============================================================
	describe('Section 19: Non-recursive rm targeting .swarm/ paths', () => {
		test('rm .swarm/evidence/4.1.json → BLOCKED (non-recursive)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rm .swarm/evidence/4.1.json',
			);
			const output = makeBashOutput('rm .swarm/evidence/4.1.json');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/rm.*targeting .swarm.*detected/,
			);
		});

		test('rm -v .swarm/evidence/4.1.json → BLOCKED (verbose flag)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rm -v .swarm/evidence/4.1.json',
			);
			const output = makeBashOutput('rm -v .swarm/evidence/4.1.json');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/rm.*targeting .swarm.*detected/,
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
				/rm.*targeting .swarm.*detected/,
			);
		});

		test('rm -f .swarm/evidence/4.1.json → BLOCKED (force flag without recursive)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rm -f .swarm/evidence/4.1.json',
			);
			const output = makeBashOutput('rm -f .swarm/evidence/4.1.json');
			// -f matches Section 3's recursive/force pattern, which also blocks .swarm paths
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rm src/temp.ts → ALLOWED (non-.swarm path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm src/temp.ts');
			const output = makeBashOutput('rm src/temp.ts');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Section 20: cp + rm chain detection (copy-then-delete bypass)
	// ============================================================
	describe('Section 20: cp + rm chain targeting .swarm/ paths', () => {
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
			// The rm is caught by Section 19 (non-recursive rm on .swarm/)
			// Section 20's cp+rm chain would catch this too if rm alone wasn't blocked first
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('cp .swarm/evidence/file.json /tmp/; rm .swarm/evidence/file.json → BLOCKED (semicolon)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp .swarm/evidence/file.json /tmp/; rm .swarm/evidence/file.json',
			);
			const output = makeBashOutput(
				'cp .swarm/evidence/file.json /tmp/; rm .swarm/evidence/file.json',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('cp src/file.ts /tmp/ && rm .swarm/data/file.json → BLOCKED (cp without .swarm, rm with)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'cp src/file.ts /tmp/ && rm .swarm/data/file.json',
			);
			const output = makeBashOutput(
				'cp src/file.ts /tmp/ && rm .swarm/data/file.json',
			);
			// rm is caught by Section 19 (non-recursive rm on .swarm/)
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('cp .swarm/file.txt /tmp/ → ALLOWED (cp without rm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'cp .swarm/file.txt /tmp/');
			const output = makeBashOutput('cp .swarm/file.txt /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
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
	// Section 21: Archive tools with delete-source flags targeting .swarm/
	// ============================================================
	describe('Section 21: Archive tools with delete-source flags targeting .swarm/', () => {
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/rsync.*delete-source.*targeting .swarm.*detected/,
			);
		});

		test('rsync --remove-source-files .swarm/data/ /tmp/backup/ → BLOCKED (source)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync --remove-source-files .swarm/data/ /tmp/backup/',
			);
			const output = makeBashOutput(
				'rsync --remove-source-files .swarm/data/ /tmp/backup/',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/rsync.*delete-source.*targeting .swarm.*detected/,
			);
		});

		test('rsync --remove-source-files /tmp/ /dest/ → ALLOWED (no .swarm path)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync --remove-source-files /tmp/ /dest/',
			);
			const output = makeBashOutput('rsync --remove-source-files /tmp/ /dest/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/tar.*delete-source.*targeting .swarm.*detected/,
			);
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/zip.*delete-source.*targeting .swarm.*detected/,
			);
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
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/7z.*delete-source.*targeting .swarm.*detected/,
			);
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
	// Section 22: Git clean -fd and worktree remove --force
	// (Already covered by existing tests; just verify no regression)
	// ============================================================
	describe('Section 22: Git clean -fd and worktree remove (regression)', () => {
		test('git clean -fd → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'git clean -fd');
			const output = makeBashOutput('git clean -fd');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/git clean -fd.*permanently deletes/,
			);
		});

		test('git worktree remove --force → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'git worktree remove --force',
			);
			const output = makeBashOutput('git worktree remove --force');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/git worktree remove --force.*detected/,
			);
		});
	});

	// ============================================================
	// Adversarial: evasion techniques
	// ============================================================
	describe('Adversarial: evasion techniques for .swarm path guards', () => {
		test('mv with backtick escapes → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			// PowerShell backtick evasion: m`v .swarm/file /tmp/
			const input = makeBashInput('test-session', 'm`v .swarm/file /tmp/');
			const output = makeBashOutput('m`v .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('move with doubled quotes evasion → BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			// Quote splicing evasion: mo""ve .swarm/file /tmp/
			const input = makeBashInput('test-session', 'mo""ve .swarm/file /tmp/');
			const output = makeBashOutput('mo""ve .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rsync with RSYNC_REMOVE_SOURCE_FILES env var → ALLOWED (not our job to detect)', async () => {
			// The guard only looks for --remove-source-files flag in the command
			// Setting the env var is a legitimate use case and not blocked
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'rsync -av /tmp/ .swarm/backup/',
			);
			const output = makeBashOutput('rsync -av /tmp/ .swarm/backup/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rm -rf .swarm/ → BLOCKED (recursive rm on .swarm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm -rf .swarm/');
			const output = makeBashOutput('rm -rf .swarm/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});

		test('rm -r .swarm/evidence/ → BLOCKED (recursive rm on .swarm subdir)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm -r .swarm/evidence/');
			const output = makeBashOutput('rm -r .swarm/evidence/');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(/BLOCKED/);
		});
	});

	// ============================================================
	// Section 23: Swarm CLI bypass — human-only `/swarm` subcommands
	// ============================================================
	describe('Section 23: Swarm CLI bypass guard', () => {
		test('bunx opencode-swarm run reset → BLOCKED (single-token restricted)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run reset',
			);
			const output = makeBashOutput('bunx opencode-swarm run reset');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run pr subscribe → BLOCKED (compound human-only)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run pr subscribe',
			);
			const output = makeBashOutput('bunx opencode-swarm run pr subscribe');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run pr unsubscribe → BLOCKED (compound human-only)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run pr unsubscribe',
			);
			const output = makeBashOutput('bunx opencode-swarm run pr unsubscribe');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('opencode-swarm run memory import → BLOCKED (bare binary compound)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'opencode-swarm run memory import',
			);
			const output = makeBashOutput('opencode-swarm run memory import');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run status → ALLOWED (agent-callable command)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run status',
			);
			const output = makeBashOutput('bunx opencode-swarm run status');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('bunx some-other-package run something → ALLOWED (not opencode-swarm)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx some-other-package run something',
			);
			const output = makeBashOutput('bunx some-other-package run something');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('bunx opencode-swarm run reset --force → BLOCKED (captures reset, not --force)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run reset --force',
			);
			const output = makeBashOutput('bunx opencode-swarm run reset --force');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run sdd project → BLOCKED (compound sdd)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run sdd project',
			);
			const output = makeBashOutput('bunx opencode-swarm run sdd project');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run rollback 2 → BLOCKED (positional arg bypass)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run rollback 2',
			);
			const output = makeBashOutput('bunx opencode-swarm run rollback 2');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run checkpoint mylabel → BLOCKED (positional arg bypass)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run checkpoint mylabel',
			);
			const output = makeBashOutput(
				'bunx opencode-swarm run checkpoint mylabel',
			);
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run status 42 → ALLOWED (agent-callable with positional arg)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run status 42',
			);
			const output = makeBashOutput('bunx opencode-swarm run status 42');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('bunx opencode-swarm run rollback\t2 → BLOCKED (tab-separated positional arg, normalize then firstToken)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run rollback\t2',
			);
			const output = makeBashOutput('bunx opencode-swarm run rollback\t2');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});

		test('bunx opencode-swarm run pr\tsubscribe → BLOCKED (tab-separated compound, normalize then full-form lookup)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput(
				'test-session',
				'bunx opencode-swarm run pr\tsubscribe',
			);
			const output = makeBashOutput('bunx opencode-swarm run pr\tsubscribe');
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/human-only swarm command/,
			);
		});
	});

	// ============================================================
	// block_destructive_commands: false bypasses new .swarm guards
	// ============================================================
	describe('block_destructive_commands: false bypasses new .swarm guards', () => {
		test('mv .swarm/file /tmp/ allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'mv .swarm/file /tmp/');
			const output = makeBashOutput('mv .swarm/file /tmp/');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rm .swarm/file allowed when block_destructive_commands is false', async () => {
			const config = defaultConfig({ block_destructive_commands: false });
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
			const input = makeBashInput('test-session', 'rm .swarm/file');
			const output = makeBashOutput('rm .swarm/file');
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		test('rsync --remove-source-files .swarm/ /tmp/ allowed when block_destructive_commands is false', async () => {
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
	});
});
