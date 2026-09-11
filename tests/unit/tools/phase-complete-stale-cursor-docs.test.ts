import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { resetSwarmState } from '../../../src/state';
import {
	executePhaseComplete,
	phaseCompleteReceiptInternals,
} from '../../../src/tools/phase-complete';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Tool-level acceptance check for the issue #2702 cursor-mistag fix
 * (fix contract points 1 and 3).
 *
 * The plan cursor (`current_phase: 1`) was authored once at plan creation and
 * never advanced, yet phase 3 is the phase being completed. The docs Task
 * dispatch stamps its durable receipt with the cursor value (1), so the
 * `required_agents` gate lookup for phase 3 misses it and phase_complete is
 * permanently blocked with REQUIRED_AGENTS_MISSING: docs.
 *
 * Modeled on tests/unit/tools/phase-complete-docs-participation-recovery.test.ts.
 */

const FIXED_EVIDENCE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function writeFixture(directory: string): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Stale Cursor Docs Gate',
		swarm: 'test',
		current_phase: 1,
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
						description: 'Foundation work',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Hardening',
				status: 'complete',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'completed',
						size: 'small',
						description: 'Hardening work',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 3,
				name: 'Ship',
				status: 'in_progress',
				tasks: [],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: [],
				require_docs: true,
				policy: 'enforce',
			},
			knowledge: { enabled: false },
			curator: { enabled: false },
			skill_improver: { enabled: false },
		}),
	);
	const retroDir = path.join(directory, '.swarm', 'evidence', 'retro-3');
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-3',
			created_at: FIXED_EVIDENCE_TIMESTAMP,
			updated_at: FIXED_EVIDENCE_TIMESTAMP,
			entries: [
				{
					task_id: 'retro-3',
					type: 'retrospective',
					timestamp: FIXED_EVIDENCE_TIMESTAMP,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 3 reviewed.',
					phase_number: 3,
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
		}),
	);
	return plan;
}

describe('phase_complete stale-cursor docs gate (issue #2702)', () => {
	let directory: string;
	let cleanup: () => void;
	let savedXdgConfigHome: string | undefined;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('phase-complete-stale-'));
		// Prevent the user's global opencode config from being merged into the
		// fixture — same rationale as the docs-participation-recovery fixture.
		savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = directory;
		writeFixture(directory);
		resetSwarmState();
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetSwarmState();
		resetPhaseParticipationForTests();
		if (savedXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
		}
		cleanup();
	});

	test('cursor-mistagged docs receipt unblocks phase 3 and is normalized to it', async () => {
		// Real docs dispatch: the receipt is stamped with the plan cursor (1),
		// not the phase being completed (3).
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'old-parent',
			callId: 'docs-call',
			args: { subagent_type: 'docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'old-parent',
			callId: 'docs-call',
			output: {
				output: 'Documentation was checked and updated.',
				metadata: { status: 'completed', sessionId: 'docs-child' },
			},
		});
		const storeBefore = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
				'utf8',
			),
		) as { receipts: Array<{ role: string; phase: number }> };
		expect(storeBefore.receipts).toHaveLength(1);
		expect(storeBefore.receipts[0]?.role).toBe('docs');
		expect(storeBefore.receipts[0]?.phase).toBe(1);

		// Simulate a fresh process: in-memory session and reservation state gone.
		resetSwarmState();
		resetPhaseParticipationForTests();
		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 3, sessionID: 'fresh-parent' },
				directory,
				directory,
			),
		) as {
			success: boolean;
			agentsMissing?: string[];
			[key: string]: unknown;
		};

		expect(result.success).toBe(true);
		expect(result.agentsMissing ?? []).not.toContain('docs');

		// Fix contract point 3: the success path normalizes the durable store —
		// the cursor-mistagged docs receipt ends up re-stamped to phase 3.
		const storeAfter = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
				'utf8',
			),
		) as { receipts: Array<{ role: string; phase: number }> };
		const docsPhases = storeAfter.receipts
			.filter((receipt) => receipt.role === 'docs')
			.map((receipt) => receipt.phase);
		expect(docsPhases).toEqual([3]);
	});

	// Critic-required pin: the success-path normalization is best-effort. A
	// rebind failure must surface as a warning, never fail an already-committed
	// completion. Overrides the receipt seam so the rebind rejects.
	test('normalization failure degrades to a warning instead of failing the completion', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'old-parent',
			callId: 'docs-call',
			args: { subagent_type: 'docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'old-parent',
			callId: 'docs-call',
			output: {
				output: 'Documentation was checked and updated.',
				metadata: { status: 'completed', sessionId: 'docs-child' },
			},
		});
		resetSwarmState();
		resetPhaseParticipationForTests();

		const originalRebind =
			phaseCompleteReceiptInternals.rebindCursorTaggedReceipts;
		phaseCompleteReceiptInternals.rebindCursorTaggedReceipts = async () => {
			throw new Error('simulated normalization outage');
		};
		try {
			const result = JSON.parse(
				await executePhaseComplete(
					{ phase: 3, sessionID: 'fresh-parent' },
					directory,
					directory,
				),
			) as { success: boolean; warnings: unknown[] };

			expect(result.success).toBe(true);
			expect(
				result.warnings.some(
					(warning) =>
						typeof warning === 'string' &&
						warning.includes('receipt normalization failed') &&
						warning.includes('simulated normalization outage'),
				),
			).toBe(true);
		} finally {
			phaseCompleteReceiptInternals.rebindCursorTaggedReceipts = originalRebind;
		}
	});
});
