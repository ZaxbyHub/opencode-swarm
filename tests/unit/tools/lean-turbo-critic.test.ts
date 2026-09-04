/**
 * Behavioral tests for the lean_turbo_critic tool (issue #2470 / #2007).
 *
 * Mirrors lean-turbo-review.test.ts: intercept compileCriticPackage and
 * dispatchCriticAgent via the integration _internals seam so the critic
 * outcome is controlled without a live agent dispatch.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { _internals as criticInternals } from '../../../src/turbo/lean/integration';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const _originalCompileCriticPackage = criticInternals.compileCriticPackage;
const _originalDispatchCriticAgent = criticInternals.dispatchCriticAgent;

function mkdtemp(): string {
	const dir = canonicalMkdtemp('lean-turbo-critic-tool-test-');
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	return dir;
}

beforeEach(() => {
	// compileCriticPackage must resolve a package without live evidence reads.
	criticInternals.compileCriticPackage = mock(async () => ({
		phase: 1,
		sessionID: 'test-session',
		lanes: [],
		phaseEvidence: null,
		reviewerEvidence: null,
	}));
});

afterEach(() => {
	criticInternals.compileCriticPackage = _originalCompileCriticPackage;
	criticInternals.dispatchCriticAgent = _originalDispatchCriticAgent;
});

describe('executeLeanTurboCritic — behavioral tests (issue #2470/#2007)', () => {
	test('APPROVED verdict is captured, returned, and written to the critic evidence file', async () => {
		const dir = mkdtemp();
		try {
			criticInternals.dispatchCriticAgent = mock(
				async (): Promise<string> =>
					'VERDICT: APPROVED\nREASON: boundary conditions satisfied',
			);
			const { executeLeanTurboCritic } = await import(
				'../../../src/tools/lean-turbo-critic'
			);
			const result = await executeLeanTurboCritic({
				directory: dir,
				phase: 1,
				sessionID: 'test-session',
			});
			expect(result.success).toBe(true);
			expect(result.verdict).toBe('APPROVED');
			expect(result.reason).toBe('boundary conditions satisfied');
			expect(result.evidencePath).toContain('lean-turbo-critic.json');

			// The evidence file is the producer the phase_critic gate reads.
			const evidence = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo-critic.json'),
					'utf-8',
				),
			);
			expect(evidence.verdict).toBe('APPROVED');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('NEEDS_REVISION verdict flows through and is persisted', async () => {
		const dir = mkdtemp();
		try {
			criticInternals.dispatchCriticAgent = mock(
				async (): Promise<string> =>
					'VERDICT: NEEDS_REVISION\nREASON: lane evidence incomplete',
			);
			const { executeLeanTurboCritic } = await import(
				'../../../src/tools/lean-turbo-critic'
			);
			const result = await executeLeanTurboCritic({
				directory: dir,
				phase: 1,
				sessionID: 'test-session',
			});
			expect(result.success).toBe(true);
			expect(result.verdict).toBe('NEEDS_REVISION');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a failing dispatch fails closed: durable REJECTED verdict is written and returned', async () => {
		const dir = mkdtemp();
		try {
			criticInternals.dispatchCriticAgent = mock(async (): Promise<string> => {
				throw new Error('critic dispatch failed');
			});
			const { executeLeanTurboCritic } = await import(
				'../../../src/tools/lean-turbo-critic'
			);
			const result = await executeLeanTurboCritic({
				directory: dir,
				phase: 1,
				sessionID: 'test-session',
			});
			// #1896/#1905 semantics: after fallbacks are exhausted the dispatch
			// fails CLOSED — a durable REJECTED verdict is persisted rather than
			// surfacing a transient error as a pass.
			expect(result.success).toBe(true);
			expect(result.verdict).toBe('REJECTED');
			const evidence = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo-critic.json'),
					'utf-8',
				),
			);
			expect(evidence.verdict).toBe('REJECTED');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the tool module routes through dispatchPhaseCritic (production wiring seam)', async () => {
		const dir = mkdtemp();
		try {
			criticInternals.dispatchCriticAgent = mock(
				async (): Promise<string> => 'VERDICT: APPROVED',
			);
			const { _internals } = await import(
				'../../../src/tools/lean-turbo-critic'
			);
			// The _internals seam must be bound to the real dispatchPhaseCritic —
			// if someone unwires the tool from the dispatch, this fails.
			const result = await _internals.dispatchPhaseCritic(
				dir,
				1,
				'test-session',
				{},
			);
			expect(result.verdict).toBe('APPROVED');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
