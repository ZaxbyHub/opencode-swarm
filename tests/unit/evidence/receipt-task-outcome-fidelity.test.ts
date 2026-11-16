import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deriveDurableTaskGate,
	deriveTaskEvidenceSynthesis,
} from '../../../src/evidence/gate-outcome';
import {
	buildVerificationReceipt,
	renderReceiptMarkdown,
} from '../../../src/evidence/receipt';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #3560 (swarm-pr-review PR #3557 + #3561 executed findings): task-kind
 * receipt outcomes must derive from the DURABLE entry, never a constant, and
 * must FAIL CLOSED on a malformed (non-string) verdict — never fall through to
 * the presence-only pass arm. Test names carry the frozen acceptance-criterion
 * signatures from the issue (AC1-AC7) plus the review-round additions, so
 * `bun test <file> -t "<signature>"` exercises exactly one frozen check.
 *
 * Fixtures are PRODUCTION-FAITHFUL (#3561 FB-009): the sole council writer
 * (src/council/council-evidence-writer.ts) persists agent 'architect'
 * (COUNCIL_AGENT_ID); presence-only kinds persist agent === the gate name
 * (src/gate-evidence.ts stage_a_passed/stage_b_completed). An actor derived
 * from the gate id therefore dies on the council leg, not only the sentinel.
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
		agent: 'architect', // production COUNCIL_AGENT_ID
		verdict,
		vetoedBy: verdict === 'REJECT' ? ['critic'] : [],
		roundNumber: 2,
		allCriteriaMet: false,
		quorumSize: 3,
	};
}

function presenceEntry(agent: string): Record<string, unknown> {
	return { sessionId: 's', timestamp: STAMP, agent };
}

const WORKFLOW_COMPLETE_SETTLED = {
	schema: 'exact-task-v1',
	generation: 0,
	state: 'complete',
	updatedAt: STAMP,
	noMutationSettlement: {
		generation: 0,
		transitionId: 'transition-abc',
		declaredFiles: [],
	},
};

