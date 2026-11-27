import { loadPluginConfig } from '../config/loader.js';
import {
	readTaskGateRequirementsReceiptsSync,
	routeEvidenceFromTaskGateRequirements,
} from '../evidence/task-gate-requirements.js';
import {
	getTaskWorkflowSnapshot,
	isTaskEvidenceReceiptRollbackFailure,
	isTestEngineerDurablyExempt,
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { isMarkdownOnlyTaskChange } from '../gate-evidence-classification.js';
import {
	collectReviewerReceiptFromTranscript,
	type ReviewerReceiptValidationOptions,
} from '../hooks/review-receipt-collector.js';
import {
	captureReviewerScopeFileFingerprint,
	type ReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
	reviewerScopeFileFingerprintsEqual,
} from '../hooks/reviewer-scope-file-fingerprint.js';
import { isRouteBlockedForSettlement } from '../review/route-invalidation-registry.js';
import {
	enforcePersistedReviewRouteReceipt,
	type ReviewRouteEvidence,
	readReviewRouteReceiptSync,
} from '../review/routing-enforcement.js';
import { isPathIdentityWithin } from '../scope/path-identity.js';
import { isStageBRouteCompleteAtSettlement } from '../review/stage-b-route-settlement.js';
import { canonicalWorkspaceIdentity } from '../scope/scope-binding.js';
import {
	type AgentSessionState,
	advanceTaskState,
	getReviewerScopeGenerationForCoderCall,
	getReviewerScopeOwnershipHistory,
	getSettledStageBRouteEvidence,
	getStageBRouteEvidence,
	getTaskState,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	isStageBRouteRequired,
	markReviewerScopeGenerationMergebackPending,
	markReviewerScopeGenerationNoChange,
	markReviewerScopeGenerationReady,
	mergeStageBRouteEvidence,
	type ReviewerScopeGeneration,
	recordModifiedFilesForTask,
	recordReviewerScopeGenerationFileFingerprint,
	recordStageBCompletion,
	recordStageBRouteEvidence,
	reserveStageBRouteEvidence,
	reviewerScopeGenerationHasDeclaredOverlap,
	type StageBRouteEvidenceRollback,
	swarmState,
	updateTaskWorkflowCache,
} from '../state.js';
import * as logger from '../utils/logger.js';
import { normalizeAttributionPath } from './attribution-path.js';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
	BackgroundWorkspaceSnapshot,
} from './pending-delegations.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	committedFilesBetween,
	compareWorkspaceSnapshots,
	workspaceSnapshotMatches,
} from './workspace-snapshot.js';

const GATE_EVIDENCE_ROLES = new Set([
	'reviewer',
	'test_engineer',
	'docs',
	'designer',
	'critic',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'explorer',
	'sme',
]);
// Only reviewer/test_engineer advance the live task state machine. The broader
// set above records gate evidence for other gate-bearing background roles.

type StageBStateRole = 'reviewer' | 'test_engineer';

function structuredStageBVerdict(
	role: StageBStateRole,
	text: string,
	taskId: string,
): 'pass' | 'fail' | 'skip' | null {
	const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern =
		role === 'reviewer'
			? new RegExp(
					`^\\[REVIEWED\\]\\s*\\|\\s*(?:task-)?${escapedTaskId}\\s*\\|\\s*(APPROVED|REJECTED|CONCERNS)\\s*\\|`,
					'im',
				)
			: new RegExp(
					`^\\[TESTED\\]\\s*\\|\\s*(?:task-)?${escapedTaskId}\\s*\\|\\s*(PASS|FAIL|SKIPPED)\\s*\\|`,
					'im',
				);
	const match = pattern.exec(text);
	if (!match) return null;
	if (match[1] === 'APPROVED' || match[1] === 'PASS') return 'pass';
	// SKIPPED means the tests were not run (issue #2756): a tool-argument
	// outcome the caller can retry, not a code failure.
	if (match[1] === 'SKIPPED') return 'skip';
	return 'fail';
}

function normalizedPathSet(
	files: readonly string[] | null,
): Set<string> | null {
	if (!files) return null;
	const normalized = new Set<string>();
	for (const file of files) {
		const candidate = normalizeAttributionPath(file);
		if (!candidate) return null;
		normalized.add(candidate);
	}
	return normalized;
}

function pathSetsEqual(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((file) => right.has(file));
}

/**
 * Scope-membership test for a file against a declared scope set.
 *
 * A declared entry may be a DIRECTORY (e.g. `declare_scope` called with
 * `files: ["context"]`): the coder write-scope guard treats such a scope as
 * covering everything beneath it, so a coder scoped to a directory can
 * legitimately edit `context/<file>`. The attribution filters here must not
 * be stricter than the write gate — with exact-path matching only, every
 * file a directory-scoped background coder changed fell out of
 * `attributedFiles`, the completion settled as `dispatch_no_mutation`
 * despite real mutations, and the task wedged at Stage A forever (the
 * observed task-1.13 background settlement wedge). Directory-prefix
 * matching cannot false-positive: a declared FILE entry has no children, so
 * `file.startsWith(entry + '/')` is false for every other path.
 *
 * Both sides are keyed through {@link scopeMatchKey} so win32 case-folds
 * exactly like the write gate this mirrors (`isPathWithinDeclaredScope` →
 * `normalizePathIdentity` lowercases on win32 while declare-scope.ts retains
 * the relative input spelling): a declared `Context` must still cover the
 * Git-reported `context/a.md`, or the write is permitted but unattributed
 * and the task wedges at `dispatch_no_mutation` (PR 3918 review F-003).
 * Case-sensitive platforms keep exact matching so two files differing only
 * by case remain distinct.
 */
function scopeSetContainsFile(scope: Set<string>, file: string): boolean {
	for (const entry of scope) {
		if (isPathIdentityWithin(file, entry)) return true;
	}
	return false;
}

/** Nullable twin of {@link scopeSetContainsFile}: a missing scope contains nothing. */
function scopeSetMaybeContainsFile(
	scope: Set<string> | null | undefined,
	file: string,
): boolean {
	return scope ? scopeSetContainsFile(scope, file) : false;
}

/**
 * Fingerprint equality with the filename reconciled through the win32
 * case-fold key (PR 3918 review F-003): the routed (guardrail-observed) and
 * the Git-reported spelling of one file may differ in case on Windows, so
 * both file fields are keyed through {@link scopeMatchKey} before the exact
 * field-for-field equality. POSIX keys are identity — unchanged there.
 */
function fingerprintsEqualWithCanonicalFile(
	routed: ReviewerScopeFileFingerprint,
	observed: ReviewerScopeFileFingerprint,
): boolean {
	return reviewerScopeFileFingerprintsEqual(
		{ ...routed, file: scopeMatchKey(routed.file) },
		{ ...observed, file: scopeMatchKey(observed.file) },
	);
}

/**
 * Canonical-keyed routed-file membership for distinct-owner validation: the
 * owner's routed (guardrail-observed) spelling may differ in case from the
 * Git-reported spelling on Windows (PR 3918 review F-003 round 2), so
 * membership is keyed through {@link scopeMatchKey}. Two routed spellings
 * folding onto one key are ambiguous provenance and fail closed; POSIX keys
 * are identity, so exact matching (and case-distinct files) are preserved
 * there. Routed entries are concrete files and are never matched as
 * directory containers.
 */
