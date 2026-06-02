/**
 * Gate 6 – Final Council.
 * Conditional on final_council QA gate flag.  Only fires after the LAST
 * phase completes — not after intermediate phases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEffectiveGates, getProfile } from '../../../db/qa-gate-profile.js';
import { loadPlan } from '../../../plan/manager';
import { derivePlanId } from '../../../plan/utils';
import { swarmState } from '../../../state';
import type { GateContext, GateResult } from './types';

export async function runFinalCouncilGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

	let finalCouncilEnabled = false;

	try {
		const plan = await loadPlan(dir);
		if (plan) {
			const lastPhaseId = plan.phases[plan.phases.length - 1]?.id;
			if (lastPhaseId !== undefined && phase === lastPhaseId) {
				const planId = derivePlanId(plan);
				const profile = getProfile(dir, planId);
				if (profile) {
					const session = sessionID
						? swarmState.agentSessions.get(sessionID)
						: undefined;
					const overrides = session?.qaGateSessionOverrides ?? {};
					const effective = getEffectiveGates(profile, overrides);

					if (effective.final_council === true) {
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

									// Plan ID binding: prevent stale evidence from prior project
									if (plan) {
										const currentPlanId = derivePlanId(plan);
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
										entry.verdict !== 'approved' &&
										entry.verdict !== 'APPROVED'
									) {
										return {
											blocked: true,
											reason: 'FINAL_COUNCIL_INVALID_VERDICT',
											message: `Phase ${phase} (last phase) cannot be completed: final council evidence contains unrecognized verdict '${entry.verdict}'. Expected 'approved'.`,
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

	return { blocked: false, agentsDispatched, agentsMissing: [], warnings: [] };
}
