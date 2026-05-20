import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Import the tool AFTER setting up test environment
const { checkpoint } = await import('../../../src/tools/checkpoint');

describe('checkpoint tool', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-')),
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

	describe('tool metadata', () => {
		test('has description', () => {
			expect(checkpoint.description).toContain('checkpoint');
			expect(checkpoint.description).toContain('save');
			expect(checkpoint.description).toContain('restore');
		});

		test('has execute function', () => {
			expect(typeof checkpoint.execute).toBe('function');
		});
	});

	describe('save action', () => {
		test('creates checkpoint and returns success JSON', async () => {
			const result = await checkpoint.execute({
				action: 'save',
				label: 'my-checkpoint',
			});
			const parsed = JSON.parse(result);

			expect(parsed.action).toBe('save');
			expect(parsed.success).toBe(true);
			expect(parsed.label).toBe('my-checkpoint');
			expect(parsed.sha).toBeDefined();
			expect(parsed.message).toContain('my-checkpoint');
		});

		test('saves checkpoint to log file', async () => {
			await checkpoint.execute({ action: 'save', label: 'test-label' });

			const logPath = path.join(tempDir, '.swarm', 'checkpoints.json');
			expect(fs.existsSync(logPath)).toBe(true);

			const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
			expect(log.version).toBe(1);
			expect(log.checkpoints).toHaveLength(1);
			expect(log.checkpoints[0].label).toBe('test-label');
			expect(log.checkpoints[0].sha).toBeDefined();
			expect(log.checkpoints[0].timestamp).toBeDefined();
		});

		test('rejects duplicate label', async () => {
			await checkpoint.execute({ action: 'save', label: 'dup-test' });
			const result = await checkpoint.execute({
				action: 'save',
				label: 'dup-test',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('duplicate label');
		});

		test('handles label with spaces', async () => {
			const result = await checkpoint.execute({
				action: 'save',
				label: 'my checkpoint name',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.label).toBe('my checkpoint name');
		});

		test('handles label with special chars (hyphen, underscore)', async () => {
			const result = await checkpoint.execute({
				action: 'save',
				label: 'test-label_123',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});

		test('rejects label exceeding max length', async () => {
			const longLabel = 'a'.repeat(101);
			const result = await checkpoint.execute({
				action: 'save',
				label: longLabel,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('exceeds maximum length');
		});

		test('rejects empty label', async () => {
			const result = await checkpoint.execute({ action: 'save', label: '' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('label is required');
		});
	});

	describe('restore action', () => {
		test('restores to checkpoint and returns success JSON', async () => {
			// Create a file change so the checkpoint save creates a real commit
			fs.writeFileSync(
				path.join(tempDir, 'checkpoint-file.txt'),
				'checkpoint content',
			);

			const saveResult = await checkpoint.execute({
				action: 'save',
				label: 'restore-me',
			});
			const saveParsed = JSON.parse(saveResult);
			expect(saveParsed.success).toBe(true);
			const checkpointSha = saveParsed.sha;

			// Verify the checkpoint created a new commit (distinct from initial)
			const priorSha = execSync('git rev-parse HEAD~1', {
				encoding: 'utf-8',
			}).trim();
			expect(checkpointSha).not.toBe(priorSha);

			// Make another commit on top
			fs.writeFileSync(path.join(tempDir, 'new.txt'), 'new content');
			execSync('git add .', { encoding: 'utf-8' });
			execSync('git commit -m "new commit"', { encoding: 'utf-8' });

			// Now restore
			const result = await checkpoint.execute({
				action: 'restore',
				label: 'restore-me',
			});
			const parsed = JSON.parse(result);

			expect(parsed.action).toBe('restore');
			expect(parsed.success).toBe(true);
			expect(parsed.label).toBe('restore-me');
			expect(parsed.sha).toBe(checkpointSha);
			expect(parsed.message).toContain('soft reset');
		});

		test('returns error for non-existent checkpoint', async () => {
			const result = await checkpoint.execute({
				action: 'restore',
				label: 'does-not-exist',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('not found');
		});
	});

	describe('list action', () => {
		test('returns empty list when no checkpoints', async () => {
			const result = await checkpoint.execute({ action: 'list' });
			const parsed = JSON.parse(result);

			expect(parsed.action).toBe('list');
			expect(parsed.success).toBe(true);
			expect(parsed.count).toBe(0);
			expect(parsed.checkpoints).toEqual([]);
		});

		test('returns list of checkpoints sorted by timestamp', async () => {
			await checkpoint.execute({ action: 'save', label: 'first' });
			await new Promise((r) => setTimeout(r, 10));
			await checkpoint.execute({ action: 'save', label: 'second' });

			const result = await checkpoint.execute({ action: 'list' });
			const parsed = JSON.parse(result);

			expect(parsed.count).toBe(2);
			expect(parsed.checkpoints).toHaveLength(2);
			expect(parsed.checkpoints[0].label).toBe('second'); // Most recent first
			expect(parsed.checkpoints[1].label).toBe('first');
		});
	});

	describe('delete action', () => {
		test('deletes checkpoint and returns success JSON', async () => {
			await checkpoint.execute({ action: 'save', label: 'to-delete' });

			const result = await checkpoint.execute({
				action: 'delete',
				label: 'to-delete',
			});
			const parsed = JSON.parse(result);

			expect(parsed.action).toBe('delete');
			expect(parsed.success).toBe(true);
			expect(parsed.label).toBe('to-delete');
			expect(parsed.message).toContain('to-delete');
		});

		test('removes checkpoint from log file', async () => {
			await checkpoint.execute({ action: 'save', label: 'to-delete' });
			await checkpoint.execute({ action: 'delete', label: 'to-delete' });

			const listResult = await checkpoint.execute({ action: 'list' });
			const listParsed = JSON.parse(listResult);

			expect(listParsed.count).toBe(0);
		});

		test('returns error for non-existent checkpoint', async () => {
			const result = await checkpoint.execute({
				action: 'delete',
				label: 'does-not-exist',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('not found');
		});
	});

	describe('validation', () => {
		test('rejects invalid action', async () => {
			const result = await checkpoint.execute({ action: 'invalid-action' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('invalid action');
		});

		test('rejects missing label for save', async () => {
			const result = await checkpoint.execute({ action: 'save' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('label is required');
		});

		test('rejects missing label for restore', async () => {
			const result = await checkpoint.execute({ action: 'restore' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('label is required');
		});

		test('rejects missing label for delete', async () => {
			const result = await checkpoint.execute({ action: 'delete' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('label is required');
		});

		test('rejects label with shell metacharacters', async () => {
			const result = await checkpoint.execute({
				action: 'save',
				label: 'test;rm -rf',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('shell metacharacters');
		});

		test('rejects label with path traversal', async () => {
			// Note: forward slash and backslash are caught by SAFE_LABEL_PATTERN first
			// This tests backslash specifically which fails validation earlier
			const result = await checkpoint.execute({
				action: 'save',
				label: '..\\etc\\passwd',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			// Either path traversal or invalid characters is acceptable
			expect(parsed.error).toMatch(/path traversal|invalid characters/);
		});
	});

	describe('non-git directory', () => {
		test('returns error when not in git repo', async () => {
			// Create temp dir without git - use different temp root to avoid locking
			const nonGitDir = path.join(os.tmpdir(), 'non-git-' + Date.now());
			fs.mkdirSync(nonGitDir, { recursive: true });

			// Save original dir and change to non-git
			const prevCwd = process.cwd();
			process.chdir(nonGitDir);

			const result = await checkpoint.execute({ action: 'list' });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('not a git repository');

			// Restore first, then cleanup
			process.chdir(prevCwd);
			// Use setTimeout to delay cleanup and avoid locking
			setTimeout(() => {
				try {
					fs.rmSync(nonGitDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors on Windows
				}
			}, 100);
		});
	});

	describe('JSON response correctness', () => {
		test('returns valid JSON for all actions', async () => {
			const actions = [
				{ action: 'list', label: undefined },
				{ action: 'save', label: 'json-test' },
			];

			for (const args of actions) {
				const result = await checkpoint.execute(args as any);
				expect(() => JSON.parse(result)).not.toThrow();
			}
		});

		test('all success responses contain required fields', async () => {
			// Save action
			const saveResult = await checkpoint.execute({
				action: 'save',
				label: 'fields-test',
			});
			const saveParsed = JSON.parse(saveResult);
			expect(saveParsed).toHaveProperty('action');
			expect(saveParsed).toHaveProperty('success');
			expect(saveParsed).toHaveProperty('label');
			expect(saveParsed).toHaveProperty('sha');
			expect(saveParsed).toHaveProperty('message');

			// List action
			const listResult = await checkpoint.execute({ action: 'list' });
			const listParsed = JSON.parse(listResult);
			expect(listParsed).toHaveProperty('action');
			expect(listParsed).toHaveProperty('success');
			expect(listParsed).toHaveProperty('count');
			expect(listParsed).toHaveProperty('checkpoints');

			// Delete action
			const deleteResult = await checkpoint.execute({
				action: 'delete',
				label: 'fields-test',
			});
			const deleteParsed = JSON.parse(deleteResult);
			expect(deleteParsed).toHaveProperty('action');
			expect(deleteParsed).toHaveProperty('success');
			expect(deleteParsed).toHaveProperty('label');
			expect(deleteParsed).toHaveProperty('message');

			// Restore action (need to save first)
			await checkpoint.execute({ action: 'save', label: 'restore-fields' });
			const restoreResult = await checkpoint.execute({
				action: 'restore',
				label: 'restore-fields',
			});
			const restoreParsed = JSON.parse(restoreResult);
			expect(restoreParsed).toHaveProperty('action');
			expect(restoreParsed).toHaveProperty('success');
			expect(restoreParsed).toHaveProperty('label');
			expect(restoreParsed).toHaveProperty('sha');
			expect(restoreParsed).toHaveProperty('message');
		});
	});

	// ───────────────────────────────────────────────────────────────────────────
	// Regression: empty-commit elimination (Issue #687)
	// ───────────────────────────────────────────────────────────────────────────

	describe('empty-commit elimination', () => {
		test('save on clean tree records HEAD SHA without creating a new commit', async () => {
			const headBefore = execSync('git rev-parse HEAD', {
				encoding: 'utf-8',
			}).trim();

			const result = await checkpoint.execute({
				action: 'save',
				label: 'clean-tree-checkpoint',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.sha).toBe(headBefore);

			// HEAD must not have advanced — no new commit was created
			const headAfter = execSync('git rev-parse HEAD', {
				encoding: 'utf-8',
			}).trim();
			expect(headAfter).toBe(headBefore);
		});

		test('save on dirty tree stages files and creates a new commit', async () => {
			fs.writeFileSync(path.join(tempDir, 'dirty.txt'), 'dirty content');
			const headBefore = execSync('git rev-parse HEAD', {
				encoding: 'utf-8',
			}).trim();

			const result = await checkpoint.execute({
				action: 'save',
				label: 'dirty-tree-checkpoint',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// HEAD must have advanced — a new commit was created
			const headAfter = execSync('git rev-parse HEAD', {
				encoding: 'utf-8',
			}).trim();
			expect(headAfter).not.toBe(headBefore);
			expect(parsed.sha).toBe(headAfter);
		});

		test('save excludes .swarm/ directory from staged changes', async () => {
			// Write something into .swarm/ — it must not appear in the commit
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'sensitive.json'),
				'{"secret":"value"}',
			);
			// Also write a non-swarm file to ensure a commit is created
			fs.writeFileSync(path.join(tempDir, 'safe.txt'), 'safe content');

			const result = await checkpoint.execute({
				action: 'save',
				label: 'exclude-swarm',
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// .swarm/sensitive.json must not be tracked in the commit
			const committedFiles = execSync('git show --name-only --format="" HEAD', {
				encoding: 'utf-8',
			}).trim();
			expect(committedFiles).not.toContain('.swarm');
			expect(committedFiles).toContain('safe.txt');
		});

		test('two consecutive saves on a clean tree share the same SHA', async () => {
			const r1 = JSON.parse(
				await checkpoint.execute({ action: 'save', label: 'snap-1' }),
			);
			const r2 = JSON.parse(
				await checkpoint.execute({ action: 'save', label: 'snap-2' }),
			);

			expect(r1.success).toBe(true);
			expect(r2.success).toBe(true);
			// Both record the same HEAD SHA because no commit was created
			expect(r1.sha).toBe(r2.sha);
		});
	});
});
