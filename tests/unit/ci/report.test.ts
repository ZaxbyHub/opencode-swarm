/**
 * Advisory-CI report rendering tests (issue #2497).
 *
 * Pins the output contract: [SWARM_CI_JSON] marker pair, parseable
 * pretty-printed JSON, Markdown per-gate/per-task tables, the exact
 * environment block, and the --json (block-only) shape.
 */

import { describe, expect, test } from 'bun:test';
import type { AdvisoryCiReport } from '../../../src/ci/evaluate.js';
import {
	renderFullReport,
	renderJsonBlock,
	renderMarkdownReport,
	SWARM_CI_JSON_CLOSE,
	SWARM_CI_JSON_OPEN,
} from '../../../src/ci/report.js';

function sampleReport(): AdvisoryCiReport {
	return {
		version: 1,
		verdict: 'fail',
		exit_reason: 'gate_violations',
		gates: [
			{ name: 'plan', status: 'pass' },
			{ name: 'plan_critic', status: 'pass' },
			{
				name: 'task 1.1 gates',
				status: 'pass',
				detail: 'all required gates satisfied',
			},
			{
				name: 'task 2.1 gates',
				status: 'no_data',
				detail: 'no durable task-gate evidence recorded',
			},
			{
				name: 'task 3.1 gates',
				status: 'corrupt',
				detail: 'unparseable evidence',
			},
			{ name: 'review_pass_rate', status: 'pass', detail: 'value 100 >= 70%' },
		],
		tasks: [
			{
				task_id: '1.1',
				evidence_state: 'valid',
				required_gates: ['reviewer', 'test_engineer'],
				missing_gates: [],
				workflow_state: 'complete',
				satisfied: true,
			},
			{
				task_id: '2.1',
				evidence_state: 'missing',
				required_gates: ['reviewer', 'test_engineer'],
				missing_gates: ['reviewer', 'test_engineer'],
				satisfied: false,
			},
			{
				task_id: '3.1',
				evidence_state: 'corrupt',
				required_gates: ['reviewer', 'test_engineer'],
				missing_gates: ['reviewer', 'test_engineer'],
				satisfied: false,
			},
		],
		plan: {
			present: true,
			title: 'CI Advisory Fixture',
			swarm: 'local',
			task_count: 3,
		},
		environment: { mode: 'advisory', tty: false, host: 'none' },
		gate_profile: 'default',
		effective_gates: {
			reviewer: true,
			test_engineer: true,
			council_mode: false,
			sme_enabled: true,
			critic_pre_plan: true,
			hallucination_guard: false,
			sast_enabled: true,
			mutation_test: false,
			phase_council: false,
			drift_check: true,
			final_council: false,
		},
		not_evaluated: [
			{
				name: 'drift_check',
				reason: 'enforced inline by the write-drift-evidence flow',
			},
		],
		not_evaluable: [
			{ name: 'agent_error_rate', reason: 'requires live plugin state' },
		],
		counts: { pass: 3, fail: 0, no_data: 1, corrupt: 1, error: 0 },
	};
}

describe('swarm ci report rendering', () => {
	test('JSON block uses the exact marker pair and parses back to the report', () => {
		const block = renderJsonBlock(sampleReport());
		expect(block.startsWith(SWARM_CI_JSON_OPEN)).toBe(true);
		expect(block.endsWith(SWARM_CI_JSON_CLOSE)).toBe(true);
		const lines = block.split('\n');
		expect(lines[0]).toBe('[SWARM_CI_JSON]');
		expect(lines[lines.length - 1]).toBe('[/SWARM_CI_JSON]');
		const jsonText = lines.slice(1, -1).join('\n');
		const parsed = JSON.parse(jsonText) as AdvisoryCiReport;
		expect(parsed.verdict).toBe('fail');
		expect(parsed.exit_reason).toBe('gate_violations');
		expect(parsed.gates.length).toBe(6);
		// Pretty-printed (2-space indent) like the [BENCHMARK_JSON] precedent.
		expect(jsonText).toContain('\n  "version": 1,');
	});

	test('Markdown report has per-gate and per-task tables and the environment line', () => {
		const md = renderMarkdownReport(sampleReport());
		expect(md).toContain('## Swarm CI Advisory Report');
		expect(md).toContain('| Gate | Status | Detail |');
		expect(md).toContain(
			'| Task | Evidence state | Required gates | Missing gates | Workflow | Satisfied |',
		);
		expect(md).toContain('| plan | ✅ pass |');
		expect(md).toContain('| task 2.1 gates | ⚪ no_data |');
		expect(md).toContain('| 1.1 | valid |');
		expect(md).toContain('mode=advisory tty=false host=none');
		expect(md).toContain('Advisory read-only evaluation');
		// Not-evaluable / not-evaluated surfaces are reported, never hidden.
		expect(md).toContain('agent_error_rate');
		expect(md).toContain('drift_check');
	});

	test('full report = markdown + machine block, with the block last', () => {
		const full = renderFullReport(sampleReport());
		const open = full.indexOf(SWARM_CI_JSON_OPEN);
		const close = full.indexOf(SWARM_CI_JSON_CLOSE);
		expect(open).toBeGreaterThan(0);
		expect(close).toBeGreaterThan(open);
		expect(full.slice(0, open)).toContain('## Swarm CI Advisory Report');
	});

	test('gate detail pipes are escaped in the Markdown table', () => {
		const report = sampleReport();
		report.gates.push({
			name: 'weird',
			status: 'fail',
			detail: 'a | b | c',
		});
		const md = renderMarkdownReport(report);
		expect(md).toContain('a \\| b \\| c');
		expect(md).not.toContain('a | b | c');
	});

	test('newlines in plan-controlled cells cannot break the table structure (PRR-009)', () => {
		// Gate names, task ids, and reasons originate from repo-controlled
		// plan.json strings; a raw newline would forge extra table rows when
		// the report is posted as a PR comment.
		const report = sampleReport();
		report.gates[0].name = 'evil\ngate | injected';
		report.gates[2].detail = 'ok\n| forged | row |';
		report.tasks[0].task_id = '1.1\n| hack |';
		report.not_evaluated[0].reason = 'reason\n- forged bullet';
		const md = renderMarkdownReport(report);
		// Every table row is a single line: the injected newlines are gone.
		expect(md).not.toContain('evil\ngate');
		expect(md).not.toContain('ok\n| forged');
		expect(md).not.toContain('1.1\n| hack');
		expect(md).not.toContain('reason\n- forged');
		// The cell content survives, flattened and pipe-escaped.
		expect(md).toContain('evil gate \\| injected');
		expect(md).toContain('ok \\| forged \\| row \\|');
		expect(md).toContain('1.1 \\| hack \\|');
	});
});
