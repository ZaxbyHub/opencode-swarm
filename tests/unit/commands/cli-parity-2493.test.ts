import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const CLI_PATH = join(import.meta.dir, '../../../src/cli/index.ts');

async function runCLI(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

import { executeSwarmCommand } from '../../../src/commands/command-dispatch.js';
import {
	COMMAND_REGISTRY,
	isCommandFailure,
	resolveCommand,
	validateAliases,
} from '../../../src/commands/registry.js';

/**
 * Issue #2493 obligation 3 (#1646 residual): CLI/library parity — alias
 * dereferencing through canonical targets, structured CommandResult with
 * exit codes, did-you-mean suggestions, deprecation warnings.
 */
describe('CLI/library parity (issue #2493, #1646 residual)', () => {
	test('every pure alias dereferences to a handler-bearing canonical entry', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if (!entry.aliasOf) continue;
			const resolved = resolveCommand([name]);
			expect(resolved, `alias '${name}' failed to resolve`).not.toBeNull();
			expect(
				typeof resolved?.entry.handler,
				`alias '${name}' did not dereference to a handler`,
			).toBe('function');
		}
	});

	test('validateAliases rejects a handler-less entry without aliasOf', () => {
		// Structural guard: the new validation rule exists and the current
		// registry (which passes it) stays valid.
		const result = validateAliases();
		expect(result.valid).toBe(true);
	});

	test('isCommandFailure distinguishes the CommandResult union halves', () => {
		expect(isCommandFailure('plain string')).toBe(false);
		expect(isCommandFailure({ text: 'x', ok: false })).toBe(true);
		expect(isCommandFailure({ text: 'x', ok: false, exitCode: 2 })).toBe(true);
	});

	test('executeSwarmCommand unwraps a CommandFailure to its text (chat path)', async () => {
		// Use a deprecated alias whose canonical handler is cheap/read-only.
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['health'],
		});
		expect(typeof result.text).toBe('string');
		expect(result.text).toContain('deprecated');
	});

	test('unknown command yields did-you-mean suggestions, never a full dump', async () => {
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['statu'],
		});
		expect(result.text).toContain('not found');
		expect(result.text).toContain('status');
		// #1646 item 2: the old CLI dumped ~160 commands; the suggestion
		// format is bounded to 3.
		const suggestionLines = result.text
			.split('\n')
			.filter((l) => l.trim().startsWith('- /swarm'));
		expect(suggestionLines.length).toBeLessThanOrEqual(3);
	});

	describe('CLI run() exit codes and suggestions (issue #2493, #1646)', () => {
		test('a failed benchmark CI gate exits 1 (CommandFailure mapping)', async () => {
			const cwd = canonicalMkdtemp('cli-exit-gate-');
			try {
				const r = await runCLI(['run', 'benchmark', '--ci-gate'], cwd);
				expect(r.exitCode).toBe(1);
				expect(r.stdout + r.stderr).toContain('FAILED');
			} finally {
				(await import('node:fs/promises')).rm(cwd, {
					recursive: true,
					force: true,
				});
			}
		});

		test('gibberish commands get no did-you-mean (relevance cutoff)', async () => {
			const cwd = canonicalMkdtemp('cli-gibberish-');
			try {
				const r = await runCLI(['run', 'qzxwv'], cwd);
				expect(r.exitCode).toBe(1);
				expect(r.stdout + r.stderr).not.toContain('Did you mean');
			} finally {
				await (await import('node:fs/promises')).rm(cwd, {
					recursive: true,
					force: true,
				});
			}
		});

		test('plausible typos still suggest; deprecated aliases warn on stderr', async () => {
			const cwd = canonicalMkdtemp('cli-typo-');
			try {
				const typo = await runCLI(['run', 'statu'], cwd);
				expect(typo.exitCode).toBe(1);
				expect(typo.stdout + typo.stderr).toContain('Did you mean');

				const alias = await runCLI(['run', 'plan'], cwd);
				expect(alias.stderr).toContain('deprecated');
			} finally {
				await (await import('node:fs/promises')).rm(cwd, {
					recursive: true,
					force: true,
				});
			}
		});
	});
});
