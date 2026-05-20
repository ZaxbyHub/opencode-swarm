import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleResetCommand } from '../../../src/commands/reset';

describe('handleResetCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-reset-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('Without --confirm - returns warning text, files NOT deleted', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, []);

		expect(result).toContain('## Swarm Reset');
		expect(result).toContain('⚠️ This will delete all swarm state from .swarm/');
		expect(result).toContain(
			'Tip**: Run `/swarm export` first to backup your state.',
		);
		expect(result).toContain('To confirm, run: `/swarm reset --confirm`');

		// Verify files still exist
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(true);
	});

	test('With --confirm - files ARE deleted', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);

		// Verify files are deleted
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);
	});

	test('With --confirm, files already missing - reports not found', async () => {
		// Don't create any files
		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('⏭️ plan.md not found (skipped)');
		expect(result).toContain('⏭️ context.md not found (skipped)');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);
	});

	test('With --confirm, only plan.md exists - deletes plan.md, skips context.md', async () => {
		// Create only plan.md
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('⏭️ context.md not found (skipped)');
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);

		// Verify plan.md is deleted but context.md was never created
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);
	});

	test('Warning message includes tip about /swarm export', async () => {
		const result = await handleResetCommand(tempDir, []);

		expect(result).toContain(
			'Tip**: Run `/swarm export` first to backup your state.',
		);
	});

	test('With --confirm flag', async () => {
		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
	});

	test('With additional args alongside --confirm', async () => {
		// Create both files
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
`,
		);

		const result = await handleResetCommand(tempDir, [
			'--confirm',
			'extra',
			'args',
		]);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
	});

	test('With --confirm - also deletes plan.json when present', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ swarm: 'test', title: 'Test Plan', phases: [] }),
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.json');
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(false);
	});

	test('With --confirm - deletes SWARM_PLAN artifacts from .swarm/', async () => {
		await writeFile(join(tempDir, '.swarm', 'SWARM_PLAN.json'), '{}');
		await writeFile(join(tempDir, '.swarm', 'SWARM_PLAN.md'), '# Plan');
		await writeFile(join(tempDir, '.swarm', 'checkpoints.json'), '[]');
		await writeFile(join(tempDir, '.swarm', 'events.jsonl'), '');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted SWARM_PLAN.json');
		expect(result).toContain('✅ Deleted SWARM_PLAN.md');
		expect(result).toContain('✅ Deleted checkpoints.json');
		expect(result).toContain('✅ Deleted events.jsonl');
		expect(existsSync(join(tempDir, '.swarm', 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'SWARM_PLAN.md'))).toBe(false);
	});

	test('With --confirm - deletes legacy root-level SWARM_PLAN artifacts', async () => {
		await writeFile(join(tempDir, 'SWARM_PLAN.json'), '{}');
		await writeFile(join(tempDir, 'SWARM_PLAN.md'), '# Plan');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted SWARM_PLAN.json (root)');
		expect(result).toContain('✅ Deleted SWARM_PLAN.md (root)');
		expect(existsSync(join(tempDir, 'SWARM_PLAN.json'))).toBe(false);
		expect(existsSync(join(tempDir, 'SWARM_PLAN.md'))).toBe(false);
	});

	test('With --confirm - skips missing optional artifacts silently', async () => {
		// Only create plan.md; all other files absent
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '# Plan');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('⏭️ plan.json not found (skipped)');
		expect(result).toContain('⏭️ SWARM_PLAN.json not found (skipped)');
		expect(result).toContain('⏭️ checkpoints.json not found (skipped)');
		expect(result).toContain('⏭️ events.jsonl not found (skipped)');
	});
});
