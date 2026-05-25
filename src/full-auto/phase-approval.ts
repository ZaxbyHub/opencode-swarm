/**
 * Full-Auto v2 phase-completion approval gate.
 *
 * Runs near the end of phase_complete, after the existing completion-verify
 * / drift / hallucination / mutation / phase-council gates. Its purpose is
 * to ensure that, when Full-Auto v2 is the active autonomy regime, the
 * critic_oversight agent has actually approved the phase via the new
 * `full_auto_oversight` evidence pipeline.
 *
 * Rules:
 *   - If Full-Auto v2 is not enabled in config OR the durable run state is
 *     not active, the gate is a no-op.
 *   - When active:
 *       * Look for `.swarm/evidence/{phase}/full-auto-*.json` events written
 *         by the shared oversight service.
 *       * Filter to records with `trigger_source === 'phase_boundary'` AND
 *         `verdict === 'APPROVED'`. (M9: an incidental APPROVED tool-action
 *         record CANNOT stand in for a phase-boundary approval.)
 *       * `evidence_checked` MUST be non-empty by default. (TASK 5: the
 *         previous "soft pass" when consecutiveNoProgressTurns === 0 was a
 *         design bug — that counter is unrelated to whether code changed
 *         in the phase.) The non-code-phase exception is granted ONLY when
 *         BOTH conditions are source-proven:
 *           1. plan.json marks the phase with `type` / `non_code` / `kind`
 *              indicating it is a non-code phase (docs/spec/research/etc.).
 *           2. There are no changed-files signals for the phase (no diff,
 *              no coder delegations recorded in run-state counters).
 *         If either cannot be proven, the gate fails closed.
 *       * Stale records (older than 24h) block.
 *       * Missing/unparseable records block.
 *
 * Turbo interaction:
 *   - When Full-Auto v2 is active, Turbo does NOT bypass this gate by
 *     default. The caller must opt in explicitly via
 *     `config.full_auto.permission_policy.allow_defaults === false` AND the
 *     turbo bypass already in phase_complete. To keep behavior fail-closed,
 *     the gate ignores Turbo on its own and relies on the existing
 *     `hasActiveTurboMode` short-circuit only when Full-Auto v2 is NOT
 *     active.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import { validateSwarmPath } from '../hooks/utils';
import * as logger from '../utils/logger';
import { isFullAutoRunActive, loadFullAutoRunState } from './state';

export interface PhaseApprovalDecision {
	ok: boolean;
	reason?: string;
	evidence?: Record<string, unknown>;
}

interface PersistedOversightEvent {
	type?: string;
	timestamp?: string;
	phase?: number;
	verdict?: string;
	decision?: string;
	trigger_source?: string;
	evidence_checked?: string[];
	full_auto_status_after?: string;
	[key: string]: unknown;
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function readEvidenceDir(directory: string, phase: number): string[] {
	try {
		const dirPath = validateSwarmPath(
			directory,
			path.posix.join('evidence', String(phase)),
		);
		if (!fs.existsSync(dirPath)) return [];
		const entries = fs.readdirSync(dirPath);
		return entries
			.filter((e) => e.startsWith('full-auto-') && e.endsWith('.json'))
			.map((e) => path.join(dirPath, e));
	} catch {
		return [];
	}
}

function parseEvidence(filePath: string): PersistedOversightEvent | undefined {
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as PersistedOversightEvent;
		return parsed;
	} catch (error) {
		logger.warn(
			`[full-auto/phase-approval] failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function verifyFullAutoPhaseApproval(
	directory: string,
	sessionID: string | undefined,
	phase: number,
	config: PluginConfig,
): PhaseApprovalDecision {
	const fullAutoConfig = config.full_auto;
	const enabled = fullAutoConfig?.enabled === true;
	if (!enabled) return { ok: true, reason: 'full_auto disabled' };
	if (!sessionID) return { ok: true, reason: 'no sessionID — gate skipped' };
	if (!isFullAutoRunActive(directory, sessionID)) {
		return { ok: true, reason: 'no active Full-Auto run' };
	}

	const failClosed = fullAutoConfig?.fail_closed !== false;
	const files = readEvidenceDir(directory, phase);
	if (files.length === 0) {
		return failClosed
			? {
					ok: false,
					reason: `Full-Auto v2 active but no full-auto oversight evidence found at .swarm/evidence/${phase}/`,
				}
			: {
					ok: true,
					reason: 'no evidence and fail_closed=false',
				};
	}

	const events = files
		.map((f) => parseEvidence(f))
		.filter((e): e is PersistedOversightEvent => Boolean(e));
	// M9 fix: tighten the eligibility filter. Phase approval requires an
	// explicit phase_boundary record with verdict APPROVED. An incidental
	// allow/APPROVED record from a tool-action escalation earlier in the
	// phase is NOT a phase boundary and cannot stand in for one.
	const phaseBoundary = events.filter(
		(e) =>
			e.phase === phase &&
			e.trigger_source === 'phase_boundary' &&
			(e.verdict ?? '').toUpperCase() === 'APPROVED',
	);
	if (phaseBoundary.length === 0) {
		return failClosed
			? {
					ok: false,
					reason: `Full-Auto v2 active but no phase-boundary oversight record found for phase ${phase}`,
				}
			: { ok: true, reason: 'no phase-boundary record and fail_closed=false' };
	}

	// Find most recent.
	phaseBoundary.sort((a, b) => {
		const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
		const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
		return tb - ta;
	});
	const latest = phaseBoundary[0];
	const verdict = latest.verdict?.toUpperCase() ?? '';

	if (verdict !== 'APPROVED') {
		return {
			ok: false,
			reason: `Full-Auto oversight verdict for phase ${phase} is ${verdict || 'MISSING'} (required: APPROVED)`,
			evidence: latest as Record<string, unknown>,
		};
	}

	// Staleness check.
	// Adversarial review H1 fix: also reject negative ages (future-dated
	// timestamps). A forged or clock-skewed timestamp 100 days in the
	// future would otherwise pass `age > APPROVAL_TTL_MS` because the
	// computed age is negative. Allow a small forward skew (5 minutes)
	// to accommodate legitimate clock drift between processes.
	const FORWARD_SKEW_MS = 5 * 60 * 1000;
	const ts = latest.timestamp ? Date.parse(latest.timestamp) : 0;
	const age = Date.now() - ts;
	if (!ts || age < -FORWARD_SKEW_MS || age > APPROVAL_TTL_MS) {
		const reason =
			age < -FORWARD_SKEW_MS
				? `Full-Auto oversight evidence for phase ${phase} has a future timestamp (${latest.timestamp}); rejected as forged or clock-skewed`
				: `Full-Auto oversight evidence for phase ${phase} is stale (>24h)`;
		return {
			ok: false,
			reason,
			evidence: latest as Record<string, unknown>,
		};
	}

	// TASK 5: evidence_checked MUST be non-empty by default. The narrow
	// exception is a phase that is explicitly marked non-code in plan.json
	// AND has produced no changed-files signal during the run. Both
	// conditions must be source-proven; otherwise the gate fails closed.
	const evidenceChecked = Array.isArray(latest.evidence_checked)
		? latest.evidence_checked
		: [];
	if (evidenceChecked.length === 0) {
		const exception = phaseIsExplicitlyNonCode(directory, phase);
		const runState = loadFullAutoRunState(directory, sessionID);
		const codeWorkObserved =
			(runState?.counters.coderDelegations ?? 0) > 0 ||
			(runState?.counters.toolCalls ?? 0) > 0;
		if (!exception || codeWorkObserved) {
			return {
				ok: false,
				reason: !exception
					? `Full-Auto oversight evidence for phase ${phase} has empty evidence_checked and the phase is not declared non-code in plan.json (required: at least one verification source)`
					: `Full-Auto oversight evidence for phase ${phase} has empty evidence_checked while run counters indicate code work was performed`,
				evidence: latest as Record<string, unknown>,
			};
		}
		// Both exception conditions hold — phase is non-code in plan.json AND
		// no code work was observed during the run. Soft-pass.
		return {
			ok: true,
			reason: `Full-Auto oversight APPROVED at ${latest.timestamp} (non-code phase exception)`,
			evidence: latest as Record<string, unknown>,
		};
	}

	return {
		ok: true,
		reason: `Full-Auto oversight APPROVED at ${latest.timestamp}`,
		evidence: latest as Record<string, unknown>,
	};
}

/**
 * Inspect `.swarm/plan.json` to determine whether the given phase is
 * explicitly marked as non-code (docs / spec / research / planning / etc.).
 * Returns `true` only when the plan exists, contains a phase entry whose
 * `type` / `kind` / `non_code` field clearly indicates non-code work.
 *
 * The exception MUST NOT be inferred from omission — if plan.json is
 * missing or the phase entry has no explicit type, this returns `false`
 * and the gate fails closed.
 */
function phaseIsExplicitlyNonCode(directory: string, phase: number): boolean {
	try {
		const planPath = validateSwarmPath(directory, 'plan.json');
		if (!fs.existsSync(planPath)) return false;
		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as {
			phases?: Array<{
				id?: number;
				phase?: number;
				type?: string;
				kind?: string;
				non_code?: boolean;
			}>;
		};
		const phases = Array.isArray(plan.phases) ? plan.phases : [];
		const entry = phases.find((p) => p.id === phase || p.phase === phase);
		if (!entry) return false;
		if (entry.non_code === true) return true;
		const kindOrType = (entry.kind ?? entry.type ?? '')
			.toString()
			.toLowerCase();
		return [
			'docs',
			'documentation',
			'spec',
			'specification',
			'research',
			'planning',
			'plan',
			'non_code',
			'non-code',
			'noncode',
		].includes(kindOrType);
	} catch (error) {
		logger.warn(
			`[full-auto/phase-approval] plan.json inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}
