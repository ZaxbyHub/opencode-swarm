import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EvidenceBundle } from '../../../src/config/evidence-schema';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Mock loadEvidence and listEvidenceTaskIds from evidence/manager
// IMPORTANT: Use local mock variable pattern, NOT vi.mocked()
const mockLoadEvidence =
	vi.fn<
		(
			dir: string,
			taskId: string,
		) => Promise<
			| {
					status: 'found';
					bundle: EvidenceBundle;
			  }
			| { status: 'not_found' }
			| { status: 'invalid_schema'; errors: string[] }
		>
	>();
const mockListEvidenceTaskIds = vi.fn<(dir: string) => Promise<string[]>>();

vi.mock('../../../src/evidence/manager', () => ({
	loadEvidence: (...args: unknown[]) =>
		mockLoadEvidence(...(args as [string, string])),
	listEvidenceTaskIds: (...args: unknown[]) =>
		mockListEvidenceTaskIds(...(args as [string])),
}));

// Import the tool after mocking
const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Helper function to write gate evidence files for Phase 4 mandatory gates
 * (completion-verify and drift-verifier)
 */
function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	// Write completion-verify.json
	const completionVerify = {
		status: 'passed',
		tasksChecked: 1,
		tasksPassed: 1,
		tasksBlocked: 0,
		reason: 'All task identifiers found in source files',
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(completionVerify, null, 2),
	);

	// Write drift-verifier.json
	const driftVerifier = {
		schema_version: '1.0.0',
		task_id: 'drift-verifier',
		entries: [
			{
				task_id: 'drift-verifier',
				type: 'drift_verification',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: 'approved',
				summary: 'Drift check passed',
			},
		],
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(driftVerifier, null, 2),
	);
}

