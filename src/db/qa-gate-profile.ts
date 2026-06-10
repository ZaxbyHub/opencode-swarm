/**
 * Service layer for the `qa_gate_profile` table in the per-project database.
 *
 * A QA gate profile is keyed by plan_id and captures which QA gates are
 * enabled for that plan. Profiles are locked after critic approval; once
 * locked, row updates are rejected by a SQLite trigger and by this service.
 * Sessions can only ratchet gates tighter (enable more), never disable them.
 */

import { createHash } from 'node:crypto';
import { getProjectDb, projectDbExists } from './project-db.js';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	getProfile: typeof getProfile;
	getOrCreateProfile: typeof getOrCreateProfile;
	setGates: typeof setGates;
	getEffectiveGates: typeof getEffectiveGates;
	computeProfileHash: typeof computeProfileHash;
} = {
	getProfile,
	getOrCreateProfile,
	setGates,
	getEffectiveGates,
	computeProfileHash,
};

/**
 * QA gate flags. All eleven gates are tracked explicitly.
 */
export interface QaGates {
	reviewer: boolean;
	test_engineer: boolean;
	council_mode: boolean;
	sme_enabled: boolean;
	critic_pre_plan: boolean;
	hallucination_guard: boolean;
	sast_enabled: boolean;
	mutation_test: boolean;
	phase_council: boolean;
	drift_check: boolean;
	final_council: boolean;
}

/**
 * Default QA gate configuration for newly-created profiles.
 */
export const DEFAULT_QA_GATES: QaGates = {
	reviewer: true,
	test_engineer: true,
	council_mode: false,
	sme_enabled: true,
	critic_pre_plan: true,
	hallucination_guard: false,
	sast_enabled: true,
	mutation_test: false,
	phase_council: false,
	drift_check: true,
	final_council: false,
};

/**
 * Row-level representation of a persisted QA gate profile.
 */
export interface QaGateProfile {
	id: number;
	plan_id: string;
	created_at: string;
	project_type: string | null;
	gates: QaGates;
	locked_at: string | null;
	locked_by_snapshot_seq: number | null;
}

interface QaGateProfileRow {
	id: number;
	plan_id: string;
	created_at: string;
	project_type: string | null;
	gates: string;
	locked_at: string | null;
	locked_by_snapshot_seq: number | null;
}

function rowToProfile(row: QaGateProfileRow): QaGateProfile {
	let parsed: Partial<QaGates> = {};
	try {
		const maybeGates = JSON.parse(row.gates);
		if (
			maybeGates &&
			typeof maybeGates === 'object' &&
			!Array.isArray(maybeGates)
		) {
			parsed = maybeGates as Partial<QaGates>;
		}
	} catch {
		parsed = {};
	}
	// Backward compat: council_mode used to trigger phase-level council too.
	// Old profiles with council_mode: true but no phase_council field are migrated
	// to phase_council: true (preserving phase-level review) and council_mode: false
	// (avoiding the new per-task Stage B replacement semantics for legacy users).
	const raw = parsed as Record<string, unknown>;
	if (raw.council_mode === true && raw.phase_council === undefined) {
		parsed.phase_council = true;
		parsed.council_mode = false;
	}
	// Filter to known gate keys only — prevents legacy/removed gate fields
	// (e.g. council_general_review) from leaking into the live gates object.
	const knownKeys = new Set(Object.keys(DEFAULT_QA_GATES));
	const filteredParsed: Partial<QaGates> = {};
	for (const key of Object.keys(parsed) as Array<keyof QaGates>) {
		if (knownKeys.has(key)) {
			filteredParsed[key] = parsed[key];
		}
	}
	const gates: QaGates = { ...DEFAULT_QA_GATES, ...filteredParsed };
	return {
		id: row.id,
		plan_id: row.plan_id,
		created_at: row.created_at,
		project_type: row.project_type,
		gates,
		locked_at: row.locked_at,
		locked_by_snapshot_seq: row.locked_by_snapshot_seq,
	};
}

/**
 * Fetch the profile for `planId` or return null if none exists.
 *
 * Read-only: if `.swarm/swarm.db` does not exist yet, returns null
 * without creating the DB file or running migrations. This keeps callers
 * on read-only paths (`get_approved_plan`, `get_qa_gate_profile`, the
 * `qa-gates show` command) from silently mutating the workspace just by
 * looking for a profile. Write paths (`getOrCreateProfile`, `setGates`,
 * `lockProfile`) continue to initialize the DB on demand.
 */
export function getProfile(
	directory: string,
	planId: string,
): QaGateProfile | null {
	if (!projectDbExists(directory)) return null;
	const db = getProjectDb(directory);
	const row = db
		.query<QaGateProfileRow, [string]>(
			'SELECT * FROM qa_gate_profile WHERE plan_id = ?',
		)
		.get(planId);
	return row ? rowToProfile(row) : null;
}

/**
 * Return the existing profile for `planId`, or create a new one seeded with
 * `DEFAULT_QA_GATES` if none exists. Tolerates races on the UNIQUE index.
 */
export function getOrCreateProfile(
	directory: string,
	planId: string,
	projectType?: string,
): QaGateProfile {
	const existing = _internals.getProfile(directory, planId);
	if (existing) return existing;

	const db = getProjectDb(directory);
	const gatesJson = JSON.stringify(DEFAULT_QA_GATES);
	const insert = db.transaction(() => {
		db.run(
			'INSERT INTO qa_gate_profile (plan_id, project_type, gates) VALUES (?, ?, ?)',
			[planId, projectType ?? null, gatesJson],
		);
	});
	try {
		insert();
	} catch (err) {
		// UNIQUE race: another caller created the row — fall through to re-query
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.toLowerCase().includes('unique')) {
			throw err;
		}
	}

	const after = _internals.getProfile(directory, planId);
	if (!after) {
		throw new Error(
			`Failed to create or load QA gate profile for plan_id=${planId}`,
		);
	}
	return after;
}

