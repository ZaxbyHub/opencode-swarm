import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deriveDurableTaskGate,
	deriveTaskEvidenceSynthesis,
	evidenceVerdictForDurableGate,
} from '../../../src/evidence/gate-outcome';
import { buildVerificationReceipt } from '../../../src/evidence/receipt';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #3560 (swarm-pr-review PR #3557, executed finding): task-kind receipt
 * outcomes must derive from the DURABLE entry, never a constant. A seeded
 * `gates.council` REJECT used to emit `outcome:'pass'`; empty `gates` used to
 * synthesize a fabricated `task_evidence pass`. Test names carry the frozen
 * acceptance-criterion signatures from the issue (AC1-AC7) so
 * `bun test <file> -t "<signature>"` exercises exactly one AC's check.
 */

const STAMP = '2026-11-02T00:00:00.000Z';

function taskDir(): {
	dir: string;
	write: (taskId: string, evidence: Record<string, unknown>) => void;
} {
	const dir = canonicalMkdtemp('r3560-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return {
		dir,
		write: (taskId, evidence) => {
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', `${taskId}.json`),
				JSON.stringify(evidence),
			);
		},
	};
}

function councilEntry(verdict: unknown): Record<string, unknown> {
	return {
		sessionId: 'swarm-council',
		timestamp: STAMP,
		agent: 'council',
		verdict,
		vetoedBy: verdict === 'REJECT' ? ['critic'] : [],
		roundNumber: 2,
		allCriteriaMet: false,
		quorumSize: 3,
	};
}

function presenceEntry(agent = 'architect'): Record<string, unknown> {
	return { sessionId: 's', timestamp: STAMP, agent };
}

describe('receipt task-arm outcome fidelity (#3560)', () => {
	test('council REJECT renders block', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.1', {
				taskId: '3.1',
				required_gates: ['pre_check'],
				gates: {
					pre_check: presenceEntry(),
					council: councilEntry('REJECT'),
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.1');
			const council = receipt.gates.find((g) => g.gate_id === 'council');
			expect(council?.outcome).toBe('block');
			expect(council?.code).toBe('REJECT');
			expect(council?.responsible_actor).toBe('council');
			// The presence-only sibling keeps its honest pass-on-presence.
			expect(
				receipt.gates.find((g) => g.gate_id === 'pre_check')?.outcome,
			).toBe('pass');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('council APPROVE renders pass', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.2', {
				taskId: '3.2',
				gates: { council: councilEntry('APPROVE') },
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.2');
			const council = receipt.gates.find((g) => g.gate_id === 'council');
			expect(council?.outcome).toBe('pass');
			expect(council?.code).toBe('APPROVE');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('council CONCERNS passes with verdict code', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.3', {
				taskId: '3.3',
				gates: { council: councilEntry('CONCERNS') },
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.3');
			const council = receipt.gates.find((g) => g.gate_id === 'council');
			// Durable CONCERNS is the task-level ADVISORY form (blocking
			// concerns are promoted and never write this record), so pass —
			// with the verdict in `code` so no reader conflates it with APPROVE.
			expect(council?.outcome).toBe('pass');
			expect(council?.code).toBe('CONCERNS');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('unknown council verdict renders error', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.4', {
				taskId: '3.4',
				gates: { council: councilEntry('ESCALATED') },
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.4');
			const council = receipt.gates.find((g) => g.gate_id === 'council');
			expect(council?.outcome).toBe('error');
			expect(council?.code).toBe('ESCALATED');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('task_evidence synthesis is not_applicable for an empty gates map', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.5', { taskId: '3.5', gates: {} });
			const receipt = await buildVerificationReceipt(dir, 'task', '3.5');
			expect(receipt.gates.length).toBe(1);
			expect(receipt.gates[0]?.gate_id).toBe('task_evidence');
			expect(receipt.gates[0]?.outcome).toBe('not_applicable');
			expect(receipt.gates[0]?.code).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('task_evidence synthesis is pass with no_mutation_settlement code when the durable read-only proof exists', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.6', {
				taskId: '3.6',
				gates: {},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'complete',
					updatedAt: STAMP,
					noMutationSettlement: {
						generation: 0,
						transitionId: 'transition-abc',
						declaredFiles: [],
					},
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.6');
			expect(receipt.gates.length).toBe(1);
			expect(receipt.gates[0]?.gate_id).toBe('task_evidence');
			expect(receipt.gates[0]?.outcome).toBe('pass');
			expect(receipt.gates[0]?.code).toBe('no_mutation_settlement');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('responsible actor from durable agent field, swarm only as fallback', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.7', {
				taskId: '3.7',
				gates: {
					reviewer: presenceEntry('reviewer'),
					// agent is schema-required; the empty string exercises the
					// 'swarm' fallback arm of the actor derivation.
					no_actor: { sessionId: 's', timestamp: STAMP, agent: '' },
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.7');
			expect(
				receipt.gates.find((g) => g.gate_id === 'reviewer')?.responsible_actor,
			).toBe('reviewer');
			expect(
				receipt.gates.find((g) => g.gate_id === 'no_actor')?.responsible_actor,
			).toBe('swarm');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// Direct derivation legs (belt-and-braces with the builder-level probes).
	test('deriveDurableTaskGate maps every verdict arm and never improves on an unknown one', () => {
		expect(
			deriveDurableTaskGate({ verdict: 'REJECT', agent: 'council' }),
		).toEqual({
			outcome: 'block',
			code: 'REJECT',
			responsible_actor: 'council',
		});
		expect(
			deriveDurableTaskGate({ verdict: 'CONCERNS', agent: 'council' }),
		).toEqual({
			outcome: 'pass',
			code: 'CONCERNS',
			responsible_actor: 'council',
		});
		expect(deriveDurableTaskGate({ verdict: 'WEIRD' })).toEqual({
			outcome: 'error',
			code: 'WEIRD',
			responsible_actor: 'swarm',
		});
		// Bounded display evidence: verdict strings are capped.
		expect(
			deriveDurableTaskGate({ verdict: 'x'.repeat(200) }).code?.length,
		).toBe(64);
		expect(deriveDurableTaskGate({ agent: 'architect' })).toEqual({
			outcome: 'pass',
			responsible_actor: 'architect',
		});
	});

	test('deriveTaskEvidenceSynthesis keeps the read-only settlement honest', () => {
		expect(deriveTaskEvidenceSynthesis(undefined).outcome).toBe(
			'not_applicable',
		);
		expect(
			deriveTaskEvidenceSynthesis({
				noMutationSettlement: {
					generation: 0,
					transitionId: 't',
					declaredFiles: [],
				},
			}),
		).toEqual({
			outcome: 'pass',
			code: 'no_mutation_settlement',
			responsible_actor: 'swarm',
		});
	});
});