function routedSetUnambiguouslyContainsFile(
	routed: Set<string> | null,
	file: string,
): boolean {
	if (!routed) return false;
	const key = scopeMatchKey(file);
	let matches = 0;
	for (const entry of routed) {
		if (scopeMatchKey(entry) !== key) continue;
		matches += 1;
		if (matches > 1) return false;
	}
	return matches === 1;
}

/**
 * File-identity leg of distinct-owner validation, shared by the live and
 * historical paths (PR 3918 review F-003 round 2): declared membership
 * (directory-aware), routed membership, and the routed fingerprint are all
 * reconciled to the Git-observed spelling through the same win32 case-fold
 * key used by the receipts handoff. Routed spellings or fingerprint entries
 * that fold two identities onto one key are ambiguous provenance and fail
 * closed. POSIX keys are identity, so behavior there is exactly the previous
 * exact-match semantics.
 */
function ownerExplainsObservedFile(input: {
	file: string;
	fingerprint: ReviewerScopeFileFingerprint;
	declaredFiles: readonly string[] | null;
	modifiedFiles: readonly string[] | null;
	modifiedFileFingerprints: readonly ReviewerScopeFileFingerprint[] | null;
}): boolean {
	const declared = normalizedPathSet(input.declaredFiles);
	const routed = normalizedPathSet(input.modifiedFiles);
	if (
		!scopeSetMaybeContainsFile(declared, input.file) ||
		!routedSetUnambiguouslyContainsFile(routed, input.file)
	) {
		return false;
	}
	const key = scopeMatchKey(input.file);
	const fingerprints = (input.modifiedFileFingerprints ?? []).filter(
		(entry) =>
			scopeMatchKey(normalizeAttributionPath(entry.file) ?? '') === key,
	);
	return (
		fingerprints.length === 1 &&
		fingerprintsEqualWithCanonicalFile(fingerprints[0], input.fingerprint)
	);
}

function hasDistinctBackgroundOwner(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	file: string;
	fingerprint: ReviewerScopeFileFingerprint;
	candidateCreatedAt: number;
	candidateCompletedAt: number;
}): boolean {
	if (
		!Number.isFinite(input.candidateCreatedAt) ||
		!Number.isFinite(input.candidateCompletedAt) ||
		input.candidateCreatedAt > input.candidateCompletedAt
	) {
		return false;
	}
	const generations =
		swarmState.agentSessions.get(input.parentSessionID)
			?.reviewerScopeGenerations ?? new Map<string, ReviewerScopeGeneration>();
	const liveOwners = [...generations.values()].filter((generation) => {
		if (
			generation.background !== true ||
			(generation.taskId === input.taskId &&
				generation.coderCallID === input.coderCallID)
		) {
			return false;
		}
		const ownerCompletedAt = generation.readyAt ?? input.candidateCompletedAt;
		return (
			Number.isFinite(generation.createdAt) &&
			Number.isFinite(ownerCompletedAt) &&
			generation.createdAt <= input.candidateCompletedAt &&
			input.candidateCreatedAt <= ownerCompletedAt &&
			ownerExplainsObservedFile({
				file: input.file,
				fingerprint: input.fingerprint,
				declaredFiles: generation.declaredFiles,
				modifiedFiles: generation.modifiedFiles,
				modifiedFileFingerprints: generation.modifiedFileFingerprints,
			})
		);
	});
	const historicalOwners = getReviewerScopeOwnershipHistory({
		parentSessionID: input.parentSessionID,
	}).filter((owner) => {
		if (
			owner.taskId === input.taskId &&
			owner.coderCallID === input.coderCallID
		) {
			return false;
		}
		return (
			owner.parentSessionID === input.parentSessionID &&
			owner.background === true &&
			Number.isFinite(owner.createdAt) &&
			Number.isFinite(owner.readyAt) &&
			owner.createdAt <= input.candidateCompletedAt &&
			input.candidateCreatedAt <= owner.readyAt &&
			ownerExplainsObservedFile({
				file: input.file,
				fingerprint: input.fingerprint,
				declaredFiles: owner.declaredFiles,
				modifiedFiles: owner.modifiedFiles,
				modifiedFileFingerprints: owner.modifiedFileFingerprints,
			})
		);
	});
	return liveOwners.length + historicalOwners.length === 1;
}

export interface StageBIngestionResult {
	ok: boolean;
	consumed: boolean;
	stale?: boolean;
	/** True when the gate reported a not-run outcome (TESTED SKIPPED): no
	 * transition fired, no proof was cleared, and the task remains Stage B
	 * eligible for re-dispatch (issue #2756). */
	skipped?: boolean;
	reason?: string;
}

export function isBackgroundGateBearingRecord(
	record: BackgroundDelegationRecord,
): boolean {
	return (
		record.batchId === undefined &&
		record.evidenceTaskId !== null &&
		GATE_EVIDENCE_ROLES.has(record.normalizedAgent)
	);
}

export function validateStageBWorkspace(
	directory: string,
	record: BackgroundDelegationRecord,
): { ok: boolean; stale: boolean; reason?: string } {
	const actualWorkspace = captureWorkspaceSnapshot(directory, {
		scope: record.workspace?.scope ?? null,
		prHeadSha: record.workspace?.prHeadSha ?? null,
		resolveCurrentPrHeadSha: record.workspace?.prHeadSha !== null,
		captureChangedFileHashes: true,
	});
	const check = compareStageBWorkspace(record, actualWorkspace, directory);
	return { ...check, ok: !check.stale };
}

const BARE_TASK_ID = /^\d+(?:\.\d+)*$/;

/**
 * Case-fold scope path keys on Windows only (canonicalRootKey precedent):
 * core.ignorecase lets git report paths with different case than the authored
 * scope entries, and the freshness predicate must not miss in-scope drift over
 * casing. Case-sensitive platforms keep exact matching so two files that differ
 * only by case remain distinct.
 */
const SCOPE_CASE_FOLD = process.platform === 'win32';

function scopeMatchKey(normalized: string): string {
	return SCOPE_CASE_FOLD ? normalized.toLowerCase() : normalized;
}

/**
 * Derive the declared review-scope file set from a dispatch snapshot's stored
 * scope string (issue #2814). The delegation gate stores the session's
 * comma-joined declared coder scope, falling back to the bare task id when
 * none was declared. Bare task ids, empty fragments, and implausible paths
 * are dropped individually; an empty result means no derivable scope and the
 * caller must keep the whole-tree comparison.
 */
function deriveScopeFiles(
	scope: string | null | undefined,
): Set<string> | null {
	if (!scope) return null;
	const files = new Set<string>();
	for (const fragment of scope.split(',')) {
		const normalized = normalizeAttributionPath(fragment);
		if (normalized === null || BARE_TASK_ID.test(normalized)) continue;
		files.add(scopeMatchKey(normalized));
	}
	return files.size > 0 ? files : null;
}

function scopeDirtySlice(
	files: readonly string[],
	scopeFiles: Set<string>,
): Set<string> {
	const slice = new Set<string>();
	for (const file of files) {
		if (scopeSetContainsFile(scopeFiles, file)) slice.add(file);
	}
	return slice;
}

function canonicalDirtyHashMap(
	hashes: Record<string, string> | null | undefined,
): Map<string, string> | null {
	if (!hashes) return null;
	const canonical = new Map<string, string>();
	for (const [file, hash] of Object.entries(hashes)) {
		if (
			file.length === 0 ||
			(hash !== 'missing' && !/^[a-f0-9]{64}$/.test(hash))
		) {
			return null;
		}
		const key = scopeMatchKey(file);
		if (canonical.has(key)) return null;
		canonical.set(key, hash);
	}
	return canonical;
}

