/**
 * Markdown + JSON rendering for `swarm ci` (issue #2497).
 *
 * Output contract (frozen checks C2/C4):
 *  - default output: a Markdown report with per-gate/per-task tables plus a
 *    fenced machine block — `[SWARM_CI_JSON]` … `[/SWARM_CI_JSON]` — holding
 *    the pretty-printed report JSON (mirrors the `[BENCHMARK_JSON]`
 *    precedent);
 *  - `--json`: the machine block only.
 *
 * Diagnostics embed bounded, lossy-safe excerpts: evidence paths are ASCII,
 * and any corrupt-evidence excerpt passes through Node's UTF-8 replacement
 * decoding, so unparseable bytes degrade to U+FFFD rather than throwing.
 */

import type { AdvisoryCiReport } from './evaluate.js';

export const SWARM_CI_JSON_OPEN = '[SWARM_CI_JSON]';
export const SWARM_CI_JSON_CLOSE = '[/SWARM_CI_JSON]';

const STATUS_ICONS: Record<string, string> = {
	pass: '✅',
	fail: '❌',
	no_data: '⚪',
	corrupt: '🧨',
	error: '💥',
};

export function renderJsonBlock(report: AdvisoryCiReport): string {
	return [
		SWARM_CI_JSON_OPEN,
		JSON.stringify(report, null, 2),
		SWARM_CI_JSON_CLOSE,
	].join('\n');
}

export function renderMarkdownReport(report: AdvisoryCiReport): string {
	const lines: string[] = [
		'## Swarm CI Advisory Report',
		'',
		`Verdict: ${report.verdict === 'pass' ? '✅ PASS' : '❌ FAIL'} (exit_reason: ${report.exit_reason})`,
		`Environment: mode=${report.environment.mode} tty=${report.environment.tty} host=${report.environment.host} gate_profile=${report.gate_profile}`,
		'',
		'### Gates',
		'',
		'| Gate | Status | Detail |',
		'|------|--------|--------|',
	];
	for (const gate of report.gates) {
		const icon = STATUS_ICONS[gate.status] ?? '';
		const detail = (gate.detail ?? '').replace(/\|/g, '\\|');
		lines.push(`| ${gate.name} | ${icon} ${gate.status} | ${detail} |`);
	}

	if (report.tasks.length > 0) {
		lines.push('', '### Tasks', '');
		lines.push(
			'| Task | Evidence state | Required gates | Missing gates | Workflow | Satisfied |',
			'|------|----------------|----------------|---------------|----------|-----------|',
		);
		for (const task of report.tasks) {
			lines.push(
				`| ${task.task_id} | ${task.evidence_state} | ${task.required_gates.join(', ') || '-'} | ${task.missing_gates.join(', ') || '-'} | ${task.workflow_state ?? '-'} | ${task.satisfied ? '✅' : '❌'} |`,
			);
		}
	}

	if (report.not_evaluated.length > 0) {
		lines.push(
			'',
			'### Enabled gates not evaluated (reported, never passed)',
			'',
		);
		for (const item of report.not_evaluated) {
			lines.push(`- ${item.name}: ${item.reason}`);
		}
	}
	if (report.not_evaluable.length > 0) {
		lines.push('', '### Not evaluable headless', '');
		for (const item of report.not_evaluable) {
			lines.push(`- ${item.name}: ${item.reason}`);
		}
	}

	lines.push(
		'',
		`Counts: ${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.no_data} no_data, ${report.counts.corrupt} corrupt, ${report.counts.error} error`,
		'',
		'Advisory read-only evaluation: this run cannot satisfy, bypass, or modify any gate.',
	);
	return lines.join('\n');
}

/** Full default output: Markdown report + machine block. */
export function renderFullReport(report: AdvisoryCiReport): string {
	return `${renderMarkdownReport(report)}\n${renderJsonBlock(report)}`;
}
