import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateAuditCellV1, GateName } from './contracts.js';
import {
	type GateGroundTruthV1,
	gateGroundTruthJoinKey,
	readGateGroundTruth,
} from './gate-ground-truth.js';
import { listGateAuditResults } from './store.js';

export type GateModelStatistics = {
	model: string;
	gate: GateName;
	total: number;
	caught: number;
	missed: number;
	falseRejections: number;
	negativeControls: number;
	infrastructureFailures: number;
	unsupported: number;
	catchRate: number | null;
	confidenceInterval: [number, number] | null;
	falseRejectionRate: number | null;
	falseRejectionConfidenceInterval: [number, number] | null;
	insufficientData: boolean;
	retries: { total: number; maximum: number };
	cost: { usd: number; unavailable: number };
};

export type ReviewerTelemetryStatistics = {
	parsed: number;
	skipped: number;
	genuine: number;
	fallback: number;
	dataQuality: number;
	blocked: number;
	fallbackToGenuineRatio: number | null;
};

export type GateStatisticsReport = {
	runs: number;
	corruptRuns: string[];
	groundTruth: {
		parsed: number;
		malformed: number;
		ambiguous: number;
		unjoined: number;
	};
	models: GateModelStatistics[];
	reviewerTelemetry: ReviewerTelemetryStatistics;
};

