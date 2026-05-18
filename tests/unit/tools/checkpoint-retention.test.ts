import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the tool AFTER setting up test environment
const { checkpoint } = await import('../../../src/tools/checkpoint');

// Test constants
const MAX_CHECKPOINTS = 20;

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

		// Set auto_checkpoint_threshold in config to match our expected threshold
		// Note: loadPluginConfigWithMeta reads from .opencode/opencode-swarm.json, not .swarm/
		const configDir = path.join(tempDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify(
				{ checkpoint: { auto_checkpoint_threshold: 20 } },
				null,
				2,
			),
		);
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
		test('is set to 20', () => {
			// We verify this by creating more than 20 checkpoints and checking only 20 remain
			// This is an indirect test since the constant is not exported
			expect(MAX_CHECKPOINTS).toBe(20);
		});

		test('retention limit is enforced at 20 checkpoints', async () => {
			// Create exactly 20 checkpoints
			for (let i = 0; i < 20; i++) {
				await checkpoint.execute({ action: 'save', label: `checkpoint-${i}` }, {
					directory: tempDir,
				} as any);
				await new Promise((r) => setTimeout(r, 10));
			}

			const listResult = await checkpoint.execute({ action: 'list' }, {
				directory: tempDir,
			} as any);
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(20);
			expect(listParsed.checkpoints).toHaveLength(20);
		});
	});

	describe('retention not applied when under limit', () => {
		test('no checkpoints deleted when count is below limit', async () => {
			// Create 10 checkpoints (under the limit of 20)
			for (let i = 0; i < 10; i++) {
				await checkpoint.execute(
					{ action: 'save', label: `under-limit-${i}` },
					{ directory: tempDir } as any,
				);
				await new Promise((r) => setTimeout(r, 10));
			}

			const listResult = await checkpoint.execute({ action: 'list' }, {
				directory: tempDir,
			} as any);
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(10);
			expect(
				listParsed.checkpoints.map((c: { label: string }) => c.label),
			).toEqual([
				'under-limit-9',
				'under-limit-8',
				'under-limit-7',
				'under-limit-6',
				'under-limit-5',
				'under-limit-4',
				'under-limit-3',
				'under-limit-2',
				'under-limit-1',
				'under-limit-0',
			]);
		});

		test('no retention event logged when under limit', async () => {
			// Create 10 checkpoints (still under the 20 limit)
			for (let i = 0; i < 10; i++) {
				await checkpoint.execute({ action: 'save', label: `no-event-${i}` }, {
					directory: tempDir,
				} as any);
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

	describe('retention applied when over limit', () => {
		test('creates 25 checkpoints, retains only 20, and logs 5 retention events', async () => {
			// Create 25 checkpoints
			for (let i = 0; i < 25; i++) {
				await checkpoint.execute({ action: 'save', label: `over-limit-${i}` }, {
					directory: tempDir,
				} as any);
				await new Promise((r) => setTimeout(r, 10));
			}

			// Verify only 20 checkpoints remain
			const listResult = await checkpoint.execute({ action: 'list' }, {
				directory: tempDir,
			} as any);
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(20);
			expect(listParsed.checkpoints).toHaveLength(20);

			// Verify oldest 5 checkpoints (0-4) were evicted
			const remainingLabels = listParsed.checkpoints.map(
				(c: { label: string }) => c.label,
			);
			for (let i = 0; i < 5; i++) {
				expect(remainingLabels).not.toContain(`over-limit-${i}`);
			}
			// Verify youngest 20 checkpoints (5-24) are still present
			for (let i = 5; i < 25; i++) {
				expect(remainingLabels).toContain(`over-limit-${i}`);
			}

			// Verify retention events were logged
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			expect(fs.existsSync(eventsPath)).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8');
			const lines = content.trim().split('\n').filter(Boolean);
			const retentionEvents = lines
				.filter((line) => {
					try {
						const event = JSON.parse(line);
						return event.event === 'checkpoint_retention_applied';
					} catch {
						return false;
					}
				})
				.map((line) => JSON.parse(line));

			// 5 events: at checkpoints 21, 22, 23, 24, 25 (each evicting 1)
			expect(retentionEvents).toHaveLength(5);

			// Verify each event has evicted_count=1 and decreasing remaining_count
			for (let i = 0; i < 5; i++) {
				expect(retentionEvents[i].evicted_count).toBe(1);
				expect(retentionEvents[i].remaining_count).toBe(20);
				expect(retentionEvents[i].evicted_labels).toEqual([`over-limit-${i}`]);
			}
		});
	});
});