export function compareStageBWorkspace(
	record: BackgroundDelegationRecord,
	actualWorkspace: BackgroundWorkspaceSnapshot,
	directory?: string,
): { stale: boolean; reason?: string } {
	// A docs agent legitimately changes the dirty-tree digest by authoring
	// documentation. Bind it to the same project, Git HEAD, and PR head while
	// allowing those expected uncommitted documentation edits.
	const expectedWorkspace =
		record.normalizedAgent === 'docs' && record.workspace
			? { ...record.workspace, dirtyHash: null }
			: record.workspace;
	if (!expectedWorkspace) return { stale: false };
	if (record.normalizedAgent === 'docs') {
		return compareWorkspaceSnapshots(expectedWorkspace, actualWorkspace);
	}
	// Reviewer/test roles must observe the tree they were dispatched against —
	// scoped to the gate's declared review scope (issue #2814): concurrent
	// activity on OTHER tasks' files (commits, dirt, untracked noise) must not
	// invalidate a clean Stage B verdict, while any in-scope drift (dirty,
	// committed, or reverted during the run) still does. When no scope can be
	// derived, or either snapshot is capture-degraded (null gitHead or
	// changedFiles), the narrowed legs cannot be computed soundly: fall back to
	// the strict whole-tree comparison, which never admits MORE than before.
	const scopeFiles = deriveScopeFiles(expectedWorkspace.scope);
	const expectedHead = expectedWorkspace.gitHead;
	const currentHead = actualWorkspace.gitHead;
	const expectedChanged = expectedWorkspace.changedFiles;
	const currentChanged = actualWorkspace.changedFiles;
	if (scopeFiles === null) {
		return compareWorkspaceSnapshots(expectedWorkspace, actualWorkspace);
	}
	if (
		expectedHead == null ||
		currentHead == null ||
		expectedChanged == null ||
		currentChanged == null ||
		directory === undefined
	) {
		return {
			stale: true,
			reason: 'scoped workspace freshness evidence unavailable',
		};
	}
	// Project-root and PR-head identity still bind the whole workspace; only
	// the tree-state legs narrow. Nulling the two tree fields reuses the
	// exported matcher for exactly the identity legs.
	const identity = workspaceSnapshotMatches(
		{ ...expectedWorkspace, gitHead: null, dirtyHash: null },
		{ ...actualWorkspace, gitHead: null, dirtyHash: null },
	);
	if (!identity.ok) return { stale: true, reason: identity.reason };
	const committed = committedFilesBetween(directory, expectedHead, currentHead);
	if (committed === null) {
		// The in-scope committed slice cannot be proven — fall back to the
		// whole-tree comparison, which fails closed on a moved head.
		return compareWorkspaceSnapshots(expectedWorkspace, actualWorkspace);
	}
	const committedInScope = committed.filter((file) =>
		scopeSetContainsFile(scopeFiles, file),
	);
	if (committedInScope.length > 0) {
		const shown = committedInScope.slice(0, 5).join(', ');
		const extra =
			committedInScope.length > 5
				? ` (+${committedInScope.length - 5} more)`
				: '';
		return {
			stale: true,
			reason: `in-scope committed change: ${shown}${extra}`,
		};
	}
	const dispatchDirty = scopeDirtySlice(expectedChanged, scopeFiles);
	const currentDirty = scopeDirtySlice(currentChanged, scopeFiles);
	const dirtied = [...currentDirty].filter((file) => !dispatchDirty.has(file));
	const cleaned = [...dispatchDirty].filter((file) => !currentDirty.has(file));
	if (dirtied.length > 0 || cleaned.length > 0) {
		return {
			stale: true,
			reason: `in-scope dirty set changed: +[${dirtied.join(', ')}] -[${cleaned.join(', ')}]`,
		};
	}
	// Path sets cannot detect another edit to a file that was already dirty.
	// Stage B captures bounded per-file content identities for the declared
	// scope; compare only those identities so unrelated dirt stays isolated.
	// Legacy records without the optional map fail closed when scoped dirt
	// exists rather than claiming freshness they cannot prove.
	if (dispatchDirty.size > 0 || currentDirty.size > 0) {
		const expectedHashes = canonicalDirtyHashMap(
			expectedWorkspace.changedFileHashes,
		);
		const currentHashes = canonicalDirtyHashMap(
			actualWorkspace.changedFileHashes,
		);
		if (!expectedHashes || !currentHashes) {
			return {
				stale: true,
				reason: 'in-scope dirty content identities unavailable',
			};
		}
		for (const file of new Set([...dispatchDirty, ...currentDirty])) {
			const key = scopeMatchKey(file);
			const expectedHash = expectedHashes.get(key);
			const currentHash = currentHashes.get(key);
			if (expectedHash === undefined || currentHash === undefined) {
				return {
					stale: true,
					reason: `in-scope dirty content identity unavailable: ${file}`,
				};
			}
			if (expectedHash !== currentHash) {
				return {
					stale: true,
					reason: `in-scope dirty content changed: ${file}`,
				};
			}
		}
	}
	return { stale: false };
}

