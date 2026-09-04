import { createHash } from 'node:crypto';
import type { GateResult } from './gates/types.js';

const MAX_DETAIL_CHARS = 1024;
const MAX_WARNINGS = 32;
const MAX_ACTORS = 64;
const DEFAULT_GATE_TIMEOUT_MS = 10_000;
const MAX_GATE_TIMEOUT_MS = 30_000;

export type PhaseGateOutcome = 'pass' | 'block' | 'error' | 'not_applicable';

export interface PhaseGateRecovery {
	kind: 'tool' | 'command' | 'retry' | 'user_action';
	action: string;
	args?: Record<string, unknown>;
}

export interface PhaseGateEntry {
	id: string;
	code: string;
	outcome: PhaseGateOutcome;
	detail?: string;
	evidenceRefs: string[];
	responsibleActor: string;
	recovery?: PhaseGateRecovery;
	requiredRecoveryKind?: PhaseGateRecovery['kind'];
	agentsDispatched: string[];
	agentsMissing: string[];
	warnings: string[];
	recoveryGuidance?: string;
	phase_council_required?: boolean;
	final_council_required?: boolean;
	retrospective_gate?: {
		schema_valid: boolean;
		gate_pass: boolean;
		verdict?: 'pass' | 'fail';
	};
}

export interface PhaseGateReport {
	schemaVersion: 1;
	phase: number;
	outcome: 'pass' | 'block';
	reportHash: string;
	entries: PhaseGateEntry[];
}

export interface PhaseGateCheck {
	id: string;
	responsibleActor: string;
	applicable?: boolean;
	notApplicableDetail?: string;
	run: () => Promise<GateResult>;
	timeoutMs?: number;
}

