import type { MutationReport, MutationResult } from './engine.js';

export type MutationGateVerdict = 'pass' | 'warn' | 'fail';

export interface MutationGateResult {
	verdict: MutationGateVerdict;
	killRate: number;
	adjustedKillRate: number;
	totalMutants: number;
	killed: number;
	survived: number;
	threshold: number;
	warnThreshold: number;
	message: string;
	/** Survived mutants that need test improvements */
	survivedMutants: MutationResult[];
	/** Prompt for targeted test improvement (non-empty when verdict is 'warn' or 'fail') */
	testImprovementPrompt: string;
}

export const _internals: {
	evaluateMutationGate: typeof evaluateMutationGate;
	buildTestImprovementPrompt: typeof buildTestImprovementPrompt;
	buildMessage: typeof buildMessage;
} = {
	evaluateMutationGate,
	buildTestImprovementPrompt,
	buildMessage,
} as const;

/** Default thresholds */
export const PASS_THRESHOLD = 0.8;
export const WARN_THRESHOLD = 0.6;

/**
 * Evaluate a mutation report against quality gate thresholds.
 * @param report - The mutation report to evaluate
 * @param passThreshold - Kill rate at or above this passes (default: 0.80)
 * @param warnThreshold - Kill rate at or above this warns (default: 0.60)
 * @returns MutationGateResult with verdict and details
 */
export function evaluateMutationGate(
	report: MutationReport,
	passThreshold: number = PASS_THRESHOLD,
	warnThreshold: number = WARN_THRESHOLD,
): MutationGateResult {
	if (passThreshold < warnThreshold) {
		throw new Error(
			`Invalid thresholds: passThreshold (${passThreshold}) must be >= warnThreshold (${warnThreshold})`,
		);
	}

	const adjustedKillRate = report.adjustedKillRate;
	const survivedMutants = report.results.filter(
		(result: MutationResult): boolean => result.outcome === 'survived',
	);

	let verdict: MutationGateVerdict;
	if (adjustedKillRate >= passThreshold) {
		verdict = 'pass';
	} else if (adjustedKillRate >= warnThreshold) {
		verdict = 'warn';
	} else {
		verdict = 'fail';
	}

	const testImprovementPrompt = _internals.buildTestImprovementPrompt(
		report,
		passThreshold,
		verdict,
	);

	const message = _internals.buildMessage(
		verdict,
		adjustedKillRate,
		report.killed,
		report.totalMutants,
		report.equivalent,
		warnThreshold,
	);

	return {
		verdict,
		killRate: report.killRate,
		adjustedKillRate,
		totalMutants: report.totalMutants,
		killed: report.killed,
		survived: report.survived,
		threshold: passThreshold,
		warnThreshold,
		message,
		survivedMutants,
		testImprovementPrompt,
	};
}

function buildTestImprovementPrompt(
	report: MutationReport,
	passThreshold: number,
	verdict: MutationGateVerdict,
): string {
	if (verdict === 'pass') {
		return '';
	}

	const lowKillRateFunctions: string[] = [];

	for (const [key, stats] of report.perFunction) {
		if (stats.killRate < passThreshold) {
			const lastColon = key.lastIndexOf(':');
			if (lastColon === -1) continue;
			const filePath = key.substring(0, lastColon);
			const functionName = key.substring(lastColon + 1);
			lowKillRateFunctions.push(
				`  - ${functionName} in ${filePath}: ${Math.round(stats.killRate * 100)}% kill rate (${stats.killed}/${stats.total} killed)`,
			);
		}
	}

	if (lowKillRateFunctions.length === 0) {
		return '';
	}

	return (
		'The following functions have low mutation kill rates and need stronger tests:\n' +
		lowKillRateFunctions.join('\n')
	);
}

function buildMessage(
	verdict: MutationGateVerdict,
	adjustedKillRate: number,
	killed: number,
	totalMutants: number,
	equivalent: number,
	warnThreshold: number,
): string {
	const killRatePercent = Math.round(adjustedKillRate * 100);
	const effectiveTotal = totalMutants - equivalent;

	switch (verdict) {
		case 'pass':
			return `Mutation gate PASSED: ${killRatePercent}% kill rate (${killed}/${effectiveTotal} mutants killed)`;
		case 'warn':
			return `Mutation gate WARNING: ${killRatePercent}% kill rate (${killed}/${effectiveTotal} mutants killed). Test improvement recommended.`;
		case 'fail':
			return `Mutation gate FAILED: ${killRatePercent}% kill rate (${killed}/${effectiveTotal} mutants killed). Below minimum threshold of ${Math.round(warnThreshold * 100)}%.`;
	}
}
