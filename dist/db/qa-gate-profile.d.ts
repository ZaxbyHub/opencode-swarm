/**
 * Service layer for the `qa_gate_profile` table in the per-project database.
 *
 * A QA gate profile is keyed by plan_id and captures which QA gates are
 * enabled for that plan. Profiles are locked after critic approval; once
 * locked, row updates are rejected by a SQLite trigger and by this service.
 * Sessions can only ratchet gates tighter (enable more), never disable them.
 */
/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    getProfile: typeof getProfile;
    getOrCreateProfile: typeof getOrCreateProfile;
    setGates: typeof setGates;
    getEffectiveGates: typeof getEffectiveGates;
    computeProfileHash: typeof computeProfileHash;
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
    council_general_review: boolean;
    drift_check: boolean;
    final_council: boolean;
}
/**
 * Default QA gate configuration for newly-created profiles.
 */
export declare const DEFAULT_QA_GATES: QaGates;
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
export declare function getProfile(directory: string, planId: string): QaGateProfile | null;
/**
 * Return the existing profile for `planId`, or create a new one seeded with
 * `DEFAULT_QA_GATES` if none exists. Tolerates races on the UNIQUE index.
 */
export declare function getOrCreateProfile(directory: string, planId: string, projectType?: string): QaGateProfile;
/**
 * Update gates for `planId`. Gates can only be ratcheted tighter —
 * attempting to disable a currently-enabled gate throws. Throws if the
 * profile is locked.
 */
export declare function setGates(directory: string, planId: string, gates: Partial<QaGates>): QaGateProfile;
/**
 * Lock the profile for `planId`, recording the snapshot seq that anchors it.
 * Idempotent: locking an already-locked profile returns it unchanged.
 */
export declare function lockProfile(directory: string, planId: string, snapshotSeq: number): QaGateProfile;
/**
 * Compute a SHA-256 hex digest over the stable identity of a profile.
 * Used by `get_approved_plan` for drift detection.
 */
export declare function computeProfileHash(profile: QaGateProfile): string;
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
 *   (Stage B replaced by submit_council_verdicts verdict).
 * - sme_enabled — consumed during MODE: BRAINSTORM/SPECIFY architect dialogue.
 * - critic_pre_plan — consumed by MODE: PLAN critic delegation before save_plan.
 * - sast_enabled — consumed inside pre_check_batch tool.
 * - hallucination_guard — src/tools/phase-complete.ts Gate 3 (blocks phase_complete
 *   until .swarm/evidence/{phase}/hallucination-guard.json has APPROVED verdict).
 * - mutation_test — src/tools/phase-complete.ts Gate 4 (blocks phase_complete
 *   until .swarm/evidence/{phase}/mutation-gate.json has pass verdict; warn does not block)
 * - council_general_review — src/agents/architect.ts SPECIFY-COUNCIL-REVIEW
 *   (fires when gate is true; runs convene_general_council on draft spec before
 *   critic-gate to fold multi-model deliberation into the spec).
 * - drift_check — src/tools/phase-complete.ts Gate 2 (blocks phase_complete when
 *   drift-verifier.json missing or rejected)
 *
 * Session overrides are intentionally ephemeral — they live only in
 * in-memory `AgentSessionState.qaGateSessionOverrides` and are NOT
 * persisted to the session snapshot. Process restart clears them.
 */
export declare function getEffectiveGates(profile: QaGateProfile, sessionOverrides: Partial<QaGates>): QaGates;
