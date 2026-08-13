import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FIXED_EVIDENCE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function writeFixture(directory: string): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Docs Recovery',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Docs',
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
	const retroDir = path.join(directory, '.swarm', 'evidence', 'retro-1');
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			created_at: FIXED_EVIDENCE_TIMESTAMP,
			updated_at: FIXED_EVIDENCE_TIMESTAMP,
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: FIXED_EVIDENCE_TIMESTAMP,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Docs phase reviewed.',
					phase_number: 1,
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

describe('phase_complete docs participation recovery', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('phase-complete-docs-'));
		writeFixture(directory);
		resetSwarmState();
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetSwarmState();
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('rehydrates exact durable docs proof after in-memory session state is lost', async () => {
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
		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'new-parent' },
				directory,
				directory,
			),
		) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.agentsDispatched).toEqual(['docs']);
		expect(result.agentsMissing).toEqual([]);
		expect(result.warnings).toContain(
			'Recovered durable docs participation proof for phase 1.',
		);
	});

	test('missing docs proof fails closed with actionable configuration guidance', async () => {
		ensureAgentSession('parent');
		recordPhaseAgentDispatch('parent', 'docs');
		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'parent' },
				directory,
				directory,
			),
		) as {
			success: boolean;
			agentsMissing: string[];
			recovery_guidance: string;
		};

		expect(result.success).toBe(false);
		expect(result.agentsMissing).toEqual(['docs']);
		expect(result.recovery_guidance).toContain(
			'Dispatch the missing required role',
		);
		expect(result.recovery_guidance).toContain(
			'phase_complete.require_docs to false',
		);
		expect(result.recovery_guidance).toContain(
			'independent of the QA gate profile',
		);
	});

	test('plan-free required docs fail closed instead of trusting chat-start dispatch', async () => {
		fs.rmSync(path.join(directory, '.swarm', 'plan.json'));
		ensureAgentSession('parent');
		recordPhaseAgentDispatch('parent', 'docs');

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'parent' },
				directory,
				directory,
			),
		) as {
			success: boolean;
			agentsDispatched: string[];
			agentsMissing: string[];
			recovery_guidance: string;
		};

		expect(result.success).toBe(false);
		expect(result.agentsDispatched).toEqual([]);
		expect(result.agentsMissing).toEqual(['docs']);
		expect(result.recovery_guidance).toContain(
			'A readable plan is required to bind durable docs participation.',
		);
	});

	test('unreadable plan required docs fail closed with plan-recovery guidance', async () => {
		fs.writeFileSync(path.join(directory, '.swarm', 'plan.json'), '{bad json');
		ensureAgentSession('parent');
		recordPhaseAgentDispatch('parent', 'docs');

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'parent' },
				directory,
				directory,
			),
		) as {
			success: boolean;
			agentsDispatched: string[];
			agentsMissing: string[];
			recovery_guidance: string;
		};

		expect(result.success).toBe(false);
		expect(result.agentsDispatched).toEqual([]);
		expect(result.agentsMissing).toEqual(['docs']);
		expect(result.recovery_guidance).toContain(
			'.swarm/plan.json/.swarm/plan.md',
		);
	});
});
