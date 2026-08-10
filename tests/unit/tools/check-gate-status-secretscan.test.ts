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
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
// Import the tool
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { freezeClock } from '../../helpers/test-clock.js';

describe('check_gate_status secretscan feature', () => {
	let restoreClock: (() => void) | undefined;
	const TEST_DIR = path.join(
		os.tmpdir(),
		`check-gate-status-test-${Date.now()}`,
	);
	const EVIDENCE_DIR = path.join(TEST_DIR, '.swarm', 'evidence');

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
		// Create test directory structure
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = undefined;
		// Clean up test directory
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	describe('secretscan verdict handling', () => {
		it('1. secretscan verdict=pass → secretscan_verdict=pass, no BLOCKED message, status unchanged', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.1', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with secretscan verdict=pass
			createEvidenceBundle('1.1', [
				{
					task_id: '1.1',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'No secrets detected',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.1');

			expect(result.secretscan_verdict).toBe('pass');
			expect(result.status).toBe('all_passed');
			expect(result.message).not.toContain('BLOCKED');
			expect(result.missing_gates).not.toContain(
				'secretscan (BLOCKED — secrets detected)',
			);
		});

		it('2. secretscan verdict=fail → secretscan_verdict=fail, BLOCKED message, status downgraded', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.2', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with secretscan verdict=fail
			createEvidenceBundle('1.2', [
				{
					task_id: '1.2',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Secrets detected in code',
					findings_count: 3,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.2');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('BLOCKED');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — secrets detected)',
			);
		});

		it('3. secretscan verdict=rejected → same as fail (BLOCKED)', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.3', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with secretscan verdict=rejected
			createEvidenceBundle('1.3', [
				{
					task_id: '1.3',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'rejected',
					summary: 'Secrets found and rejected',
					findings_count: 2,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.3');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('BLOCKED');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — secrets detected)',
			);
		});

		it('3b. secretscan verdict=fail with incomplete coverage reports incomplete coverage', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.3.1', ['test', 'review'], { test: {}, review: {} });

			createEvidenceBundle('1.3.1', [
				{
					task_id: '1.3.1',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Scan incomplete',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 0,
					skipped_files: 1,
					incomplete_files: 1,
					incomplete_paths: [
						{
							path: 'src/oversized.txt',
							reason: 'oversized',
						},
					],
				},
			]);

			const result = await runTool('1.3.1');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('incomplete coverage');
			expect(result.message).not.toContain('secrets detected');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — incomplete coverage)',
			);
		});

		it('4. secretscan verdict=approved → secretscan_verdict=pass', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.4', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with secretscan verdict=approved
			createEvidenceBundle('1.4', [
				{
					task_id: '1.4',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'approved',
					summary: 'Secrets scan approved',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.4');

			expect(result.secretscan_verdict).toBe('pass');
			expect(result.status).toBe('all_passed');
			expect(result.message).not.toContain('BLOCKED');
		});

		it('fails closed when a pass verdict contradicts incomplete coverage', async () => {
			createGateEvidence('1.4.1', ['test', 'review'], { test: {}, review: {} });
			createEvidenceBundle('1.4.1', [
				{
					task_id: '1.4.1',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'Contradictory scan result',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 1,
					incomplete_files: 1,
					incomplete_paths: [{ path: 'src/blocked.txt', reason: 'read_error' }],
				},
			]);

			const result = await runTool('1.4.1');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('incomplete coverage');
		});

		it('fails closed when a pass verdict contradicts findings', async () => {
			createGateEvidence('1.4.2', ['test', 'review'], { test: {}, review: {} });
			createEvidenceBundle('1.4.2', [
				{
					task_id: '1.4.2',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'Contradictory scan result',
					findings_count: 1,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.4.2');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('found secrets');
		});

		it('5. secretscan verdict=info → secretscan_verdict=pass', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.5', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with secretscan verdict=info
			createEvidenceBundle('1.5', [
				{
					task_id: '1.5',
					type: 'secretscan',
					timestamp: new Date().toISOString(),
					agent: 'pre_check_batch',
					verdict: 'info',
					summary: 'Informational scan result',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.5');

			expect(result.secretscan_verdict).toBe('pass');
			expect(result.status).toBe('all_passed');
		});

		it('6. No secretscan entries in EvidenceBundle → advisory message in result', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.6', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with no secretscan entries (different type)
			createEvidenceBundle('1.6', [
				{
					task_id: '1.6',
					type: 'note',
					timestamp: new Date().toISOString(),
					agent: 'mega_test_engineer',
					verdict: 'pass',
					summary: 'Note evidence',
				},
			]);

			const result = await runTool('1.6');

			expect(result.secretscan_verdict).toBe('not_run');
			expect(result.message).toContain(
				'Advisory: No secretscan evidence found',
			);
		});

		it('7. No EvidenceBundle file exists → tool works normally (secretscan_verdict=not_run)', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.7', ['test', 'review'], { test: {}, review: {} });
			// Do NOT create EvidenceBundle file

			const result = await runTool('1.7');

			expect(result.secretscan_verdict).toBe('not_run');
			expect(result.status).toBe('all_passed');
			expect(result.message).toBe(
				'All required gates have passed for task "1.7".',
			);
		});

		it('8. EvidenceBundle with invalid schema fails closed', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.8', ['test', 'review'], { test: {}, review: {} });

			// Setup: Invalid EvidenceBundle file
			const dir = path.join(EVIDENCE_DIR, '1.8', 'evidence.json');
			fs.mkdirSync(path.dirname(dir), { recursive: true });
			fs.writeFileSync(dir, JSON.stringify({ invalid: 'schema' }));

			const result = await runTool('1.8');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('evidence is invalid');
			expect(result.missing_gates).toContain(
				'secretscan (BLOCKED — invalid evidence)',
			);
		});

		it('fails closed when pass evidence omits required coverage metadata', async () => {
			createGateEvidence('1.8.0', ['test', 'review'], { test: {}, review: {} });
			const dir = path.join(EVIDENCE_DIR, '1.8.0', 'evidence.json');
			fs.mkdirSync(path.dirname(dir), { recursive: true });
			fs.writeFileSync(
				dir,
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: '1.8.0',
					entries: [
						{
							task_id: '1.8.0',
							type: 'secretscan',
							timestamp: new Date().toISOString(),
							agent: 'pre_check_batch',
							verdict: 'pass',
							summary: 'Legacy pass without coverage metadata',
							findings_count: 0,
							scan_directory: 'src',
							files_scanned: 5,
							skipped_files: 0,
						},
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			);

			const result = await runTool('1.8.0');

			expect(result.secretscan_verdict).toBe('fail');
			expect(result.status).toBe('incomplete');
			expect(result.message).toContain('evidence is invalid');
		});

		for (const [index, verdict] of ['pass', 'approved', 'info'].entries()) {
			it(`fails closed when verdict=${verdict} reports zero coverage`, async () => {
				const taskId = `1.8.${index + 1}`;
				createGateEvidence(taskId, ['test', 'review'], {
					test: {},
					review: {},
				});
				createEvidenceBundle(taskId, [
					{
						task_id: taskId,
						type: 'secretscan',
						timestamp: new Date().toISOString(),
						agent: 'pre_check_batch',
						verdict,
						summary: 'Contradictory zero-coverage result',
						findings_count: 0,
						scan_directory: 'src',
						files_scanned: 0,
						skipped_files: 0,
					},
				]);

				const result = await runTool(taskId);

				expect(result.secretscan_verdict).toBe('fail');
				expect(result.status).toBe('incomplete');
				expect(result.message).toContain('scanned zero files');
			});
		}

		it('9. Most recent secretscan entry is used (when multiple entries exist)', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.9', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with multiple secretscan entries
			const earlier = new Date('2024-01-01T00:00:00Z').toISOString();
			const later = new Date('2024-01-02T00:00:00Z').toISOString();
			const latest = new Date('2024-01-03T00:00:00Z').toISOString();

			createEvidenceBundle('1.9', [
				{
					task_id: '1.9',
					type: 'secretscan',
					timestamp: earlier,
					agent: 'pre_check_batch',
					verdict: 'fail',
					summary: 'Earlier scan with secrets',
					findings_count: 5,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
				{
					task_id: '1.9',
					type: 'secretscan',
					timestamp: later,
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'Later scan clean',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
				{
					task_id: '1.9',
					type: 'secretscan',
					timestamp: latest,
					agent: 'pre_check_batch',
					verdict: 'pass',
					summary: 'Latest scan clean',
					findings_count: 0,
					scan_directory: 'src',
					files_scanned: 5,
					skipped_files: 0,
				},
			]);

			const result = await runTool('1.9');

			// Should use the most recent entry (verdict=pass)
			expect(result.secretscan_verdict).toBe('pass');
			expect(result.status).toBe('all_passed');
			expect(result.message).not.toContain('BLOCKED');
		});

		it('10. secretscan_verdict=not_run when EvidenceBundle exists but has no secretscan entries and no other evidence', async () => {
			// Setup: gate-evidence shows all gates passed
			createGateEvidence('1.10', ['test', 'review'], { test: {}, review: {} });

			// Setup: EvidenceBundle with non-secretscan entry only
			createEvidenceBundle('1.10', [
				{
					task_id: '1.10',
					type: 'review',
					timestamp: new Date().toISOString(),
					agent: 'mega_reviewer',
					verdict: 'pass',
					summary: 'Review passed',
					risk: 'low',
					issues: [],
				},
			]);

			const result = await runTool('1.10');

			expect(result.secretscan_verdict).toBe('not_run');
			expect(result.message).toContain(
				'Advisory: No secretscan evidence found',
			);
		});
	});
});
