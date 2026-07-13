import { computeGateStatistics } from '../evaluation/gate-stats.js';

export async function handleGateStatsCommand(
	directory: string,
	args: string[],
): Promise<string> {
	let json = false;
	let minSamples = 6;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === '--json') json = true;
		else if (args[index] === '--min-samples') {
			const value = args[index + 1];
			if (!value || !/^\d+$/.test(value)) {
				throw new Error('--min-samples requires a positive integer');
			}
			minSamples = Number(value);
			index++;
		} else throw new Error(`Unknown gate-stats argument: ${args[index]}`);
	}
	const report = await computeGateStatistics(directory, minSamples);
	if (json) return JSON.stringify(report, null, 2);
	const lines = [
		'## Gate Statistics',
		'',
		`- Valid runs: ${report.runs}`,
		`- Corrupt runs preserved: ${report.corruptRuns.length}`,
		`- Ground truth parsed/malformed/ambiguous/unjoined: ${report.groundTruth.parsed}/${report.groundTruth.malformed}/${report.groundTruth.ambiguous}/${report.groundTruth.unjoined}`,
		`- Reviewer genuine/fallback/data-quality: ${report.reviewerTelemetry.genuine}/${report.reviewerTelemetry.fallback}/${report.reviewerTelemetry.dataQuality}`,
		`- Reviewer fallback:genuine ratio: ${report.reviewerTelemetry.fallbackToGenuineRatio ?? 'insufficient-data'}`,
		'',
		'| Model | Gate | Catch rate | 95% CI | False-reject rate | Clean controls | Retries | Cost | Status |',
		'| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |',
	];
	for (const stat of report.models) {
		lines.push(
			`| ${stat.model} | ${stat.gate} | ${stat.catchRate === null ? 'n/a' : `${(stat.catchRate * 100).toFixed(1)}%`} | ${stat.confidenceInterval ? `${(stat.confidenceInterval[0] * 100).toFixed(1)}-${(stat.confidenceInterval[1] * 100).toFixed(1)}%` : 'n/a'} | ${stat.falseRejectionRate === null ? 'n/a' : `${(stat.falseRejectionRate * 100).toFixed(1)}%`} | ${stat.negativeControls} | ${stat.retries.total} | ${stat.cost.unavailable > 0 ? `unavailable (${stat.cost.unavailable})` : `$${stat.cost.usd.toFixed(4)}`} | ${stat.insufficientData ? 'insufficient-data' : 'sufficient'} |`,
		);
	}
	return lines.join('\n');
}