async function runBoundedGate(check: PhaseGateCheck): Promise<GateResult> {
	const timeoutMs = Math.min(
		MAX_GATE_TIMEOUT_MS,
		Math.max(1, check.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			check.run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`${check.id.toUpperCase()}_TIMEOUT: gate read exceeded ${timeoutMs}ms`,
							),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function bounded(value: unknown, fallback = ''): string {
	const text = typeof value === 'string' ? value : fallback;
	return text.length <= MAX_DETAIL_CHARS
		? text
		: `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function boundedStrings(value: unknown, limit = MAX_ACTORS): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === 'string')
		.slice(0, limit)
		.map((item) => bounded(item));
}

function recoveryFrom(result: GateResult): PhaseGateRecovery | undefined {
	const raw = result.recovery;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const candidate = raw as Record<string, unknown>;
	if (
		!['tool', 'command', 'retry', 'user_action'].includes(
			String(candidate.kind),
		) ||
		typeof candidate.action !== 'string' ||
		candidate.action.length === 0
	) {
		return undefined;
	}
	return {
		kind: candidate.kind as PhaseGateRecovery['kind'],
		action: bounded(candidate.action),
		...(candidate.args &&
		typeof candidate.args === 'object' &&
		!Array.isArray(candidate.args)
			? { args: candidate.args as Record<string, unknown> }
			: {}),
	};
}

function defaultBlockedRecovery(
	check: PhaseGateCheck,
	result: GateResult,
): PhaseGateRecovery {
	const toolByGate: Record<string, string> = {
		critical_directives: 'knowledge_receipt',
		retrospective: 'write_retro',
		completion_verify: 'completion_verify',
		drift: 'write_drift_evidence',
		hallucination: 'write_hallucination_evidence',
		mutation: 'write_mutation_evidence',
		final_review: 'run_phase_review',
		lean_turbo_readiness: 'lean_turbo_review',
	};
	const action = toolByGate[check.id];
	if (action) {
		if (check.id === 'lean_turbo_readiness') {
			// Readiness can block on reviewer OR critic evidence (both default
			// true for config-driven lean projects). The advertised action
			// stays lean_turbo_review (a registered tool); the follow_up_tool
			// hint names the critic only when the blocked reason is critic-
			// specific, so the model is not pointed at the wrong producer.
			const blockedOnCritic = /critic/i.test(
				`${result.message ?? ''} ${result.reason ?? ''}`,
			);
			return {
				kind: 'tool' as const,
				action,
				...(blockedOnCritic
					? { args: { follow_up_tool: 'lean_turbo_critic' } }
					: {}),
			};
		}
		return { kind: 'tool', action };
	}
	if (check.id === 'phase_council' || check.id === 'final_council') {
		return {
			kind: 'user_action',
			action: 'Task',
			args: {
				agents: ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'],
				follow_up_tool:
					check.id === 'phase_council'
						? 'submit_phase_council_verdicts'
						: 'write_final_council_evidence',
			},
		};
	}
	if (check.id === 'architecture_supervisor') {
		return {
			kind: 'user_action',
			action: 'Task',
			args: {
				agents: ['critic_architecture_supervisor'],
				follow_up_tool: 'write_architecture_supervisor_evidence',
			},
		};
	}
	if (check.id === 'full_auto_approval') {
		return {
			kind: 'user_action',
			action: 'Task',
			args: { agents: ['critic_oversight'] },
		};
	}
	if (check.id === 'required_agents') {
		return {
			kind: 'user_action',
			action: 'Task',
			args: { agents: boundedStrings(result.agentsMissing) },
		};
	}
	return { kind: 'retry', action: 'phase_complete' };
}

function retrospectiveGateFrom(result: GateResult):
	| {
			schema_valid: boolean;
			gate_pass: boolean;
			verdict?: 'pass' | 'fail';
	  }
	| undefined {
	const raw = result.retrospective_gate;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.schema_valid !== 'boolean' ||
		typeof candidate.gate_pass !== 'boolean'
	) {
		return undefined;
	}
	return {
		schema_valid: candidate.schema_valid,
		gate_pass: candidate.gate_pass,
		...(candidate.verdict === 'pass' || candidate.verdict === 'fail'
			? { verdict: candidate.verdict }
			: {}),
	};
}

function stableReportHash(
	phase: number,
	entries: readonly PhaseGateEntry[],
): string {
	return createHash('sha256')
		.update(JSON.stringify({ schemaVersion: 1, phase, entries }))
		.digest('hex');
}

export async function collectPhaseGateReport(input: {
	phase: number;
	checks: readonly PhaseGateCheck[];
}): Promise<PhaseGateReport> {
	const entries: PhaseGateEntry[] = [];
	for (const check of input.checks) {
		if (check.applicable === false) {
			entries.push({
				id: check.id,
				code: 'NOT_APPLICABLE',
				outcome: 'not_applicable',
				detail: bounded(check.notApplicableDetail, 'gate not applicable'),
				evidenceRefs: [],
				responsibleActor: check.responsibleActor,
				agentsDispatched: [],
				agentsMissing: [],
				warnings: [],
			});
			continue;
		}
		try {
			const result = await runBoundedGate(check);
			const recovery =
				recoveryFrom(result) ??
				(result.blocked ? defaultBlockedRecovery(check, result) : undefined);
			const retrospectiveGate = retrospectiveGateFrom(result);
			entries.push({
				id: check.id,
				code:
					typeof result.reason === 'string'
						? bounded(result.reason)
						: result.blocked
							? `${check.id.toUpperCase()}_BLOCKED`
							: 'PASS',
				outcome: result.blocked ? 'block' : 'pass',
				...(typeof result.message === 'string'
					? { detail: bounded(result.message) }
					: {}),
				evidenceRefs: boundedStrings(result.evidenceRefs),
				responsibleActor: check.responsibleActor,
				...(recovery ? { recovery, requiredRecoveryKind: recovery.kind } : {}),
				...(retrospectiveGate ? { retrospective_gate: retrospectiveGate } : {}),
				agentsDispatched: boundedStrings(result.agentsDispatched),
				agentsMissing: boundedStrings(result.agentsMissing),
				warnings: boundedStrings(result.warnings, MAX_WARNINGS),
				...(typeof result.recovery_guidance === 'string'
					? { recoveryGuidance: bounded(result.recovery_guidance) }
					: {}),
				...(result.phase_council_required === true
					? { phase_council_required: true }
					: {}),
				...(result.final_council_required === true
					? { final_council_required: true }
					: {}),
			});
		} catch (error) {
			entries.push({
				id: check.id,
				code:
					error instanceof Error &&
					error.message.startsWith(`${check.id.toUpperCase()}_TIMEOUT:`)
						? `${check.id.toUpperCase()}_TIMEOUT`
						: `${check.id.toUpperCase()}_ERROR`,
				outcome: 'error',
				detail: bounded(
					error instanceof Error ? error.message : String(error),
					'unknown gate error',
				),
				evidenceRefs: [],
				responsibleActor: check.responsibleActor,
				recovery: { kind: 'retry', action: 'phase_complete' },
				requiredRecoveryKind: 'retry',
				agentsDispatched: [],
				agentsMissing: [],
				warnings: [],
			});
		}
	}
	const outcome = entries.some(
		(entry) => entry.outcome === 'block' || entry.outcome === 'error',
	)
		? 'block'
		: 'pass';
	return {
		schemaVersion: 1,
		phase: input.phase,
		outcome,
		reportHash: stableReportHash(input.phase, entries),
		entries,
	};
}

export function formatPhaseGateCompatibility(report: PhaseGateReport): {
	success: boolean;
	phase: number;
	status: 'success' | 'blocked' | 'incomplete';
	reason?: string;
	message?: string;
	agentsDispatched: string[];
	agentsMissing: string[];
	warnings: string[];
	gate_report: PhaseGateReport;
	retrospective_gate?: {
		schema_valid: boolean;
		gate_pass: boolean;
		verdict?: 'pass' | 'fail';
	};
	recovery_guidance?: string;
	phase_council_required?: boolean;
	final_council_required?: boolean;
} {
	const firstFailure = report.entries.find(
		(entry) => entry.outcome === 'block' || entry.outcome === 'error',
	);
	const retrospectiveEntry = report.entries.find(
		(entry) => entry.id === 'retrospective' && entry.retrospective_gate,
	);
	const recoveryGuidance = report.entries.find(
		(entry) => entry.id === 'required_agents' && entry.recoveryGuidance,
	)?.recoveryGuidance;
	const requiredAgentsEntry = report.entries.find(
		(entry) => entry.id === 'required_agents',
	);
	const dispatched = new Set<string>();
	const missing = new Set<string>();
	const warnings: string[] = [];
	for (const entry of report.entries) {
		for (const actor of entry.agentsDispatched) dispatched.add(actor);
		for (const actor of entry.agentsMissing) missing.add(actor);
		for (const warning of entry.warnings) {
			if (warnings.length < MAX_WARNINGS && !warnings.includes(warning)) {
				warnings.push(warning);
			}
		}
	}
	if (requiredAgentsEntry) {
		dispatched.clear();
		for (const actor of requiredAgentsEntry.agentsDispatched) {
			dispatched.add(actor);
		}
	}
	return {
		success: report.outcome === 'pass',
		phase: report.phase,
		status:
			report.outcome === 'pass'
				? 'success'
				: firstFailure?.code === 'REQUIRED_AGENTS_MISSING'
					? 'incomplete'
					: 'blocked',
		...(firstFailure
			? { reason: firstFailure.code, message: firstFailure.detail }
			: {}),
		agentsDispatched: [...dispatched].sort(),
		agentsMissing: [...missing].sort(),
		warnings,
		gate_report: report,
		...(recoveryGuidance ? { recovery_guidance: recoveryGuidance } : {}),
		...(report.entries.some((entry) => entry.phase_council_required)
			? { phase_council_required: true }
			: {}),
		...(report.entries.some((entry) => entry.final_council_required)
			? { final_council_required: true }
			: {}),
		...(retrospectiveEntry?.retrospective_gate
			? { retrospective_gate: retrospectiveEntry.retrospective_gate }
			: {}),
	};
}
