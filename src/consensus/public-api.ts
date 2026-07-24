/**
 * Stable package-level boundary for the consensus miner (issue #1821).
 *
 * Mirrors `src/evaluation/public-api.ts`: OpenCode's legacy plugin loader
 * permits named FUNCTION exports but rejects plain-object named exports, so a
 * cohesive versioned API has to be a callable whose methods are attached to it
 * rather than a bare namespace object. Exporting `{ mine, read, ... }` here
 * would make the plugin undiscoverable at load time with no error surfaced —
 * the failure mode AGENTS.md invariant 1 exists to prevent.
 */

import type { ConsensusMineRequest, ConsensusReportV1 } from './contracts.js';
import { type MineConsensusDeps, mineConsensus } from './miner.js';
import {
	listConsensusProposalFingerprints,
	listConsensusReports,
	readConsensusReport,
	writeConsensusReport,
} from './store.js';

export type MineAndStoreConsensusOptions = {
	directory: string;
	request: ConsensusMineRequest;
	deps: MineConsensusDeps;
};

export type MineAndStoreConsensusResult = {
	report: ConsensusReportV1;
	truncated: boolean;
	unreadableSources: string[];
	investigationNoteCount: number;
	dedupedProposalCount: number;
	summarizedCount: number;
	summarizationSkippedReason?: string;
};

/**
 * Mine, then persist. The two phases stay separable on purpose — `mineConsensus`
 * mutates nothing and is safe to call speculatively; only this boundary writes,
 * and it writes exactly one artifact: the report itself.
 */
export async function mineAndStoreConsensusV1(
	options: MineAndStoreConsensusOptions,
): Promise<MineAndStoreConsensusResult> {
	const priorFingerprints =
		options.deps.priorFingerprints ??
		(await listConsensusProposalFingerprints(options.directory));
	const result = await mineConsensus(options.directory, options.request, {
		...options.deps,
		priorFingerprints,
	});
	const report = await writeConsensusReport(options.directory, result.report);
	return { ...result, report };
}

/**
 * Callable function namespace — see the module doc for why this is not a plain
 * object. Frozen so a consumer cannot monkey-patch the boundary at runtime.
 */
export const consensusV1: ((
	options: MineAndStoreConsensusOptions,
) => Promise<MineAndStoreConsensusResult>) & {
	mineAndStore: typeof mineAndStoreConsensusV1;
	mine: typeof mineConsensus;
	readReport: typeof readConsensusReport;
	listReports: typeof listConsensusReports;
	listProposalFingerprints: typeof listConsensusProposalFingerprints;
} = Object.freeze(
	Object.assign(
		(options: MineAndStoreConsensusOptions) => mineAndStoreConsensusV1(options),
		{
			mineAndStore: mineAndStoreConsensusV1,
			mine: mineConsensus,
			readReport: readConsensusReport,
			listReports: listConsensusReports,
			listProposalFingerprints: listConsensusProposalFingerprints,
		},
	),
);
