/**
 * Agent Activity — Adversarial Security & Edge-Case Tests
 *
 * Attacks the atomic write implementation in doFlush() to identify
 * security vulnerabilities and race conditions.
 *
 * Attack vectors:
 * 1. Path traversal: directory with ../ segments
 * 2. Concurrent writes: racing on the same .tmp file
 * 3. Oversized content: 10MB+ strings
 * 4. Null/undefined directory: empty/undefined paths
 * 5. Stale temp file: pre-existing .tmp from crash
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { _flushForTesting } from '../../../src/hooks/agent-activity';
import { resetSwarmState, swarmState } from '../../../src/state';

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

describe('Agent Activity — Adversarial Security & Edge Cases', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'agent-activity-adversarial-'));
		// Create .swarm directory
		await mkdir(join(tempDir, '.swarm'), { recursive: true });

		// Set up some tool activity so flush has data to write
		swarmState.toolAggregates.set('test-tool', {
			tool: 'test-tool',
			count: 1,
			successCount: 1,
			failureCount: 0,
			totalDuration: 100,
		});
		swarmState.pendingEvents = 1;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('Path traversal attacks', () => {
		it('should NOT escape .swarm/ when directory contains ../ segments', async () => {
			// Attack: Use directory path with .. to try to write outside .swarm
			const maliciousDir = join(tempDir, '.swarm', '..', '..');

			// Attempt to flush with malicious directory
			// This will likely fail with EISDIR when trying to read context.md
			try {
				await _flushForTesting(maliciousDir);
			} catch (error) {
				// It's OK if it throws - the important thing is files don't escape
			}

			// Check if any files were written outside .swarm
			// Should NOT exist: tempDir/context.md or tempDir/context.md.tmp
			const escapedPath1 = join(tempDir, 'context.md');
			const escapedPath2 = join(tempDir, 'context.md.tmp');

			expect(existsSync(escapedPath1)).toBe(false);
			expect(existsSync(escapedPath2)).toBe(false);
		});

		it('should handle directory with ../ segments that resolves to a directory', async () => {
			// Attack: Relative path that points to a directory (not a file)
			// The code tries to read directory + '/.swarm/context.md' which becomes a directory path

			// Try with relative path that points to the temp directory itself
			const relativeDir = join(tempDir, '.swarm', '..');

			// This should fail with EISDIR and be caught
			try {
				await _flushForTesting(relativeDir);
			} catch (error) {
				// It's OK if it throws
			}

			// Verify no files escaped to tempDir root
			const escapedContext = join(tempDir, 'context.md');
			expect(existsSync(escapedContext)).toBe(false);
		});
	});

	describe('Concurrent write races', () => {
		it('should handle concurrent calls without corrupting each other', async () => {
			// Create initial context.md
			const contextPath = join(tempDir, '.swarm', 'context.md');
			await writeFile(contextPath, '# Initial\n');

			// Simulate concurrent flushes by calling twice in parallel
			// They will race on the same .tmp file
			const flush1 = _flushForTesting(tempDir);
			const flush2 = _flushForTesting(tempDir);

			// Wait for both to complete
			await Promise.all([flush1, flush2]);

			// Final file should still be valid (not corrupted)
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');

			// Verify .tmp file was cleaned up (not left behind)
			const tempExists = await stat(`${contextPath}.tmp`)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);
		});

		it('should handle rapid successive flushes without data loss', async () => {
			// Create initial context.md
			const contextPath = join(tempDir, '.swarm', 'context.md');
			await writeFile(contextPath, '# Initial\n');

			// Add more tool activity to simulate rapid calls
			swarmState.toolAggregates.set('tool2', {
				tool: 'tool2',
				count: 5,
				successCount: 4,
				failureCount: 1,
				totalDuration: 500,
			});

			// Fire 5 flushes in rapid succession
			const flushes = Array(5)
				.fill(null)
				.map(() => _flushForTesting(tempDir));

			await Promise.all(flushes);

			// Final file should still be valid
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');

			// Verify .tmp file was cleaned up
			const tempExists = await stat(`${contextPath}.tmp`)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);

			// Check if content contains expected tools
			expect(content).toContain('test-tool');
			expect(content).toContain('tool2');
		});

		it('should handle concurrent flushes with different toolAggregates states', async () => {
			const contextPath = join(tempDir, '.swarm', 'context.md');
			await writeFile(contextPath, '# Initial\n');

			// Create a promise we can control
			let resolveWrite: () => void;
			const writeBlocker = new Promise<void>((resolve) => {
				resolveWrite = resolve!;
			});

			// Mock Bun.write to block on first call, then release
			const originalWrite = Bun.write;
			let writeCount = 0;
			const writeSpy = vi
				.spyOn(Bun, 'write')
				.mockImplementation(async (path: string, data: string | BunFile) => {
					writeCount++;
					if (writeCount === 1) {
						// Block first write to create race condition
						await writeBlocker;
					}
					return originalWrite(path, data);
				});

			// Start first flush (will block)
			const flush1 = _flushForTesting(tempDir);

			// While first flush is blocked, modify state and trigger second flush
			swarmState.pendingEvents = 10;
			swarmState.toolAggregates.set('tool3', {
				tool: 'tool3',
				count: 2,
				successCount: 1,
				failureCount: 1,
				totalDuration: 200,
			});

			const flush2 = _flushForTesting(tempDir);

			// Release the block
			resolveWrite!();

			// Wait for both to complete
			await Promise.all([flush1, flush2]);

			// Final file should be valid
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');

			// Verify .tmp file was cleaned up
			const tempExists = await stat(`${contextPath}.tmp`)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);

			writeSpy.mockRestore();
		});
	});

	describe('Oversized content attacks', () => {
		it('should handle 10MB context content without error', async () => {
			// Create initial context.md with 10MB of content
			const contextPath = join(tempDir, '.swarm', 'context.md');
			const largeContent = 'X'.repeat(10 * 1024 * 1024); // 10MB
			await writeFile(contextPath, largeContent);

			// Mock console.warn to suppress any warnings
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			// Flush should complete successfully
			await _flushForTesting(tempDir);

			// Verify file was updated
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');
			expect(content.length).toBeGreaterThan(10 * 1024 * 1024); // Still large

			// Verify .tmp file was cleaned up
			const tempExists = await stat(`${contextPath}.tmp`)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);

			warnSpy.mockRestore();
		});

		it('should handle extremely large toolAggregates (many entries)', async () => {
			const contextPath = join(tempDir, '.swarm', 'context.md');
			await writeFile(contextPath, '# Initial\n');

			// Add 1000 different tools
			for (let i = 0; i < 1000; i++) {
				swarmState.toolAggregates.set(`tool-${i}`, {
					tool: `tool-${i}`,
					count: i + 1,
					successCount: Math.floor((i + 1) * 0.8),
					failureCount: Math.ceil((i + 1) * 0.2),
					totalDuration: (i + 1) * 100,
				});
			}
			swarmState.pendingEvents = 1000;

			// Mock console.warn to suppress any warnings
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			// Flush should complete successfully
			await _flushForTesting(tempDir);

			// Verify file was updated
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('tool-0');
			expect(content).toContain('tool-999');

			// Verify .tmp file was cleaned up
			const tempExists = await stat(`${contextPath}.tmp`)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);

			warnSpy.mockRestore();
		});
	});

	describe('Null/undefined directory attacks', () => {
		it('should handle empty string directory gracefully', async () => {
			// Try with empty string directory
			// This will try to write to '/.swarm/context.md' which should fail
			try {
				await _flushForTesting('');
			} catch (error) {
				// It's OK if it throws - the important thing is files don't escape
			}

			// Verify no files were written to unexpected locations
			const escapedContext = join(tempDir, 'context.md');
			expect(existsSync(escapedContext)).toBe(false);
		});

		it('should handle trailing slash path gracefully', async () => {
			// Try with a path that has a trailing slash
			// This results in directory + '/.swarm/context.md' which might resolve oddly
			const weirdPath = join(tempDir, '.swarm') + '/';

			// Try to flush - this might fail or work depending on how the path is resolved
			try {
				await _flushForTesting(weirdPath);
			} catch (error) {
				// It's OK if it throws
			}

			// The key is: verify no files escaped to tempDir root
			const escapedContext = join(tempDir, 'context.md');
			expect(existsSync(escapedContext)).toBe(false);
		});
	});

	describe('Stale temp file attacks', () => {
		it('should overwrite pre-existing .tmp file from crash', async () => {
			const contextPath = join(tempDir, '.swarm', 'context.md');
			const tempPath = `${contextPath}.tmp`;

			// Create a stale .tmp file from a previous "crash"
			await writeFile(tempPath, 'CORRUPTED DATA FROM CRASH\n');

			// Create initial context.md
			await writeFile(contextPath, '# Initial\n');

			// Flush should overwrite the stale .tmp file
			await _flushForTesting(tempDir);

			// Verify final file is correct (not corrupted)
			const content = await Bun.file(contextPath).text();
			expect(content).toContain('## Agent Activity');
			expect(content).not.toContain('CORRUPTED DATA FROM CRASH');

			// Verify .tmp file was cleaned up
			const tempExists = await stat(tempPath)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);
		});

		it('should handle read-only .tmp file gracefully', async () => {
			const contextPath = join(tempDir, '.swarm', 'context.md');
			const tempPath = `${contextPath}.tmp`;

			// Create a read-only .tmp file
			// Note: On Windows, read-only can still be overwritten by the owner
			// This test mainly checks error handling
			await writeFile(tempPath, 'STALE DATA\n');

			// Create initial context.md
			await writeFile(contextPath, '# Initial\n');

			// Mock console.warn to suppress expected errors
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			// Flush should handle this gracefully
			try {
				await _flushForTesting(tempDir);
			} catch (error) {
				// It's OK if it throws
			}

			// Verify context.md was not corrupted
			const content = await Bun.file(contextPath).text();
			// Either contains the expected data or is unchanged
			expect(
				content.includes('## Agent Activity') || content === '# Initial\n',
			).toBe(true);

			warnSpy.mockRestore();
		});

		it('should handle stale .tmp file and ensure cleanup on error', async () => {
			const contextPath = join(tempDir, '.swarm', 'context.md');
			const tempPath = `${contextPath}.tmp`;

			// Create a stale .tmp file from a previous "crash"
			await writeFile(tempPath, 'CORRUPTED DATA FROM CRASH\n');

			// Create initial context.md
			await writeFile(contextPath, '# Initial\n');

			// Mock Bun.write to simulate write error
			const writeSpy = spyOn(Bun, 'write').mockImplementation(async () => {
				throw new Error('ENOSPC: no space left on device');
			});

			// Flush should fail gracefully
			await _flushForTesting(tempDir);

			// Verify original context.md was not corrupted
			const content = await Bun.file(contextPath).text();
			expect(content).toBe('# Initial\n');

			// Verify .tmp file was cleaned up (unlink in catch block)
			const tempExists = await stat(tempPath)
				.then(() => true)
				.catch(() => false);
			expect(tempExists).toBe(false);

			writeSpy.mockRestore();
		});
	});
});

// Helper function to list files recursively
async function listFiles(
	dir: string,
	baseDir: string = dir,
): Promise<string[]> {
	const files: string[] = [];
	const entries = await Bun.file(dir).arrayBuffer();

	// Use node:fs for directory listing
	const { readdir } = await import('node:fs/promises');
	const dirEntries = await readdir(dir, { withFileTypes: true });

	for (const entry of dirEntries) {
		const fullPath = join(dir, entry.name);
		const relativePath = fullPath.replace(baseDir, '').replace(/\\/g, '/');

		if (entry.isDirectory()) {
			files.push(...(await listFiles(fullPath, baseDir)));
		} else {
			files.push(relativePath);
		}
	}

	return files;
}
