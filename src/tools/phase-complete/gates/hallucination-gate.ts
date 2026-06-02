/**
 * Gate 3 – Hallucination Guard.
 * Conditional on hallucination_guard QA gate flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEffectiveGates, getProfile } from '../../../db/qa-gate-profile.js';
import { loadPlan } from '../../../plan/manager';
import { derivePlanId } from '../../../plan/utils';
import { swarmState } from '../../../state';
import type { GateContext, GateResult } from './types';

export async function runHallucinationGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

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

				if (effective.hallucination_guard === true) {
					const hgPath = path.join(
						dir,
						'.swarm',
						'evidence',
						String(phase),
						'hallucination-guard.json',
					);
					let hgVerdictFound = false;
					let hgVerdictApproved = false;

					try {
						const hgContent = fs.readFileSync(hgPath, 'utf-8');
						const hgBundle = JSON.parse(hgContent);
						for (const entry of hgBundle.entries ?? []) {
							if (
								typeof entry.type === 'string' &&
								entry.type.includes('hallucination') &&
								typeof entry.verdict === 'string'
							) {
								hgVerdictFound = true;
								if (entry.verdict === 'approved') {
									hgVerdictApproved = true;
								}
								if (
									entry.verdict === 'rejected' ||
									(typeof entry.summary === 'string' &&
										entry.summary.includes('NEEDS_REVISION'))
								) {
									return {
										blocked: true,
										reason: 'HALLUCINATION_VERIFICATION_REJECTED',
										message: `Phase ${phase} cannot be completed: hallucination verifier returned verdict '${entry.verdict}'. Remove fabricated APIs/signatures and fix broken citations before completing the phase.`,
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
								`[phase_complete] Hallucination guard evidence unreadable:`,
								readErr,
							);
						}
						hgVerdictFound = false;
					}

					if (!hgVerdictFound) {
						return {
							blocked: true,
							reason: 'HALLUCINATION_VERIFICATION_MISSING',
							message: `Phase ${phase} cannot be completed: hallucination_guard is enabled and evidence not found at .swarm/evidence/${phase}/hallucination-guard.json. Delegate to critic_hallucination_verifier and call write_hallucination_evidence before completing the phase.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}

					if (!hgVerdictApproved) {
						return {
							blocked: true,
							reason: 'HALLUCINATION_VERIFICATION_REJECTED',
							message: `Phase ${phase} cannot be completed: hallucination verifier verdict is not approved.`,
							agentsDispatched,
							agentsMissing: [],
							warnings: [],
						};
					}
				}
			}
		}
	} catch (hgError) {
		// Non-blocking — treat as warning and continue
		safeWarn(
			`[phase_complete] Hallucination guard error (non-blocking):`,
			hgError,
		);
	}

	return { blocked: false, agentsDispatched, agentsMissing: [], warnings: [] };
}
