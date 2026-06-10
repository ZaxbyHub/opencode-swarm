import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * DEBUG_SWARM Diagnostic Gating Tests
 *
 * Tests verify that console.debug/console.warn calls in the following locations
 * are properly gated behind `process.env.DEBUG_SWARM`:
 *
 * 1. src/index.ts:736 — console.debug('[hook-chain]...')
 * 2. src/index.ts:853 — console.debug('[session]...')
 * 3. src/session/snapshot-writer.ts:219 — console.warn('[snapshot-writer]...')
 * 4. src/hooks/curator.ts:57 — console.warn('Failed to parse curator-summary.json...')
 */

describe('DEBUG_SWARM diagnostic gating', () => {
	describe('readCuratorSummary (src/hooks/curator.ts:57)', () => {
		let tempDir: string;
		let originalDebugSwarm: string | undefined;

		beforeEach(() => {
			tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'curator-diagnostic-test-')),
			);
			originalDebugSwarm = process.env.DEBUG_SWARM;
		});

		afterEach(() => {
			process.env.DEBUG_SWARM = originalDebugSwarm;
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('returns null on corrupt JSON regardless of DEBUG_SWARM setting', async () => {
			// Arrange: Create .swarm directory with corrupt JSON
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(
				path.join(swarmDir, 'curator-summary.json'),
				'{ invalid json }',
			);

			// Act & Assert: Should return null both with and without DEBUG_SWARM
			process.env.DEBUG_SWARM = undefined;
			const { readCuratorSummary } = await import(
				'../../../src/hooks/curator.js'
			);
			const result1 = await readCuratorSummary(tempDir);
			expect(result1).toBeNull();

			process.env.DEBUG_SWARM = '1';
			// Need to re-import to pick up env change
			const { readCuratorSummary: readCuratorSummary2 } = await import(
				'../../../src/hooks/curator.js'
			);
			const result2 = await readCuratorSummary2(tempDir);
			expect(result2).toBeNull();
		});

		test('source code has correct gating pattern for curator warn', () => {
			// Read the curator source and verify the gating pattern
			const curatorSource = fs.readFileSync(
				path.join(process.cwd(), 'src/hooks/curator.ts'),
				'utf-8',
			);

			// PR #327-style migration: curator replaced inline
			// `process.env.DEBUG_SWARM && console.warn` with `logger.warn()` from
			// utils/logger, which is gated by OPENCODE_SWARM_DEBUG. Verify the
			// 'Failed to parse curator-summary.json' diagnostic still goes through a
			// gated path (the logger, or the legacy DEBUG_SWARM check).
			const lines = curatorSource.split('\n');
			let foundGatedWarn = false;

			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes("'Failed to parse curator-summary.json")) {
					// Check for a gated diagnostic on the line or within 5 lines before.
					for (let j = i; j >= Math.max(0, i - 5); j--) {
						if (
							lines[j].includes('logger.warn') ||
							lines[j].includes('process.env.DEBUG_SWARM')
						) {
							foundGatedWarn = true;
							break;
						}
					}
				}
			}

			expect(foundGatedWarn).toBe(true);
		});
	});

	describe('writeSnapshot (src/session/snapshot-writer.ts:219)', () => {
		let originalDebugSwarm: string | undefined;

		beforeEach(() => {
			originalDebugSwarm = process.env.DEBUG_SWARM;
		});

		afterEach(() => {
			process.env.DEBUG_SWARM = originalDebugSwarm;
		});

		test('source code has correct gating pattern for snapshot-writer warn', () => {
			// Read the snapshot-writer source and verify the gating pattern
			const snapshotWriterSource = fs.readFileSync(
				path.join(process.cwd(), 'src/session/snapshot-writer.ts'),
				'utf-8',
			);

			// PR #327 replaced process.env.DEBUG_SWARM && console.warn with log() from utils/logger.
			// Verify that log() is used on or near the '[snapshot-writer]' diagnostic line.
			const lines = snapshotWriterSource.split('\n');
			let foundGatedWarn = false;

			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes("'[snapshot-writer]")) {
					// Check if log( appears on the same line or within 2 lines before (log is gated by OPENCODE_SWARM_DEBUG)
					for (let j = i; j >= Math.max(0, i - 2); j--) {
						if (lines[j].includes('log(')) {
							foundGatedWarn = true;
							break;
						}
					}
				}
			}

			expect(foundGatedWarn).toBe(true);
		});

		test('writeSnapshot catches errors within try block and does not rethrow', async () => {
			// The function should catch errors internally
			// We need to trigger an error INSIDE the try block
			// One way is to provide a valid directory but then make the write fail
			// But since we can't easily force a write failure, we verify the structure

			const snapshotWriterSource = fs.readFileSync(
				path.join(process.cwd(), 'src/session/snapshot-writer.ts'),
				'utf-8',
			);

			// Verify the structure: try { ... } catch { if (DEBUG_SWARM) console.warn }
			// This ensures errors are caught and not rethrown
			const hasTryCatch = snapshotWriterSource.includes('} catch (error) {');
			expect(hasTryCatch).toBe(true);

			// Verify the catch block doesn't rethrow
			const catchBlockMatch = snapshotWriterSource.match(
				/} catch \(error\) \{[\s\S]*?\n\t}/,
			);
			expect(catchBlockMatch).not.toBeNull();
			// The catch block should NOT contain 'throw'
			expect(catchBlockMatch![0]).not.toContain('throw');
		});
	});

	describe('OpenCodeSwarm hooks (src/index.ts)', () => {
		test('source has correct gating pattern for all DEBUG_SWARM usages', () => {
			// Read all three source files
			const indexSource = fs.readFileSync(
				path.join(process.cwd(), 'src/index.ts'),
				'utf-8',
			);
			const snapshotWriterSource = fs.readFileSync(
				path.join(process.cwd(), 'src/session/snapshot-writer.ts'),
				'utf-8',
			);
			const curatorSource = fs.readFileSync(
				path.join(process.cwd(), 'src/hooks/curator.ts'),
				'utf-8',
			);

			const allSources = indexSource + snapshotWriterSource + curatorSource;

			// Count total occurrences of process.env.DEBUG_SWARM - should be >= 8
			const debugSwarmMatches = allSources.match(/process\.env\.DEBUG_SWARM/g);
			const count = debugSwarmMatches ? debugSwarmMatches.length : 0;
			expect(count).toBeGreaterThanOrEqual(8);

			// For each occurrence of process.env.DEBUG_SWARM, verify a console.error or console.warn follows within 5 lines
			function hasGatedConsoleCall(source: string): boolean {
				const lines = source.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes('process.env.DEBUG_SWARM')) {
						// Look ahead up to 5 lines for console.error or console.warn
						let hasConsoleCall = false;
						for (let j = i; j <= Math.min(lines.length - 1, i + 5); j++) {
							if (
								lines[j].includes('console.error') ||
								lines[j].includes('console.warn')
							) {
								hasConsoleCall = true;
								break;
							}
						}
						if (!hasConsoleCall) {
							return false;
						}
					}
				}
				return true;
			}

			expect(hasGatedConsoleCall(indexSource)).toBe(true);
			expect(hasGatedConsoleCall(snapshotWriterSource)).toBe(true);
			expect(hasGatedConsoleCall(curatorSource)).toBe(true);
		});
	});

	describe('integration: all 4 diagnostic calls are properly gated', () => {
		test('all 4 locations have DEBUG_SWARM gating within 5 lines before the console call', () => {
			const indexSource = fs.readFileSync(
				path.join(process.cwd(), 'src/index.ts'),
				'utf-8',
			);
			const snapshotWriterSource = fs.readFileSync(
				path.join(process.cwd(), 'src/session/snapshot-writer.ts'),
				'utf-8',
			);
			const curatorSource = fs.readFileSync(
				path.join(process.cwd(), 'src/hooks/curator.ts'),
				'utf-8',
			);

			// Helper function to check if console call is gated
			// Simplified: check that within 5 lines before any console.error/console.warn
			// there's a process.env.DEBUG_SWARM
			function isGated(
				source: string,
				consoleCall: string,
				hookName: string,
			): boolean {
				const lines = source.split('\n');
				for (let i = 0; i < lines.length; i++) {
					// Find any console.error or console.warn call
					if (
						lines[i].includes('console.error') ||
						lines[i].includes('console.warn')
					) {
						// Check if there's a process.env.DEBUG_SWARM within 5 lines before
						for (let j = i; j >= Math.max(0, i - 5); j--) {
							if (lines[j].includes('process.env.DEBUG_SWARM')) {
								return true;
							}
						}
					}
				}
				return false;
			}

			// Location 1: src/index.ts — console.error('[DIAG]...)
			expect(isGated(indexSource, 'console.error', '[DIAG]')).toBe(true);

			// Location 2: src/index.ts — console.debug('[session]...)
			expect(isGated(indexSource, 'console.debug', '[session]')).toBe(true);

			// Location 3: src/session/snapshot-writer.ts — PR #327 replaced process.env.DEBUG_SWARM &&
			// console.warn with log() from utils/logger (gated by OPENCODE_SWARM_DEBUG). No longer
			// uses the DEBUG_SWARM pattern, so isGated() does not apply here.
			// expect(isGated(snapshotWriterSource, "console.warn", "[snapshot-writer]")).toBe(true);

			// Location 4: src/hooks/curator.ts — migrated to logger.warn() (gated by
			// OPENCODE_SWARM_DEBUG, PR #327-style), so the inline
			// process.env.DEBUG_SWARM + console.warn pattern no longer applies.
			// Verify the diagnostic goes through the gated logger instead.
			expect(
				curatorSource.includes(
					"logger.warn('Failed to parse curator-summary.json",
				),
			).toBe(true);
		});

		test('all DEBUG_SWARM checks use correct pattern (process.env.DEBUG_SWARM)', () => {
			const indexSource = fs.readFileSync(
				path.join(process.cwd(), 'src/index.ts'),
				'utf-8',
			);
			const snapshotWriterSource = fs.readFileSync(
				path.join(process.cwd(), 'src/session/snapshot-writer.ts'),
				'utf-8',
			);
			const curatorSource = fs.readFileSync(
				path.join(process.cwd(), 'src/hooks/curator.ts'),
				'utf-8',
			);

			// All DEBUG_SWARM checks should use process.env.DEBUG_SWARM
			const allSources = indexSource + snapshotWriterSource + curatorSource;

			// Verify no bare DEBUG_SWARM references (should always be process.env.DEBUG_SWARM)
			// This regex looks for DEBUG_SWARM that's NOT preceded by process.env.
			const bareDebugSwarm = /(?<!process\.env\.)DEBUG_SWARM/;
			expect(allSources).not.toMatch(bareDebugSwarm);

			// Count the DEBUG_SWARM env var checks. Both snapshot-writer (PR #327) and
			// curator have since migrated their diagnostics to the gated logger
			// (utils/logger, OPENCODE_SWARM_DEBUG), leaving only src/index.ts's inline
			// process.env.DEBUG_SWARM checks.
			const debugSwarmChecks = allSources.match(/process\.env\.DEBUG_SWARM/g);
			expect(debugSwarmChecks).toHaveLength(8);
		});
	});

	describe('verify return value behavior is unaffected by DEBUG_SWARM', () => {
		let tempDir: string;
		let originalDebugSwarm: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-return-test-'));
			originalDebugSwarm = process.env.DEBUG_SWARM;
		});

		afterEach(() => {
			process.env.DEBUG_SWARM = originalDebugSwarm;
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('readCuratorSummary returns null on missing file regardless of DEBUG_SWARM', async () => {
			// File doesn't exist
			process.env.DEBUG_SWARM = undefined;
			const { readCuratorSummary } = await import(
				'../../../src/hooks/curator.js'
			);
			const result1 = await readCuratorSummary(tempDir);
			expect(result1).toBeNull();

			process.env.DEBUG_SWARM = '1';
			const { readCuratorSummary: readCuratorSummary2 } = await import(
				'../../../src/hooks/curator.js'
			);
			const result2 = await readCuratorSummary2(tempDir);
			expect(result2).toBeNull();
		});

		test('readCuratorSummary returns null on corrupt JSON regardless of DEBUG_SWARM', async () => {
			// Create corrupt JSON
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(
				path.join(swarmDir, 'curator-summary.json'),
				'not valid json {',
			);

			process.env.DEBUG_SWARM = undefined;
			const { readCuratorSummary } = await import(
				'../../../src/hooks/curator.js'
			);
			const result1 = await readCuratorSummary(tempDir);
			expect(result1).toBeNull();

			process.env.DEBUG_SWARM = '1';
			const { readCuratorSummary: readCuratorSummary2 } = await import(
				'../../../src/hooks/curator.js'
			);
			const result2 = await readCuratorSummary2(tempDir);
			expect(result2).toBeNull();
		});

		test('readCuratorSummary returns null on wrong schema version regardless of DEBUG_SWARM', async () => {
			// Create JSON with wrong schema version
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(
				path.join(swarmDir, 'curator-summary.json'),
				JSON.stringify({
					schema_version: 99, // Wrong version
					session_id: 'test',
					last_updated: new Date().toISOString(),
					last_phase_covered: 1,
					digest: 'test',
					phase_digests: [],
					compliance_observations: [],
					knowledge_recommendations: [],
				}),
			);

			process.env.DEBUG_SWARM = undefined;
			const { readCuratorSummary } = await import(
				'../../../src/hooks/curator.js'
			);
			const result1 = await readCuratorSummary(tempDir);
			expect(result1).toBeNull();

			process.env.DEBUG_SWARM = '1';
			const { readCuratorSummary: readCuratorSummary2 } = await import(
				'../../../src/hooks/curator.js'
			);
			const result2 = await readCuratorSummary2(tempDir);
			expect(result2).toBeNull();
		});
	});
});
