/**
 * Gate 5b – Architecture Supervision (issue #893).
 * Opt-in, gate mode only.  Reads the raw supervisor sidecar and blocks on a
 * missing/invalid/stale/REJECT verdict.  Unlike Gates 1–5 this gate is NOT
 * turbo-bypassed — enabling mode:'gate' is an explicit opt-in to a hard
 * cross-task coherence check.
 */

import {
	evaluateCouncilFreshness,
	resolveCouncilFreshnessMaxAgeMs,
} from '../../../council/council-freshness';
import { readSupervisorReportRaw } from '../../../summaries/store';
import type { GateContext, GateResult } from './types';

export async function runArchitectureSupervisorGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, pluginConfig, agentsDispatched, safeWarn } = ctx;

	const asConfig = pluginConfig.architectural_supervision;

	// Brief summary of supervisor findings to surface in block messages (parity with
	// the phase-council gate, which echoes requiredFixes).
	const summarizeFindings = (findings: unknown[] | undefined): string => {
		if (!Array.isArray(findings) || findings.length === 0) return '';
		const details = findings
			.map((f) =>
				f &&
				typeof f === 'object' &&
				typeof (f as { description?: unknown }).description === 'string'
					? (f as { description: string }).description
					: undefined,
			)
			.filter((d): d is string => Boolean(d));
		return details.length > 0 ? `\nFindings: ${details.join('; ')}` : '';
	};

	const asBlocked = (reason: string, message: string): GateResult => ({
		blocked: true,
		reason,
		message,
		agentsDispatched,
		agentsMissing: [],
		warnings: [],
	});

	let asEntry: ReturnType<typeof readSupervisorReportRaw> = null;
	try {
		asEntry = readSupervisorReportRaw(dir, phase);
	} catch (asError) {
		// Fail-closed: gate errors block phase completion.
		return asBlocked(
			'ARCH_SUPERVISOR_ERROR',
			`Phase ${phase} cannot be completed: architecture supervisor gate encountered an error. Error: ${String(asError)}`,
		);
	}

	if (!asEntry) {
		return asBlocked(
			'ARCH_SUPERVISOR_REQUIRED',
			`Phase ${phase} cannot be completed: architectural_supervision gate mode is enabled and no architecture supervisor evidence was found at .swarm/evidence/${phase}/architecture-supervisor.json. Dispatch critic_architecture_supervisor with the phase + agent summaries, then call write_architecture_supervisor_evidence.`,
		);
	}

	// Centralized freshness (issue #2102 contract D): the same shared
	// evaluator, captured preflight clock, and council freshness config that
	// govern the phase and final councils also govern this supervisor check.
	// The architecture supervisor is intentionally NOT part of the council
	// review identity/digest scope — it is a single-agent phase review, not a
	// council, and its evidence file stays identity-less.
	const freshness = evaluateCouncilFreshness({
		nowMs: ctx.preflightNowMs,
		timestampMs: asEntry.timestamp
			? new Date(asEntry.timestamp).getTime()
			: null,
		maxAgeMs: resolveCouncilFreshnessMaxAgeMs(ctx.pluginConfig.council),
	});
	if (!freshness.ok) {
		const reasonByFailure: Record<string, string> = {
			invalid_timestamp: 'ARCH_SUPERVISOR_INVALID_TIMESTAMP',
			future_timestamp: 'ARCH_SUPERVISOR_FUTURE_TIMESTAMP',
			stale_evidence: 'ARCH_SUPERVISOR_STALE_EVIDENCE',
			predates_required_input: 'ARCH_SUPERVISOR_STALE_EVIDENCE',
			invalid_required_input: 'ARCH_SUPERVISOR_INVALID_REQUIRED_INPUT',
		};
		return asBlocked(
			reasonByFailure[freshness.reason ?? ''] ??
				'ARCH_SUPERVISOR_STALE_EVIDENCE',
			`Phase ${phase} cannot be completed: architecture supervisor ${freshness.message}. ${freshness.recovery}`,
		);
	}

	// Phase number must match.
	if (
		typeof asEntry.phase_number !== 'number' ||
		asEntry.phase_number !== phase
	) {
		return asBlocked(
			'ARCH_SUPERVISOR_PHASE_MISMATCH',
			`Phase ${phase} cannot be completed: architecture supervisor evidence is for phase ${String(asEntry.phase_number)}, not phase ${phase}.`,
		);
	}

	// Provenance verification (issue #893 follow-up, F-001).
	// When provenance_verify is enabled in gate mode, reject evidence without valid provenance.
	const gateWarnings: string[] = [];
	if (asConfig?.provenance_verify === true) {
		const provenance = asEntry.provenance;
		if (!provenance || (!provenance.agent_name && !provenance.session_id)) {
			return asBlocked(
				'ARCH_SUPERVISOR_MISSING_PROVENANCE',
				`Phase ${phase} cannot be completed: architecture supervisor evidence lacks provenance (agent_name or session_id). Evidence provenance verification is enabled.`,
			);
		}
	} else if (
		!asEntry.provenance ||
		(!asEntry.provenance.agent_name && !asEntry.provenance.session_id)
	) {
		const msg = `Architecture supervisor evidence lacks provenance for phase ${phase}. Enable 'provenance_verify' in architectural_supervision config to enforce provenance verification.`;
		gateWarnings.push(msg);
		safeWarn(`[phase_complete] ${msg}`, undefined);
	}

	// Verdict.
	const asVerdict = asEntry.verdict;
	if (asVerdict === 'REJECT') {
		return asBlocked(
			'ARCH_SUPERVISOR_REJECTED',
			`Phase ${phase} cannot be completed: architecture supervisor returned verdict 'REJECT'. Address the system-level findings before completing the phase.${summarizeFindings(asEntry.findings)}`,
		);
	}
	if (asVerdict === 'CONCERNS') {
		if (asConfig?.allow_concerns_to_complete === false) {
			return asBlocked(
				'ARCH_SUPERVISOR_CONCERNS',
				`Phase ${phase} cannot be completed: architecture supervisor returned verdict 'CONCERNS' and allow_concerns_to_complete is disabled.${summarizeFindings(asEntry.findings)}`,
			);
		}
		safeWarn(
			`[phase_complete] Architecture supervisor returned CONCERNS for phase ${phase} — proceeding (allow_concerns_to_complete is enabled)`,
			undefined,
		);
	} else if (asVerdict !== 'APPROVE') {
		return asBlocked(
			'ARCH_SUPERVISOR_INVALID',
			`Phase ${phase} cannot be completed: architecture supervisor evidence contains unrecognized verdict '${String(asVerdict)}'. Expected one of: APPROVE, CONCERNS, REJECT.`,
		);
	}

	return {
		blocked: false,
		agentsDispatched,
		agentsMissing: [],
		warnings: gateWarnings,
	};
}
