import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Adversarial coverage for the fail-closed contract on phase_complete gates.
 *
 * Each gate wraps its logic in try/catch. When the try block throws for a
 * reason unrelated to "gate not applicable" (e.g. a filesystem error other
 * than ENOENT, or the underlying verify call itself throwing), the gate
 * must NOT silently let the phase complete. If the gate had already
 * confirmed the QA flag is enabled before the throw, an error must BLOCK
 * the phase (fail-closed). If the gate never got far enough to confirm the
 * flag is enabled (e.g. resolveGatePreamble itself throws), it is
 * acceptable to pass through non-blocking, since there is no evidence the
 * gate was even active.
 */

function makeCtx(tmpDir: string) {
	return {
		phase: 1,
		dir: tmpDir,
		sessionID: 'test-session',
		pluginConfig: {},
		agentsDispatched: ['coder'],
		safeWarn: () => {},
	};
}

describe('phase_complete gates — fail-closed on internal errors', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('phase-complete-gate-fc-');
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		mock.restore();
	});

	test('completion-verify-gate: executeCompletionVerify throwing blocks the phase', async () => {
		mock.module('../../../src/tools/completion-verify', () => ({
			executeCompletionVerify: async () => {
				throw new Error('boom: verify subsystem exploded');
			},
		}));

		const { runCompletionVerifyGate } = await import(
			'../../../src/tools/phase-complete/gates/completion-verify-gate'
		);

		const result = await runCompletionVerifyGate(makeCtx(tmpDir) as any);

		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('COMPLETION_VERIFY_ERROR');
	});

	test('hallucination-gate: enabled + unexpected error blocks the phase', async () => {
		// identityBound: false with plan: undefined triggers TypeError on
		// preamble.plan!.swarm AFTER hallucinationGateEnabled is set to true,
		// exercising the outer catch's fail-closed branch.
		mock.module('../../../src/tools/phase-complete/gates/gate-helpers', () => ({
			resolveGatePreamble: async () => ({
				resolved: true,
				effectiveGates: { hallucination_guard: true },
				identityBound: false,
				plan: undefined,
			}),
		}));

		const { runHallucinationGate } = await import(
			'../../../src/tools/phase-complete/gates/hallucination-gate'
		);

		const result = await runHallucinationGate(makeCtx(tmpDir) as any);

		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('HALLUCINATION_GATE_ERROR');
	});

	test('hallucination-gate: preamble resolution throwing before enablement is confirmed does NOT block', async () => {
		mock.module('../../../src/tools/phase-complete/gates/gate-helpers', () => ({
			resolveGatePreamble: async () => {
				throw new Error('boom: plan load exploded');
			},
		}));

		const { runHallucinationGate } = await import(
			'../../../src/tools/phase-complete/gates/hallucination-gate'
		);

		const result = await runHallucinationGate(makeCtx(tmpDir) as any);

		expect(result.blocked).toBe(false);
	});

	test('mutation-gate: enabled + unexpected error blocks the phase', async () => {
		// Same pattern: identityBound: false + plan: undefined triggers TypeError
		// after mutationGateEnabled is set, exercising the outer catch fail-closed branch.
		mock.module('../../../src/tools/phase-complete/gates/gate-helpers', () => ({
			resolveGatePreamble: async () => ({
				resolved: true,
				effectiveGates: { mutation_test: true },
				identityBound: false,
				plan: undefined,
			}),
		}));

		const { runMutationGate } = await import(
			'../../../src/tools/phase-complete/gates/mutation-gate'
		);

		const result = await runMutationGate(makeCtx(tmpDir) as any);

		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('MUTATION_GATE_ERROR');
	});

	test('mutation-gate: preamble resolution throwing before enablement is confirmed does NOT block', async () => {
		mock.module('../../../src/tools/phase-complete/gates/gate-helpers', () => ({
			resolveGatePreamble: async () => {
				throw new Error('boom: plan load exploded');
			},
		}));

		const { runMutationGate } = await import(
			'../../../src/tools/phase-complete/gates/mutation-gate'
		);

		const result = await runMutationGate(makeCtx(tmpDir) as any);

		expect(result.blocked).toBe(false);
	});
});
