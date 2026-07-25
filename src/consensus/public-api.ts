/**
 * Stable package-level boundary for the consensus miner (issue #1821).
 *
 * This module exports exactly one thing — `mineAndStoreConsensusV1` — because
 * exactly one caller exists: `src/tools/consensus-mine.ts`. It previously also
 * exported a frozen callable `consensusV1` namespace mirroring
 * `src/evaluation/public-api.ts`, together with a `src/consensus/index.ts`
 * barrel. Both were dead RUNTIME VALUES — a public API surface with no importer
 * anywhere in `src/`, `tests/`, or `scripts/` — and the evaluation precedent did
 * not apply: that barrel IS consumed (`src/index.ts` re-exports `evaluationV1`),
 * whereas nothing ever wired consensus into the plugin entry. Both were removed
 * rather than left standing (see the "never ship unwired code" directive in
 * `CLAUDE.md`). If a future consumer needs a versioned namespace, reintroduce it
 * together with that consumer.
 *
 * The two type aliases below have no by-name importer either, and are kept for a
 * different and declared reason: they are the parameter and return shapes of
 * `mineAndStoreConsensusV1` itself, so they are already handed out by its
 * signature. See the export carve-out note at the bottom of `./contracts.ts`.
 */

import type { ConsensusMineRequest, ConsensusReportV1 } from './contracts.js';
import { type MineConsensusDeps, mineConsensus } from './miner.js';
import {
	listConsensusProposalFingerprints,
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
