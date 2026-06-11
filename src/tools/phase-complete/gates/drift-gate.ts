/**
 * Gate 2 – Drift Verifier.
 * Conditional on drift_check QA gate.  Blocks when drift evidence is missing
 * (when an effective spec exists) or when the verdict is rejected.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEffectiveGates, getProfile } from '../../../db/qa-gate-profile.js';
import { loadPlan } from '../../../plan/manager';
import { derivePlanId } from '../../../plan/utils';
import { readEffectiveSpecSync } from '../../../sdd/effective-spec';
import { swarmState } from '../../../state';
import type { GateContext, GateResult } from './types';

export async function runDriftGate(ctx: GateContext): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

	const gateWarnings: string[] = [];

	// Load QA gate profile to check drift_check flag
	let driftCheckEnabled = true; // Default: preserve current mandatory behaviour
	let driftHasEffectiveSpec = false;

	try {
		driftHasEffectiveSpec = readEffectiveSpecSync(dir) !== null;

		const gatePlan = await loadPlan(dir);
		if (gatePlan) {
			const gatePlanId = derivePlanId(gatePlan);
			const gateProfile = getProfile(dir, gatePlanId);
			if (gateProfile) {
				const gateSession = sessionID
					? swarmState.agentSessions.get(sessionID)
					: undefined;
				const gateOverrides = gateSession?.qaGateSessionOverrides ?? {};
				const gateEffective = getEffectiveGates(gateProfile, gateOverrides);
				driftCheckEnabled = gateEffective.drift_check === true;
			}
			// No profile → driftCheckEnabled stays true (DEFAULT_QA_GATES fallback)
		}
	} catch (gateLoadError) {
		safeWarn(
			`[phase_complete] QA gate profile load error, drift_check defaults to enabled:`,
			gateLoadError,
		);
	}

	if (!driftCheckEnabled) {
		// drift_check gate disabled — skip drift verification entirely
		return {
			blocked: false,
			agentsDispatched,
			agentsMissing: [],
			warnings: [
				`drift_check gate is disabled. Drift verification was skipped for phase ${phase}.`,
			],
		};
	}

	// drift_check enabled — run drift verification
	// First: check phase type annotation — non-code phases skip entirely
	let phaseType: string | undefined;
	try {
		const planPath = path.join(dir, '.swarm', 'plan.json');
		if (fs.existsSync(planPath)) {
			const planRaw = fs.readFileSync(planPath, 'utf-8');
			const plan = JSON.parse(planRaw);
			const targetPhase = plan.phases?.find(
				(p: { id: number }) => p.id === phase,
			);
			phaseType = targetPhase?.type;
		}
	} catch {
		// plan.json missing or unreadable — phaseType stays undefined
	}

	if (phaseType === 'non-code') {
		return {
			blocked: false,
			agentsDispatched,
			agentsMissing: [],
			warnings: [
				`Phase ${phase} is annotated as 'non-code'. Drift verification was skipped per phase type annotation.`,
			],
		};
	}

	// Code phase — proceed with drift evidence checking
	try {
		const driftEvidencePath = path.join(
			dir,
			'.swarm',
			'evidence',
			String(phase),
			'drift-verifier.json',
		);
		let driftVerdictFound = false;
		let driftVerdictApproved = false;

		try {
			const driftEvidenceContent = fs.readFileSync(driftEvidencePath, 'utf-8');
			const driftEvidence = JSON.parse(driftEvidenceContent);
			const entries = driftEvidence.entries ?? [];

			for (const entry of entries) {
				if (
					typeof entry.type === 'string' &&
					entry.type.includes('drift') &&
					typeof entry.verdict === 'string'
				) {
					driftVerdictFound = true;

					// Provenance verification (issue #893 follow-up, F-001)
					// Advisory warning when provenance is missing
					if (
						!entry.provenance ||
						(!entry.provenance.agent_name && !entry.provenance.session_id)
					) {
						const msg = `Drift verification evidence lacks provenance for phase ${phase}. Evidence should include agent_name or session_id for verification.`;
						gateWarnings.push(msg);
						safeWarn(`[phase_complete] ${msg}`, undefined);
					}

					if (entry.verdict === 'approved') {
						driftVerdictApproved = true;
					}
					// Check if summary indicates needs_revision
					if (
						entry.verdict === 'rejected' ||
						(typeof entry.summary === 'string' &&
							entry.summary.includes('NEEDS_REVISION'))
					) {
						return {
							blocked: true,
							reason: 'DRIFT_VERIFICATION_REJECTED',
							message: `Phase ${phase} cannot be completed: drift verifier returned verdict '${entry.verdict}'. Address the drift issues before completing the phase.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
				}
			}
		} catch (readError) {
			// File doesn't exist or is invalid JSON
			if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
				safeWarn(
					`[phase_complete] Drift verifier evidence unreadable:`,
					readError,
				);
			}
			// Treat as missing — fall through to blocked check below
			driftVerdictFound = false;
		}

		if (!driftVerdictFound) {
			if (!driftHasEffectiveSpec) {
				// No effective spec — drift verification is advisory-only
				// Check task completion status for advisory message quality
				let incompleteTaskCount = 0;
				let planParseable = false;
				try {
					const planPath = path.join(dir, '.swarm', 'plan.json');
					if (fs.existsSync(planPath)) {
						const planRaw = fs.readFileSync(planPath, 'utf-8');
						const plan = JSON.parse(planRaw);
						planParseable = true;
						const planPhase = plan.phases?.find(
							(p: { id: number }) => p.id === phase,
						);
						if (planPhase?.tasks) {
							incompleteTaskCount = planPhase.tasks.filter(
								(t: { status?: string }) =>
									t.status !== 'completed' && t.status !== 'closed',
							).length;
						}
					}
				} catch {
					// plan.json unreadable or malformed — planParseable stays false
				}

				if (!planParseable) {
					return {
						blocked: false,
						agentsDispatched,
						agentsMissing: [],
						warnings: [
							`No effective spec found and drift verification evidence missing — consider running critic_drift_verifier before phase completion.`,
						],
					};
				} else if (incompleteTaskCount > 0) {
					return {
						blocked: false,
						agentsDispatched,
						agentsMissing: [],
						warnings: [
							`No effective spec found and drift verification evidence missing. Phase ${phase} has ${incompleteTaskCount} incomplete task(s) in plan.json — consider running critic_drift_verifier before phase completion.`,
						],
					};
				} else {
					return {
						blocked: false,
						agentsDispatched,
						agentsMissing: [],
						warnings: [
							`No effective spec found. Phase ${phase} tasks are all completed in plan.json. Drift verification was skipped.`,
						],
					};
				}
			} else {
				// Effective spec exists AND drift evidence missing — hard block
				return {
					blocked: true,
					reason: 'DRIFT_VERIFICATION_MISSING',
					message: `Phase ${phase} cannot be completed: drift_check is enabled and drift verifier evidence not found at .swarm/evidence/${phase}/drift-verifier.json. Run drift verification before completing the phase.`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
			}
		}

		if (!driftVerdictApproved && driftVerdictFound) {
			return {
				blocked: true,
				reason: 'DRIFT_VERIFICATION_REJECTED',
				message: `Phase ${phase} cannot be completed: drift verifier verdict is not approved.`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [],
			};
		}

		return {
			blocked: false,
			agentsDispatched,
			agentsMissing: [],
			warnings: gateWarnings,
		};
	} catch (driftError) {
		// Hard block — drift verification errors prevent phase completion
		return {
			blocked: true,
			reason: 'DRIFT_VERIFICATION_ERROR',
			message: `Phase ${phase} cannot be completed: drift verification encountered an error: ${driftError instanceof Error ? driftError.message : String(driftError)}. This is a hard block — resolve the error before completing the phase.`,
			agentsDispatched,
			agentsMissing: [],
			warnings: [],
		};
	}
}
