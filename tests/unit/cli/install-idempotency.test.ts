import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const CLI_PATH = join(import.meta.dir, '../../../src/cli/index.ts');

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

/**
 * Issue #2493 obligations 1-2: install idempotency and first-run activation.
 * Adversarial edge cases straight from the issue: second install no-op,
 * user-modified config preserved, alternate config dir honored.
 */
describe('CLI install idempotency (issue #2493)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-idem-');
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('fresh install writes auto_select_architect: true (first-run activation)', async () => {
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const pluginConfig = JSON.parse(
			await readFile(join(tempDir, 'opencode', 'opencode-swarm.json'), 'utf-8'),
		);
		expect(pluginConfig.auto_select_architect).toBe(true);
	});

	test('second install is a byte-for-byte no-op (opencode.json untouched)', async () => {
		const first = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(first.exitCode).toBe(0);
		const afterFirst = await readFile(
			join(tempDir, 'opencode', 'opencode.json'),
			'utf-8',
		);

		const second = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(second.exitCode).toBe(0);
		expect(second.stdout).toContain('already up to date');

		const afterSecond = await readFile(
			join(tempDir, 'opencode', 'opencode.json'),
			'utf-8',
		);
		expect(afterSecond).toBe(afterFirst);

		// No backup is created when nothing is rewritten.
		expect(
			existsSync(
				join(tempDir, 'opencode', 'opencode.swarm-install-backup.json'),
			),
		).toBe(false);
	});

	test('existing user config with custom formatting is backed up before rewrite', async () => {
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		const original =
			'{\n  "theme": "custom",\n  "plugin": ["other-plugin"]\n}\n';
		await writeFile(opencodeJsonPath, original);

		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const backupPath = join(
			tempDir,
			'opencode',
			'opencode.swarm-install-backup.json',
		);
		expect(existsSync(backupPath)).toBe(true);
		expect(await readFile(backupPath, 'utf-8')).toBe(original);

		const updated = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(updated.plugin).toContain('opencode-swarm');
		expect(updated.plugin).toContain('other-plugin');
		expect(updated.theme).toBe('custom');
	});

	test('OPENCODE_CONFIG_DIR is honored (alternate config dir)', async () => {
		const altDir = canonicalMkdtemp('opencode-swarm-alt-');
		try {
			const result = await runCLI(['install'], {
				OPENCODE_CONFIG_DIR: altDir,
				XDG_CONFIG_HOME: tempDir,
			});
			expect(result.exitCode).toBe(0);

			expect(existsSync(join(altDir, 'opencode.json'))).toBe(true);
			expect(existsSync(join(tempDir, 'opencode', 'opencode.json'))).toBe(
				false,
			);
		} finally {
			await rm(altDir, { recursive: true, force: true });
		}
	});

	test('key-order-only differences are not rewritten (order-insensitive compare)', async () => {
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		// Semantically what install produces, but with reversed key order and
		// different whitespace — a rewrite here would churn the user's file.
		await writeFile(
			opencodeJsonPath,
			'{"agent":{"general":{"disable":true},"explore":{"disable":true}},"plugin":["opencode-swarm"]}',
		);

		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('already up to date');
		expect(await readFile(opencodeJsonPath, 'utf-8')).toBe(
			'{"agent":{"general":{"disable":true},"explore":{"disable":true}},"plugin":["opencode-swarm"]}',
		);
	});

	// #2493 review: pin the documented safe-replacement behavior for a
	// malformed (non-object) agent value — the string cannot carry a disable
	// flag, so it is replaced with a well-formed record instead of throwing.
	test('malformed non-object agent value is replaced with a well-formed record', async () => {
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		await writeFile(opencodeJsonPath, '{"agent":{"explore":"legacy-string"}}');

		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(parsed.agent.explore).toEqual({ disable: true });
		expect(parsed.plugin).toContain('opencode-swarm');
	});

	// #2493 review: an unparseable opencode.json must not fail the install —
	// it starts fresh, WARNS, and preserves the original bytes in the backup.
	test('unparseable config warns, starts fresh, and preserves the original in the backup', async () => {
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		const backupPath = join(
			tempDir,
			'opencode',
			'opencode.swarm-install-backup.json',
		);
		await writeFile(opencodeJsonPath, '{ this is not json');

		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('could not be parsed');

		const parsed = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(parsed.plugin).toContain('opencode-swarm');
		expect(await readFile(backupPath, 'utf-8')).toBe('{ this is not json');
	});
});
