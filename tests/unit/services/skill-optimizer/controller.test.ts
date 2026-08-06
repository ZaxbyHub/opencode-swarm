/**
 * Tests for the serial controller.
 * Covers: lock ordering + concurrency (second acquirer gets locked), caps,
 * transient-retry → inconclusive, equivalent-patch stop, dry-run.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SkillOptConfig } from '../../../../src/config/schema.js';
import { DEFAULT_SKILL_OPT_CONFIG } from '../../../../src/config/schema.js';
import {
	_internals,
	runOptimizationLoop,
	runOptimizationRound,
} from '../../../../src/services/skill-optimizer/controller.js';

let tmp = '';
const originalInternals = { ..._internals };

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-opt-ctrl-'));
	// Reset internals between tests.
	Object.assign(_internals, originalInternals);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Object.assign(_internals, originalInternals);
});

function writeIncumbent(slug: string, content: string): void {
	const dir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
}

const CFG: SkillOptConfig = { ...DEFAULT_SKILL_OPT_CONFIG };

describe('skill-opt controller — concurrency / lock ordering', () => {
	it('returns a locked status when the project lock is already held', async () => {
		writeIncumbent('lock-skill', '---\nname: x\ndescription: y\n---\n# body\n');
		// Stub tryAcquireLock to always report "not acquired".
		_internals.tryAcquireLock = mock(() =>
			Promise.resolve({ acquired: false }),
		);
		const result = await runOptimizationRound({
			directory: tmp,
			skillSlug: 'lock-skill',
			config: CFG,
			models: ['m'],
			validationTasks: [],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:plan',
			dryRun: true,
		});
		expect(result.stopped).toBe(true);
		expect(result.stopReason).toContain('locked');
	});
});

describe('skill-opt controller — dry-run plan', () => {
	it('plans without executing validation (dry-run stops at drafted)', async () => {
		writeIncumbent('plan-skill', '---\nname: x\ndescription: y\n---\n# body\n');
		const result = await runOptimizationRound({
			directory: tmp,
			skillSlug: 'plan-skill',
			config: CFG,
			models: ['m'],
			validationTasks: [],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:plan',
			dryRun: true,
		});
		expect(result.decidedState).toBe('drafted');
		expect(result.stopReason).toBe('dry-run');
	});
});

describe('skill-opt controller — equivalent patch stop', () => {
	it('rejects when the deterministic draft equals the baseline', async () => {
		// Empty evidence → deterministic draft appends nothing new if the
		// baseline already ends with the section. Use a baseline that already
		// has the section to force equivalence.
		const baseline =
			'---\nname: x\ndescription: y\n---\n# body\n\n## Optimization Notes\n';
		writeIncumbent('eq-skill', baseline);
		const result = await runOptimizationRound({
			directory: tmp,
			skillSlug: 'eq-skill',
			config: CFG,
			models: ['m'],
			seedEvidence: [],
			validationTasks: [],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:plan',
			dryRun: true,
		});
		// The draft produces content equal to baseline → equivalent-patch stop.
		expect(result.stopped).toBe(true);
		expect(result.stopReason).toBe('equivalent-patch');
	});
});

describe('skill-opt controller — caps', () => {
	it('respects max_transient_retries for transient infra failures (exact call count)', async () => {
		writeIncumbent(
			'trans-skill',
			'---\nname: x\ndescription: y\n---\n# body\n',
		);
		// Force validation to throw a transient error every time.
		_internals.evaluateCandidateV1 = mock(() =>
			Promise.reject(new Error('infrastructure_failure: timeout')),
		);
		const maxRetries = 1;
		const result = await runOptimizationRound({
			directory: tmp,
			skillSlug: 'trans-skill',
			config: { ...CFG, max_transient_retries: maxRetries },
			models: ['m'],
			validationTasks: [{ id: 't1' }],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:run',
			dispatcher: (() => {}) as never,
		});
		// After exhausting transient retries, the result is inconclusive.
		expect(result.decidedState).toBe('inconclusive');
		// The transient path retried exactly maxRetries+1 times (1 initial + maxRetries retries).
		expect(
			(_internals.evaluateCandidateV1 as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(maxRetries + 1);
	});
});

describe('skill-opt controller — optimization loop caps (reviewer CR3 + final critic FC2)', () => {
	it('stops after a rejected validation (held-out set consumed; no re-validation)', async () => {
		writeIncumbent('loop-skill', '---\nname: x\ndescription: y\n---\n# body\n');
		// Validation rejects → the held-out set is consumed → loop stops.
		_internals.evaluateCandidateV1 = mock(() =>
			Promise.resolve({
				run: { runId: 'r' } as never,
				decision: {
					status: 'reject',
					reasons: ['decisive_regression:baseline'],
					deadband: 0,
					lineage: { baselineRunId: 'r' },
				} as never,
			}),
		) as never;
		const result = await runOptimizationLoop({
			directory: tmp,
			skillSlug: 'loop-skill',
			config: { ...CFG, max_rounds: 5 },
			models: ['m'],
			validationTasks: [{ id: 't1' }],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:run',
			dispatcher: (() => {}) as never,
		});
		expect(result.stopped).toBe(true);
		// A rejected validation is terminal — the held-out set is single-use.
		expect(result.stopReason).toBe('validation-terminal:rejected');
		expect(result.rounds.length).toBe(1);
	});

	it('stops immediately when a candidate is accepted (no autonomous chaining)', async () => {
		writeIncumbent(
			'accept-skill',
			'---\nname: x\ndescription: y\n---\n# body\n',
		);
		_internals.evaluateCandidateV1 = mock(() =>
			Promise.resolve({
				run: { runId: 'r' } as never,
				decision: {
					status: 'accept',
					reasons: [
						'improvement_exceeds_deadband_for_baseline_and_historical_best',
					],
					deadband: 0,
					lineage: { baselineRunId: 'r' },
				} as never,
			}),
		) as never;
		const result = await runOptimizationLoop({
			directory: tmp,
			skillSlug: 'accept-skill',
			config: { ...CFG, max_rounds: 10 },
			models: ['m'],
			validationTasks: [{ id: 't1' }],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:run',
			dispatcher: (() => {}) as never,
		});
		expect(result.stopped).toBe(true);
		expect(result.stopReason).toBe('accepted-pending-approval');
		expect(result.rounds.length).toBe(1);
	});

	it('stops immediately on a non-transient hard stop (does NOT retry)', async () => {
		writeIncumbent('hard-skill', '---\nname: x\ndescription: y\n---\n# body\n');
		_internals.evaluateCandidateV1 = mock(() =>
			Promise.reject(new Error('permanent configuration error: no scorer')),
		);
		const result = await runOptimizationLoop({
			directory: tmp,
			skillSlug: 'hard-skill',
			config: { ...CFG, max_rounds: 10 },
			models: ['m'],
			validationTasks: [{ id: 't1' }],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:run',
			dispatcher: (() => {}) as never,
		});
		expect(result.stopped).toBe(true);
		expect(result.stopReason).toBe('non-transient-hard-stop');
		expect(result.rounds.length).toBe(1);
	});

	it('classifies TestAlreadyConsumedError as terminal inconclusive (NOT a hard stop)', async () => {
		writeIncumbent('tac-skill', '---\nname: x\ndescription: y\n---\n# body\n');
		// Simulate the held-out set already being claimed (e.g. a prior run).
		class TestAlreadyConsumedError extends Error {
			name = 'TestAlreadyConsumedError';
		}
		_internals.evaluateCandidateV1 = mock(() =>
			Promise.reject(
				new TestAlreadyConsumedError('task set hash already claimed'),
			),
		);
		const result = await runOptimizationRound({
			directory: tmp,
			skillSlug: 'tac-skill',
			config: CFG,
			models: ['m'],
			validationTasks: [{ id: 't1' }],
			baselineModel: 'm',
			candidateModel: 'm',
			origin: 'command:skill-opt:run',
			dispatcher: (() => {}) as never,
		});
		// TestAlreadyConsumedError → inconclusive, NOT a hard-stop fault.
		expect(result.decidedState).toBe('inconclusive');
		expect(result.hardStop).not.toBe(true);
	});
});
