/**
 * Gate 6 – Final Council.
 * Conditional on final_council QA gate flag.  Only fires after the LAST
 * phase completes — not after intermediate phases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceBundle } from '../../../config/evidence-schema';
import { hasAnyProfileWithEnabledGate } from '../../../db/qa-gate-profile';
import { derivePlanIdentityHash } from '../../../plan/utils';
import { swarmState } from '../../../state';
import { resolveGatePreamble } from './gate-helpers';
import type { GateContext, GateResult } from './types';

function parseTimestampMs(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = new Date(value).getTime();
	return Number.isNaN(parsed) ? null : parsed;
}

function latestRetroTimestampMsFromBundle(
	bundle: EvidenceBundle | null | undefined,
	phase: number,
): number | null {
	if (!bundle) return null;
	const timestamps = [
		parseTimestampMs(bundle.created_at),
		parseTimestampMs(bundle.updated_at),
		...(bundle.entries ?? [])
			.filter(
				(entry) =>
					entry.type === 'retrospective' && entry.phase_number === phase,
			)
			.map((entry) => parseTimestampMs(entry.timestamp)),
	].filter((timestamp): timestamp is number => timestamp !== null);
	return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

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
					finalCouncilEnabled = true;
					const fcPath = path.join(
						dir,
						'.swarm',
						'evidence',
						'final-council.json',
					);
					let fcVerdictFound = false;
					let _fcVerdict: string | undefined;

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

								// Timestamp freshness: block if timestamp is in the future, warn if older than 24h.
								const now = new Date();
								const fcTimeMs = parseTimestampMs(entry.timestamp);
								if (fcTimeMs === null) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_TIMESTAMP_REQUIRED',
										message: `Phase ${phase} cannot be completed: final council evidence is missing a valid timestamp. Re-run the final council to generate fresh evidence.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}
								if (fcTimeMs > now.getTime()) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_FUTURE_TIMESTAMP',
										message: `Phase ${phase} cannot be completed: final council evidence timestamp is in the future.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}
								if (now.getTime() - fcTimeMs > 24 * 60 * 60 * 1000) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_STALE_EVIDENCE',
										message: `Phase ${phase} cannot be completed: final council evidence is older than 24 hours. Re-run the final council for fresh review.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								const latestRetroTimestampMs =
									latestRetroTimestampMsFromBundle(
										ctx.loadedRetroBundle,
										phase,
									) ?? readLatestRetroTimestampMs(dir, phase);
								if (
									latestRetroTimestampMs !== null &&
									fcTimeMs < latestRetroTimestampMs
								) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_STALE_EVIDENCE',
										message: `Phase ${phase} cannot be completed: final council evidence predates the current phase retrospective. Re-run the final council after the latest project evidence is available.`,
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
									if (entry.plan_hash !== preamble.planHash) {
										return {
											blocked: true,
											reason: entry.plan_hash
												? 'FINAL_COUNCIL_STALE_PLAN'
												: 'FINAL_COUNCIL_PLAN_HASH_REQUIRED',
											message: entry.plan_hash
												? `Phase ${phase} cannot be completed: final council evidence was produced for an older plan hash. Re-run the final council for the current plan.`
												: `Phase ${phase} cannot be completed: final council evidence is missing plan_hash binding. Re-run the final council to generate evidence tied to the current plan content.`,
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
								}

								if (
									typeof entry.quorumSize !== 'number' ||
									!Number.isFinite(entry.quorumSize) ||
									entry.quorumSize < 5
								) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_MISSING_QUORUM',
										message: `Phase ${phase} (last phase) cannot be completed: final council evidence is missing valid quorum metadata. Re-run the project-scoped five-member final council and call write_final_council_evidence to generate quorumed evidence.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								const requiredFinalCouncilMembers = [
									'critic',
									'reviewer',
									'sme',
									'test_engineer',
									'explorer',
								];
								const membersVoted = Array.isArray(entry.membersVoted)
									? entry.membersVoted.filter(
											(member: unknown): member is string =>
												typeof member === 'string',
										)
									: [];
								const membersAbsent = Array.isArray(entry.membersAbsent)
									? entry.membersAbsent.filter(
											(member: unknown): member is string =>
												typeof member === 'string',
										)
									: [];
								const distinctMembersVoted = new Set(membersVoted);
								const hasAllRequiredMembers =
									requiredFinalCouncilMembers.every((member) =>
										distinctMembersVoted.has(member),
									) &&
									distinctMembersVoted.size ===
										requiredFinalCouncilMembers.length &&
									membersAbsent.length === 0;
								if (!hasAllRequiredMembers) {
									return {
										blocked: true,
										reason: 'FINAL_COUNCIL_MISSING_QUORUM',
										message: `Phase ${phase} (last phase) cannot be completed: final council evidence does not prove all five required members voted. Re-run the project-scoped five-member final council and call write_final_council_evidence to generate complete evidence.`,
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
								`Final council required - dispatch the five project-scoped council members, then call write_final_council_evidence to persist quorumed evidence.`,
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