describe('receipt task-arm outcome fidelity (#3560)', () => {
	test('council REJECT renders block', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.1', {
				taskId: '3.1',
				required_gates: ['pre_check'],
				gates: {
					pre_check: presenceEntry('pre_check'),
					council: councilEntry('REJECT'),
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.1');
			const council = receipt.gates.find((g) => g.gate_id === 'council');
			expect(council?.outcome).toBe('block');
			expect(council?.code).toBe('REJECT');
			expect(council?.responsible_actor).toBe('architect');
			// The presence-only sibling keeps its honest pass-on-presence.
			expect(
				receipt.gates.find((g) => g.gate_id === 'pre_check')?.outcome,
			).toBe('pass');
			// AC1's rendered-Markdown half (#3561 FB-005/PRR-006): the block
			// outcome MUST reach the human/export table, not only the JSON.
			const md = renderReceiptMarkdown(receipt);
			expect(md).toContain('| council | block | REJECT | architect |');
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

	// #3561 FB-001 / PRR-001: a verdict-bearing record whose verdict is NOT a
	// string must FAIL CLOSED to error, never fall through to pass.
	test('council non-string verdict renders error, never pass', async () => {
		for (const malformed of [
			42,
			null,
			{ status: 'REJECT' },
			['REJECT'],
			true,
		]) {
			const { dir, write } = taskDir();
			try {
				write('3.10', {
					taskId: '3.10',
					gates: { council: councilEntry(malformed) },
				});
				const receipt = await buildVerificationReceipt(dir, 'task', '3.10');
				const council = receipt.gates.find((g) => g.gate_id === 'council');
				expect(
					council?.outcome,
					`verdict ${JSON.stringify(malformed)} must not attest pass`,
				).toBe('error');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
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
				workflow: WORKFLOW_COMPLETE_SETTLED,
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

	// #3561 FB-002 / PRR-002: a preserved settlement marker on a NON-idle/
	// complete workflow (blocked) is NOT a canonical proof — must not fabricate
	// a pass. Bare field truthiness would have attested pass here.
	test('task_evidence synthesis is not_applicable when the settlement proof is stale for a blocked workflow', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.11', {
				taskId: '3.11',
				gates: {},
				workflow: { ...WORKFLOW_COMPLETE_SETTLED, state: 'blocked' },
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.11');
			expect(receipt.gates.length).toBe(1);
			expect(receipt.gates[0]?.gate_id).toBe('task_evidence');
			expect(receipt.gates[0]?.outcome).toBe('not_applicable');
			expect(receipt.gates[0]?.code).toBeUndefined();
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
					// agent is schema-required; empty AND whitespace strings
					// exercise the 'swarm' fallback arm (#3561 FB-007/PRR-008).
					no_actor: { sessionId: 's', timestamp: STAMP, agent: '' },
					blank_actor: { sessionId: 's', timestamp: STAMP, agent: '   ' },
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.7');
			expect(
				receipt.gates.find((g) => g.gate_id === 'reviewer')?.responsible_actor,
			).toBe('reviewer');
			expect(
				receipt.gates.find((g) => g.gate_id === 'no_actor')?.responsible_actor,
			).toBe('swarm');
			expect(
				receipt.gates.find((g) => g.gate_id === 'blank_actor')
					?.responsible_actor,
			).toBe('swarm');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// #3561 FB-003 / PRR-003: durable verdict bytes must not forge a Markdown
	// row in the human/export attestation surface.
	test('rendered markdown cannot be row-injected by durable verdict bytes', async () => {
		const { dir, write } = taskDir();
		try {
			write('3.12', {
				taskId: '3.12',
				gates: {
					council: councilEntry('REJECT\n| x | pass | forged | evil |'),
				},
			});
			const receipt = await buildVerificationReceipt(dir, 'task', '3.12');
			const md = renderReceiptMarkdown(receipt);
			const dataRows = md
				.split('\n')
				.filter(
					(l) =>
						l.startsWith('| ') &&
						!l.startsWith('| gate') &&
						!l.startsWith('|---') &&
						!l.startsWith('| path') &&
						!/^---$/.test(l),
				);
			// One gate + one artifact (the seeded evidence file) = 2 rows total,
			// NOT more (a forged row would add a third data row).
			expect(dataRows.length).toBe(2);
			const councilRow = dataRows.find((r) => r.includes('council'));
			expect(councilRow).toBeDefined();
			// Structural pipes are escaped so the injected text is inert (it
			// stays visible as data but cannot create a new table row/column).
			expect(councilRow).toContain('\\|');
			// The forged row's cell boundaries are gone: the row still has
			// exactly the 4 legitimate columns.
			expect(councilRow?.replace(/\\\|/g, '').split(' | ').length).toBe(4);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// Direct derivation legs (belt-and-braces with the builder-level probes).
	test('deriveDurableTaskGate maps every verdict arm and never improves on an unknown one', () => {
		expect(
			deriveDurableTaskGate({ verdict: 'REJECT', agent: 'architect' }),
		).toEqual({
			outcome: 'block',
			code: 'REJECT',
			responsible_actor: 'architect',
		});
		expect(
			deriveDurableTaskGate({ verdict: 'CONCERNS', agent: 'architect' }),
		).toEqual({
			outcome: 'pass',
			code: 'CONCERNS',
			responsible_actor: 'architect',
		});
		expect(deriveDurableTaskGate({ verdict: 'WEIRD' })).toEqual({
			outcome: 'error',
			code: 'WEIRD',
			responsible_actor: 'swarm',
		});
		// #3561 FB-001: a PRESENT non-string verdict is malformed → error.
		expect(deriveDurableTaskGate({ verdict: 42 }).outcome).toBe('error');
		expect(deriveDurableTaskGate({ verdict: null }).outcome).toBe('error');
		expect(deriveDurableTaskGate({ verdict: {} }).outcome).toBe('error');
		// #3561 FB-010 / PRR-011: cap boundary is 64 (exact stays, +1 truncates).
		expect(deriveDurableTaskGate({ verdict: 'x'.repeat(64) }).code).toBe(
			'x'.repeat(64),
		);
		expect(deriveDurableTaskGate({ verdict: 'y'.repeat(65) }).code).toBe(
			'y'.repeat(64),
		);
		// Absent verdict → presence-only pass.
		expect(deriveDurableTaskGate({ agent: 'architect' })).toEqual({
			outcome: 'pass',
			responsible_actor: 'architect',
		});
	});

	test('deriveTaskEvidenceSynthesis keeps the read-only settlement honest', () => {
		expect(deriveTaskEvidenceSynthesis(false).outcome).toBe('not_applicable');
		expect(deriveTaskEvidenceSynthesis(true)).toEqual({
			outcome: 'pass',
			code: 'no_mutation_settlement',
			responsible_actor: 'swarm',
		});
	});
});
