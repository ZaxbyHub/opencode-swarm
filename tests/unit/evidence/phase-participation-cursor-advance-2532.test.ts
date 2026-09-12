import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { updateTaskStatus } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2532 sequential-flow regression (PRR-001): docs participation
 * receipts must stay verifiable after the live cursor advance.
 *
 * Production sequence: docs is dispatched mid-phase N (the receipt stamps
 * the cursor at dispatch = N and a plan-structure hash), phase N's last
 * task completes (savePlan advances current_phase to N+1 BEFORE phase_complete
 * can run), and only then does phase_complete(N) read the receipt. Before the
 * receiptStructureHash fix, the cursor advance rotated computePlanStructureHash
 * (it includes current_phase), so samePlanIdentity rejected the receipt and
 * phase_complete(N) deadlocked with REQUIRED_AGENTS_MISSING under the default
 * require_docs=true / policy=enforce config — with no recovery (re-dispatch
 * stamps the now-current phase; the mistag tolerance arm only accepts a tag
 * BEHIND the completing phase).
 *
 * Property under test: cursor movement alone never invalidates a docs
 * receipt; a real structural plan edit still does (anti-gaming), and a
 * receipt for phase N never satisfies phase N+1 (per-phase enforcement).
 */

function planAtPhase2Active(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Sequential Docs Plan',
		swarm: 'test',
		current_phase: 2,
		phases: [
			{
				id: 1,
				name: 'Foundation',
				status: 'complete',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Foundation task',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Build',
				status: 'in_progress',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'completed',
						size: 'small',
						description: 'Build task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '2.2',
						phase: 2,
						status: 'in_progress',
						size: 'small',
						description: 'Build task two',
						depends: ['2.1'],
						files_touched: [],
					},
				],
			},
			{
				id: 3,
				name: 'Wrap',
				status: 'pending',
				tasks: [
					{
						id: '3.1',
						phase: 3,
						status: 'pending',
						size: 'small',
						description: 'Wrap task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function writePlan(directory: string, plan: Plan): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function readPlan(directory: string): Plan {
	return JSON.parse(
		fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
	) as Plan;
}

describe('docs receipts survive the live cursor advance (#2532 / PRR-001)', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('pp-cursor-advance-2532-');
		resetPhaseParticipationForTests();
		writePlan(directory, planAtPhase2Active());
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function dispatchDocs(callId: string): Promise<void> {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId,
			args: { subagent_type: 'docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId,
			output: {
				output: 'Documentation was checked and updated.',
				metadata: { status: 'completed', sessionId: 'docs-child' },
			},
		});
	}

	test('receipt stamped mid-phase 2 satisfies phase 2 after the cursor advances to 3', async () => {
		// Docs dispatched while phase 2 is active (cursor 2).
		await dispatchDocs('docs-call-2');

		// The phase's LAST task completes through the registered path —
		// savePlan advances the cursor to 3 before phase_complete can run.
		await updateTaskStatus(directory, '2.2', 'completed');
		const advanced = readPlan(directory);
		expect(advanced.current_phase).toBe(3);

		// phase_complete(2)'s gate read: the receipt must still verify.
		const gateRead = await readPhaseParticipation(
			directory,
			advanced,
			2,
			'docs',
		);
		expect(gateRead.status).toBe('valid');
		expect(gateRead.found).toBe(true);
	});

	test('a phase-2 receipt never satisfies phase 3 (per-phase enforcement)', async () => {
		await dispatchDocs('docs-call-2');
		await updateTaskStatus(directory, '2.2', 'completed');
		const advanced = readPlan(directory);

		const nextPhaseRead = await readPhaseParticipation(
			directory,
			advanced,
			3,
			'docs',
		);
		expect(nextPhaseRead.status).toBe('valid');
		expect(nextPhaseRead.found).toBe(false);
	});

	test('a structural plan edit still invalidates the receipt (anti-gaming)', async () => {
		await dispatchDocs('docs-call-2');
		await updateTaskStatus(directory, '2.2', 'completed');
		const plan = readPlan(directory);

		// Revise plan content (not just the cursor): a real edit must force
		// docs re-dispatch.
		plan.phases[1].name = 'Build (revised)';
		writePlan(directory, plan);

		const afterEdit = await readPhaseParticipation(directory, plan, 2, 'docs');
		expect(afterEdit.status).toBe('valid');
		expect(afterEdit.found).toBe(false);
	});
});
