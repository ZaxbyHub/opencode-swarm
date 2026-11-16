import type { KnowledgeConfig, PluginConfig } from '../../config/schema';
import type { SessionReflectionResult } from '../../services/session-reflection';
import type { SqliteRowCounts } from '../archive-sqlite';

export interface PlanPhase {
	id: number;
	name: string;
	status: string;
	tasks: Array<{
		id: string;
		status: string;
		close_reason?: string;
	}>;
}
export interface PlanData {
	title: string;
	phases: PlanPhase[];
}
export interface CloseCommandOptions {
	sessionID?: string;
	skillReviewTimeoutMs?: number;
}
export interface CurationCounts {
	stored: number;
	/** Issue #2077: surfaced for the reflection knowledge-delta report. */
	reinforced: number;
	skipped: number;
	rejected: number;
	quarantined: number;
}
export interface CloseKnowledgeEntry {
	created_at?: string;
}
// ── Structured archive result (issue #2030) ────────────────────────────────
// One result per archived artifact. This is the single source of truth from
// which the user-facing prose, the clean-stage gate (archivedActiveStateFiles),
// the failure map, AND the `close_archive_result` telemetry event are all
// derived — so none of them can disagree (issue item 6 acceptance: "Archive
// prose and canonical event are derived from the same result object and cannot
// disagree").
export type ArchiveRequiredness = 'required' | 'optional';
export type ArchiveAttempt = 'not_attempted' | 'succeeded' | 'failed';
export type ArchiveValidation = 'not_applicable' | 'passed' | 'failed';
export type ArchiveSourceDisposition = 'absent' | 'retained' | 'removed';
export interface ArtifactArchiveResult {
	artifact: string;
	requiredness: ArchiveRequiredness;
	attempt: ArchiveAttempt;
	validation: ArchiveValidation;
	source_disposition: ArchiveSourceDisposition;
	method: string; // 'copy' | 'vacuum_into' | 'none'
	reason_code: string;
	/** Counts only (no row content), present for validated sqlite snapshots. */
	row_counts?: SqliteRowCounts;
	/** Non-sensitive diagnostic. */
	detail?: string;
}
export interface ArchiveStageContext {
	directory: string;
	swarmDir: string;
	config: PluginConfig;
	warnings: string[];
}
export interface CloseStageContext {
	directory: string;
	swarmDir: string;
	planData: PlanData;
	planExists: boolean;
	planAlreadyDone: boolean;
	config: KnowledgeConfig;
	projectName: string;
	warnings: string[];
	closedPhases: number[];
	closedTasks: string[];
	sessionStart: string | undefined;
	isForced: boolean;
	runSkillReview: boolean;
	options: CloseCommandOptions;
	phases: PlanPhase[];
	inProgressPhases: PlanPhase[];
	curationSucceeded: boolean;
	curationResult: CurationCounts | undefined;
	allLessons: string[];
	explicitLessons: string[];
	retroLessons: string[];
	knowledgeSkillHint: string;
	skillReviewSummary: string;
	postMortemSummary: string;
	sessionReflection: SessionReflectionResult | undefined;
	hivePromoted: number;
	sessionKnowledgeCreated: number;
	fallbackKnowledgeCreated: number;
	/** Issue #2077: FR-015 dedup drop count (retro lessons dropped as already-known). */
	dedupDropped: number;
	/** Issue #2077: false when the dedup knowledge read failed (fail-open). */
	dedupAvailable: boolean;
	/** Issue #2077: total retro lessons before dedup. */
	retroLessonTotal: number;
	/** Issue #2077: full-auto state computed once, reused at reflection + menu render. */
	fullAuto: boolean;
	originalStatuses: Map<string, string>;
	guaranteeResult: { closedPhaseIds: number[]; closedTaskIds: string[] };
	terminalizationError?: string;
	archiveResult: string;
	archivedFileCount: number;
	archivedActiveStateFiles: Set<string>;
	archivedActiveStateDirs: Set<string>;
	archiveFailureReasons: Map<string, string>;
	/** Structured per-artifact results — single source of truth (issue #2030). */
	archiveResults: ArtifactArchiveResult[];
	/** True when the archive STAGE threw wholesale (e.g. mkdir EACCES/ENOSPC). */
	archiveStageFailed: boolean;
	timestamp: string;
	archiveDir: string;
	archiveSuffix: string;
	args: string[];
	/**
	 * Issue #2953: the tracked-dirty set the close gate measured at the top of
	 * this invocation — exactly the scope the operator's confirm token
	 * certified (or the empty set on the clean-tree fast path). The align
	 * stage's guard re-verifies it immediately before the destructive reset
	 * and aborts fail-closed if tracked files changed in the window.
	 */
	purgeGateDirtyPaths?: string[];
}
export interface GitAlignResult {
	gitAlignResult: string;
	prunedBranches: string[];
}
export interface CleanStageResult {
	cleanedFiles: string[];
	configBackupsRemoved: number;
	swarmPlanFilesRemoved: number;
	/**
	 * #2968 swarm-pr-review FB-003: `receipt-<kind>-<id>-<hash>` export
	 * bundles (and crashed-export `.receipt-<...>.tmp-<pid>-<ts>` staging
	 * trees) reaped from `.swarm/plan-export/` at close. This is the reaper
	 * the retention registry's `verification-receipts` row cites as its
	 * keyspaceBound — without it the registry's boundedness premise was
	 * false and every distinct export accumulated byte-copies forever.
	 * Optional so pre-existing typed fixtures remain valid.
	 */
	receiptBundlesRemoved?: number;
	/**
	 * Stale atomic-write temp files MOVED into `.swarm/quarantine/<batch>/`
	 * (issue #2035). Quarantine is a recoverable move with a manifest — the
	 * pre-#2035 blind `.tmp.*` unlink sweep is gone; preserved candidates
	 * (recent/active/tracked/ambiguous) are counted in `residuePreserved`.
	 */
	residueQuarantined: number;
	residuePreserved: number;
}
