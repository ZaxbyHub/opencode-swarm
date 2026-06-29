/**
 * Adversarial tests for FR-005 (evidence spoofing).
 *
 * Covers 3 attack vectors:
 * - SC-005.1 Forged verdict rejection: verdict objects with invalid signatures/IDs/values must be rejected
 * - SC-005.2 Timestamp manipulation rejection: timestamps before task assignment, in future, or inconsistent must be rejected
 * - SC-005.3 Task-ID spoofing rejection: writes for non-existent or completed tasks must be rejected
 *
 * Tests use the _internals DI seam to mock validateProjectRoot, enabling
 * isolated testing of saveEvidence's validation logic without filesystem
 * environment constraints.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence } from '../../src/config/evidence-schema';
import type { Plan } from '../../src/config/plan-schema';
import type { validateProjectRoot as ValidateProjectRootType } from '../../src/evidence/manager';
import {
	_internals,
	loadEvidence,
	saveEvidence,
} from '../../src/evidence/manager';

let tempDir: string;
let savedValidateProjectRoot: ValidateProjectRootType;

beforeEach(() => {
	// Mock validateProjectRoot to isolate evidence validation tests from filesystem
	// environment constraints (parent .swarm/ detection). Tests that specifically
	// exercise validateProjectRoot do so in manager.test.ts.
	savedValidateProjectRoot = _internals.validateProjectRoot;
	_internals.validateProjectRoot = () => {};

	tempDir = join(
		tmpdir(),
		`evidence-spoof-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.validateProjectRoot = savedValidateProjectRoot;
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Minimal valid evidence base — used as the foundation for forging fields. */
function validBase(overrides: Partial<Evidence> = {}): Evidence {
	return {
		task_id: '1.1',
		type: 'note',
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary: 'Test evidence',
		...overrides,
	} as Evidence;
}