export async function ingestBackgroundStageBCompletion(args: {
	directory: string;
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	reviewerReceiptOptions?: ReviewerReceiptValidationOptions;
}): Promise<StageBIngestionResult> {
	const taskId = args.record.evidenceTaskId ?? args.record.planTaskId;
	if (!taskId) {
		// The trusted terminal completion is still settled in the durable ledger by
		// the caller; it simply has no Stage B evidence/state side effects.
		return { ok: true, consumed: false };
	}

	if (args.record.normalizedAgent === 'coder') {
		const taskChangeContext = args.record.taskChangeContext;
		const settledFiles =
			args.record.coderSettlement?.state === 'settled'
				? args.record.coderSettlement.observedFiles
				: undefined;
		const observedFiles =
			settledFiles !== undefined
				? settledFiles
				: taskChangeContext
					? changedFilesSinceSnapshot(
							taskChangeContext.baseline.directory,
							taskChangeContext.baseline,
						)
					: null;
		if (observedFiles === null) {
			return {
				ok: false,
				consumed: false,
				stale: true,
				reason:
					'background coder files could not be attributed to a clean immutable baseline',
			};
		}
		try {
			const observedSet = normalizedPathSet(observedFiles);
			const declaredSet = normalizedPathSet(
				taskChangeContext?.declaredFiles ?? null,
			);
			const completionTime = args.record.completedAt ?? args.record.updatedAt;
			let attributedFiles = observedFiles ?? [];
			if (args.reviewerReceiptOptions?.config?.enabled !== true) {
				// Without ownership validation, restrict attributed files to the
				// declared scope so concurrent background coders don't cross-attribute.
				if (observedSet && declaredSet) {
					attributedFiles = [...observedSet].filter((file) =>
						scopeSetContainsFile(declaredSet, file),
					);
				}
			}
			if (args.reviewerReceiptOptions?.config?.enabled === true) {
				if (!observedSet || !declaredSet) {
					return {
						ok: false,
						consumed: false,
						reason:
							'background coder changed-file attribution could not be reconstructed exactly',
					};
				}
				attributedFiles = [...observedSet].filter((file) =>
					scopeSetContainsFile(declaredSet, file),
				);
				const generation = getReviewerScopeGenerationForCoderCall({
					parentSessionID: args.record.parentSessionId,
					taskId,
					coderCallID: args.record.callID,
				});
				const generationScope = normalizedPathSet(
					generation?.declaredFiles ?? null,
				);
				const routedFiles = normalizedPathSet(
					generation?.modifiedFiles ?? null,
				);
				const routedFingerprints = generation?.modifiedFileFingerprints ?? null;
				// Issue #2100: a background coder with zero observed files and a
				// zero-route collecting generation is a truthful no-change, not an
				// attribution failure.
				if (
					generation?.status === 'collecting' &&
					generation.background === true &&
					observedSet.size === 0 &&
					routedFiles?.size === 0 &&
					declaredSet
				) {
					if (
						markReviewerScopeGenerationNoChange({
							parentSessionID: args.record.parentSessionId,
							taskId,
							coderCallID: args.record.callID,
						})
					) {
						return { ok: true, consumed: true };
					}
				}
				// Capture from the generation's bound workspace root (the lane
				// for worktree-isolated background coders) with typed results.
				const captureRoot =
					generation?.captureDirectory?.trim() || args.directory;
				const observedFingerprints = new Map<
					string,
					ReviewerScopeFileFingerprint
				>();
				for (const file of observedSet) {
					const captured = captureReviewerScopeFileFingerprint(
						captureRoot,
						file,
					);
					if (captured.kind === 'capture_failed') {
						return {
							ok: false,
							consumed: false,
							reason: `background coder post-write fingerprint could not be reconstructed exactly (${captured.code}${captured.retryable ? ' (retryable)' : ' (permanent)'} on ${captured.file})`,
						};
					}
					const fingerprint = reviewerScopeCaptureToFingerprint(captured);
					if (!fingerprint) {
						return {
							ok: false,
							consumed: false,
							reason:
								'background coder post-write fingerprint returned an unusable result',
						};
					}
					observedFingerprints.set(file, fingerprint);
				}
				const changedWithinDeclaredScope = new Set(
					[...observedSet].filter(
						(file) =>
							scopeSetContainsFile(declaredSet, file) &&
							scopeSetMaybeContainsFile(generationScope, file),
					),
				);
				// Reconcile guardrail-routed spellings with Git-reported
				// spellings through the same win32 case-fold key used for
				// scope membership (PR 3918 review F-003): on a
				// case-insensitive checkout the coder may route
				// `Context/entry-a.md` while git reports the tracked file as
				// `context/entry-a.md`. Distinct spellings folding to one key
				// on either side are ambiguous identities and fail closed in
				// the guard below; POSIX keys are identity, so exact matching
				// and case-distinct files are preserved there.
				const observedFileByKey = new Map<string, string>();
				let observedIdentitiesUnambiguous = true;
				for (const file of observedSet) {
					const key = scopeMatchKey(file);
					if (observedFileByKey.has(key)) {
						observedIdentitiesUnambiguous = false;
					} else {
						observedFileByKey.set(key, file);
					}
				}
				const routedFileByKey = new Map<string, string>();
				let routedIdentitiesUnambiguous = true;
				for (const file of routedFiles ?? []) {
					const key = scopeMatchKey(file);
					if (routedFileByKey.has(key)) {
						routedIdentitiesUnambiguous = false;
					} else {
						routedFileByKey.set(key, file);
					}
				}
				const routedIdentitiesReconciled =
					observedIdentitiesUnambiguous &&
					routedIdentitiesUnambiguous &&
					routedFileByKey.size === changedWithinDeclaredScope.size &&
					[...changedWithinDeclaredScope].every((file) =>
						routedFileByKey.has(scopeMatchKey(file)),
					);
				const observedOutsideCurrentScope = [...observedSet].filter(
					(file) => !scopeSetMaybeContainsFile(generationScope, file),
				);
				if (
					(generation?.status !== 'collecting' &&
						generation?.status !== 'ready') ||
					generation.background !== true ||
					!generationScope ||
					!routedFiles ||
					!routedFingerprints ||
					routedFiles.size === 0 ||
					!pathSetsEqual(declaredSet, generationScope) ||
					!routedIdentitiesReconciled ||
					reviewerScopeGenerationHasDeclaredOverlap({
						parentSessionID: args.record.parentSessionId,
						taskId,
						coderCallID: args.record.callID,
						declaredFiles: generation.declaredFiles,
						workspaceIdentity: generation.workspaceIdentity,
					}) ||
					observedOutsideCurrentScope.some(
						(file) =>
							!hasDistinctBackgroundOwner({
								parentSessionID: args.record.parentSessionId,
								taskId,
								coderCallID: args.record.callID,
								file,
								fingerprint: observedFingerprints.get(file)!,
								candidateCreatedAt: args.record.createdAt,
								candidateCompletedAt: completionTime,
							}),
					) ||
					[...routedFiles].some((file) => {
						const key = scopeMatchKey(file);
						const observedFile = observedFileByKey.get(key);
						const fingerprints = routedFingerprints.filter(
							(entry) =>
								scopeMatchKey(normalizeAttributionPath(entry.file) ?? '') ===
								key,
						);
						const observedFingerprint = observedFile
							? observedFingerprints.get(observedFile)
							: undefined;
						return (
							observedFile === undefined ||
							!scopeSetContainsFile(declaredSet, file) ||
							!scopeSetContainsFile(generationScope, file) ||
							fingerprints.length !== 1 ||
							!observedFingerprint ||
							!fingerprintsEqualWithCanonicalFile(
								fingerprints[0],
								observedFingerprint,
							)
						);
					})
				) {
					return {
						ok: false,
						consumed: false,
						reason:
							'background coder scope handoff could not be reconstructed exactly',
					};
				}
				// Credit the Git-reported (canonical) spelling — the identity
				// git and the durable evidence agree on. The routed spelling is
				// only the coder's authored path and may differ in case on
				// Windows; the guard above proved a 1:1 key correspondence, so
				// exactly one canonical file is credited per routed entry.
				attributedFiles = [...routedFiles].map(
					(file) => observedFileByKey.get(scopeMatchKey(file)) ?? file,
				);
				// Repair path (issue #2100): ingestion re-captured every routed
				// file's exact bytes against the generation's bound root — write
				// them back so the completeness gate at ready-publication sees a
				// fully populated fingerprint set even when a write-time capture
				// transiently failed. The fingerprint is rekeyed to the routed
				// spelling so the generation's modifiedFiles and fingerprint
				// files stay in one identity family for markReady's exact
				// completeness check.
				for (const file of routedFiles) {
					const observedFile = observedFileByKey.get(scopeMatchKey(file));
					const fingerprint = observedFile
						? observedFingerprints.get(observedFile)
						: undefined;
					if (fingerprint) {
						recordReviewerScopeGenerationFileFingerprint({
							parentSessionID: args.record.parentSessionId,
							taskId,
							coderCallID: args.record.callID,
							fingerprint: { ...fingerprint, file },
						});
					}
				}
			}
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (parentSession) {
				const state = getTaskState(parentSession, taskId);
				if (
					state !== 'idle' &&
					state !== 'coder_delegated' &&
					state !== 'rework_required'
				) {
					return {
						ok: false,
						consumed: false,
						reason: `background coder completion is late for task ${taskId}: current state is ${state}`,
					};
				}
			}
			const accepted = attributedFiles.length > 0;
			const expectedGeneration =
				args.record.taskChangeContext?.workflowGeneration ?? 0;
			const transitionId = `background-coder:${args.record.correlationId}`;
			const existingEvidence = await readTaskEvidence(args.directory, taskId);
			const existingWorkflow = getTaskWorkflowSnapshot(existingEvidence);
			const alreadyApplied =
				existingWorkflow.authoritative &&
				existingWorkflow.lastTransitionId === transitionId &&
				existingWorkflow.lastOutcome ===
					(accepted ? 'accepted_mutation' : 'dispatch_no_mutation') &&
				existingWorkflow.generation === expectedGeneration + (accepted ? 1 : 0);
			const updated = alreadyApplied
				? existingEvidence!
				: await transitionTaskWorkflowEvidence(
						args.directory,
						taskId,
						accepted
							? {
									type: 'accepted_mutation',
									agentType: 'coder',
									context: {
										testEngineerExempt: isMarkdownOnlyTaskChange(
											taskChangeContext?.declaredFiles,
											attributedFiles,
										),
									},
									expectedGeneration,
									transitionId,
								}
							: {
									type: 'dispatch_no_mutation',
									agentType: 'coder',
									expectedGeneration,
									transitionId,
								},
					);
			if (accepted) {
				const workflow = getTaskWorkflowSnapshot(updated);
				const parentSession = swarmState.agentSessions.get(
					args.record.parentSessionId,
				);
				if (parentSession) {
					if (
						!recordModifiedFilesForTask(
							parentSession,
							taskId,
							attributedFiles,
							args.directory,
						)
					) {
						logger.warn(
							`[background] durable coder mutation for ${taskId} exceeded session file-attribution capacity`,
						);
					}
					parentSession.taskWorkflowStates.set(taskId, 'coder_delegated');
					parentSession.stageBCompletion?.delete(taskId);
					parentSession.taskCouncilApproved?.delete(taskId);
					parentSession.taskCouncilWorkflowGeneration?.delete(taskId);
					updateTaskWorkflowCache(parentSession, taskId, workflow);
				}
			}
			if (args.reviewerReceiptOptions?.config?.enabled === true) {
				// Lane-rooted background generations are never published ready
				// from the primary root without merge-back verification (F-001):
				// retain them as mergeback_pending; the merge-back verifier
				// repoints and publishes when the primary matches.
				const laneGeneration = getReviewerScopeGenerationForCoderCall({
					parentSessionID: args.record.parentSessionId,
					taskId,
					coderCallID: args.record.callID,
				});
				const laneRooted =
					laneGeneration !== null &&
					laneGeneration.workspaceIdentity !==
						canonicalWorkspaceIdentity(args.directory);
				if (laneRooted) {
					markReviewerScopeGenerationMergebackPending({
						parentSessionID: args.record.parentSessionId,
						taskId,
						coderCallID: args.record.callID,
					});
					return { ok: true, consumed: true };
				}
			}
			if (
				args.reviewerReceiptOptions?.config?.enabled === true &&
				!markReviewerScopeGenerationReady({
					parentSessionID: args.record.parentSessionId,
					taskId,
					coderCallID: args.record.callID,
					primaryWorkspaceIdentity:
						canonicalWorkspaceIdentity(args.directory) ?? undefined,
				})
			) {
				return {
					ok: false,
					consumed: false,
					reason:
						'background coder scope handoff could not be marked ready after evidence persisted',
				};
			}
			return { ok: true, consumed: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				consumed: false,
				reason: `background coder evidence ingestion failed: ${message}`,
			};
		}
	}

	if (!isBackgroundGateBearingRecord(args.record)) {
		return { ok: true, consumed: false };
	}

	const workspaceCheck = validateStageBWorkspace(args.directory, args.record);
	if (workspaceCheck.stale) {
		return {
			ok: false,
			consumed: false,
			stale: true,
			reason:
				workspaceCheck.reason ?? 'workspace changed while gate was running',
		};
	}

	try {
		if (args.record.workflowGeneration === undefined) {
			return {
				ok: false,
				consumed: false,
				reason: `stage-b ingestion failed: TASK_WORKFLOW_GENERATION_REQUIRED for ${taskId}`,
			};
		}
		const existingEvidence = await readTaskEvidence(args.directory, taskId);
		const isStageBRole =
			args.record.normalizedAgent === 'reviewer' ||
			args.record.normalizedAgent === 'test_engineer';
		const stageBRole = isStageBRole
			? (args.record.normalizedAgent as StageBStateRole)
			: null;
		const verdict = stageBRole
			? structuredStageBVerdict(stageBRole, args.result.text ?? '', taskId)
			: null;
		if (stageBRole && verdict === 'skip') {
			// TESTED SKIPPED = tests not run (issue #2756): consume the record so
			// the observer publishes the skip advisory and no retry loop forms,
			// but fire NO stage_b_failed transition and clear no gate proof —
			// the task stays Stage B eligible for a test-gate re-dispatch.
			return {
				ok: false,
				consumed: true,
				skipped: true,
				reason: `background ${stageBRole} skipped task ${taskId} — tests not run; re-dispatch the test gate (task stays Stage B eligible; reviewer proof preserved)`,
			};
		}
		if (stageBRole && verdict !== 'pass') {
			const rejected = await transitionTaskWorkflowEvidence(
				args.directory,
				taskId,
				{
					type: 'stage_b_failed',
					gate: stageBRole,
					expectedGeneration: args.record.workflowGeneration,
					transitionId: `background-gate-failed:${args.record.correlationId}`,
				},
			);
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (parentSession) {
				parentSession.taskWorkflowStates.set(taskId, 'rework_required');
				parentSession.stageBCompletion?.delete(taskId);
				updateTaskWorkflowCache(
					parentSession,
					taskId,
					getTaskWorkflowSnapshot(rejected),
				);
			}
			return {
				ok: false,
				consumed: true,
				reason:
					verdict === 'fail'
						? `background ${stageBRole} rejected task ${taskId}`
						: `background ${stageBRole} returned no valid structured verdict for task ${taskId}`,
			};
		}
		let preparedRoute:
			| ReturnType<typeof resolveBackgroundStageBRoute>
			| undefined;
		let routeCompleteForPersistence: boolean | undefined;
		if (stageBRole) {
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (parentSession) {
				preparedRoute = resolveBackgroundStageBRoute({
					directory: args.directory,
					taskId,
					parentSessionId: args.record.parentSessionId,
					role: stageBRole,
					callId: args.record.callID,
					childSessionId: args.record.subagentSessionId,
					generation: args.record.workflowGeneration,
					session: parentSession,
				});
				const routeEnabled = (() => {
					try {
						return (
							loadPluginConfig(args.directory).review_routing
								?.enforce_receipts ?? true
						);
					} catch {
						return true;
					}
				})();
				// #3509 consult site A (ingestion admission read): this
				// completion's dispatch faulted before its route receipt
				// persisted — a prior receipt must not authorize the background
				// evidence publication. BLOCK-only: consults never retire the
				// marker; only the completion observer's confirmed consumed
				// commit does.
				if (
					routeEnabled &&
					isRouteBlockedForSettlement(
						args.directory,
						args.record.callID,
						args.record.parentSessionId,
						taskId,
					)
				) {
					logger.warn(
						`[background-stage-b] route receipt invalidated before evidence publication for ${taskId} (call ${args.record.callID})`,
					);
					return {
						ok: false,
						consumed: true,
						reason: `route receipt invalidated before Stage-B evidence publication: this dispatch's routing faulted before its receipt persisted; a prior receipt does not authorize the background completion`,
					};
				}
				const routeDecision = enforcePersistedReviewRouteReceipt({
					projectRoot: args.directory,
					sessionId: args.record.parentSessionId,
					taskId,
					receipts: preparedRoute.prospective,
					enforcementEnabled: routeEnabled,
					legacyUnrouted: preparedRoute.legacyUnrouted,
					requireEvidenceBindings: true,
					requireCompleteEvidence: false,
					expectedDispatch: preparedRoute.binding
						? {
								role: preparedRoute.binding.role,
								identity: preparedRoute.binding.identity,
								callId: preparedRoute.binding.callId,
								childSessionId: preparedRoute.binding.childSessionId,
								generation: preparedRoute.binding.generation,
							}
						: undefined,
				});
				if (!routeDecision.canAdvance) {
					logger.warn(
						`[background-stage-b] route receipt blocked before evidence publication for ${taskId}: ${routeDecision.reason ?? 'unknown reason'}`,
					);
					// TERMINAL drop (round-4/5 W3): an invalidated/blocked
					// completion cannot advance AND must not retry —
					// consumed:true matches the terminal-negative pattern at
					// the verdict arms above so the observer durably consumes
					// instead of retrying forever.
					return {
						ok: false,
						consumed: true,
						reason: `route receipt blocked before Stage-B evidence publication: ${routeDecision.reason ?? 'unknown reason'}`,
					};
				}
				if (
					routeEnabled &&
					preparedRoute.route?.kind === 'review_route_receipt'
				) {
					// #3509 consult site B (completeness read): same call-scoped
					// refusal before the completeness decision is recorded.
					if (
						isRouteBlockedForSettlement(
							args.directory,
							args.record.callID,
							args.record.parentSessionId,
							taskId,
						)
					) {
						logger.warn(
							`[background-stage-b] route receipt invalidated at completeness read for ${taskId} (call ${args.record.callID})`,
						);
						return {
							ok: false,
							consumed: true,
							reason: `route receipt invalidated at the Stage-B completeness read: this dispatch's routing faulted before its receipt persisted`,
						};
					}
					routeCompleteForPersistence = enforcePersistedReviewRouteReceipt({
						projectRoot: args.directory,
						sessionId: args.record.parentSessionId,
						taskId,
						receipts: preparedRoute.prospective,
						enforcementEnabled: true,
						legacyUnrouted: preparedRoute.legacyUnrouted,
						requireEvidenceBindings: true,
						requireCompleteEvidence: true,
						// Exempt wedge: a receipt that still lists test-engineer
						// slots (allocated before exemption-aware routing, or by
						// an unrouted complexity fallback) must not pin the durable
						// workflow at reviewer_run when the durable evidence
						// proves the sanctioned exemption.
						testEngineerExempt: isTestEngineerDurablyExempt(existingEvidence),
					}).canAdvance;
				}
			} else {
				// #3509 consult site C (parent-unavailable recovery arm): the
				// parent session is gone, so the registry consult is all this
				// arm has — refuse before the durable fallback read. Gated on
				// the same enforce_receipts config as every other consult.
				const recoveryRouteEnabled = (() => {
					try {
						return (
							loadPluginConfig(args.directory).review_routing
								?.enforce_receipts ?? true
						);
					} catch {
						return true;
					}
				})();
				if (
					recoveryRouteEnabled &&
					isRouteBlockedForSettlement(
						args.directory,
						args.record.callID,
						args.record.parentSessionId,
						taskId,
					)
				) {
					logger.warn(
						`[background-stage-b] route receipt invalidated in parent-unavailable recovery for ${taskId} (call ${args.record.callID})`,
					);
					return {
						ok: false,
						consumed: true,
						reason:
							'route receipt invalidated in the parent-unavailable recovery arm: this dispatch\u2019s routing faulted before its receipt persisted',
					};
				}
				const route = readReviewRouteReceiptSync({
					projectRoot: args.directory,
					sessionId: args.record.parentSessionId,
					taskId,
				});
				if (
					route?.kind !== 'review_route_router_error' ||
					route.sessionId !== args.record.parentSessionId ||
					route.taskId !== taskId
				) {
					// TERMINAL drop (round-4/5 W3): the parent session is
					// unavailable and the recovery receipt is not
					// identity-bound — retrying reproduces the same state.
					return {
						ok: false,
						consumed: true,
						reason:
							'route receipt blocked before Stage-B evidence publication: parent session is unavailable and recovery receipt is not identity-bound',
					};
				}
			}
		}
		let routeEvidenceRollback: StageBRouteEvidenceRollback | null = null;
		if (preparedRoute?.binding) {
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (!parentSession) {
				logger.warn(
					`[background-stage-b] route receipt blocked before evidence publication for ${taskId}: parent session unavailable`,
				);
				return {
					ok: false,
					consumed: false,
					reason:
						'route receipt blocked before Stage-B evidence publication: parent session unavailable',
				};
			}
			// The reserve lands the reclaim on the LIVE array too: a fully-bound
			// reservation replaces the obsolete same-identity binding (see
			// reserveStageBRouteEvidence), so the live evidence a later
			// advancement or update_task_status reads never carries the
			// superseded entry beside the fresh one (ROUTE_RECEIPT_DUPLICATE).
			routeEvidenceRollback = reserveStageBRouteEvidence(
				parentSession,
				taskId,
				preparedRoute.binding,
			);
			if (!routeEvidenceRollback) {
				logger.warn(
					`[background-stage-b] route receipt blocked before evidence publication for ${taskId}: bounded route evidence capacity exceeded`,
				);
				return {
					ok: false,
					consumed: false,
					reason:
						'route receipt blocked before Stage-B evidence publication: bounded route evidence capacity exceeded',
				};
			}
		}
		if (routeEvidenceRollback && !routeEvidenceRollback.beginPublication()) {
			routeEvidenceRollback();
			throw new Error('STAGE_B_ROUTE_PUBLISHING');
		}
		try {
			await recordGateEvidence(
				args.directory,
				taskId,
				args.record.normalizedAgent,
				args.record.subagentSessionId,
				hasActiveTurboMode(args.record.parentSessionId),
				{
					expectedGeneration: args.record.workflowGeneration,
					transitionId: `background-gate:${args.record.correlationId}`,
					// Missing/non-exempt provenance is conservative: require the full
					// Stage B pair without fabricating a new coder mutation/generation.
					ensureDefaultStageB: !isTestEngineerDurablyExempt(existingEvidence),
					routeBinding: preparedRoute?.binding,
					routeComplete: routeCompleteForPersistence,
					resolveRouteComplete:
						preparedRoute?.route?.kind === 'review_route_receipt' &&
						preparedRoute.binding
							? () => {
									const current = preparedRoute?.binding;
									const session = current
										? swarmState.agentSessions.get(args.record.parentSessionId)
										: undefined;
									if (!current || !session) return false;
									return isStageBRouteCompleteAtSettlement({
										directory: args.directory,
										session,
										sessionId: args.record.parentSessionId,
										taskId,
										current,
										legacyUnrouted: preparedRoute.legacyUnrouted,
										testEngineerExempt:
											isTestEngineerDurablyExempt(existingEvidence),
									});
								}
							: undefined,
					beforeCommit: routeEvidenceRollback
						? () => {
								if (!routeEvidenceRollback.isCurrent()) {
									throw new Error('STAGE_B_ROUTE_SUPERSEDED');
								}
							}
						: undefined,
				},
			);
			// The durable route-evidence write succeeded: commit the live
			// reservation so its chain metadata (predecessor links) is pruned —
			// settled slots must not retain the binding history of every
			// re-dispatch (PR 3919 round-2 review finding).
			routeEvidenceRollback?.settle();
		} catch (err) {
			// A rollback failure leaves durable evidence possibly advanced: keep
			// the live reservation fail-closed instead of rolling it back.
			if (!isTaskEvidenceReceiptRollbackFailure(err)) routeEvidenceRollback?.();
			throw err;
		} finally {
			routeEvidenceRollback?.endPublication();
		}

		if (args.record.normalizedAgent === 'reviewer') {
			await collectReviewerReceiptFromTranscript(
				args.directory,
				{
					targetAgent: args.record.swarmPrefixedAgent,
					prompt: args.record.prompt?.text ?? '',
					transcript: args.result.text ?? '',
					// Guardrails records current coder-task scope on the architect
					// parent session, not the returning reviewer child session.
					sessionID: args.record.parentSessionId,
					taskId,
					reviewerCallID: args.record.callID,
					consumeHandoff: true,
				},
				args.reviewerReceiptOptions,
			);
		}

		if (
			args.record.normalizedAgent === 'reviewer' ||
			args.record.normalizedAgent === 'test_engineer'
		) {
			applyStageBStateCompletion(
				taskId,
				args.record.normalizedAgent,
				args.record.parentSessionId,
				isTestEngineerDurablyExempt(existingEvidence),
				args.directory,
				args.record.callID,
				args.record.subagentSessionId,
				args.record.workflowGeneration,
				preparedRoute,
			);
		}

		return { ok: true, consumed: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`[background-stage-b] ingestion failed: ${message}`);
		return {
			ok: false,
			consumed: false,
			reason: `stage-b ingestion failed: ${message}`,
		};
	}
}

