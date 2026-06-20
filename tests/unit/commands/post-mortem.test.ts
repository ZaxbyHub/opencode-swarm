/**
 * Tests for handlePostMortemCommand (FR-002, post-mortem.ts:7-64).
 *
 * Uses _internals DI seam from post-mortem.ts to mock runCuratorPostMortem
 * and createCuratorLLMDelegate without mock.module.
 *
 * Verifies:
 *   - --force flag parsing (args.includes('--force'))
 *   - LLM delegate creation failure → data-only fallback
 *   - Success output formatting
 *   - Failure output formatting
 *   - Warnings display
 *   - Top-level error catch returning error message string
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ────────────────────────────────────────────────
const { handlePostMortemCommand, _internals: pmInternals } = await import(
	'../../../src/commands/post-mortem.js'
);

// ── Save real _internals ─────────────────────────────────────────────

const realCreateCuratorLLMDelegate = pmInternals.createCuratorLLMDelegate;
const realRunCuratorPostMortem = pmInternals.runCuratorPostMortem;

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function setupTestDir(): void {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'post-mortem-test-'));
	mkdirSync(swarmDir(), { recursive: true });
}

// ── Test suites ──────────────────────────────────────────────────────

describe('handlePostMortemCommand (FR-002)', () => {
	beforeEach(() => {
		setupTestDir();
		pmInternals.createCuratorLLMDelegate = realCreateCuratorLLMDelegate;
		pmInternals.runCuratorPostMortem = mock(
			async (
				_directory: string,
				_options: { force?: boolean; llmDelegate?: unknown },
			) => ({
				success: true,
				planId: 'unknown',
				reportPath: null,
				summary: null,
				warnings: ['Plan not found — using fallback plan ID.'],
			}),
		);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		pmInternals.createCuratorLLMDelegate = realCreateCuratorLLMDelegate;
		pmInternals.runCuratorPostMortem = realRunCuratorPostMortem;
	});

	// ── Test 1: --force flag parsing ──────────────────────────────────

	describe('--force flag parsing', () => {
		it('passes force=true to runCuratorPostMortem when --force is in args', async () => {
			let capturedForce = false;
			pmInternals.runCuratorPostMortem = mock(
				async (_dir: string, options: { force?: boolean }) => {
					capturedForce = options.force === true;
					return {
						success: true,
						planId: 'test',
						reportPath: null,
						summary: null,
						warnings: [],
					};
				},
			);

			await handlePostMortemCommand(testDir, ['--force']);

			expect(capturedForce).toBe(true);
		});

		it('does not pass force when --force is absent', async () => {
			let capturedForce = false;
			pmInternals.runCuratorPostMortem = mock(
				async (_dir: string, options: { force?: boolean }) => {
					capturedForce = options.force === true;
					return {
						success: true,
						planId: 'test',
						reportPath: null,
						summary: null,
						warnings: [],
					};
				},
			);

			await handlePostMortemCommand(testDir, []);

			expect(capturedForce).toBe(false);
		});
	});

	// ── Test 2: LLM delegate creation failure → data-only fallback ────

	describe('LLM delegate creation failure → data-only fallback', () => {
		it('continues with data-only report when createCuratorLLMDelegate throws', async () => {
			pmInternals.createCuratorLLMDelegate = mock(() => {
				throw new Error('LLM factory unavailable');
			});

			let receivedDelegate = false;
			pmInternals.runCuratorPostMortem = mock(
				async (_dir: string, options: { llmDelegate?: unknown }) => {
					receivedDelegate = options.llmDelegate !== undefined;
					return {
						success: true,
						planId: 'test',
						reportPath: null,
						summary: null,
						warnings: [],
					};
				},
			);

			const result = await handlePostMortemCommand(testDir, [], {
				sessionID: 'test-session',
			});

			// llmDelegate must NOT have been passed because the error was caught
			expect(receivedDelegate).toBe(false);
			expect(result).toContain('## Post-Mortem Report Generated');
		});

		it('succeeds even when LLM delegate creation throws', async () => {
			pmInternals.createCuratorLLMDelegate = mock(() => {
				throw new Error('LLM provider down');
			});

			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'test',
				reportPath: null,
				summary: null,
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, [], {
				sessionID: 'session-123',
			});

			expect(result).toContain('## Post-Mortem Report Generated');
		});
	});

	// ── Test 3: Success output formatting ─────────────────────────────

	describe('Success output formatting', () => {
		it('includes "## Post-Mortem Report Generated" on success', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'plan-abc',
				reportPath: path.join(swarmDir(), 'post-mortem', 'report.md'),
				summary: 'This is the post-mortem summary.',
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain('## Post-Mortem Report Generated');
		});

		it('includes report path when present in success result', async () => {
			// The actual path is validateSwarmPath(dir, 'post-mortem-<planId>.md')
			// which resolves to <dir>/.swarm/post-mortem-<planId>.md
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'plan-abc',
				reportPath: path.join(swarmDir(), 'post-mortem-plan-abc.md'),
				summary: null,
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain('Report:');
			expect(result).toContain('post-mortem-plan-abc.md');
		});

		it('includes summary text when present in success result', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'plan-abc',
				reportPath: null,
				summary: 'Three knowledge entries were reviewed.',
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain('Three knowledge entries were reviewed.');
		});
	});

	// ── Test 4: Failure output formatting ─────────────────────────────

	describe('Failure output formatting', () => {
		it('includes "## Post-Mortem Failed" when result.success is false', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: false,
				planId: 'plan-abc',
				reportPath: null,
				summary: null,
				warnings: ['LLM timeout', 'Plan not found'],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain('## Post-Mortem Failed');
			expect(result).toContain(
				'The post-mortem report could not be generated.',
			);
		});

		it('does not include success header when result.success is false', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: false,
				planId: 'plan-abc',
				reportPath: null,
				summary: null,
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).not.toContain('## Post-Mortem Report Generated');
		});
	});

	// ── Test 5: Warnings display ──────────────────────────────────────

	describe('Warnings display', () => {
		it('renders each warning as a bullet under "### Warnings"', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'plan-abc',
				reportPath: null,
				summary: null,
				warnings: [
					'Plan not found — using fallback plan ID.',
					'Failed to collect knowledge summary.',
					'LLM delegate failed, falling back to data-only report: timeout',
				],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain('### Warnings');
			expect(result).toContain('- Plan not found — using fallback plan ID.');
			expect(result).toContain('- Failed to collect knowledge summary.');
			expect(result).toContain(
				'- LLM delegate failed, falling back to data-only report: timeout',
			);
		});

		it('omits the warnings section when warnings array is empty', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'plan-abc',
				reportPath: null,
				summary: null,
				warnings: [],
			}));

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).not.toContain('### Warnings');
		});
	});

	// ── Test 6: Top-level error catch ─────────────────────────────────

	describe('Top-level error catch', () => {
		it('returns an error message string when runCuratorPostMortem throws', async () => {
			const errorMessage = 'Critical post-mortem infrastructure failure';
			pmInternals.runCuratorPostMortem = mock(async () => {
				throw new Error(errorMessage);
			});

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain(`Error running post-mortem: ${errorMessage}`);
			expect(result).toContain('Run /swarm diagnose to check .swarm/ health.');
		});

		it('stringifies non-Error throws in the top-level catch', async () => {
			pmInternals.runCuratorPostMortem = mock(async () => {
				throw 'string-error-from-postmortem';
			});

			const result = await handlePostMortemCommand(testDir, []);

			expect(result).toContain(
				'Error running post-mortem: string-error-from-postmortem',
			);
			expect(result).toContain('Run /swarm diagnose to check .swarm/ health.');
		});
	});
});
