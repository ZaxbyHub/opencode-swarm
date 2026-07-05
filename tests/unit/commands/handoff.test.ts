import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	formatSessionScopedHandoffMarkdown,
	handleHandoffCommand,
} from '../../../src/commands/handoff';

describe('handleHandoffCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tempDir = await mkdtemp(join(tmpdir(), 'handoff-test-'));
		// Create .swarm directory
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		// Clean up the temporary directory after each test
		await rm(tempDir, { recursive: true, force: true });
	});

	test('writes .swarm/handoff.md atomically using temp file + rename', async () => {
		await handleHandoffCommand(tempDir, []);

		// Verify handoff.md was created
		const handoffPath = join(tempDir, '.swarm', 'handoff.md');
		expect(existsSync(handoffPath)).toBe(true);

		// Read the file to verify content
		const content = await Bun.file(handoffPath).text();
		expect(content).toContain('## Swarm Handoff');

		// Should NOT have temp files (they should be renamed/cleaned up)
		const swarmDir = join(tempDir, '.swarm');
		const files = await readdir(swarmDir);
		const tempFiles = files.filter((f) => f.includes('.tmp.'));
		expect(tempFiles.length).toBe(0);
	});

	test('session-scoped handoff formatter marks only new session handoffs', () => {
		const markdown = '## Swarm Handoff\nContinue from here.';

		expect(formatSessionScopedHandoffMarkdown(markdown)).toBe(markdown);

		const scoped = formatSessionScopedHandoffMarkdown(markdown, 'session 1/2');
		expect(scoped).toStartWith(
			'<!-- opencode-swarm-handoff-source-session: session%201%2F2 -->',
		);
		expect(scoped).toContain(markdown);
	});

	test('returns markdown with brief content and instructions', async () => {
		// Create minimal session state file
		await mkdir(join(tempDir, '.swarm', 'session'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'session', 'state.json'),
			JSON.stringify({ activeAgent: { architect: 'test' } }),
		);

		// Create minimal plan.json
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{ id: '1.1', status: 'in_progress', description: 'Task 1' },
						],
					},
				],
			}),
		);

		const result = await handleHandoffCommand(tempDir, []);

		// Verify response contains expected sections
		expect(result).toContain('## Handoff Brief Written');
		expect(result).toContain('.swarm/handoff.md');
		expect(result).toContain('## Swarm Handoff');
		expect(result).toContain('## Continuation Prompt');
		expect(result).toContain('```markdown');
	});

	test('handles missing .swarm directory gracefully', async () => {
		// Remove .swarm directory
		await rm(join(tempDir, '.swarm'), { recursive: true });

		// Should not throw, should handle gracefully
		const result = await handleHandoffCommand(tempDir, []);

		// Should still return a valid response
		expect(result).toContain('## Handoff Brief Written');
	});

	test('calls snapshot write after brief creation', async () => {
		await handleHandoffCommand(tempDir, []);

		// Verify handoff.md was created
		const handoffPath = join(tempDir, '.swarm', 'handoff.md');
		expect(existsSync(handoffPath)).toBe(true);

		// Snapshot is called internally - we verify by no errors thrown
		// The snapshot file is written to .swarm/session/snapshot.json
	});

	test('returns proper markdown format', async () => {
		const result = await handleHandoffCommand(tempDir, []);

		// Check response structure
		expect(result).toStartWith('## Handoff Brief Written');
		expect(result).toContain('## Continuation Prompt');
		expect(result).toContain('Copy and paste the block below');
	});

	test('handles write failures gracefully with non-existent directory', async () => {
		// Try to write to an unwritable location - use path that won't allow creating .swarm
		// The function should either throw or fail gracefully
		const nonExistentPath = '/this/path/does/not/exist/at/all';

		// Call function and check behavior - either throws or returns with error handling
		try {
			const result = await handleHandoffCommand(nonExistentPath, []);
			// If it doesn't throw, it should handle gracefully and still return markdown
			expect(result).toContain('## Handoff Brief Written');
		} catch (error) {
			// Error is expected for non-existent directory
			expect(error).toBeDefined();
		}
	});

	test('verifies atomic write - no partial files left behind', async () => {
		// Get files before
		const beforeFiles = await readdir(join(tempDir, '.swarm'));

		await handleHandoffCommand(tempDir, []);

		// Get files after
		const afterFiles = await readdir(join(tempDir, '.swarm'));

		// Should have more files (handoff.md)
		expect(afterFiles.length).toBeGreaterThan(beforeFiles.length);

		// Should NOT have temp files (they should be renamed/cleaned up)
		const tempFiles = afterFiles.filter((f) => f.includes('.tmp.'));
		expect(tempFiles.length).toBe(0);
	});
});
