/**
 * Derived non-task entries under the `.swarm/evidence/` root (#3554).
 *
 * The evidence root serves two populations: per-task bundles (directory name
 * == plan task id, holding `evidence.json`) and DERIVED subtrees written by
 * gate/audit machinery. `listEvidenceTaskIds` enumerates the former; before
 * #3554 only `receipts` (PR #3550 FB-008) was exempted, so every other
 * derived writer was misclassified as a task id and `/swarm doctor` reported
 * a false "Orphaned Evidence ❌" in every project that had run them.
 *
 * This is the LISTING-side classification only. Phase-evidence snapshot
 * membership stays governed by
 * `SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES` (snapshot-identity.ts), which must
 * remain exactly `{'receipts'}` — changing snapshot membership is a separate
 * product decision recorded in PR #3550. The two surfaces must not drift, so
 * both name each other in their comments.
 */

import { FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE } from '../full-auto/evidence-names.js';

/**
 * Named derived directories at the evidence root (never plan task ids).
 * Every writer is source-cited; extend this set ONLY with a verified writer.
 * - `gate-audit` — src/evaluation/store.ts:479 (+ retention.ts:97)
 * - `task-gate-requirements` — src/evidence/task-gate-requirements.ts
 * - `task-gate-quarantine` — src/evidence/task-gate-repair.ts
 * - `auto-review` — src/review/evidence.ts (non-phase arm writes
 *   evidence/auto-review/<trigger>-<hash>.json)
 */
export const DERIVED_EVIDENCE_DIR_NAMES: ReadonlySet<string> = new Set([
	'gate-audit',
	'task-gate-requirements',
	'task-gate-quarantine',
	'auto-review',
]);

/**
 * Phase-writer artifact filenames that mark a phase-numbered directory as
 * derived (`.swarm/evidence/<N>/`). Every writer is source-cited; extend this
 * set ONLY with a verified writer:
 * - sast-baseline.json — src/tools/sast-baseline.ts
 * - epic-phase-review.json — src/epic/phase-readiness.ts
 * - lean-turbo-critic.json — src/turbo/lean/reviewer-facing critic record
 * - lean-turbo-reviewer.json — src/turbo/lean/reviewer.ts
 * - curator-findings.json — src/hooks/curator.ts
 * - completion-verify.json — src/tools/completion-verify.ts
 * - auto-review.json — src/review/evidence.ts (phase arm)
 * - phase-architecture-summary.json — src/summaries/store.ts
 * - architecture-supervisor.json — src/summaries/store.ts
 * - drift-verifier.json — src/tools/write-drift-evidence.ts
 * - hallucination-guard.json — src/tools/write-hallucination-evidence.ts
 * - mutation-gate.json — src/tools/write-mutation-evidence.ts
 */
export const PHASE_DIR_ARTIFACT_MARKERS: ReadonlySet<string> = new Set([
	'sast-baseline.json',
	'epic-phase-review.json',
	'lean-turbo-critic.json',
	'lean-turbo-reviewer.json',
	'curator-findings.json',
	'completion-verify.json',
	'auto-review.json',
	'phase-architecture-summary.json',
	'architecture-supervisor.json',
	'drift-verifier.json',
	'hallucination-guard.json',
	'mutation-gate.json',
]);

/**
 * Directory names that mark a phase-numbered directory as derived when they
 * appear as direct children (nested writer shapes whose artifacts live one
 * level down):
 * - `lean-turbo` — src/turbo/lean/evidence.ts writes
 *   evidence/<phase>/lean-turbo/lean-turbo-phase.json
 */
const PHASE_DIR_MARKER_SUBDIRS: ReadonlySet<string> = new Set(['lean-turbo']);

/** Whether a directory entry name is a plain decimal phase number. */
function isPhaseNumberedName(name: string): boolean {
	return name.length > 0 && /^[0-9]+$/.test(name);
}

/**
 * Classify one `.swarm/evidence/` root entry as a DERIVED (non-task) entry.
 *
 * Precedence is load-bearing (#3554 plan-critic F5): a REAL task bundle — a
 * directory containing a root-level `evidence.json` file — is NEVER derived,
 * even when its name collides with a derived writer (a task id can be
 * `gate-audit` or a bare number) or when a phase artifact also sits in the
 * directory. Bundle shape wins over every name/marker exemption.
 *
 * Bare-numeric names without any marker stay task ids (the critic amendment's
 * ambiguity rule): the marker gate is what distinguishes a phase directory
 * from a numeric task id, not the name alone.
 */
export function isDerivedEvidenceEntry(
	name: string,
	entryPath: string,
	existsSync: (path: string) => boolean,
	readDirSync: (path: string) => string[],
): boolean {
	// 1. Real task bundle precedence.
	if (existsSync(joinPath(entryPath, 'evidence.json'))) return false;
	// 2. Named derived writers.
	if (DERIVED_EVIDENCE_DIR_NAMES.has(name)) return true;
	// 3. Phase-numbered dirs, marker-gated.
	if (isPhaseNumberedName(name)) {
		try {
			for (const child of readDirSync(entryPath)) {
				if (PHASE_DIR_ARTIFACT_MARKERS.has(child)) return true;
				if (FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE.test(child)) return true;
				if (PHASE_DIR_MARKER_SUBDIRS.has(child)) return true;
			}
		} catch {
			return false;
		}
	}
	return false;
}

/** Minimal path join (POSIX-style separators are fine for existence checks). */
function joinPath(dir: string, entry: string): string {
	if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${entry}`;
	return `${dir}/${entry}`;
}
