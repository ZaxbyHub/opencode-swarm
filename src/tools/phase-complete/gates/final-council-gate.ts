/**
 * Gate 6 – Final Council.
 * Conditional on final_council QA gate flag.  Only fires after the LAST
 * phase completes — not after intermediate phases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceBundle } from '../../../config/evidence-schema';
import {
	evaluateCouncilFreshness,
	latestRetroTimestampMsFromBundle,
	parseTimestampMs,
	resolveCouncilFreshnessMaxAgeMs,
} from '../../../council/council-freshness';
import {
	COUNCIL_REVIEW_IDENTITY_VERSION,
	computeCouncilReviewIdentity,
	isIdentityDigest,
	resolveCouncilMemberRole,
	resolveFinalCompletionPolicy,
} from '../../../council/council-review-identity';
import { COUNCIL_MEMBER_ROLES } from '../../../council/types';
import { hasAnyProfileWithEnabledGate } from '../../../db/qa-gate-profile';
import { derivePlanIdentityHash } from '../../../plan/utils';
import { formatLegacyQaBindingRecovery } from '../../../qa-gate/recovery.js';
import { swarmState } from '../../../state';
import { resolveGatePreamble } from './gate-helpers';
import type { GateContext, GateResult } from './types';

function readLatestRetroTimestampMs(dir: string, phase: number): number | null {
	const baseDir = path.normalize(path.resolve(dir, '.swarm'));
	// Defense-in-depth: ensure the constructed path is within .swarm
	// before reading. Mirrors validateSwarmPath's containment check.
	const retroPath = path.normalize(
		path.join(baseDir, 'evidence', `retro-${phase}`, 'evidence.json'),
	);
	const isWindows = process.platform === 'win32';
	const pathInSwarm = isWindows
		? retroPath.toLowerCase().startsWith(baseDir.toLowerCase() + path.sep) ||
			retroPath.toLowerCase() === baseDir.toLowerCase()
		: retroPath.startsWith(baseDir + path.sep) || retroPath === baseDir;
	if (!pathInSwarm) return null;
	try {
		const content = fs.readFileSync(retroPath, 'utf-8');
		return latestRetroTimestampMsFromBundle(
			JSON.parse(content) as EvidenceBundle,
			phase,
		);
	} catch {
		return null;
	}
}

function sessionHasEnabledFinalCouncil(sessionID: string | undefined): boolean {
	if (!sessionID) return false;
	return (
		swarmState.agentSessions.get(sessionID)?.qaGateSessionOverrides
			?.final_council === true
	);
}

export async function runFinalCouncilGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

	let finalCouncilEnabled = false;
	const gateWarnings: string[] = [];

	try {
		const preamble = await resolveGatePreamble(dir, sessionID);

		if (!preamble.resolved || !preamble.plan) {
			if (
				hasAnyProfileWithEnabledGate(dir, 'final_council') ||
				sessionHasEnabledFinalCouncil(sessionID)
			) {
				return {
					blocked: true,
					reason: 'FINAL_COUNCIL_PLAN_REQUIRED',
					message: `Phase ${phase} cannot be completed: final_council is enabled but plan.json is missing or invalid, so the final council gate cannot verify the current plan identity. Restore a valid .swarm/plan.json and re-run the final council.`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
			}
			const warning =
				'Final council gate: plan.json is missing and no enabled final_council profile was found. If final_council is required, the gate cannot be verified.';
			gateWarnings.push(warning);
			safeWarn(`[phase_complete] ${warning}`, undefined);
			return {
				blocked: false,
				agentsDispatched,
				agentsMissing: [],
				warnings: [warning],
			};
		}

		if (preamble.resolved && preamble.plan) {
			const lastPhaseId =
				preamble.plan.phases[preamble.plan.phases.length - 1]?.id;
			if (lastPhaseId !== undefined && phase === lastPhaseId) {
				if (preamble.effectiveGates?.final_council === true) {
					if (preamble.identityBound === false) {
						return {
							blocked: true,
							reason: 'FINAL_COUNCIL_IDENTITY_UNBOUND',
							message: `Phase ${phase} (last phase) cannot be completed: final_council is enabled but the QA gate profile is not exact-bound to the current raw swarm_id/plan_title. ${formatLegacyQaBindingRecovery(
								{ swarm: preamble.plan!.swarm, title: preamble.plan!.title },
								'retry completing the project',
							)}`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
					finalCouncilEnabled = true;
					const fcPath = path.join(
						dir,
						'.swarm',
						'evidence',
						'final-council.json',
					);
					let fcVerdictFound = false;
					let _fcVerdict: string | undefined;

					// The gate recomputes the canonical review identity from the
					// SAME shared implementation the writer used, so the digests
					// match byte-for-byte by construction (issue #2102 contracts A/H).
					const identity = computeCouncilReviewIdentity({
						level: 'final',
						scope: { kind: 'final', final: true },
						plan: preamble.plan,
						config: ctx.pluginConfig.council,
					});
					const completionPolicy = resolveFinalCompletionPolicy(
						ctx.pluginConfig.council,
					);
					const maxAgeMs = resolveCouncilFreshnessMaxAgeMs(
						ctx.pluginConfig.council,
					);

					try {
						const fcContent = fs.readFileSync(fcPath, 'utf-8');
						const fcBundle = JSON.parse(fcContent);
						for (const entry of fcBundle.entries ?? []) {
							if (
								typeof entry.type === 'string' &&
								entry.type === 'final-council' &&
								typeof entry.verdict === 'string'
							) {
								fcVerdictFound = true;
								_fcVerdict = entry.verdict;

								// Centralized freshness (issue #2102 contract D): one shared
								// evaluator, one captured preflight clock, one config bound.
								// Evidence must postdate the phase retrospective.
								const fcTimeMs = parseTimestampMs(entry.timestamp);
								const latestRetroTimestampMs =
									latestRetroTimestampMsFromBundle(
										ctx.loadedRetroBundle,
										phase,
									) ?? readLatestRetroTimestampMs(dir, phase);
								const freshness = evaluateCouncilFreshness({
									nowMs: ctx.preflightNowMs,
									timestampMs: fcTimeMs,
									maxAgeMs,
									mustPostdateMs: latestRetroTimestampMs,
								});
								if (!freshness.ok) {
									const reasonByFailure: Record<string, string> = {
										invalid_timestamp: 'FINAL_COUNCIL_TIMESTAMP_REQUIRED',
										future_timestamp: 'FINAL_COUNCIL_FUTURE_TIMESTAMP',
										stale_evidence: 'FINAL_COUNCIL_STALE_EVIDENCE',
										predates_required_input: 'FINAL_COUNCIL_STALE_EVIDENCE',
										invalid_required_input:
											'FINAL_COUNCIL_INVALID_REQUIRED_INPUT',
									};
									return {
										blocked: true,
										reason:
											reasonByFailure[freshness.reason ?? ''] ??
											'FINAL_COUNCIL_STALE_EVIDENCE',
										message: `Phase ${phase} cannot be completed: final council ${freshness.message}. ${freshness.recovery}`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								// Plan ID binding: prevent stale evidence from prior project
								if (preamble.plan) {
									const currentPlanId = preamble.planId;
									if (entry.plan_id && entry.plan_id !== currentPlanId) {
										return {
											blocked: true,
											reason: 'final_council_plan_mismatch',
											message: `Final council evidence belongs to a different plan (evidence: ${entry.plan_id}, current: ${currentPlanId}). Re-run the final council.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									if (!entry.plan_id) {
										return {
											blocked: true,
											reason: 'FINAL_COUNCIL_PLAN_ID_REQUIRED',
											message: `Phase ${phase} (last phase) cannot be completed: final council evidence is missing plan_id binding. Re-run the final council to generate evidence with plan identity.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									const currentIdentityHash = derivePlanIdentityHash(
										preamble.plan,
									);
									if (entry.plan_identity_hash !== currentIdentityHash) {
										return {
											blocked: true,
											reason: entry.plan_identity_hash
												? 'FINAL_COUNCIL_PLAN_IDENTITY_MISMATCH'
												: 'FINAL_COUNCIL_PLAN_IDENTITY_REQUIRED',
											message: entry.plan_identity_hash
												? `Phase ${phase} cannot be completed: final council evidence belongs to a different raw plan identity. Re-run the final council.`
												: `Phase ${phase} cannot be completed: final council evidence is missing plan_identity_hash binding. Re-run the final council to generate collision-resistant plan identity evidence.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									// Canonical review identity binding (issue #2102): the
									// status-stable review hash + council policy digest. Unlike
									// the legacy plan_hash comparison, ordinary task-status
									// progress cannot invalidate the review; only a
									// review-relevant plan or policy change can. Legacy evidence
									// without identity proof fails closed (fresh council run).
									if (
										entry.identity_version !== COUNCIL_REVIEW_IDENTITY_VERSION
									) {
										return {
											blocked: true,
											reason: entry.identity_version
												? 'FINAL_COUNCIL_IDENTITY_MISMATCH'
												: 'FINAL_COUNCIL_IDENTITY_REQUIRED',
											message: entry.identity_version
												? `Phase ${phase} cannot be completed: final council evidence was produced under a different council identity schema version (${entry.identity_version}, expected ${COUNCIL_REVIEW_IDENTITY_VERSION}). Re-run the final council.`
												: `Phase ${phase} cannot be completed: final council evidence predates the council review identity cutover and carries no identity proof. Re-run the final council to generate identity-bound evidence.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									if (
										entry.review_hash !== identity.reviewHash ||
										!isIdentityDigest(entry.identity_digest) ||
										entry.identity_digest !== identity.identityDigest
									) {
										return {
											blocked: true,
											reason: entry.review_hash
												? 'FINAL_COUNCIL_STALE_REVIEW_IDENTITY'
												: 'FINAL_COUNCIL_IDENTITY_REQUIRED',
											message: `Phase ${phase} cannot be completed: final council evidence does not match the current council review identity (review-relevant plan content or council policy changed since the review). Re-run the final council for the current plan and policy.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									if (entry.policy_digest !== identity.policyDigest) {
										return {
											blocked: true,
											reason: entry.policy_digest
												? 'FINAL_COUNCIL_POLICY_MISMATCH'
												: 'FINAL_COUNCIL_IDENTITY_REQUIRED',
											message: `Phase ${phase} cannot be completed: final council evidence was produced under a different council policy. Re-run the final council under the current policy.`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
								}

								// Quorum per the explicit final completion policy
								// (issue #2102 contract C). Default all_required preserves
								// the exact legacy requirement; quorum is an explicit,
								// bounded weakening. Only distinct canonical roles of the
								// five-role set count; unknown names never count.
								const requiredMembers =
									completionPolicy.mode === 'quorum'
										? completionPolicy.minimumMembers
										: COUNCIL_MEMBER_ROLES.length;
								const rawMembersVoted = Array.isArray(entry.membersVoted)
									? entry.membersVoted.filter(
											(member: unknown): member is string =>
												typeof member === 'string',
										)
									: [];
								const distinctCanonicalVoted = new Set(
									rawMembersVoted
										.map((member: string) => resolveCouncilMemberRole(member))
										.filter((role: string | null): role is string =>
											Boolean(role),
										),
								);
								// Recompute absentees from canonical roles; do not trust the
								// persisted membersAbsent array.
								const membersAbsent = COUNCIL_MEMBER_ROLES.filter(
									(role) => !distinctCanonicalVoted.has(role),
								);
								const strictAllMembersPresent =
									distinctCanonicalVoted.size === COUNCIL_MEMBER_ROLES.length;
								const quorumSatisfied =
									completionPolicy.mode === 'quorum'
										? distinctCanonicalVoted.size >= requiredMembers
										: strictAllMembersPresent && membersAbsent.length === 0;
								if (
									typeof entry.quorumSize !== 'number' ||
									!Number.isFinite(entry.quorumSize) ||
									entry.quorumSize < requiredMembers ||
									!quorumSatisfied
								) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_MISSING_QUORUM',
										message: `Phase ${phase} (last phase) cannot be completed: final council evidence does not prove the required quorum (policy ${completionPolicy.mode}${
											completionPolicy.mode === 'quorum'
												? `, minimumMembers: ${completionPolicy.minimumMembers}`
												: ''
										}; recorded quorumSize: ${
											typeof entry.quorumSize === 'number'
												? entry.quorumSize
												: 'missing'
										}; distinct canonical members: ${distinctCanonicalVoted.size} of ${requiredMembers} required; absent: [${membersAbsent.join(', ')}]). Re-run the project-scoped final council and call write_final_council_evidence to generate quorumed evidence.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								if (
									entry.verdict === 'rejected' ||
									entry.verdict === 'REJECTED'
								) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_REJECTED',
										message: `Phase ${phase} (last phase) cannot be completed: final council returned verdict 'REJECTED'. Address the required fixes before completing the project.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								if (
									entry.verdict === 'concerns' ||
									entry.verdict === 'CONCERNS'
								) {
									const advisoryNotes = Array.isArray(entry.advisoryNotes)
										? entry.advisoryNotes.filter(
												(note: unknown): note is string =>
													typeof note === 'string',
											)
										: [];
									const warning =
										advisoryNotes.length > 0
											? `Final council returned CONCERNS (non-blocking): ${advisoryNotes.join('; ')}`
											: 'Final council returned CONCERNS (non-blocking).';
									gateWarnings.push(warning);
									safeWarn(`[phase_complete] ${warning}`, undefined);
								}

								if (
									entry.verdict !== 'approved' &&
									entry.verdict !== 'APPROVED' &&
									entry.verdict !== 'concerns' &&
									entry.verdict !== 'CONCERNS'
								) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_INVALID_VERDICT',
										message: `Phase ${phase} (last phase) cannot be completed: final council evidence contains unrecognized verdict '${entry.verdict}'. Expected one of: approved, concerns, rejected.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}
							}
						}
					} catch (readErr) {
						if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
							safeWarn(
								`[phase_complete] Final council evidence unreadable:`,
								readErr,
							);
						}
						fcVerdictFound = false;
					}

					if (!fcVerdictFound) {
						return {
							blocked: true,
							reason: 'FINAL_COUNCIL_REQUIRED',
							final_council_required: true,
							message: `Phase ${phase} (last phase) cannot be completed: final_council is enabled and final council evidence not found at .swarm/evidence/final-council.json. Dispatch critic, reviewer, sme, test_engineer, and explorer with project-scoped context, collect their CouncilMemberVerdict JSON, and call write_final_council_evidence before completing the project. Do not use convene_general_council for this gate.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [
								`Final council required - dispatch the project-scoped council members, then call write_final_council_evidence to persist quorumed evidence.`,
							],
						};
					}
				}
			}
		}
	} catch (fcError) {
		if (finalCouncilEnabled) {
			return {
				blocked: true,
				reason: 'FINAL_COUNCIL_ERROR',
				message: `Phase ${phase} (last phase) cannot be completed: final council gate encountered an error. Error: ${String(fcError)}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [`FINAL_COUNCIL_ERROR: ${String(fcError)}`],
			};
		} else {
			safeWarn(
				`[phase_complete] Final council gate error (non-blocking):`,
				fcError,
			);
		}
	}

	return {
		blocked: false,
		agentsDispatched,
		agentsMissing: [],
		warnings: gateWarnings,
	};
}
