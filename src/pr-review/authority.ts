/**
 * PR-review event authority census (issue #2512).
 *
 * The reducer deliberately owns only the six event shapes that have a
 * production creator. The other ten names are retained here as historical
 * vocabulary so a future reducer/event addition cannot silently become an
 * orphan. Wired rows bind an exported production ancestor; retired rows name
 * the lock/CAS-backed authority that replaced the old reducer facade.
 */

import {
	assertPrFeedbackReadyToPublish,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	recordPrFeedbackPushAttemptResult,
	recoverArmedPrWorkflow,
	reserveActivePrReviewReentryAuthorization,
	rollbackPrReviewBaseAdmissionIfUnlaunched,
	settlePresumedStalePrWorkflowLanes,
	submitPrReviewResult,
} from '../hooks/pr-workflow-gate.js';
import { executeCollectLaneResults } from '../tools/dispatch-lanes.js';
import { scanPrReviewCircuitEvidence } from './circuit.js';
import { composePrReviewPhaseVerdicts } from './legacy-transcript-adapter.js';
import type { PrReviewEvent } from './types.js';

/** The six reducer discriminants with production creators. */
export const PR_REVIEW_WIRED_EVENT_TYPES = [
	'base_admission_rolled_back',
	'collection_observed',
	'lane_structured_result_submitted',
	'circuit_advance_requested',
	'circuit_probe_settled',
	'resilience_config_changed',
] as const satisfies readonly PrReviewEvent['type'][];

type PrReviewWiredEventType = (typeof PR_REVIEW_WIRED_EVENT_TYPES)[number];
type MissingPrReviewWiredEventType = Exclude<
	PrReviewEvent['type'],
	PrReviewWiredEventType
>;
type ExtraPrReviewWiredEventType = Exclude<
	PrReviewWiredEventType,
	PrReviewEvent['type']
>;
type AssertNever<T extends never> = T;
export type PrReviewWiredEventTypesAreExhaustive =
	AssertNever<MissingPrReviewWiredEventType>;
export type PrReviewWiredEventTypesHaveNoExtras =
	AssertNever<ExtraPrReviewWiredEventType>;

/** The ten historical reducer discriminants retired as test-only facades. */
export const PR_REVIEW_RETIRED_EVENT_TYPES = [
	'base_admission_requested',
	'transcript_evidence_presented',
	'provider_terminal_observed',
	'lane_cancelled',
	'coverage_finalization_requested',
	'critic_result_recorded',
	'publication_armed',
	'publication_published',
	'armed_recovery_requested',
	'reviewer_authorization_consumed',
] as const;

/** Every historical reducer discriminant, including retired test-only names. */
export const PR_REVIEW_HISTORICAL_EVENT_TYPES = [
	'base_admission_requested',
	'base_admission_rolled_back',
	'collection_observed',
	'lane_structured_result_submitted',
	'transcript_evidence_presented',
	'provider_terminal_observed',
	'lane_cancelled',
	'circuit_advance_requested',
	'circuit_probe_settled',
	'resilience_config_changed',
	'coverage_finalization_requested',
	'critic_result_recorded',
	'publication_armed',
	'publication_published',
	'armed_recovery_requested',
	'reviewer_authorization_consumed',
] as const;

export type PrReviewHistoricalEventType =
	(typeof PR_REVIEW_HISTORICAL_EVENT_TYPES)[number];

export type PrReviewAuthorityDomain =
	| 'base-admission'
	| 'collection'
	| 'structured-result'
	| 'resilience'
	| 'completion'
	| 'critic'
	| 'publication'
	| 'recovery'
	| 'authorization';

/** Function reference to an exported production authority ancestor. */
export type PrReviewAuthorityBinding = (...args: never[]) => unknown;

export type PrReviewEventAuthorityEntry =
	| {
			status: 'wired';
			lifecycle: 'wired';
			domain: PrReviewAuthorityDomain;
			authority: PrReviewAuthorityBinding;
			authoritySymbol: string;
			productionCreator: string;
	  }
	| {
			status: 'retired';
			lifecycle: 'retired';
			domain: PrReviewAuthorityDomain;
			replacement: string;
			replacementAuthority: PrReviewAuthorityBinding;
	  };

type ExactPrReviewEventAuthorityRegistry = {
	[K in PrReviewHistoricalEventType]: PrReviewEventAuthorityEntry;
};

const wired = (
	domain: PrReviewAuthorityDomain,
	authority: PrReviewAuthorityBinding,
	authoritySymbol: string,
	productionCreator: string,
): PrReviewEventAuthorityEntry => ({
	status: 'wired',
	lifecycle: 'wired',
	domain,
	authority,
	authoritySymbol,
	productionCreator,
});

