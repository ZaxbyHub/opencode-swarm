/**
 * Gate 3 – Hallucination Guard.
 * Conditional on hallucination_guard QA gate flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatLegacyQaBindingRecovery } from '../../../qa-gate/recovery.js';
import { resolveGatePreamble } from './gate-helpers';
import type { GateContext, GateResult } from './types';

export async function runHallucinationGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

	let hallucinationGateEnabled = false;

	try {
		const preamble = await resolveGatePreamble(dir, sessionID);

		if (
			preamble.resolved &&
			preamble.effectiveGates?.hallucination_guard === true
		) {
			hallucinationGateEnabled = true;
			if (preamble.identityBound === false) {
				return {
					blocked: true,
					reason: 'HALLUCINATION_VERIFICATION_IDENTITY_UNBOUND',
					message: `Phase ${phase} cannot be completed: hallucination_guard is enabled but the QA gate profile is not exact-bound to the current raw swarm_id/plan_title. ${formatLegacyQaBindingRecovery(
						{ swarm: preamble.plan!.swarm, title: preamble.plan!.title },
						'retry completing the phase',
					)}`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
			}
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
	} catch (hgError) {
		if (hallucinationGateEnabled) {
			// Fail-closed: hallucination gate errors block phase completion (issue #2099 recurrence)
			return {
				blocked: true,
				reason: 'HALLUCINATION_GATE_ERROR',
				message: `Phase ${phase} cannot be completed: hallucination guard gate encountered an error when hallucination_guard was enabled. Error: ${String(hgError)}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [`HALLUCINATION_GATE_ERROR: ${String(hgError)}`],
			};
		} else {
			// Non-blocking when hallucination_guard is off
			safeWarn(
				`[phase_complete] Hallucination guard error (non-blocking):`,
				hgError,
			);
		}
	}

	return { blocked: false, agentsDispatched, agentsMissing: [], warnings: [] };
}
