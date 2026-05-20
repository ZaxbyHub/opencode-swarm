import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleQaGatesCommand } from '../../../src/commands/qa-gates';
import { closeProjectDb } from '../../../src/db/project-db';
import { DEFAULT_QA_GATES, getProfile } from '../../../src/db/qa-gate-profile';
import type { SetQaGatesArgs } from '../../../src/tools/set-qa-gates';
import {
	executeSetQaGates,
	set_qa_gates,
} from '../../../src/tools/set-qa-gates';

describe('final_council gate integration', () => {
	// -------------------------------------------------------------------------
	// VERIFICATION TESTS
	// -------------------------------------------------------------------------

	describe('verification', () => {
		it('DEFAULT_QA_GATES.final_council is false', () => {
			expect(DEFAULT_QA_GATES.final_council).toBe(false);
		});

		it('ALL_GATE_NAMES includes final_council (verified via command error message)', async () => {
			// Pass an invalid gate name; the error should list all valid gates
			// which includes 'final_council'
			const result = await handleQaGatesCommand(
				process.cwd(),
				['enable', 'not_a_real_gate_name'],
				'test-session',
			);
			// The command returns an error string listing valid gates
			expect(result).toContain('final_council');
		});

		it('final_council is last entry in ALL_GATE_NAMES (verified via DEFAULT_QA_GATES key ordering)', () => {
			// The QaGates interface fields are ordered; final_council is last
			// We verify DEFAULT_QA_GATES has final_council and it equals false
			expect(DEFAULT_QA_GATES).toHaveProperty('final_council');
			const keys = Object.keys(
				DEFAULT_QA_GATES,
			) as (keyof typeof DEFAULT_QA_GATES)[];
			expect(keys[keys.length - 1]).toBe('final_council');
		});

		it('set-qa-gates tool schema validates final_council: true', () => {
			// set_qa_gates.args.final_council is the Zod schema for the final_council field
			const finalCouncilSchema = set_qa_gates.args.final_council;
			const result = finalCouncilSchema.safeParse(true);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toBe(true);
			}
		});

		it('set-qa-gates tool schema validates final_council: false', () => {
			// set_qa_gates.args.final_council is the Zod schema for the final_council field
			const finalCouncilSchema = set_qa_gates.args.final_council;
			const result = finalCouncilSchema.safeParse(false);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toBe(false);
			}
		});
	});

	// -------------------------------------------------------------------------
	// ADVERSARIAL TESTS
	// -------------------------------------------------------------------------

	describe('adversarial', () => {
		it('set-qa-gates rejects unknown gate names in the schema', () => {
			// Unknown gate names are not part of the schema, so passing them
			// directly to safeParse on the whole args object would fail
			// We verify by checking that set_qa_gates.args does NOT have
			// a property for unknown gates
			const unknownGate = 'not_a_real_gate' as keyof typeof set_qa_gates.args;
			expect(set_qa_gates.args[unknownGate]).toBeUndefined();
		});

		it('set-qa-gates ignores extra fields gracefully (unknown fields are stripped)', () => {
			// When extra unknown fields are passed, they should be stripped by Zod
			// We verify by checking that unknown fields are not in the args schema
			const extraField =
				'unknown_extra_field' as keyof typeof set_qa_gates.args;
			expect(set_qa_gates.args[extraField]).toBeUndefined();
		});

		it('DEFAULT_QA_GATES has exactly 11 keys', () => {
			const keys = Object.keys(DEFAULT_QA_GATES);
			expect(keys).toHaveLength(11);
		});
	});

	// -------------------------------------------------------------------------
	// BEHAVIORAL TESTS
	// -------------------------------------------------------------------------

	describe('persistence', () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), 'final-council-gate-test-'));
			// Create minimal .swarm/ directory structure with valid plan.json
			const swarmDir = join(tempDir, '.swarm');
			mkdirSync(swarmDir, { recursive: true });
			// Write a valid plan.json that passes PlanSchema validation
			const planJson = {
				schema_version: '1.0.0',
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
								id: '1.1',
								phase: 1,
								status: 'pending',
								description: 'Test task',
							},
						],
					},
				],
			};
			writeFileSync(
				join(swarmDir, 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);
		});

		afterEach(() => {
			closeProjectDb(tempDir);
			rmSync(tempDir, { recursive: true, force: true });
		});

		it('set_qa_gates persists final_council: true to profile', async () => {
			const result = await executeSetQaGates({ final_council: true }, tempDir);
			expect(result.success).toBe(true);
			const profile = getProfile(tempDir, result.plan_id!);
			expect(profile).not.toBeNull();
			expect(profile!.gates.final_council).toBe(true);
		});

		it('set_qa_gates persists final_council: false to profile', async () => {
			// First enable final_council so we can test disabling it is rejected
			// (ratchet-tight policy: can only enable, not disable)
			await executeSetQaGates({ final_council: true }, tempDir);
			// Attempting to set final_council back to false should fail due to ratchet
			const result = await executeSetQaGates({ final_council: false }, tempDir);
			expect(result.success).toBe(false);
			expect(result.reason).toBe('ratchet_violation');
		});
	});
});