const retired = (
	domain: PrReviewAuthorityDomain,
	replacement: string,
	replacementAuthority: PrReviewAuthorityBinding,
): PrReviewEventAuthorityEntry => ({
	status: 'retired',
	lifecycle: 'retired',
	domain,
	replacement,
	replacementAuthority,
});

/**
 * The one canonical event-authority registry. The `satisfies` constraint is
 * intentionally exact: missing or extra historical discriminants are compile
 * errors, while the exported object retains literal row information for
 * census tests and documentation tooling.
 */
export const PR_REVIEW_EVENT_AUTHORITY_REGISTRY = {
	base_admission_requested: retired(
		'base-admission',
		'src/hooks/pr-workflow-gate.ts#enforcePrReviewBaseDimensions',
		enforcePrReviewBaseDimensions,
	),
	base_admission_rolled_back: wired(
		'base-admission',
		rollbackPrReviewBaseAdmissionIfUnlaunched,
		'src/hooks/pr-workflow-gate.ts#rollbackPrReviewBaseAdmissionIfUnlaunched',
		'src/hooks/pr-workflow-gate.ts#rollbackPrReviewBaseAdmissionIfUnlaunched',
	),
	collection_observed: wired(
		'collection',
		executeCollectLaneResults,
		'src/tools/dispatch-lanes.ts#executeCollectLaneResults',
		'src/tools/dispatch-lanes.ts#executeCollectLaneResults',
	),
	lane_structured_result_submitted: wired(
		'structured-result',
		submitPrReviewResult,
		'src/hooks/pr-workflow-gate.ts#submitPrReviewResult',
		'src/hooks/pr-workflow-gate.ts#submitPrReviewResult',
	),
	transcript_evidence_presented: retired(
		'critic',
		'src/pr-review/legacy-transcript-adapter.ts#composePrReviewPhaseVerdicts',
		composePrReviewPhaseVerdicts,
	),
	provider_terminal_observed: retired(
		'resilience',
		'src/pr-review/circuit.ts#scanPrReviewCircuitEvidence',
		scanPrReviewCircuitEvidence,
	),
	lane_cancelled: retired(
		'base-admission',
		'src/hooks/pr-workflow-gate.ts#settlePresumedStalePrWorkflowLanes',
		settlePresumedStalePrWorkflowLanes,
	),
	circuit_advance_requested: wired(
		'resilience',
		enforcePrReviewBaseDimensions,
		'src/hooks/pr-workflow-gate.ts#enforcePrReviewBaseDimensions',
		'src/hooks/pr-workflow-gate.ts#advanceResilienceCircuitWhileLocked',
	),
	circuit_probe_settled: wired(
		'resilience',
		rollbackPrReviewBaseAdmissionIfUnlaunched,
		'src/hooks/pr-workflow-gate.ts#rollbackPrReviewBaseAdmissionIfUnlaunched',
		'src/hooks/pr-workflow-gate.ts#rollbackPrReviewBaseAdmissionIfUnlaunched',
	),
	resilience_config_changed: wired(
		'resilience',
		enforcePrReviewBaseDimensions,
		'src/hooks/pr-workflow-gate.ts#enforcePrReviewBaseDimensions',
		'src/hooks/pr-workflow-gate.ts#enforcePrReviewBaseDimensionsWhileLocked',
	),
	coverage_finalization_requested: retired(
		'completion',
		'src/hooks/pr-workflow-gate.ts#completePrWorkflow',
		completePrWorkflow,
	),
	critic_result_recorded: retired(
		'critic',
		'src/pr-review/legacy-transcript-adapter.ts#composePrReviewPhaseVerdicts',
		composePrReviewPhaseVerdicts,
	),
	publication_armed: retired(
		'publication',
		'src/hooks/pr-workflow-gate.ts#assertPrFeedbackReadyToPublish',
		assertPrFeedbackReadyToPublish,
	),
	publication_published: retired(
		'publication',
		'src/hooks/pr-workflow-gate.ts#recordPrFeedbackPushAttemptResult',
		recordPrFeedbackPushAttemptResult,
	),
	armed_recovery_requested: retired(
		'recovery',
		'src/hooks/pr-workflow-gate.ts#recoverArmedPrWorkflow',
		recoverArmedPrWorkflow,
	),
	reviewer_authorization_consumed: retired(
		'authorization',
		'src/hooks/pr-workflow-gate.ts#reserveActivePrReviewReentryAuthorization',
		reserveActivePrReviewReentryAuthorization,
	),
} satisfies ExactPrReviewEventAuthorityRegistry;