/**
 * Update gates for `planId`. Gates can only be ratcheted tighter —
 * attempting to disable a currently-enabled gate throws. Throws if the
 * profile is locked.
 */
export function setGates(
	directory: string,
	planId: string,
	gates: Partial<QaGates>,
): QaGateProfile {
	const current = _internals.getProfile(directory, planId);
	if (!current) {
		throw new Error(
			`No QA gate profile found for plan_id=${planId} — call getOrCreateProfile first`,
		);
	}
	if (current.locked_at !== null) {
		throw new Error(
			'Cannot modify gates: QA gate profile is locked after critic approval',
		);
	}

	const merged: QaGates = { ...current.gates };
	for (const key of Object.keys(gates) as Array<keyof QaGates>) {
		const incoming = gates[key];
		if (incoming === undefined) continue;
		if (incoming === false && current.gates[key] === true) {
			throw new Error(
				`Cannot disable gate '${key}': sessions can only ratchet tighter`,
			);
		}
		if (incoming === true) {
			merged[key] = true;
		}
	}

	const db = getProjectDb(directory);
	db.run('UPDATE qa_gate_profile SET gates = ? WHERE plan_id = ?', [
		JSON.stringify(merged),
		planId,
	]);

	const updated = _internals.getProfile(directory, planId);
	if (!updated) {
		throw new Error(
			`Failed to re-read QA gate profile after update for plan_id=${planId}`,
		);
	}
	return updated;
}

/**
 * Lock the profile for `planId`, recording the snapshot seq that anchors it.
 * Idempotent: locking an already-locked profile returns it unchanged.
 */
export function lockProfile(
	directory: string,
	planId: string,
	snapshotSeq: number,
): QaGateProfile {
	const current = _internals.getProfile(directory, planId);
	if (!current) {
		throw new Error(
			`No QA gate profile found for plan_id=${planId} — cannot lock`,
		);
	}
	if (current.locked_at !== null) {
		return current;
	}
	const db = getProjectDb(directory);
	db.run(
		"UPDATE qa_gate_profile SET locked_at = datetime('now'), locked_by_snapshot_seq = ? WHERE plan_id = ?",
		[snapshotSeq, planId],
	);
	const locked = _internals.getProfile(directory, planId);
	if (!locked) {
		throw new Error(
			`Failed to re-read locked QA gate profile for plan_id=${planId}`,
		);
	}
	return locked;
}

/**
 * Compute a SHA-256 hex digest over the stable identity of a profile.
 * Used by `get_approved_plan` for drift detection.
 */
export function computeProfileHash(profile: QaGateProfile): string {
	const payload = JSON.stringify({
		plan_id: profile.plan_id,
		gates: profile.gates,
	});
	return createHash('sha256').update(payload).digest('hex');
}

/**
 * Merge session-level gate overrides on top of the spec-level profile.
 * Session overrides can only ratchet gates tighter (set to true); false
 * values in overrides are ignored.
 *
 * IMPORTANT — caller responsibility: this function is the *computation*
 * of effective gates, not an enforcement point. Enforcement consumers
 * must call this at their own check sites, passing the current profile
 * from `getProfile` and the agent session's `qaGateSessionOverrides ?? {}`.
 * Reading raw `profile.gates` directly from an enforcement site will
 * silently ignore operator-applied session overrides.
 *
 * Active enforcement consumers (keep this list in sync when wiring new gates):
 * - reviewer / test_engineer — src/hooks/delegation-gate.ts (Stage B state
 *   machine; blocks coder→next-coder advancement until reviewer + test_engineer
 *   delegations observed).
 * - council_mode — src/state.ts isCouncilGateActive + src/hooks/delegation-gate.ts
 *   (replaces per-task Stage B with full 5-member council via submit_council_verdicts).
 * - sme_enabled — consumed during MODE: BRAINSTORM/SPECIFY architect dialogue.
 * - critic_pre_plan — consumed by MODE: PLAN critic delegation before save_plan.
 * - sast_enabled — consumed inside pre_check_batch tool.
 * - hallucination_guard — src/tools/phase-complete.ts Gate 3 (blocks phase_complete
 *   until .swarm/evidence/{phase}/hallucination-guard.json has APPROVED verdict).
 * - mutation_test — src/tools/phase-complete.ts Gate 4 (blocks phase_complete
 *   until .swarm/evidence/{phase}/mutation-gate.json has pass verdict; warn does not block)
 * - phase_council — src/tools/phase-complete/gates/phase-council-gate.ts Gate 5
 *   (blocks phase_complete until .swarm/evidence/{phase}/phase-council.json has
 *   approved verdict from 5-member holistic phase review).
 * - drift_check — src/tools/phase-complete.ts Gate 2 (blocks phase_complete when
 *   drift-verifier.json missing or rejected)
 * - final_council — src/tools/write-final-council-evidence.ts (blocks project
 *   completion until .swarm/evidence/final-council.json has approved verdict
 *   from 5-member project-scope review).
 *
 * Session overrides are intentionally ephemeral — they live only in
 * in-memory `AgentSessionState.qaGateSessionOverrides` and are NOT
 * persisted to the session snapshot. Process restart clears them.
 */
export function getEffectiveGates(
	profile: QaGateProfile,
	sessionOverrides: Partial<QaGates>,
): QaGates {
	const merged: QaGates = { ...profile.gates };
	for (const key of Object.keys(sessionOverrides) as Array<keyof QaGates>) {
		if (sessionOverrides[key] === true) {
			merged[key] = true;
		}
	}
	return merged;
}
