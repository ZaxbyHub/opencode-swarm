/**
 * Gate 5 – Phase Council.
 * Conditional on phase_council QA gate flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
} from '../../../council/council-review-identity';
import { formatLegacyQaBindingRecovery } from '../../../qa-gate/recovery.js';
import { resolveGatePreamble } from './gate-helpers';
import type { GateContext, GateResult } from './types';

function readLatestRetroTimestampMs(dir: string, phase: number): number | null {
	const baseDir = path.normalize(path.resolve(dir, '.swarm'));
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
		return latestRetroTimestampMsFromBundle(
			JSON.parse(fs.readFileSync(retroPath, 'utf-8')),
			phase,
		);
	} catch {
		return null;
	}
}

export async function runPhaseCouncilGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, sessionID, pluginConfig, agentsDispatched, safeWarn } =
		ctx;

	const gateWarnings: string[] = [];

	let councilModeEnabled = false;

	try {
		const preamble = await resolveGatePreamble(dir, sessionID);

		if (
			preamble.resolved &&
			preamble.effectiveGates?.phase_council === true &&
			pluginConfig.council?.enabled === true
		) {
			if (preamble.identityBound === false) {
				return {
					blocked: true,
					reason: 'PHASE_COUNCIL_IDENTITY_UNBOUND',
					message: `Phase ${phase} cannot be completed: phase_council is enabled but the QA gate profile is not exact-bound to the current raw swarm_id/plan_title. ${formatLegacyQaBindingRecovery(
						{ swarm: preamble.plan!.swarm, title: preamble.plan!.title },
						'retry completing the phase',
					)}`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
			}
			councilModeEnabled = true;
			// Same shared identity implementation the phase writer used
			// (issue #2102 contracts A/H).
			const identity = computeCouncilReviewIdentity({
				level: 'phase',
				scope: { kind: 'phase', phaseNumber: phase },
				plan: preamble.plan ?? null,
				config: pluginConfig.council,
			});
			const maxAgeMs = resolveCouncilFreshnessMaxAgeMs(pluginConfig.council);
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
						pcPhaseNumber =
							typeof entry.phase_number === 'number'
								? entry.phase_number
								: typeof entry.phase === 'number'
									? entry.phase
									: undefined;

						// Phase number must match before identity binding so a
						// wrong-phase entry reports the precise mismatch instead of
						// surfacing as an identity failure.
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

						// Centralized freshness (issue #2102 contract D): shared
						// evaluator + one captured preflight clock + one config bound.
						// Evidence must postdate this phase's retrospective when one
						// exists.
						const freshness = evaluateCouncilFreshness({
							nowMs: ctx.preflightNowMs,
							timestampMs: parseTimestampMs(entry.timestamp),
							maxAgeMs,
							// Prefer the retro bundle already captured by the aggregate preflight;
							// fall back to disk only when no bundle was loaded (PRR-021(g)).
							mustPostdateMs:
								latestRetroTimestampMsFromBundle(
									ctx.loadedRetroBundle,
									phase,
								) ?? readLatestRetroTimestampMs(dir, phase),
						});
						if (!freshness.ok) {
							const reasonByFailure: Record<string, string> = {
								invalid_timestamp: 'PHASE_COUNCIL_INVALID_TIMESTAMP',
								future_timestamp: 'PHASE_COUNCIL_FUTURE_TIMESTAMP',
								stale_evidence: 'PHASE_COUNCIL_STALE_EVIDENCE',
								predates_required_input: 'PHASE_COUNCIL_STALE_EVIDENCE',
								invalid_required_input: 'PHASE_COUNCIL_INVALID_REQUIRED_INPUT',
							};
							return {
								blocked: true,
								reason:
									reasonByFailure[freshness.reason ?? ''] ??
									'PHASE_COUNCIL_STALE_EVIDENCE',
								message: `Phase ${phase} cannot be completed: phase council ${freshness.message}. ${freshness.recovery}`,
								agentsDispatched,
								agentsMissing: [],
								warnings: [],
							};
						}

						// Canonical review identity binding (issue #2102): review hash
						// + policy digest. Status-only progress keeps the identity
						// stable; legacy evidence without identity proof fails closed.
						if (entry.identity_version !== COUNCIL_REVIEW_IDENTITY_VERSION) {
							return {
								blocked: true,
								reason: entry.identity_version
									? 'PHASE_COUNCIL_IDENTITY_MISMATCH'
									: 'PHASE_COUNCIL_IDENTITY_REQUIRED',
								message: `Phase ${phase} cannot be completed: phase council evidence ${entry.identity_version ? `was produced under a different council identity schema version (${entry.identity_version}, expected ${COUNCIL_REVIEW_IDENTITY_VERSION})` : 'predates the council review identity cutover and carries no identity proof'}. Re-convene the phase council for the current plan and policy.`,
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
								reason: 'PHASE_COUNCIL_STALE_REVIEW_IDENTITY',
								message: `Phase ${phase} cannot be completed: phase council evidence does not match the current council review identity (review-relevant plan content changed since the review). Re-convene the phase council.`,
								agentsDispatched,
								agentsMissing: [],
								warnings: [],
							};
						}
						if (entry.policy_digest !== identity.policyDigest) {
							return {
								blocked: true,
								reason: entry.policy_digest
									? 'PHASE_COUNCIL_POLICY_MISMATCH'
									: 'PHASE_COUNCIL_IDENTITY_REQUIRED',
								message: `Phase ${phase} cannot be completed: phase council evidence was produced under a different council policy. Re-convene the phase council under the current policy.`,
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
							safeWarn(`[phase_complete] ${msg}`, undefined);
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

						if (entry.verdict === 'CONCERNS' || entry.verdict === 'concerns') {
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

			// Validate quorum against the SAME task/phase quorum config the
			// evidence writer enforced (the policy digest check above already
			// proves the evidence was produced under this exact policy).
			const effectiveMinimum = pluginConfig.council.requireAllMembers
				? 5
				: (pluginConfig.council.minimumMembers ?? 3);
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
			if (pcQuorumSize < effectiveMinimum) {
				return {
					blocked: true,
					reason: 'PHASE_COUNCIL_INSUFFICIENT_QUORUM',
					message: `Phase ${phase} cannot be completed: phase council quorum (${pcQuorumSize}) is below minimum (${effectiveMinimum}). Re-convene council with sufficient members.`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
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

	return {
		blocked: false,
		agentsDispatched,
		agentsMissing: [],
		warnings: gateWarnings,
	};
}
