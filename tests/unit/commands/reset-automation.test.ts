import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock resetAutomationManager function BEFORE importing the module
const mockResetAutomationManager = mock(() => {});

// Mock the background/manager module
mock.module('../../../src/background/manager.js', () => ({
	resetAutomationManager: mockResetAutomationManager,
	getAutomationManager: mock(() => ({})),
	createAutomationManager: mock(() => ({})),
}));

// Import after mock setup
const { handleResetCommand } = await import('../../../src/commands/reset.js');

describe('handleResetCommand - Background Automation Reset', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-reset-automation-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		mockResetAutomationManager.mockClear();
		// Reset mock to default behavior (no error)
		mockResetAutomationManager.mockImplementation(() => {});
	});

	afterEach(async () => {
		mock.restore();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('Reset stops automation - resetAutomationManager is called with --confirm', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify resetAutomationManager was called
		expect(mockResetAutomationManager).toHaveBeenCalledTimes(1);

		// Verify output contains automation reset message
		expect(result).toContain(
			'✅ Stopped background automation (in-memory queues cleared)',
		);
	});

	it('Reset clears queues and reports success', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify resetAutomationManager was called to clear queues
		expect(mockResetAutomationManager).toHaveBeenCalledTimes(1);

		// Verify output mentions queue clearing
		expect(result).toContain('in-memory queues cleared');
	});

	it('Reset preserves file cleanup - plan.md and context.md are still deleted', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify files are deleted
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);

		// Verify output mentions file deletion
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');

		// Verify automation reset was also called
		expect(mockResetAutomationManager).toHaveBeenCalledTimes(1);
	});

	it('Reset handles non-running automation gracefully', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		// Simulate resetAutomationManager throwing an error (automation not running)
		mockResetAutomationManager.mockImplementation(() => {
			throw new Error('Automation not running');
		});

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify files are still deleted even when automation reset fails
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(false);

		// Verify output shows automation was skipped, not stopped
		expect(result).toContain('⏭️ Background automation not running (skipped)');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
	});

	it('User sees confirmation - output mentions queue clearing', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify output contains all expected messages
		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain(
			'✅ Stopped background automation (in-memory queues cleared)',
		);
		expect(result).toContain(
			'Swarm state has been cleared. Start fresh with a new plan.',
		);
	});

	it('Without --confirm - resetAutomationManager is NOT called', async () => {
		// Create test files
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');

		const result = await handleResetCommand(tempDir, []);

		// Verify resetAutomationManager was NOT called
		expect(mockResetAutomationManager).not.toHaveBeenCalled();

		// Verify files still exist
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'context.md'))).toBe(true);

		// Verify output is the warning message
		expect(result).toContain('## Swarm Reset');
		expect(result).toContain('To confirm, run: `/swarm reset --confirm`');
	});

	it('Reset works when no files exist but automation is running', async () => {
		// Don't create any files

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify resetAutomationManager was called
		expect(mockResetAutomationManager).toHaveBeenCalledTimes(1);

		// Verify output mentions automation reset
		expect(result).toContain(
			'✅ Stopped background automation (in-memory queues cleared)',
		);

		// Verify output mentions files not found
		expect(result).toContain('⏭️ plan.md not found (skipped)');
		expect(result).toContain('⏭️ context.md not found (skipped)');
	});

	it('Reset preserves summaries directory cleanup', async () => {
		// Create test files and summaries directory
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');
		await mkdir(join(tempDir, '.swarm', 'summaries'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'summaries', 'summary.txt'),
			'Test summary',
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify summaries directory is deleted
		expect(existsSync(join(tempDir, '.swarm', 'summaries'))).toBe(false);

		// Verify output mentions summaries deletion
		expect(result).toContain('✅ Deleted summaries/ directory');

		// Verify automation reset was also called
		expect(mockResetAutomationManager).toHaveBeenCalledTimes(1);
	});

	it('Reset includes all cleanup operations in correct order', async () => {
		// Create test files and summaries directory
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '## Test Plan\n');
		await writeFile(join(tempDir, '.swarm', 'context.md'), '# Context\n');
		await mkdir(join(tempDir, '.swarm', 'summaries'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'summaries', 'summary.txt'),
			'Test summary',
		);

		const result = await handleResetCommand(tempDir, ['--confirm']);

		// Verify output structure - automation reset should be after file deletion
		expect(result).toContain('## Swarm Reset Complete');
		expect(result).toContain('✅ Deleted plan.md');
		expect(result).toContain('✅ Deleted context.md');
		expect(result).toContain(
			'✅ Stopped background automation (in-memory queues cleared)',
		);
		expect(result).toContain('✅ Deleted summaries/ directory');

		// Verify the order: files deleted before automation reset message
		const planIndex = result.indexOf('Deleted plan.md');
		const automationIndex = result.indexOf('Stopped background automation');
		expect(planIndex).toBeLessThan(automationIndex);
	});
});