function wilson95(successes: number, total: number): [number, number] | null {
	if (total === 0) return null;
	const z = 1.959963984540054;
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const center = (p + (z * z) / (2 * total)) / denominator;
	const margin =
		(z / denominator) *
		Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function telemetryStats(directory: string): ReviewerTelemetryStatistics {
	const summary: ReviewerTelemetryStatistics = {
		parsed: 0,
		skipped: 0,
		genuine: 0,
		fallback: 0,
		dataQuality: 0,
		blocked: 0,
		fallbackToGenuineRatio: null,
	};
	for (const filename of ['telemetry.jsonl.1', 'telemetry.jsonl']) {
		let content = '';
		try {
			content = fs.readFileSync(
				path.join(directory, '.swarm', filename),
				'utf8',
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') summary.skipped++;
			continue;
		}
		for (const line of content.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let event: Record<string, unknown>;
			try {
				const value = JSON.parse(line) as unknown;
				if (!value || typeof value !== 'object' || Array.isArray(value)) {
					throw new Error('not an object');
				}
				event = value as Record<string, unknown>;
			} catch {
				summary.skipped++;
				continue;
			}
			if (event.event !== 'reviewer_gate_decision') continue;
			const kind = event.evidenceKind;
			if (
				!['genuine', 'fallback', 'data_quality', 'block'].includes(String(kind))
			) {
				summary.skipped++;
				continue;
			}
			summary.parsed++;
			if (kind === 'genuine') summary.genuine++;
			else if (kind === 'fallback') summary.fallback++;
			else if (kind === 'data_quality') summary.dataQuality++;
			else summary.blocked++;
		}
	}
	summary.fallbackToGenuineRatio =
		summary.genuine === 0 ? null : summary.fallback / summary.genuine;
	return summary;
}

type AuditedCell = { runId: string; cell: GateAuditCellV1 };

function summarizeCells(
	cells: AuditedCell[],
	truthByKey: Map<string, GateGroundTruthV1[]>,
	minSamples: number,
): {
	models: GateModelStatistics[];
	ambiguous: number;
	unjoined: number;
} {
	const groups = new Map<string, AuditedCell[]>();
	for (const audited of cells) {
		const key = `${audited.cell.model}\u0000${audited.cell.gate}`;
		const group = groups.get(key) ?? [];
		group.push(audited);
		groups.set(key, group);
	}
	let ambiguous = 0;
	let unjoined = 0;
	const models = [...groups.values()]
		.map((group) => {
			const first = group[0].cell;
			const joined: Array<{ cell: GateAuditCellV1; truth: GateGroundTruthV1 }> =
				[];
			for (const audited of group) {
				if (!audited.cell.candidateId) {
					unjoined++;
					continue;
				}
				const matches =
					truthByKey.get(
						gateGroundTruthJoinKey({
							runId: audited.runId,
							taskId: audited.cell.taskId,
							candidateId: audited.cell.candidateId,
							model: audited.cell.model,
							gate: audited.cell.gate,
							repetition: audited.cell.repetition,
						}),
					) ?? [];
				if (matches.length === 0) {
					unjoined++;
					continue;
				}
				const classifications = new Set(
					matches.map((match) => match.classification),
				);
				if (classifications.size !== 1) {
					ambiguous++;
					continue;
				}
				joined.push({
					cell: audited.cell,
					truth:
						matches.find((match) => match.source === 'test-impact') ??
						matches[0],
				});
			}
			const regressionCells = joined.filter(
				(entry) => entry.truth.classification === 'new_regression',
			);
			const caught = regressionCells.filter(
				(entry) => entry.cell.outcome === 'caught',
			).length;
			const missed = regressionCells.filter(
				(entry) => entry.cell.outcome === 'missed',
			).length;
			const denominator = caught + missed;
			const cleanCells = joined.filter(
				(entry) => entry.truth.classification === 'clean',
			);
			const falseRejections = cleanCells.filter(
				(entry) =>
					entry.cell.outcome === 'caught' ||
					entry.cell.outcome === 'false_rejection',
			).length;
			const negativeControls = cleanCells.filter((entry) =>
				['caught', 'missed', 'false_rejection'].includes(entry.cell.outcome),
			).length;
			const knownCosts = group.filter(
				(entry) => entry.cell.cost.source !== 'unavailable',
			);
			return {
				model: first.model,
				gate: first.gate,
				total: group.length,
				caught,
				missed,
				falseRejections,
				negativeControls,
				infrastructureFailures: group.filter(
					(entry) => entry.cell.outcome === 'infrastructure_failure',
				).length,
				unsupported: group.filter(
					(entry) => entry.cell.outcome === 'unsupported',
				).length,
				catchRate: denominator === 0 ? null : caught / denominator,
				confidenceInterval: wilson95(caught, denominator),
				falseRejectionRate:
					negativeControls === 0 ? null : falseRejections / negativeControls,
				falseRejectionConfidenceInterval: wilson95(
					falseRejections,
					negativeControls,
				),
				insufficientData:
					denominator < minSamples || negativeControls < minSamples,
				retries: {
					total: group.reduce((sum, entry) => sum + entry.cell.retries, 0),
					maximum: Math.max(0, ...group.map((entry) => entry.cell.retries)),
				},
				cost: {
					usd: knownCosts.reduce(
						(sum, entry) => sum + (entry.cell.cost.usd ?? 0),
						0,
					),
					unavailable: group.length - knownCosts.length,
				},
			};
		})
		.sort((left, right) =>
			`${left.model}\u0000${left.gate}`.localeCompare(
				`${right.model}\u0000${right.gate}`,
			),
		);
	return { models, ambiguous, unjoined };
}

export async function computeGateStatistics(
	directory: string,
	minSamples = 6,
	runId?: string,
): Promise<GateStatisticsReport> {
	if (!Number.isInteger(minSamples) || minSamples < 1 || minSamples > 10_000) {
		throw new Error('minSamples must be an integer between 1 and 10000');
	}
	const audit = await listGateAuditResults(directory);
	const results = runId
		? audit.results.filter((result) => result.runId === runId)
		: audit.results;
	const truthSummaries = await Promise.all(
		results.map((result) => readGateGroundTruth(directory, result.runId)),
	);
	const truthByKey = new Map<string, GateGroundTruthV1[]>();
	for (const summary of truthSummaries) {
		for (const event of summary.events) {
			const key = gateGroundTruthJoinKey(event);
			const group = truthByKey.get(key) ?? [];
			group.push(event);
			truthByKey.set(key, group);
		}
	}
	const summary = summarizeCells(
		results.flatMap((result) =>
			result.cells.map((cell) => ({ runId: result.runId, cell })),
		),
		truthByKey,
		minSamples,
	);
	return {
		runs: results.length,
		corruptRuns: runId
			? audit.corruptRunIds.filter((corruptRunId) => corruptRunId === runId)
			: audit.corruptRunIds,
		groundTruth: {
			parsed: truthSummaries.reduce(
				(total, value) => total + value.events.length,
				0,
			),
			malformed: truthSummaries.reduce(
				(total, value) => total + value.malformed,
				0,
			),
			ambiguous: summary.ambiguous,
			unjoined: summary.unjoined,
		},
		models: summary.models,
		reviewerTelemetry: telemetryStats(directory),
	};
}
