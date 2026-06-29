import {
	type CostSummary,
	summarizeTelemetryCosts,
} from '../services/cost-accounting.js';

export async function handleCostsCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const summary = summarizeTelemetryCosts(directory);
	const json = args.includes('--json');
	if (json) {
		return [
			'[COSTS_JSON]',
			JSON.stringify(summary, null, 2),
			'[/COSTS_JSON]',
		].join('\n');
	}
	return renderCostSummary(summary);
}

export function renderCostSummary(summary: CostSummary): string {
	const lines: string[] = [
		'## Swarm Costs',
		'',
		`Total tracked cost: ${formatUsd(summary.total_cost_usd)}`,
		`Delegations: ${summary.delegations}`,
		`Tokens: input ${summary.total_input_tokens.toLocaleString()}, output ${summary.total_output_tokens.toLocaleString()}, reasoning ${summary.total_reasoning_tokens.toLocaleString()}, cache ${summary.total_cache_tokens.toLocaleString()}`,
		`Cost source: reported ${formatUsd(summary.total_reported_usd)}, estimated ${formatUsd(summary.total_estimated_usd)}, unavailable ${summary.unavailable_delegations}`,
		'',
		'### By Agent',
	];

	appendCostRows(
		lines,
		'Agent',
		summary.by_agent,
		'No delegation cost telemetry recorded.',
	);

	lines.push('', '### By Task');
	appendCostRows(
		lines,
		'Task',
		summary.by_task,
		'No task cost telemetry recorded.',
	);

	lines.push('', '### By Gate');
	appendCostRows(
		lines,
		'Gate',
		summary.by_gate,
		'No gate cost telemetry recorded.',
	);

	lines.push('', '### By Retry Loop');
	appendCostRows(
		lines,
		'Retry',
		summary.by_retry,
		'No retry-loop cost telemetry recorded.',
	);

	return lines.join('\n');
}

function appendCostRows(
	lines: string[],
	label: string,
	rows: CostSummary['by_agent'],
	emptyMessage: string,
): void {
	if (rows.length === 0) {
		lines.push(emptyMessage);
		return;
	}
	lines.push(
		`| ${label} | Delegations | Cost | Input | Output | Reasoning | Cache | Unavailable |`,
		'|------|-------------|------|-------|--------|-----------|-------|-------------|',
	);
	for (const row of rows) {
		lines.push(
			`| ${row.name} | ${row.delegations} | ${formatUsd(row.cost_usd)} | ${row.input_tokens.toLocaleString()} | ${row.output_tokens.toLocaleString()} | ${row.reasoning_tokens.toLocaleString()} | ${row.cache_tokens.toLocaleString()} | ${row.unavailable_delegations} |`,
		);
	}
}

export function formatUsd(value: number): string {
	return `$${value.toFixed(6)}`;
}