describe('phase_complete - loadEvidence discriminated union fixes (A+B+C)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();
		vi.clearAllMocks();

		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-load-evidence-test-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and config
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		// Create minimal config
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);

		// Write gate evidence files for Phase 4 mandatory gates
		writeGateEvidence(tempDir, 1);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		vi.clearAllMocks();
	});

	describe('Fix A: Discriminated union handling for loadEvidence', () => {
		test('1. When loadEvidence returns found with valid retro -> retroFound = true -> normal flow', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Mock loadEvidence to return 'found' with a valid retro entry
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: `retro-${phase}`,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					entries: [
						{
							task_id: `retro-${phase}`,
							type: 'retrospective',
							timestamp: new Date().toISOString(),
							agent: 'architect',
							verdict: 'pass' as const,
							summary: `Phase ${phase} completed`,
							phase_number: phase,
							total_tool_calls: 10,
							coder_revisions: 1,
							reviewer_rejections: 0,
							test_failures: 0,
							security_findings: 0,
							integration_issues: 0,
							task_count: 5,
							task_complexity: 'moderate' as const,
							top_rejection_reasons: [],
							lessons_learned: [],
						},
					],
				},
			});

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.reason).toBeUndefined();
		});

		test('2. When loadEvidence returns not_found -> retroFound = false -> RETROSPECTIVE_MISSING blocked response', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Mock loadEvidence to return 'not_found'
			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
			expect(parsed.message).toContain('no valid retrospective evidence found');
		});

		test('3. Fix A: Uses status === "found" check (discriminated union) for retroResult', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Mock loadEvidence to return 'found'
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: `retro-${phase}`,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					entries: [
						{
							task_id: `retro-${phase}`,
							type: 'retrospective',
							timestamp: new Date().toISOString(),
							agent: 'architect',
							verdict: 'pass' as const,
							summary: `Phase ${phase} completed`,
							phase_number: phase,
							total_tool_calls: 10,
							coder_revisions: 1,
							reviewer_rejections: 0,
							test_failures: 0,
							security_findings: 0,
							integration_issues: 0,
							task_count: 5,
							task_complexity: 'moderate' as const,
							top_rejection_reasons: [],
							lessons_learned: [],
						},
					],
				},
			});

			// Act
			await phase_complete.execute({ phase, sessionID: 'sess1' });

			// Assert - verify loadEvidence was called and used discriminated union
			expect(mockLoadEvidence).toHaveBeenCalled();
		});

		test('4. Fix A: Uses status !== "found" check (discriminated union) for bundleResult in fallback', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Primary call returns not_found
			mockLoadEvidence
				.mockResolvedValueOnce({ status: 'not_found' })
				// Fallback calls return not_found
				.mockResolvedValue({ status: 'not_found' });

			mockListEvidenceTaskIds.mockResolvedValue(['retro-2']);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert - should try primary, then fallback, then block
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
		});
	});

	describe('Fix B: Schema errors captured and included in error message', () => {
		test('5. When loadEvidence returns invalid_schema -> schema errors appear in blocked response message', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			const schemaErrors = [
				'entries.0.phase_number: Expected number, got string',
				'entries.0.verdict: Invalid enum value',
			];

			// Mock loadEvidence to return 'invalid_schema'
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: schemaErrors,
			});
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.message).toContain('Schema validation failed');
			expect(parsed.message).toContain(schemaErrors[0]);
			expect(parsed.message).toContain(schemaErrors[1]);
		});

		test('6. Fix B: Schema error detail formatted with "Schema validation failed:" prefix', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			const schemaErrors = [
				'schema_version: Required',
				'entries: Must be array',
			];

			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: schemaErrors,
			});
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.message).toMatch(/Schema validation failed:/);
		});

		test('7. Fix B: Fallback scan also captures schema errors', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Primary call returns not_found
			mockLoadEvidence
				.mockResolvedValueOnce({ status: 'not_found' })
				// Fallback returns invalid_schema
				.mockResolvedValue({
					status: 'invalid_schema',
					errors: ['entries.0.phase_number: Missing field'],
				});

			mockListEvidenceTaskIds.mockResolvedValue(['retro-2']);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Schema validation failed');
			expect(parsed.message).toContain('entries.0.phase_number: Missing field');
		});
	});

	describe('Fix C: Valid JSON template in warnings[1]', () => {
		test('8. Template in warnings[1] is valid parseable JSON', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert - warnings[1] should be valid JSON string
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
			expect(typeof parsed.warnings[1]).toBe('string');

			// Parse the template and verify it's valid
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template).toBeDefined();
			expect(typeof template).toBe('object');
		});

		test('9. Template has schema_version: "1.0.0"', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template.schema_version).toBe('1.0.0');
		});

		test('10. Template has task_count: 1 (not 0)', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template.entries).toBeDefined();
			expect(template.entries.length).toBeGreaterThan(0);
			expect(template.entries[0].task_count).toBe(1);
		});

		test('11. Template has task_complexity: "simple" (not "medium")', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template.entries[0].task_complexity).toBe('simple');
		});

		test('12. Template has verdict: "pass"', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template.entries[0].verdict).toBe('pass');
		});

		test('13. Template uses snake_case field names', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			const template = JSON.parse(parsed.warnings[1] as string);
			// Check for snake_case fields
			expect(template.schema_version).toBeDefined(); // snake_case
			expect(template.task_id).toBeDefined(); // snake_case
			expect(template.created_at).toBeDefined(); // snake_case
			expect(template.updated_at).toBeDefined(); // snake_case
			expect(template.entries[0].phase_number).toBeDefined(); // snake_case
			expect(template.entries[0].task_count).toBeDefined(); // snake_case
			expect(template.entries[0].task_complexity).toBeDefined(); // snake_case
			expect(template.entries[0].top_rejection_reasons).toBeDefined(); // snake_case
			expect(template.entries[0].lessons_learned).toBeDefined(); // snake_case
		});
	});

	describe('Combined scenarios: Discriminated union + schema errors + template', () => {
		test('14. Fallback scan: when primary is not_found but fallback finds valid retro -> proceeds', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			// Primary call returns not_found
			mockLoadEvidence
				.mockResolvedValueOnce({ status: 'not_found' })
				// Fallback call finds valid retro
				.mockResolvedValue({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: 'retro-2',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: 'retro-2',
								type: 'retrospective',
								timestamp: new Date().toISOString(),
								agent: 'architect',
								verdict: 'pass' as const,
								summary: `Phase ${phase} completed`,
								phase_number: phase,
								total_tool_calls: 10,
								coder_revisions: 1,
								reviewer_rejections: 0,
								test_failures: 0,
								security_findings: 0,
								integration_issues: 0,
								task_count: 5,
								task_complexity: 'moderate' as const,
								top_rejection_reasons: [],
								lessons_learned: [],
							},
						],
					},
				});

			mockListEvidenceTaskIds.mockResolvedValue(['retro-2']);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('15. Full flow: not_found -> fallback not_found -> blocked with template and schema errors', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');

			const schemaErrors = ['entries.0.phase_number: Required'];

			// Primary returns not_found, fallback returns invalid_schema
			mockLoadEvidence
				.mockResolvedValueOnce({ status: 'not_found' })
				.mockResolvedValue({
					status: 'invalid_schema',
					errors: schemaErrors,
				});

			mockListEvidenceTaskIds.mockResolvedValue(['retro-2']);

			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
			expect(parsed.message).toContain('Schema validation failed');
			expect(parsed.message).toContain(schemaErrors[0]);

			// Verify template is valid JSON
			const template = JSON.parse(parsed.warnings[1] as string);
			expect(template.schema_version).toBe('1.0.0');
			expect(template.entries[0].task_count).toBe(1);
			expect(template.entries[0].task_complexity).toBe('simple');
		});
	});

	describe('Fix D: Retrospective auto-repair migration notice', () => {
		test('18. No migration warning when loadEvidence returns not_found', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');
			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);
			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);
			// Assert: blocked (no retro found) AND no migration warning
			expect(parsed.status).toBe('blocked');
			expect(parsed.warnings ?? []).not.toContain(
				`Retrospective data for phase ${phase} may have been automatically migrated to current schema format.`,
			);
		});

		test('20. No migration warning when invalid_schema (load fails — not a repaired bundle)', async () => {
			// Arrange
			const phase = 1;
			ensureAgentSession('sess1');
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['entries.0.task_complexity: Invalid enum value'],
			});
			mockListEvidenceTaskIds.mockResolvedValue([`retro-${phase}`]);
			// Act
			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);
			// Assert: blocked or warning path, but NOT the migration warning
			const hasAutoMigrationWarning = (parsed.warnings ?? []).some(
				(w: string) => w.includes('automatically migrated'),
			);
			expect(hasAutoMigrationWarning).toBe(false);
		});
	});
});