function candidateSessions(parentSessionId: string): AgentSessionState[] {
	const parent = swarmState.agentSessions.get(parentSessionId);
	return parent ? [parent] : [];
}

function routeDispatchKey(entry: ReviewRouteEvidence): string | null {
	if (
		!entry.callId ||
		!entry.childSessionId ||
		typeof entry.generation !== 'number'
	) {
		return null;
	}
	return [
		entry.role,
		entry.sessionId ?? '',
		entry.taskId ?? '',
		entry.callId,
		entry.childSessionId,
		String(entry.generation),
	].join('\u0000');
}

function resolveBackgroundStageBRoute(input: {
	directory: string;
	taskId: string;
	parentSessionId: string;
	role: StageBStateRole;
	callId: string;
	childSessionId: string;
	generation: number;
	session: AgentSessionState;
}): {
	route: ReturnType<typeof readReviewRouteReceiptSync>;
	binding?: ReviewRouteEvidence;
	prospective: ReviewRouteEvidence[];
	legacyUnrouted: boolean;
} {
	const route = readReviewRouteReceiptSync({
		projectRoot: input.directory,
		sessionId: input.parentSessionId,
		taskId: input.taskId,
	});
	const liveEvidence = getSettledStageBRouteEvidence(
		input.session,
		input.taskId,
	);
	let durableEvidence: ReviewRouteEvidence[] = [];
	try {
		durableEvidence = routeEvidenceFromTaskGateRequirements(
			readTaskGateRequirementsReceiptsSync(input.directory, input.taskId),
		);
	} catch {
		// The durable evidence read will fail closed in the route predicate below.
	}
	const evidence = mergeStageBRouteEvidence(liveEvidence, durableEvidence);
	const legacyUnrouted =
		route === null &&
		!isStageBRouteRequired(input.session, input.taskId) &&
		(() => {
			try {
				const receipts = readTaskGateRequirementsReceiptsSync(
					input.directory,
					input.taskId,
				);
				return (
					receipts.length > 0 &&
					receipts.every((receipt) => !receipt.routeBinding)
				);
			} catch {
				return false;
			}
		})();
	let binding: ReviewRouteEvidence | undefined;
	let prospective = evidence;
	if (route?.kind === 'review_route_receipt') {
		const identities =
			input.role === 'reviewer'
				? route.identities.reviewers
				: route.identities.testEngineers;
		const slots =
			input.role === 'reviewer'
				? (route.slots?.reviewers ?? identities)
				: (route.slots?.testEngineers ?? identities);
		const dispatchKey = [
			input.role,
			input.parentSessionId,
			input.taskId,
			input.callId,
			input.childSessionId,
			String(input.generation),
		].join('\u0000');
		const retry = evidence.find(
			(entry) =>
				entry.role === input.role && routeDispatchKey(entry) === dispatchKey,
		);
		const usedSlots = new Set(
			evidence
				.filter(
					(entry) =>
						entry.role === input.role && entry !== retry && entry.slotId,
				)
				.map((entry) => entry.slotId as string),
		);
		let slotIndex = retry
			? slots.indexOf(retry.slotId ?? '')
			: slots.findIndex((slot) => !usedSlots.has(slot));
		// Stage-B re-dispatch slot reclamation (the reviewer_run wedge class):
		// when every slot of this role is already occupied by a DIFFERENT
		// dispatch, the prior attempt is an obsolete review of the same gate
		// cycle — either its settlement never advanced the workflow (the
		// pre-exemption wedge: all proof recorded, state pinned at
		// reviewer_run) or the generation rotated past it (rework). The
		// sanctioned unwedging path is to re-dispatch the Stage-B agent, so the
		// fresh dispatch must be able to re-earn the identity: it REPLACES the
		// obsolete binding instead of finding the slot occupied forever. The
		// replacement preserves the exact identity count (no extra identity is
		// invented) and tightens the binding to the dispatch actually being
		// verified; the durable requirements chain keeps both rows for audit
		// and collapses them per identity on read.
		let superseded: ReviewRouteEvidence | undefined;
		if (!retry && slotIndex < 0) {
			for (const entry of evidence) {
				if (entry.role !== input.role || entry === retry || !entry.slotId) {
					continue;
				}
				if (!identities.includes(entry.identity)) continue;
				const candidateIndex = slots.indexOf(entry.slotId);
				if (candidateIndex >= 0 && candidateIndex < identities.length) {
					superseded = entry;
					slotIndex = candidateIndex;
					break;
				}
			}
		}
		if (slotIndex >= 0 && slotIndex < identities.length) {
			const slotId = slots[slotIndex];
			const identity = identities[slotIndex];
			binding = {
				role: input.role,
				identity,
				sessionId: input.parentSessionId,
				taskId: input.taskId,
				slotId,
				callId: input.callId,
				childSessionId: input.childSessionId,
				generation: input.generation,
			};
			prospective = retry
				? evidence.map((entry) => (entry === retry ? binding! : entry))
				: superseded
					? evidence.map((entry) => (entry === superseded ? binding! : entry))
					: [...evidence, binding];
		}
	}
	return { route, binding, prospective, legacyUnrouted };
}

