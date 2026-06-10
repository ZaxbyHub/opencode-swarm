/**
 * Gate 5 – Phase Council.
 * Conditional on phase_council QA gate flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEffectiveGates, getProfile } from '../../../db/qa-gate-profile.js';
import { loadPlan } from '../../../plan/manager';
import { derivePlanId } from '../../../plan/utils';
import { swarmState } from '../../../state';
import type { GateContext, GateResult } from './types';

export async function runPhaseCouncilGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, pluginConfig, agentsDispatched, safeWarn } =
		ctx;

	const gateWarnings: string[] = [];

	let councilModeEnabled = false;

	try {
		const plan = await loadPlan(dir);
		if (plan) {
			const planId = derivePlanId(plan);
			const profile = getProfile(dir, planId);
			if (profile) {
				const session = sessionID
					? swarmState.agentSessions.get(sessionID)
					: undefined;
				const overrides = session?.qaGateSessionOverrides ?? {};
				const effective = getEffectiveGates(profile, overrides);

				if (
					effective.phase_council === true &&
					pluginConfig.council?.enabled === true
				) {
					councilModeEnabled = true;
					const pcPath = path.join(
						dir,
						'.swarm',
						'evidence',
						String(phase),
						'phase-council.json',
					);
					let pcVerdictFound = false;
					let _pcVerdict: string | undefined;
					let pcQuorumSize: number | undefined;
					let pcTimestamp: string | undefined;
					let pcPhaseNumber: number | undefined;

					try {
						const pcContent = fs.readFileSync(pcPath, 'utf-8');
						const pcBundle = JSON.parse(pcContent);
						for (const entry of pcBundle.entries ?? []) {
							if (
								typeof entry.type === 'string' &&
								entry.type === 'phase-council' &&
								typeof entry.verdict === 'string'
							) {
								pcVerdictFound = true;
								_pcVerdict = entry.verdict;
								pcQuorumSize =
									typeof entry.quorumSize === 'number'
										? entry.quorumSize
										: undefined;
								pcTimestamp =
									typeof entry.timestamp === 'string'
										? entry.timestamp
										: undefined;
								pcPhaseNumber =
									typeof entry.phase_number === 'number'
										? entry.phase_number
										: typeof entry.phase === 'number'
											? entry.phase
											: undefined;

								// Validate timestamp freshness (must be within last 24 hours and not in the future)
								const now = new Date();
								const pcTime = pcTimestamp ? new Date(pcTimestamp) : null;
								if (!pcTime || Number.isNaN(pcTime.getTime())) {
									return {
										blocked: true,
										reason: 'PHASE_COUNCIL_INVALID_TIMESTAMP',
										message: `Phase ${phase} cannot be completed: phase council evidence has missing or invalid timestamp.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}
								const maxAge = 24 * 60 * 60 * 1000; // 24 hours
								if (pcTime.getTime() > now.getTime()) {
									return {
										blocked: true,
										reason: 'PHASE_COUNCIL_FUTURE_TIMESTAMP',
										message: `Phase ${phase} cannot be completed: phase council evidence timestamp is in the future.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}
								if (now.getTime() - pcTime.getTime() > maxAge) {
									return {
										blocked: true,
										reason: 'PHASE_COUNCIL_STALE_EVIDENCE',
										message: `Phase ${phase} cannot be completed: phase council evidence is older than 24 hours. Re-convene council for fresh review.`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								// Provenance verification (issue #893 follow-up, F-001)
								// Advisory warning when provenance is missing
								if (
									!entry.provenance ||
									(!entry.provenance.agent_name && !entry.provenance.session_id)
								) {
									const msg = `Phase council evidence lacks provenance for phase ${phase}. Evidence should include agent_name or session_id for verification.`;
									gateWarnings.push(msg);
									safeWarn(
										`[phase_complete] ${msg}`,
										undefined,
									);
								}

								if (entry.verdict === 'REJECT' || entry.verdict === 'reject') {
									const requiredFixes =
										entry.requiredFixes ?? entry.required_fixes ?? [];
									const fixesDetail =
										Array.isArray(requiredFixes) && requiredFixes.length > 0
											? `\nRequired fixes: ${requiredFixes.map((f: { detail?: string; location?: string }) => f.detail ?? JSON.stringify(f)).join('; ')}`
											: '';

									return {
										blocked: true,
										reason: 'PHASE_COUNCIL_REJECTED',
										message: `Phase ${phase} cannot be completed: phase council returned verdict 'REJECT'. Address the required fixes before completing the phase.${fixesDetail}`,
										agentsDispatched,
										agentsMissing: [],
										warnings: [],
									};
								}

								if (
									entry.verdict === 'CONCERNS' ||
									entry.verdict === 'concerns'
								) {
									const phaseConcernsAllow =
										pluginConfig.council?.phaseConcernsAllowComplete ?? true;

									if (!phaseConcernsAllow) {
										const advisoryNotes =
											entry.advisoryNotes ?? entry.advisory_notes ?? [];
										const notesDetail =
											Array.isArray(advisoryNotes) && advisoryNotes.length > 0
												? `\nAdvisory notes: ${advisoryNotes.join('; ')}`
												: '';

										return {
											blocked: true,
											reason: 'PHASE_COUNCIL_CONCERNS',
											message: `Phase ${phase} cannot be completed: phase council returned verdict 'CONCERNS'.${notesDetail}`,
											agentsDispatched,
											agentsMissing: [],
											warnings: [],
										};
									}
									// If concerns-pass is allowed, warn and continue
									safeWarn(
										`[phase_complete] Phase council returned CONCERNS for phase ${phase} — proceeding (phaseConcernsAllowComplete is enabled)`,
										undefined,
									);
								}

								if (
									entry.verdict !== 'APPROVE' &&
									entry.verdict !== 'approve' &&
									entry.verdict !== 'CONCERNS' &&
									entry.verdict !== 'concerns'
								) {
									return {
										blocked: true,
										reason: 'PHASE_COUNCIL_INVALID',
										message: `Phase ${phase} cannot be completed: phase council evidence contains unrecognized verdict '${entry.verdict}'. Expected one of: APPROVE, CONCERNS, REJECT.`,
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
								`[phase_complete] Phase council evidence unreadable:`,
								readErr,
							);
						}
						pcVerdictFound = false;
					}

					if (!pcVerdictFound) {
						return {
							blocked: true,
							reason: 'PHASE_COUNCIL_REQUIRED',
							phase_council_required: true,
							message: `Phase ${phase} cannot be completed: phase_council is enabled and phase council evidence not found at .swarm/evidence/${phase}/phase-council.json. Convene a phase-level council (dispatch 5 members, collect verdicts, call submit_phase_council_verdicts) before completing the phase.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [
								`Phase council required — convene 5 council members (critic, reviewer, sme, test_engineer, explorer) for holistic phase review. Call submit_phase_council_verdicts to synthesize verdicts and write phase-council.json evidence.`,
							],
						};
					}

					// Validate quorum (minimum 3)
					if (pcQuorumSize === undefined || typeof pcQuorumSize !== 'number') {
						return {
							blocked: true,
							reason: 'PHASE_COUNCIL_MISSING_QUORUM',
							message: `Phase ${phase} cannot be completed: phase council evidence is missing quorumSize field.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
					if (pcQuorumSize < 3) {
						return {
							blocked: true,
							reason: 'PHASE_COUNCIL_INSUFFICIENT_QUORUM',
							message: `Phase ${phase} cannot be completed: phase council quorum (${pcQuorumSize}) is below minimum (3). Re-convene council with sufficient members.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}

					// Validate phase number matches
					if (
						pcPhaseNumber === undefined ||
						typeof pcPhaseNumber !== 'number'
					) {
						return {
							blocked: true,
							reason: 'PHASE_COUNCIL_MISSING_PHASE',
							message: `Phase ${phase} cannot be completed: phase council evidence is missing phase_number field.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
					if (pcPhaseNumber !== phase) {
						return {
							blocked: true,
							reason: 'PHASE_COUNCIL_PHASE_MISMATCH',
							message: `Phase ${phase} cannot be completed: phase council evidence is for phase ${pcPhaseNumber}, not phase ${phase}. Run council for the correct phase.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
				}
			}
		}
	} catch (pcError) {
		if (councilModeEnabled) {
			// Fail-closed: council gate errors block phase completion
			return {
				blocked: true,
				reason: 'PHASE_COUNCIL_ERROR',
				message: `Phase ${phase} cannot be completed: phase council gate encountered an error when phase_council was enabled. Error: ${String(pcError)}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [`PHASE_COUNCIL_ERROR: ${String(pcError)}`],
			};
		} else {
			// Non-blocking when phase_council is off
			safeWarn(
				`[phase_complete] Phase council gate error (non-blocking):`,
				pcError,
			);
		}
	}

	return { blocked: false, agentsDispatched, agentsMissing: [], warnings: gateWarnings };
}
