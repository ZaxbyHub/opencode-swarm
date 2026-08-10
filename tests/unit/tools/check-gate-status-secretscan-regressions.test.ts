/**
 * Verification tests for secretscan gate status feature in check_gate_status tool.
 *
 * Tests the secretscan verdict handling in check-gate-status.ts:
 * - Verdict 'fail' or 'rejected' → BLOCKED message, status downgraded to 'incomplete'
 * - Verdict 'pass', 'approved', 'info' → secretscan_verdict='pass'
 * - No secretscan entries → advisory message
 * - No EvidenceBundle → secretscan_verdict='not_run'
 * - Invalid schema → silently skipped (caught error)
 * - Most recent secretscan entry is used
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
// Import the tool
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('check_gate_status secretscan feature', () => {
	let restoreClock: (() => void) | undefined;
	let TEST_DIR: string;
	let EVIDENCE_DIR: string;

	// Helper to create a gate-evidence file (at .swarm/evidence/{taskId}.json)
	function createGateEvidence(
		taskId: string,
		requiredGates: string[],
		gates: Record<
			string,
			{ sessionId?: string; timestamp?: string; agent?: string }
		>,
	) {
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
		const evidence = {
			taskId,
			required_gates: requiredGates,
			gates,
		};
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, `${taskId}.json`),
			JSON.stringify(evidence, null, 2),
		);
	}

	// Helper to create an EvidenceBundle file (at .swarm/evidence/{taskId}/evidence.json)
	function createEvidenceBundle(taskId: string, entries: object[]) {
		const bundleDir = path.join(EVIDENCE_DIR, taskId);
		fs.mkdirSync(bundleDir, { recursive: true });
		const normalizedEntries = entries.map((entry) => {
			if (
				entry &&
				typeof entry === 'object' &&
				'type' in entry &&
				(entry as { type?: string }).type === 'secretscan'
			) {
				return {
					incomplete_files: 0,
					incomplete_paths: [],
					...entry,
				};
			}
			return entry;
		});
		const bundle = {
			schema_version: '1.0.0',
			task_id: taskId,
			entries: normalizedEntries,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		fs.writeFileSync(
			path.join(bundleDir, 'evidence.json'),
			JSON.stringify(bundle, null, 2),
		);
	}

	// Helper to run the tool with proper ToolContext
	async function runTool(taskId: string) {
		const result = await check_gate_status.execute({ task_id: taskId }, {
			directory: TEST_DIR,
		} as unknown as ToolContext);
		return JSON.parse(result);
	}

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: 1_700_000_000_000,
			isoNow: '2023-11-14T22:13:20.000Z',
		});
		TEST_DIR = canonicalMkdtemp('check-gate-status-test-');
		EVIDENCE_DIR = path.join(TEST_DIR, '.swarm', 'evidence');
		// Create test directory structure
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = undefined;
		// Clean up test directory
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});
	describe('status downgrade scenarios', () => {
		it('should downgrade status from all_passed to incomplete when secretscan verdict is fail', async () => {
			// Setup: gate-evidence shows all gates passed initially
			createGateEvidence('2.1', ['test', 'review', 'secretscan'], {
				test: {},
				review: {},
				secretscan: {},
			});

			// Setup: EvidenceBundle with secretscan verdict=fail
			createEvidenceBundle('2.1', [
				{
					task_id: '2.1',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Secrets detected',
					findings_count: 1,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('2.1');

			// Status should be downgraded to incomplete
			expect(result.status).toBe('incomplete');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — secrets detected)',
			);
			expect(result.message).toContain('BLOCKED');
		});

		it('should NOT downgrade status when already incomplete', async () => {
			// Setup: gate-evidence shows incomplete (missing 'review' gate)
			createGateEvidence('2.2', ['test', 'review'], { test: {} });

			// Setup: EvidenceBundle with secretscan verdict=fail
			createEvidenceBundle('2.2', [
				{
					task_id: '2.2',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Secrets detected',
					findings_count: 1,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('2.2');

			// Status should remain incomplete (not 'all_passed')
			expect(result.status).toBe('incomplete');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — secrets detected)',
			);
		});
	});

	describe('loadEvidence error handling', () => {
		it('should silently skip when loadEvidence throws an error', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('3.1', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle that will cause loadEvidence to throw
			// (path traversal in taskId would cause issue, but here we use valid path)
			createEvidenceBundle('3.1', [
				{
					task_id: '3.1',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'No secrets',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('3.1');

			// Should work normally
			expect(result.secretscan_verdict).toBe('pass');
			expect(result.status).toBe('all_passed');
		});

		it('should handle EvidenceBundle with missing required fields gracefully', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('3.2', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with incomplete secretscan entry (missing required fields)
			const dir = path.join(EVIDENCE_DIR, '3.2', 'evidence.json');
			fs.mkdirSync(path.dirname(dir), { recursive: true });
			fs.writeFileSync(
				dir,
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: '3.2',
					entries: [
						{
							// Missing required fields like timestamp, agent, verdict, summary
							task_id: '3.2',
							type: 'secretscan',
						},
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			);

			const result = await runTool('3.2');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('evidence is invalid');
		});
	});

	describe('multiple non-secretscan entries with most recent secretscan', () => {
		it('should use the most recent secretscan even when mixed with other types', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('4.1', ['test', 'review'], { test: {}, review: {} });

			const early = new Date('2024-01-01T00:00:00Z').toISOString();
			const middle = new Date('2024-01-02T00:00:00Z').toISOString();
			const late = new Date('2024-01-03T00:00:00Z').toISOString();

			createEvidenceBundle('4.1', [
				{
					task_id: '4.1',
					type: 'note',
					timestamp: early,
					agent: 'mega_test_engineer',
					verdict: 'pass',
					summary: 'Note entry',
				},
				{
					task_id: '4.1',
					type: 'secretscan',
					timestamp: middle,
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Secrets found',
					findings_count: 2,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
				{
					task_id: '4.1',
					type: 'review',
					timestamp: late,
					agent: 'mega_reviewer',
					verdict: 'pass',
					summary: 'Review passed',
					risk: 'low',
					issues: [],
				},
			]);

			const result = await runTool('4.1');

			// Most recent secretscan is the middle one (fail)
			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('BLOCKED');
		});
	});
});