function applyStageBStateCompletion(
	taskId: string,
	agent: StageBStateRole,
	parentSessionId: string,
	testEngineerExempt: boolean,
	directory: string,
	callId: string,
	childSessionId: string,
	generation: number | undefined,
	preparedRoute?: ReturnType<typeof resolveBackgroundStageBRoute>,
): void {
	for (const session of candidateSessions(parentSessionId)) {
		const resolvedRoute =
			preparedRoute ??
			resolveBackgroundStageBRoute({
				directory,
				taskId,
				parentSessionId,
				role: agent,
				callId,
				childSessionId,
				generation: generation ?? -1,
				session,
			});
		const {
			binding,
			prospective: routeEvidence,
			legacyUnrouted,
		} = resolvedRoute;
		const routeEnabled = (() => {
			try {
				return (
					loadPluginConfig(directory).review_routing?.enforce_receipts ?? true
				);
			} catch {
				return true;
			}
		})();
		// #3509 consult site D (completion recording + advancement): keyed by
		// this function's `callId` PARAMETER (the dispatch being completed, not
		// args.record.callID — direct recovery callers reach this function
		// without an ingestion record). BLOCK-only: never retires the marker.
		if (
			routeEnabled &&
			isRouteBlockedForSettlement(directory, callId, parentSessionId, taskId)
		) {
			logger.warn(
				`[background-stage-b] route receipt invalidated before completion recording for ${taskId} (call ${callId})`,
			);
			continue;
		}
		// First authorize and record this exact completion. A valid partial route
		// must be durable even while sibling slots are still outstanding; only the
		// advancement decision below requires the complete route.
		const completionDecision = enforcePersistedReviewRouteReceipt({
			projectRoot: directory,
			sessionId: parentSessionId,
			taskId,
			receipts: routeEvidence,
			enforcementEnabled: routeEnabled,
			legacyUnrouted,
			requireEvidenceBindings: true,
			requireCompleteEvidence: false,
			expectedDispatch: binding
				? {
						role: binding.role,
						identity: binding.identity,
						callId: binding.callId,
						childSessionId: binding.childSessionId,
						generation: binding.generation,
					}
				: undefined,
		});
		if (!completionDecision.canAdvance) {
			logger.warn(
				`[background-stage-b] route receipt blocked ${taskId}: ${completionDecision.reason ?? 'unknown reason'}`,
			);
			continue;
		}
		if (binding && preparedRoute !== undefined) {
			// PR 3919 closeout fence (stale re-record): through the prepared
			// (post-await) path this binding was installed and settled BEFORE
			// collectReviewerReceiptFromTranscript awaited. A NEWER settlement
			// of the same gate cycle can replace the slot's live binding during
			// that await; re-recording the captured binding would then clobber
			// that settlement with a stale write. The newer settlement owns the
			// slot — skip only this re-record (this dispatch's durable evidence
			// is already published, and the advancement decision below reads the
			// LIVE array). Direct recovery callers (no preparedRoute) resolve the
			// binding synchronously against the current live state, so the
			// fence never applies to them.
			const liveEntry = getStageBRouteEvidence(session, taskId).find(
				(entry) =>
					entry.role === binding.role && entry.identity === binding.identity,
			);
			const newerSettlementOwnsSlot =
				liveEntry !== undefined &&
				typeof liveEntry.callId === 'string' &&
				liveEntry.callId.length > 0 &&
				typeof liveEntry.childSessionId === 'string' &&
				liveEntry.childSessionId.length > 0 &&
				typeof liveEntry.generation === 'number' &&
				(liveEntry.callId !== binding.callId ||
					liveEntry.childSessionId !== binding.childSessionId ||
					liveEntry.generation !== binding.generation);
			if (newerSettlementOwnsSlot) {
				logger.warn(
					`[background-stage-b] skipped stale route-evidence re-record for ${taskId}: a newer settlement owns the slot (live call ${liveEntry.callId} vs completed call ${binding.callId ?? 'unknown'})`,
				);
			} else if (!recordStageBRouteEvidence(session, taskId, binding)) {
				logger.warn(
					`[background-stage-b] route receipt blocked before Stage-B evidence publication for ${taskId}: bounded route evidence capacity exceeded`,
				);
				continue;
			}
		} else if (
			binding &&
			!recordStageBRouteEvidence(session, taskId, binding)
		) {
			logger.warn(
				`[background-stage-b] route receipt blocked before Stage-B evidence publication for ${taskId}: bounded route evidence capacity exceeded`,
			);
			continue;
		}
		recordStageBCompletion(session, taskId, agent);
		const state = getTaskState(session, taskId);
		if (state === 'tests_run' || state === 'complete') continue;
		// #3509 consult site D2 (advancement barrier): re-consult before the
		// tests_run advancement — the completion consult above consumed a
		// per-task key, but the whole-call fault marker (the common routing
		// fault shape) is only removed by retirement and must gate advancement
		// too.
		if (
			routeEnabled &&
			isRouteBlockedForSettlement(directory, callId, parentSessionId, taskId)
		) {
			logger.warn(
				`[background-stage-b] route receipt invalidated before advancement for ${taskId} (call ${callId})`,
			);
			continue;
		}
		const advancementEvidence = (() => {
			try {
				return mergeStageBRouteEvidence(
					getSettledStageBRouteEvidence(session, taskId),
					routeEvidenceFromTaskGateRequirements(
						readTaskGateRequirementsReceiptsSync(directory, taskId),
					),
				);
			} catch {
				return getSettledStageBRouteEvidence(session, taskId);
			}
		})();
		const advancementDecision = enforcePersistedReviewRouteReceipt({
			projectRoot: directory,
			sessionId: parentSessionId,
			taskId,
			receipts: advancementEvidence,
			enforcementEnabled: routeEnabled,
			legacyUnrouted,
			requireEvidenceBindings: true,
			requireCompleteEvidence: true,
			// Exempt wedge (see the persistence-site comment): the completeness
			// barrier must not demand test-engineer evidence the sanctioned
			// exemption says will never exist.
			testEngineerExempt,
		});
		const routeComplete = advancementDecision.canAdvance;

		if (
			routeComplete &&
			(hasBothStageBCompletions(session, taskId) ||
				(testEngineerExempt && agent === 'reviewer'))
		) {
			try {
				if (state === 'coder_delegated' || state === 'pre_check_passed') {
					advanceTaskState(session, taskId, 'reviewer_run', {
						telemetrySessionId: parentSessionId,
					});
				}
				if (getTaskState(session, taskId) === 'reviewer_run') {
					advanceTaskState(session, taskId, 'tests_run', {
						telemetrySessionId: parentSessionId,
					});
				}
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} after ${agent}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			continue;
		}

		if (
			agent === 'reviewer' &&
			(state === 'coder_delegated' || state === 'pre_check_passed')
		) {
			try {
				advanceTaskState(session, taskId, 'reviewer_run', {
					telemetrySessionId: parentSessionId,
				});
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} to reviewer_run: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else if (
			routeComplete &&
			agent === 'test_engineer' &&
			state === 'reviewer_run'
		) {
			try {
				advanceTaskState(session, taskId, 'tests_run', {
					telemetrySessionId: parentSessionId,
				});
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} to tests_run: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
}

/**
 * Focused regression seams for route allocation and state publication. These
 * keep the adversarial tests on the real resolver/authorizer without exposing
 * either helper as a runtime tool API.
 */
export const _test_exports = {
	resolveBackgroundStageBRoute,
	applyStageBStateCompletion,
};
