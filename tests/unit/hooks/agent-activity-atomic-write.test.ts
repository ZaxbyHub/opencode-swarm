/**
 * Agent Activity — Atomic Write Tests
 *
 * Tests the atomic write-to-temp-then-rename pattern in doFlush()
 * to ensure proper cleanup of .tmp files and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { _flushForTesting } from '../../../src/hooks/agent-activity';
import { resetSwarmState, swarmState } from '../../../src/state';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write';

const realWriteSync = atomicWriteInternals.writeSync;

/** Any canonical-grammar or legacy temp for the flush target counts as residue. */
async function contextTempResidue(tempDir: string): Promise<string[]> {
	const entries = await readdir(join(tempDir, '.swarm'));
	return entries.filter(
		(e) => e.startsWith('context.md') && e.endsWith('.tmp'),
	);
}

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

describe('Agent Activity — Atomic Write Pattern', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'agent-activity-atomic-test-'));
		// Create .swarm directory
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('doFlush() atomic write pattern', () => {
		beforeEach(async () => {
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

		describe('Happy path', () => {
			it('should write final file and NOT leave .tmp file on success', async () => {
				// Create initial context.md
				const contextPath = join(tempDir, '.swarm', 'context.md');
				await writeFile(contextPath, '# Initial Context\n');

				await _flushForTesting(tempDir);

				// Verify final file exists and contains the Agent Activity section
				const finalExists = await stat(contextPath)
					.then(() => true)
					.catch(() => false);
				expect(finalExists).toBe(true);

				const content = await Bun.file(contextPath).text();
				expect(content).toContain('## Agent Activity');
				expect(content).toContain('test-tool');

				// Verify .tmp file does NOT exist
				const tempPath = `${contextPath}.tmp`;
				const tempExists = await stat(tempPath)
					.then(() => true)
					.catch(() => false);
				expect(tempExists).toBe(false);

				// Verify pendingEvents was reset
				expect(swarmState.pendingEvents).toBe(0);
			});

			it('should overwrite existing context.md with atomic rename', async () => {
				const contextPath = join(tempDir, '.swarm', 'context.md');
				const originalContent = '# Original\n\nSome content.';
				await writeFile(contextPath, originalContent);

				await _flushForTesting(tempDir);

				// Verify content was updated (Agent Activity section added)
				const content = await Bun.file(contextPath).text();
				expect(content).toContain('## Agent Activity');
				expect(content).toContain('test-tool');
				expect(content).toContain('# Original'); // Original content preserved
				expect(content).toContain('Some content.'); // Original content preserved
			});

			it('should create new context.md if it does not exist', async () => {
				const contextPath = join(tempDir, '.swarm', 'context.md');
				// Note: file does not exist

				await _flushForTesting(tempDir);

				// Verify file was created
				const finalExists = await stat(contextPath)
					.then(() => true)
					.catch(() => false);
				expect(finalExists).toBe(true);

				const content = await Bun.file(contextPath).text();
				expect(content).toContain('## Agent Activity');
				expect(content).toContain('test-tool');

				// Verify .tmp file does NOT exist
				const tempPath = `${contextPath}.tmp`;
				const tempExists = await stat(tempPath)
					.then(() => true)
					.catch(() => false);
				expect(tempExists).toBe(false);
			});
		});

		describe('Write failure cleanup', () => {
			it('should clean up its own temp when the payload write fails', async () => {
				const contextPath = join(tempDir, '.swarm', 'context.md');

				// Create initial context.md
				await writeFile(contextPath, '# Initial\n');

				// Force the canonical writer's payload write to fail (the
				// seam the migrated writer actually uses — Bun.write is no
				// longer on this path).
				atomicWriteInternals.writeSync = () => {
					throw new Error('Write failed: EIO');
				};

				try {
					// Flush should not throw (error caught internally)
					await _flushForTesting(tempDir);

					// Verify the writer's OWN unique temp was cleaned up
					expect(await contextTempResidue(tempDir)).toEqual([]);

					// Verify the original context.md was NOT modified
					const originalContent = await Bun.file(contextPath).text();
					expect(originalContent).not.toContain('## Agent Activity');
				} finally {
					atomicWriteInternals.writeSync = realWriteSync;
				}
			});
		});

		describe('Error re-throw behavior', () => {
			it('should re-throw the write error so outer catch handles it', async () => {
				const contextPath = join(tempDir, '.swarm', 'context.md');

				// Create initial context.md before setting up mocks
				await writeFile(contextPath, '# Initial\n');

				atomicWriteInternals.writeSync = () => {
					throw new Error('Disk full');
				};

				try {
					// Flush should complete without throwing (outer catch in
					// doFlush handles the error). warn() from utils is
					// DEBUG-gated (OPENCODE_SWARM_DEBUG=1), so console.warn is
					// not called in test environments. Verify side effects.
					await _flushForTesting(tempDir);

					// Verify temp file was cleaned up
					expect(await contextTempResidue(tempDir)).toEqual([]);

					// Verify original file NOT modified
					const originalContent = await Bun.file(contextPath).text();
					expect(originalContent).toBe('# Initial\n');
				} finally {
					atomicWriteInternals.writeSync = realWriteSync;
				}
			});

			it('should preserve pendingEvents when write fails (will retry)', async () => {
				const contextPath = join(tempDir, '.swarm', 'context.md');

				// Set up pending events
				swarmState.pendingEvents = 5;

				atomicWriteInternals.writeSync = () => {
					throw new Error('Write failed');
				};

				// Mock console.warn to suppress output
				const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

				try {
					// Flush
					await _flushForTesting(tempDir);

					// Verify pendingEvents was NOT reset (comment says "Don't reset pendingEvents — will retry on next trigger")
					expect(swarmState.pendingEvents).toBe(5);

					// Verify temp file cleaned up
					expect(await contextTempResidue(tempDir)).toEqual([]);
				} finally {
					atomicWriteInternals.writeSync = realWriteSync;
					warnSpy.mockRestore();
				}
			});
		});

		describe('Edge cases', () => {
			it('should handle empty toolAggregates (renders "No tool activity recorded yet.")', async () => {
				swarmState.toolAggregates.clear();
				swarmState.pendingEvents = 2;

				const contextPath = join(tempDir, '.swarm', 'context.md');
				await writeFile(contextPath, '# Initial\n');

				await _flushForTesting(tempDir);

				const content = await Bun.file(contextPath).text();
				expect(content).toContain('## Agent Activity');
				expect(content).toContain('No tool activity recorded yet.');

				// Verify .tmp file does NOT exist
				const tempExists = await stat(`${contextPath}.tmp`)
					.then(() => true)
					.catch(() => false);
				expect(tempExists).toBe(false);

				// Verify pendingEvents was reset on success
				expect(swarmState.pendingEvents).toBe(0);
			});

			it('should handle missing context.md file gracefully', async () => {
				// Note: .swarm directory exists, but context.md does not
				// This should create a new context.md file
				await _flushForTesting(tempDir);

				// Verify file was created
				const contextPath = join(tempDir, '.swarm', 'context.md');
				const exists = await stat(contextPath)
					.then(() => true)
					.catch(() => false);
				expect(exists).toBe(true);

				const content = await Bun.file(contextPath).text();
				expect(content).toContain('## Agent Activity');
			});
		});
	});
});