/** Write a minimal plan.json with a specific task marked as completed (FB-005). */
function writePlanJsonForCompletionTest(
	dir: string,
	completedTaskId: string,
): void {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: completedTaskId,
						phase: 1,
						status: 'completed' as const,
						size: 'small' as const,
						description: 'Test task',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Another task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

// ---------------------------------------------------------------------------
// SC-005.1 — Forged verdict rejection
// ---------------------------------------------------------------------------

describe('SC-005.1 — Forged verdict rejection', () => {
	/**
	 * Verdict is a Zod enum in BaseEvidenceSchema. Supplying an invalid string
	 * value should cause EvidenceBundleSchema.parse() inside saveEvidence to
	 * throw, preventing the forged verdict from being persisted.
	 */

	it('rejects evidence with a non-enum verdict string ("hacked")', async () => {
		const forgedEvidence = validBase({ verdict: 'hacked' as any });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with a non-enum verdict string ("undefined")', async () => {
		const forgedEvidence = validBase({ verdict: 'undefined' as any });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with verdict as a raw number instead of string', async () => {
		// Zod BaseEvidenceSchema defines verdict as z.string() — passing a number should fail
		const forgedEvidence = validBase({ verdict: 1 as any });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with verdict as null', async () => {
		const forgedEvidence = validBase({ verdict: null as any });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with verdict as undefined', async () => {
		// Zod treats undefined as missing required field
		const { verdict: _v, ...noVerdict } = validBase();
		const forgedEvidence = { ...noVerdict, verdict: undefined } as Evidence;
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('accepts all valid verdict enum values without throwing', async () => {
		// sanity check: all valid verdicts must NOT throw
		const validVerdicts = [
			'pass',
			'fail',
			'warn',
			'skip',
			'approved',
			'rejected',
			'info',
		] as const;
		for (const verdict of validVerdicts) {
			const evidence = validBase({ verdict });
			// Should not throw
			await expect(
				saveEvidence(tempDir, `1.1-${verdict}`, evidence),
			).resolves.toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// SC-005.2 — Timestamp manipulation rejection
// ---------------------------------------------------------------------------

describe('SC-005.2 — Timestamp manipulation rejection', () => {
	/**
	 * BaseEvidenceSchema requires timestamp to be z.string().datetime() (ISO 8601).
	 * Non-datetime strings must be rejected at the Zod validation layer inside
	 * saveEvidence.
	 */

	it('rejects evidence with a plain text string as timestamp', async () => {
		const forgedEvidence = validBase({ timestamp: 'not-a-date' });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with a numeric timestamp', async () => {
		const forgedEvidence = validBase({ timestamp: 1234567890 as any });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with a malformed ISO timestamp (invalid month 99)', async () => {
		const forgedEvidence = validBase({ timestamp: '2024-99-01T00:00:00.000Z' });
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	// Note: Zod's datetime validator accepts any valid ISO 8601 timestamp, including
	// past dates like 1999. The current implementation does NOT enforce bounds on
	// timestamps (e.g., must be after project init). This is a known limitation of
	// the schema-level validation and is tracked separately.

	it('accepts a valid ISO 8601 timestamp without throwing', async () => {
		// Sanity check: valid timestamps must NOT throw
		const evidence = validBase({ timestamp: new Date().toISOString() });
		await expect(saveEvidence(tempDir, '1.1', evidence)).resolves.toBeDefined();
	});

	// FB-005: Semantic timestamp tests
	it('rejects evidence with a future timestamp (1 day ahead)', async () => {
		const futureTimestamp = new Date(Date.now() + 86400000).toISOString();
		const forgedEvidence = validBase({ timestamp: futureTimestamp });
		// Zod datetime() accepts future dates; saveEvidence schema validation currently
		// allows them too — this test documents the expected secure behavior.
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('accepts a past timestamp (before task assignment) — known limitation', async () => {
		// FB-005: Schema validation does NOT enforce lower-bound on timestamps.
		// This is a known limitation documented in the schema validation layer.
		// The application layer should reject timestamps predating task creation,
		// but currently does not. This test documents current behavior.
		const ancientTimestamp = '1999-01-01T00:00:00.000Z';
		const evidence = validBase({ timestamp: ancientTimestamp });
		// Currently passes — known limitation
		await expect(saveEvidence(tempDir, '1.1', evidence)).resolves.toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// SC-005.3 — Task-ID spoofing rejection
// ---------------------------------------------------------------------------

describe('SC-005.3 — Task-ID spoofing rejection', () => {
	/**
	 * Task IDs are validated at two layers:
	 * 1. sanitizeTaskId() — path traversal, empty string, invalid format
	 * 2. saveEvidence path-length check (4096 bytes)
	 * 3. BaseEvidenceSchema task_id — z.string().min(1)
	 *
	 *spoofing attacks must be caught and rejected before evidence is persisted.
	 */

	it('rejects task ID with path traversal (../etc/passwd)', async () => {
		const evidence = validBase({ task_id: '../etc/passwd' });
		await expect(
			saveEvidence(tempDir, '../etc/passwd', evidence),
		).rejects.toThrow('Invalid task ID');
	});

	it('rejects task ID with Windows-style path traversal (..\\windows)', async () => {
		const evidence = validBase({ task_id: '..\\windows' });
		await expect(
			saveEvidence(tempDir, '..\\windows', evidence),
		).rejects.toThrow('Invalid task ID');
	});

	it('rejects empty string task ID via BaseEvidenceSchema', async () => {
		// sanitizeTaskId catches empty string at the taskId level, but also
		// BaseEvidenceSchema task_id is z.string().min(1)
		const evidence = validBase({ task_id: '' });
		await expect(saveEvidence(tempDir, '', evidence)).rejects.toThrow();
	});

	it('rejects task ID with null byte', async () => {
		const evidence = validBase({ task_id: '1.1\x00' });
		await expect(saveEvidence(tempDir, '1.1\x00', evidence)).rejects.toThrow(
			'Invalid task ID',
		);
	});

	it('rejects task ID with control characters', async () => {
		const evidence = validBase({ task_id: '1.1\x1b' });
		await expect(saveEvidence(tempDir, '1.1\x1b', evidence)).rejects.toThrow(
			'Invalid task ID',
		);
	});

	it('rejects task ID with double-dot pattern', async () => {
		const evidence = validBase({ task_id: '1..1' });
		await expect(saveEvidence(tempDir, '1..1', evidence)).rejects.toThrow(
			'Invalid task ID',
		);
	});

	it('rejects task ID with slash character', async () => {
		const evidence = validBase({ task_id: '1/1' });
		await expect(saveEvidence(tempDir, '1/1', evidence)).rejects.toThrow(
			'Invalid task ID',
		);
	});

	it('accepts a valid numeric task ID without throwing', async () => {
		// Sanity check: valid task IDs must NOT throw
		const evidence = validBase({ task_id: '2.5' });
		await expect(saveEvidence(tempDir, '2.5', evidence)).resolves.toBeDefined();
	});

	it('accepts a valid retrospective task ID (retro-1) without throwing', async () => {
		const evidence = validBase({ task_id: 'retro-1' });
		await expect(
			saveEvidence(tempDir, 'retro-1', evidence),
		).resolves.toBeDefined();
	});

	it('accepts a valid internal tool task ID (sast_scan) without throwing', async () => {
		const evidence = validBase({ task_id: 'sast_scan' });
		await expect(
			saveEvidence(tempDir, 'sast_scan', evidence),
		).resolves.toBeDefined();
	});

	// FB-005: Semantic task-ID tests
	it('rejects evidence with a non-existent task_id (999.999)', async () => {
		// FB-005: A task ID that does not exist in the project plan should be rejected.
		// The application-layer validation in saveEvidence should enforce this.
		const evidence = validBase({ task_id: '999.999' });
		await expect(saveEvidence(tempDir, '999.999', evidence)).rejects.toThrow();
	});

	it('rejects evidence with a completed task_id (status=completed)', async () => {
		// FB-005: Writing evidence for an already-completed task should be rejected,
		// as it could be used to backdate or forge evidence after task completion.
		// Set up plan.json with task 1.1 already marked completed.
		writePlanJsonForCompletionTest(tempDir, '1.1');
		const evidence = validBase({ task_id: '1.1' });
		await expect(saveEvidence(tempDir, '1.1', evidence)).rejects.toThrow(
			'already completed',
		);
	});
});

// ---------------------------------------------------------------------------
// Additional: Combined forged fields that should be rejected together
// ---------------------------------------------------------------------------

describe('Combined field spoofing — multiple invalid fields', () => {
	it('rejects evidence with both forged verdict and forged timestamp', async () => {
		const forgedEvidence = validBase({
			verdict: 'forged' as any,
			timestamp: 'not-a-datetime',
		});
		await expect(
			saveEvidence(tempDir, '1.1', forgedEvidence),
		).rejects.toThrow();
	});

	it('rejects evidence with forged verdict, timestamp, and task_id simultaneously', async () => {
		const forgedEvidence = {
			task_id: '../forged',
			type: 'note',
			timestamp: ' forged ',
			agent: 'test-agent',
			verdict: 'invalid_verdict' as any,
			summary: 'Spoofed evidence',
		} as Evidence;
		await expect(
			saveEvidence(tempDir, '../forged', forgedEvidence),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Additional: Verify loadEvidence also rejects forged evidence
// ---------------------------------------------------------------------------

describe('loadEvidence — rejects forged evidence loaded from disk', () => {
	it('returns invalid_schema when loading evidence with forged verdict persisted to disk', async () => {
		// First, write a valid bundle, then manually corrupt it on disk
		const evidence = validBase();
		await saveEvidence(tempDir, '1.1', evidence);

		// Manually write a forged verdict into the file on disk
		const evidencePath = join(
			tempDir,
			'.swarm',
			'evidence',
			'1.1',
			'evidence.json',
		);
		const fs = await import('node:fs/promises');
		const content = await fs.readFile(evidencePath, 'utf-8');
		const bundle = JSON.parse(content);
		bundle.entries[0].verdict = 'forged_verdict';
		await fs.writeFile(evidencePath, JSON.stringify(bundle));

		// loadEvidence should detect the forged verdict
		const result = await loadEvidence(tempDir, '1.1');
		expect(result.status).toBe('invalid_schema');
	});

	it('returns invalid_schema when loading evidence with forged timestamp on disk', async () => {
		const evidence = validBase();
		await saveEvidence(tempDir, '1.1', evidence);

		const evidencePath = join(
			tempDir,
			'.swarm',
			'evidence',
			'1.1',
			'evidence.json',
		);
		const fs = await import('node:fs/promises');
		const content = await fs.readFile(evidencePath, 'utf-8');
		const bundle = JSON.parse(content);
		bundle.entries[0].timestamp = 'not-a-datetime';
		await fs.writeFile(evidencePath, JSON.stringify(bundle));

		const result = await loadEvidence(tempDir, '1.1');
		expect(result.status).toBe('invalid_schema');
	});

	it('returns invalid_schema when loading evidence with empty task_id in entry', async () => {
		const evidence = validBase();
		await saveEvidence(tempDir, '1.1', evidence);

		const evidencePath = join(
			tempDir,
			'.swarm',
			'evidence',
			'1.1',
			'evidence.json',
		);
		const fs = await import('node:fs/promises');
		const content = await fs.readFile(evidencePath, 'utf-8');
		const bundle = JSON.parse(content);
		bundle.entries[0].task_id = '';
		await fs.writeFile(evidencePath, JSON.stringify(bundle));

		const result = await loadEvidence(tempDir, '1.1');
		expect(result.status).toBe('invalid_schema');
	});

	// Note: Zod's BaseEvidenceSchema validates task_id as z.string().min(1),
	// which accepts path traversal strings like "../../etc/passwd". This is a known
	// limitation of the schema-level validation. Path traversal protection for
	// task_id in entries must be enforced at a higher application layer.
});
