import { describe, expect, test } from 'bun:test';
import {
	collectPhaseGateReport,
	formatPhaseGateCompatibility,
	type PhaseGateCheck,
} from '../../../src/tools/phase-complete/preflight-report';
import { TOOL_NAME_SET } from '../../../src/tools/tool-names';

function check(
	id: string,
	run: PhaseGateCheck['run'],
	applicable = true,
): PhaseGateCheck {
	return { id, responsibleActor: 'architect', applicable, run };
}

describe('phase_complete structured preflight report', () => {
	test('collects every blocker and error in deterministic order', async () => {
		const report = await collectPhaseGateReport({
			phase: 3,
			checks: [
				check('completion_verify', async () => ({
					blocked: true,
					reason: 'COMPLETION_MISSING',
					message: 'completion evidence missing',
					agentsDispatched: ['coder'],
					agentsMissing: ['reviewer'],
					warnings: [],
				})),
				check('drift', async () => {
					throw new Error(`unreadable ${'x'.repeat(5_000)}`);
				}),
				check(
					'turbo_skipped',
					async () => {
						throw new Error('must not execute');
					},
					false,
				),
				check('final_review', async () => ({
					blocked: true,
					reason: 'FINAL_REVIEW_REQUIRED',
					message: 'run phase review',
					agentsDispatched: ['reviewer'],
					agentsMissing: [],
					warnings: ['review warning'],
					recovery: {
						kind: 'tool',
						action: 'run_phase_review',
					},
				})),
			],
		});

		expect(report.schemaVersion).toBe(1);
		expect(report.outcome).toBe('block');
		expect(report.entries.map((entry) => entry.id)).toEqual([
			'completion_verify',
			'drift',
			'turbo_skipped',
			'final_review',
		]);
		expect(report.entries.map((entry) => entry.outcome)).toEqual([
			'block',
			'error',
			'not_applicable',
			'block',
		]);
		expect(report.entries[1].detail?.length).toBeLessThanOrEqual(1024);
		expect(report.entries[3].recovery?.action).toBe('run_phase_review');
	});

	test('compatibility formatter preserves legacy top-level fields', async () => {
		const report = await collectPhaseGateReport({
			phase: 2,
			checks: [
				check('retro', async () => ({
					blocked: true,
					reason: 'RETROSPECTIVE_FAILED',
					message: 'retro verdict failed',
					agentsDispatched: ['architect'],
					agentsMissing: ['docs'],
					warnings: ['truthful failure'],
					phase_council_required: true,
					final_council_required: true,
				})),
			],
		});
		const compat = formatPhaseGateCompatibility(report);

		expect(compat.success).toBe(false);
		expect(compat.status).toBe('blocked');
		expect(compat.reason).toBe('RETROSPECTIVE_FAILED');
		expect(compat.message).toBe('retro verdict failed');
		expect(compat.agentsDispatched).toEqual(['architect']);
		expect(compat.agentsMissing).toEqual(['docs']);
		expect(compat.warnings).toEqual(['truthful failure']);
		expect(compat.phase_council_required).toBe(true);
		expect(compat.final_council_required).toBe(true);
		expect(compat.gate_report).toBe(report);
	});

	test('reports pass when every applicable gate passes', async () => {
		const report = await collectPhaseGateReport({
			phase: 1,
			checks: [
				check('one', async () => ({
					blocked: false,
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				})),
			],
		});

		expect(report.outcome).toBe('pass');
		expect(report.entries[0].outcome).toBe('pass');
	});

	test('bounds a stalled gate and continues collecting later results', async () => {
		const report = await collectPhaseGateReport({
			phase: 4,
			checks: [
				{
					...check('stalled', () => new Promise(() => undefined)),
					timeoutMs: 5,
				},
				check('later', async () => ({
					blocked: true,
					reason: 'LATER_BLOCKED',
					message: 'later gate still ran',
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				})),
			],
		});

		expect(report.entries.map((entry) => entry.code)).toEqual([
			'STALLED_TIMEOUT',
			'LATER_BLOCKED',
		]);
		expect(report.entries.map((entry) => entry.outcome)).toEqual([
			'error',
			'block',
		]);
	});

	test('every advertised recovery resolves to a registered tool or host Task action', async () => {
		const gateIds = [
			'critical_directives',
			'retrospective',
			'completion_verify',
			'drift',
			'hallucination',
			'mutation',
			'phase_council',
			'architecture_supervisor',
			'final_review',
			'final_council',
			'full_auto_approval',
			'lean_turbo_readiness',
			'required_agents',
			'snapshot_identity',
		];
		const report = await collectPhaseGateReport({
			phase: 5,
			checks: gateIds.map((id) =>
				check(id, async () => ({
					blocked: true,
					reason: `${id.toUpperCase()}_BLOCKED`,
					agentsDispatched: [],
					agentsMissing: id === 'required_agents' ? ['docs'] : [],
					warnings: [],
				})),
			),
		});

		for (const entry of report.entries) {
			expect(entry.recovery).toBeDefined();
			const action = entry.recovery?.action ?? '';
			expect(action === 'Task' || TOOL_NAME_SET.has(action as never)).toBe(
				true,
			);
		}
	});
});
