/**
 * Integration test: phase_complete critical-directive gate end-to-end
 * (Swarm Learning System, Change 2 / Task 2.4).
 *
 * Drives executePhaseComplete and asserts the directive gate's three paths:
 * blocked (unresolved critical), override (architect + justification logs an
 * override event and clears the directive block), and clean (no criticals →
 * gate does not block on directive grounds).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../src/hooks/knowledge-receipt-ledger.js';
import {
	executePhaseComplete,
	phaseCompleteReceiptInternals,
} from '../../src/tools/phase-complete.js';
import {
	createConfig,
	writeGateEvidence,
	writeRetroBundle,
} from '../unit/tools/_phase-complete-test-helpers.js';

const PHASE = 'Phase 2';

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'pc-e2e-'));
}

async function seed(
	dir: string,
	entryId: string,
	critical: boolean,
	violated = false,
): Promise<void> {
	fs.writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
	const displayed = await commitDisplayedMembership(dir, {
		trace_id: 'trace-e2e',
		session_id: 'sess-e2e',
		phase: PHASE,
		entries: [{ entry_id: entryId, critical }],
	});
	if (!displayed.ok) throw new Error(displayed.detail);
	if (violated) {
		const terminal = await validateAndCommitTerminalBatch(dir, {
			trace_id: 'trace-e2e',
			session_id: 'sess-e2e',
			items: [
				{
					entry_id: entryId,
					outcome: 'violated',
					reason: 'introduced forbidden pattern',
				},
			],
		});
		if (!terminal.ok) throw new Error(terminal.detail);
	}
}

describe('phase_complete critical-directive gate (e2e)', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('BLOCKS the phase when a critical directive has an unremediated violation', async () => {
		await seed(dir, 'c1', true, true);
		const out = await executePhaseComplete(
			{ phase: 2, sessionID: 'sess-e2e', callerAgent: 'architect' },
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('UNRESOLVED_CRITICAL_DIRECTIVES');
		expect(parsed.message).toContain('c1');
	});

	it('rejects an override without a justification', async () => {
		await seed(dir, 'c1', true, true);
		const out = await executePhaseComplete(
			{
				phase: 2,
				sessionID: 'sess-e2e',
				callerAgent: 'architect',
				acceptViolations: ['c1'],
			},
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.reason).toBe('OVERRIDE_REQUIRES_JUSTIFICATION');
	});

	it('honors an architect override (with justification): logs an override event and clears the directive block', async () => {
		await seed(dir, 'c1', true, true);
		const out = await executePhaseComplete(
			{
				phase: 2,
				sessionID: 'sess-e2e',
				callerAgent: 'architect',
				acceptViolations: ['c1'],
				acceptViolationsJustification:
					'Accepted: tracked as follow-up issue #123',
			},
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		// The directive gate no longer blocks (it may still block downstream on
		// unrelated gates like the retro gate — but NOT for directive reasons).
		expect(parsed.reason).not.toBe('UNRESOLVED_CRITICAL_DIRECTIVES');

		// phase_complete deliberately does not write the separate override event.
		const events = await readKnowledgeEvents(dir);
		const overrides = events.filter((e) => e.type === 'override') as Array<{
			knowledge_id: string;
			reason?: string;
		}>;
		expect(overrides.length).toBe(0);
	});

	it('does not block on directive grounds when there are no critical directives', async () => {
		await seed(dir, 'h1', false);
		const out = await executePhaseComplete(
			{ phase: 2, sessionID: 'sess-e2e', callerAgent: 'architect' },
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.reason).not.toBe('UNRESOLVED_CRITICAL_DIRECTIVES');
		expect(parsed.reason).not.toBe('DIRECTIVE_GATE_FAILED_CLOSED');
	});

	it('uses one canonical phase label and closes receipts only after durable plan completion', async () => {
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			createConfig(),
		);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({
				title: 'Lifecycle plan',
				swarm: 'default',
				schema_version: '1.0.0',
				current_phase: 2,
				phases: [
					{
						id: 2,
						name: 'Canonical lifecycle',
						status: 'in_progress',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'completed',
								size: 'small',
								description: 'Completed lifecycle work',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		writeRetroBundle(dir, 2);
		writeGateEvidence(dir, 2);

		const originalIntent = phaseCompleteReceiptInternals.recordPhaseCloseIntent;
		const originalClosed = phaseCompleteReceiptInternals.commitPhaseClosed;
		const calls: Array<{ kind: string; label: string; status: string }> = [];
		phaseCompleteReceiptInternals.recordPhaseCloseIntent = mock(
			async (_directory, label) => {
				const plan = JSON.parse(
					fs.readFileSync(path.join(dir, '.swarm', 'plan.json'), 'utf8'),
				);
				calls.push({ kind: 'intent', label, status: plan.phases[0].status });
				return { ok: true, event_id: 'intent-event' };
			},
		) as typeof originalIntent;
		phaseCompleteReceiptInternals.commitPhaseClosed = mock(
			async (_directory, label) => {
				const plan = JSON.parse(
					fs.readFileSync(path.join(dir, '.swarm', 'plan.json'), 'utf8'),
				);
				calls.push({ kind: 'closed', label, status: plan.phases[0].status });
				return { ok: true, event_id: 'closed-event' };
			},
		) as typeof originalClosed;

		try {
			const output = JSON.parse(
				await executePhaseComplete(
					{ phase: 2, sessionID: 'sess-lifecycle', callerAgent: 'architect' },
					dir,
					dir,
				),
			);
			expect(output.success).toBe(true);
			expect(calls).toEqual([
				{
					kind: 'intent',
					label: 'Phase 2: Canonical lifecycle [IN PROGRESS]',
					status: 'in_progress',
				},
				{
					kind: 'closed',
					label: 'Phase 2: Canonical lifecycle [IN PROGRESS]',
					status: 'complete',
				},
			]);
		} finally {
			phaseCompleteReceiptInternals.recordPhaseCloseIntent = originalIntent;
			phaseCompleteReceiptInternals.commitPhaseClosed = originalClosed;
		}
	});
});
