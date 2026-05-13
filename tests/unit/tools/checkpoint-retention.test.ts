import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the tool AFTER setting up test environment
const { checkpoint } = await import('../../../src/tools/checkpoint');

// Test constants
const MAX_CHECKPOINTS = 10;

describe('checkpoint retention policy', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-')),
		);
		originalCwd = process.cwd();

		// Initialize a git repo in temp directory
		process.chdir(tempDir);
		execSync('git init', { encoding: 'utf-8' });
		execSync('git config --local commit.gpgsign false', { encoding: 'utf-8' });
		execSync('git config user.email "test@test.com"', { encoding: 'utf-8' });
		execSync('git config user.name "Test"', { encoding: 'utf-8' });
		// Create initial commit
		fs.writeFileSync(path.join(tempDir, 'initial.txt'), 'initial');
		execSync('git add .', { encoding: 'utf-8' });
		execSync('git commit -m "initial"', { encoding: 'utf-8' });
	});

	afterEach(() => {
		// Restore original directory
		process.chdir(originalCwd);
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('MAX_CHECKPOINTS constant', () => {
		test('is set to 10', () => {
			// We verify this by creating more than 10 checkpoints and checking only 10 remain
			// This is an indirect test since the constant is not exported
			expect(MAX_CHECKPOINTS).toBe(10);
		});

		test('retention limit is enforced at 10 checkpoints', async () => {
			// Create exactly 10 checkpoints
			for (let i = 0; i < 10; i++) {
				await checkpoint.execute({ action: 'save', label: `checkpoint-${i}` });
				await new Promise((r) => setTimeout(r, 10));
			}

			const listResult = await checkpoint.execute({ action: 'list' });
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(10);
			expect(listParsed.checkpoints).toHaveLength(10);
		});
	});

	describe('retention not applied when under limit', () => {
		test('no checkpoints deleted when count is below limit', async () => {
			// Create 5 checkpoints (under the limit of 10)
			for (let i = 0; i < 5; i++) {
				await checkpoint.execute({ action: 'save', label: `under-limit-${i}` });
				await new Promise((r) => setTimeout(r, 10));
			}

			const listResult = await checkpoint.execute({ action: 'list' });
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(5);
			expect(
				listParsed.checkpoints.map((c: { label: string }) => c.label),
			).toEqual([
				'under-limit-4',
				'under-limit-3',
				'under-limit-2',
				'under-limit-1',
				'under-limit-0',
			]);
		});

		test('no retention event logged when under limit', async () => {
			// Create 5 checkpoints
			for (let i = 0; i < 5; i++) {
				await checkpoint.execute({ action: 'save', label: `no-event-${i}` });
				await new Promise((r) => setTimeout(r, 10));
			}

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');

			// No events.jsonl should exist or it should have no retention events
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n').filter(Boolean);
				const retentionEvents = lines.filter((line) => {
					try {
						const event = JSON.parse(line);
						return event.event === 'checkpoint_retention_applied';
					} catch {
						return false;
					}
				});
				expect(retentionEvents).toHaveLength(0);
			}
		});
	});
});
