/**
 * Test-visible cap seam for every #2483 retention bound (issue #2483 §0).
 *
 * Writers keep their cap constants exported on their own modules (registry
 * citations point there), but ENFORCEMENT must resolve the effective value
 * through {@link resolveRetentionCap} so tests and acceptance checks can
 * shrink a cap below its production default and prove the writer actually
 * clamps. A writer that reads only its own constant is unfalsifiable at cap+1
 * test widths that are impractical to write (10 000 entries / 8 MiB).
 *
 * Pure module: no filesystem, no imports — safe on the init path and under
 * both the Bun and Node hosts (AGENTS.md invariant 2).
 */

/** Canonical cap names (frozen by the #2483 acceptance checks). */
export type RetentionCapName =
	| 'MAX_RETRACTION_RECORDS'
	| 'MAX_UNACKNOWLEDGED_CRITICALS'
	| 'MAX_CURATION_PROPOSALS'
	| 'MAX_CONSOLIDATION_LOG_ENTRIES'
	| 'MAX_CONTEXT_SNAPSHOT_BYTES'
	| 'MAX_CALIBRATION_MODULES'
	| 'MAX_DIVERGENCE_BYTES'
	| 'MAX_TEST_HISTORY_ENTRIES'
	| 'MAX_TEST_HISTORY_KEYS'
	| 'MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL'
	| 'MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES'
	| 'MAX_RECEIPTS_READ'
	| 'MAX_CAPSULES_LISTED'
	| 'MAX_SUMMARIES_LISTED'
	| 'MAX_RUN_LOG_ENTRIES'
	| 'MAX_UNITID_PROBE_ENTRIES';

/** Process-local overrides; test-only, never persisted. */
const overrides = new Map<string, number>();

/**
 * Install test cap overrides (partial). Production code never calls this;
 * tests and the #2483 acceptance checks do. Values are validated to be
 * positive finite numbers so a bad fixture fails loudly at install time.
 */
export function setRetentionCapOverrides(
	partial: Partial<Record<RetentionCapName, number>>,
): void {
	for (const [name, value] of Object.entries(partial)) {
		if (value === undefined) continue;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
			throw new Error(
				`setRetentionCapOverrides: ${name} must be a positive finite number`,
			);
		}
		overrides.set(name, value);
	}
}

/** Clear every override (test teardown). */
export function clearRetentionCapOverrides(): void {
	overrides.clear();
}

/**
 * Resolve the effective cap for {@link name}: the installed override when
 * present, otherwise {@link defaultValue}. Every capped writer routes its
 * enforcement through this function.
 */
export function resolveRetentionCap(
	name: RetentionCapName,
	defaultValue: number,
): number {
	const override = overrides.get(name);
	if (override !== undefined && Number.isFinite(override) && override >= 1) {
		return override;
	}
	return defaultValue;
}

/** Test/inspection seam. */
export const _internals = {
	overrides,
};
