/**
 * Consensus miner barrel (issue #1821, Workstream C).
 *
 * Mirrors `src/evaluation/index.ts`. Note that every named export reachable from
 * here is a type, a function, or a frozen callable namespace — never a plain
 * object literal, which OpenCode's legacy plugin loader rejects. See
 * `./public-api.ts` for the rationale behind `consensusV1`'s shape.
 */

export * from './contracts.js';
export type {
	ConsensusCorpus,
	CorpusObservation,
	CorpusReaders,
	KnowledgeLike,
	LoadCorpusOptions,
} from './corpus.js';
export {
	listEvaluationRunIds,
	listTrajectorySessions,
	loadConsensusCorpus,
	sanitizeExcerpt,
} from './corpus.js';
export type {
	ConsensusReportIntegrityInput,
	MineConsensusDeps,
	MineConsensusResult,
	SignalTally,
} from './miner.js';
export {
	buildAttributes,
	buildProposals,
	computeAttributeId,
	computeConfidence,
	computeConsensusIntegrityHash,
	deriveReportId,
	filterObservations,
	MAX_LLM_SUMMARIES,
	MIN_TASK_DIVERSITY_FOR_PROPOSAL,
	mineConsensus,
	tallySignals,
} from './miner.js';
export * from './public-api.js';
export type { ConsensusListSummary, ConsensusPruneResult } from './store.js';
export {
	ConsensusConflictError,
	ConsensusIntegrityError,
	listConsensusProposalFingerprints,
	listConsensusReports,
	pruneConsensusReports,
	readConsensusReport,
	writeConsensusReport,
} from './store.js';
