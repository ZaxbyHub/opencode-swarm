/**
 * Tests for the LLM timeout race in runCuratorPostMortem (FR-003, curator-postmortem.ts:485-507).
 *
 * Verifies:
 *   - Data-only fallback is produced when LLM delegate rejects (simulating timeout/abort)
 *   - The `void delegatePromise.catch(() => {})` guard prevents unhandled rejection
 *   - The fallback path completes cleanly (finally block runs to completion)
 *   - The fallback report contains expected structure
 *
 * Strategy: the production code's timeout path triggers when the LLM delegate
 * rejects (after AbortController.abort() fires at 300_000ms). We simulate this
 * by passing a delegate that rejects with an abort-like error, which exercises
 * the same catch block (line 509) that handles the timeout case.
 *
 * Uses the existing _internals export from curator-postmortem.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ────────────────────────────────────────────────
import {
	_internals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), 'postmortem-timeout-test-'));
}

function ensureSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function writePlan(dir: string): void {
	const swarmDir = ensureSwarmDir(dir);
	writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			title: 'Timeout Test Project',
			swarm: 'paid',
			schema_version: '1.0.0',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [{ id: '1.1', status: 'complete', description: 'Task A' }],
				},
			],
		}),
	);
}

// ── Test suites ──────────────────────────────────────────────────────

describe('runCuratorPostMortem — LLM timeout race (FR-003)', () => {
	// ── Test 1: Data-only fallback when LLM delegate rejects (simulating timeout/abort) ──

	it('produces data-only fallback when LLM delegate rejects with abort error', async () => {
		const testDir = makeTempDir();
		writePlan(testDir);

		// Delegate that rejects with an abort-like error.
		// This simulates the state after AbortController fires at timeout.
		const rejectingDelegate = async () => {
			throw new Error('The operation was aborted');
		};

		const result = await runCuratorPostMortem(testDir, {
			llmDelegate: rejectingDelegate,
		});

		// Success is true because the fallback produces a valid data-only report
		expect(result.success).toBe(true);
		// Warnings should include the fallback message
		expect(
			result.warnings.some((w) =>
				w.includes('LLM delegate failed, falling back to data-only report'),
			),
		).toBe(true);
		// Report should have been written
		expect(result.reportPath).not.toBeNull();
		expect(result.reportPath).toContain('post-mortem-');

		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	// ── Test 2: The `void delegatePromise.catch(() => {})` guard prevents unhandled rejection ──

	it('does not produce unhandled rejection when delegate rejects with abort error', async () => {
		const testDir = makeTempDir();
		writePlan(testDir);

		// Track unhandledrejection events
		const unhandledErrors: Array<Error | string> = [];
		const handler = (event: PromiseRejectionEvent) => {
			unhandledErrors.push(
				event.reason instanceof Error ? event.reason : String(event.reason),
			);
		};
		globalThis.addEventListener('unhandledrejection', handler);

		// Delegate that rejects synchronously (simulating abort-triggered rejection)
		const rejectingDelegate = async () => {
			throw new Error('The operation was aborted');
		};

		// Run the post-mortem — the delegate rejects, but the catch guard
		// on delegatePromise should swallow the rejection
		await runCuratorPostMortem(testDir, {
			llmDelegate: rejectingDelegate,
		});

		// Remove the listener
		globalThis.removeEventListener('unhandledrejection', handler);

		// The guard `void delegatePromise.catch(() => {})` must have prevented
		// any unhandled rejection from reaching the event loop
		expect(unhandledErrors.length).toBe(0);

		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	// ── Test 3: Fallback path completes cleanly (verifies finally runs) ──

	it('completes post-mortem with fallback after LLM delegate abort error', async () => {
		const testDir = makeTempDir();
		writePlan(testDir);

		// Delegate that always rejects (simulating persistent abort condition)
		const rejectingDelegate = async () => {
			throw new Error('CURATOR_LLM_TIMEOUT');
		};

		// The post-mortem must complete (not hang) after the delegate rejects,
		// proving that the finally block runs to completion
		const result = await runCuratorPostMortem(testDir, {
			llmDelegate: rejectingDelegate,
		});

		expect(result.success).toBe(true);
		expect(result.reportPath).not.toBeNull();

		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	// ── Test 4: Data-only fallback contains expected content ──────────

	it('data-only fallback report contains plan ID and knowledge metrics section', async () => {
		const testDir = makeTempDir();
		writePlan(testDir);

		const rejectingDelegate = async () => {
			throw new Error('The operation was aborted');
		};

		const result = await runCuratorPostMortem(testDir, {
			llmDelegate: rejectingDelegate,
		});

		// The written report should contain data-only report markers
		expect(result.reportPath).not.toBeNull();
		if (result.reportPath) {
			const reportContent = readFileSync(result.reportPath, 'utf-8');
			expect(reportContent).toContain('# Post-Mortem Report: unknown');
			expect(reportContent).toContain('## Knowledge Metrics');
		}

		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});
});
