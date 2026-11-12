import * as child_process from 'node:child_process';
import * as path from 'node:path';
import {
	committedFilesBetweenAsync,
	isSwarmRuntimePath,
	resolveCurrentGitHeadAsync,
} from '../background/workspace-snapshot.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	isPathWithinDeclaredScope,
	sanitizeDiagnosticText,
} from '../scope/path-identity.js';
import {
	canonicalWorkspaceIdentity,
	getScopeBindingForParentDispatch,
	type ScopeBinding,
} from '../scope/scope-binding.js';
import {
	attachReviewerScopeGenerationDispatchSnapshot,
	claimReviewerScopeGeneration,
	discardReviewerScopeGenerationClaim,
	discardReviewerScopeGenerationForCoderCall,
	ensureAgentSession,
	getReviewerScopeGenerationForCoderCall,
	isReviewerScopeGenerationCurrent,
	MAX_REVIEWER_SCOPE_GENERATION_FILES,
	markReviewerScopeGenerationMergebackPending,
	markReviewerScopeGenerationNoChange,
	markReviewerScopeGenerationReady,
	peekReadyReviewerScopeGeneration,
	peekReviewerScopeGenerationByStatus,
	type ReviewerScopeGeneration,
	recordReviewerScopeGenerationCaptureFailure,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resolveSessionWorkspaceDirectory,
	startReviewerScopeGeneration,
} from '../state.js';
import { pushAdvisory } from '../utils/advisory-queue.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import {
	abortStandardWorktreeDispatch,
	standardWorktreeByCallID,
} from './delegation-gate/worktree-isolation.js';
import { isTaskToolId } from './normalize-tool-name.js';
import { computeScopeFingerprint } from './review-receipt.js';
import {
	buildReviewerTaskScope,
	REVIEWER_TASK_SCOPE_DESCRIPTION,
	REVIEWER_TASK_SCOPE_HEADER,
	type ReviewerTaskScope,
	resolveReviewerScopeTaskId,
} from './review-receipt-scope.js';
import {
	captureReviewerScopeFileFingerprint,
	REVIEWER_SCOPE_CAPTURE_ATTEMPTS,
	REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
	reviewerScopeCaptureToFingerprint,
	reviewerScopeFileFingerprintsEqual,
} from './reviewer-scope-file-fingerprint.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { classifyTaskResult } from './task-result-classifier.js';

export type ReviewerScopeLifecycleTransition =
	| 'coder_started'
	| 'coder_ready'
	| 'coder_no_change'
	| 'reviewer_claimed';

/** Test-only dependency-injection seam for the no-change status probe. */
export const _internals: {
	spawn: typeof child_process.spawn;
	backoffMs?: number;
	/** Test-only deadline override for the bounded retry loop (ms). */
	retryDeadlineMs?: number;
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name, which resolves against
	 * the PATH inside the child's env and can pick up an unintended binary.
	 * Exposed for test injection following the convention in
	 * `src/hooks/review-receipt-scope.ts`.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
} = {
	spawn: child_process.spawn,
	resolveGitExecutable,
};

const NOCHANGE_STATUS_TIMEOUT_MS = 10_000;
/** Byte cap for small bounded git text probes (rev-parse and friends). */
const NOCHANGE_TEXT_BYTES = 4 * 1024;
const MANIFEST_PROMPT_BYTES = 8 * 1024;

function lifecycleTarget(args: unknown): string {
	const delegation = parseDelegationArgs(args);
	return delegation
		? stripKnownSwarmPrefix(delegation.targetAgent).toLowerCase()
		: '';
}

function isTaskTool(tool: unknown): boolean {
	return typeof tool === 'string' && isTaskToolId(tool);
}

type FreshnessOutcome =
	| { current: true }
	| { current: false; reason: 'genuine_drift' }
	| {
			current: false;
			reason: 'capture_failed';
			failure: { file: string; code: string; retryable: boolean };
	  };

function generationFingerprintsAreCurrent(
	generation: ReviewerScopeGeneration,
	options: { deadlineAt?: number } = {},
): FreshnessOutcome {
	const modifiedFiles = generation.modifiedFiles;
	const fingerprints = generation.modifiedFileFingerprints;
	if (
		modifiedFiles.length === 0 ||
		modifiedFiles.length !== fingerprints.length ||
		new Set(modifiedFiles).size !== modifiedFiles.length ||
		new Set(fingerprints.map((entry) => entry.file)).size !==
			fingerprints.length
	) {
		return { current: false, reason: 'genuine_drift' };
	}
	for (const file of modifiedFiles) {
		const stored = fingerprints.filter((entry) => entry.file === file);
		if (stored.length !== 1) return { current: false, reason: 'genuine_drift' };
		const current = captureReviewerScopeFileFingerprint(
			generation.captureDirectory,
			file,
			{ deadlineAt: options.deadlineAt },
		);
		if (current.kind === 'capture_failed') {
			return {
				current: false,
				reason: 'capture_failed',
				failure: {
					file: current.file,
					code: current.code,
					retryable: current.retryable,
				},
			};
		}
		const currentFingerprint = reviewerScopeCaptureToFingerprint(current);
		if (
			!currentFingerprint ||
			!reviewerScopeFileFingerprintsEqual(stored[0], currentFingerprint)
		) {
			return { current: false, reason: 'genuine_drift' };
		}
	}
	return { current: true };
}

function scopeMatchesGenerationFingerprints(
	scope: ReviewerTaskScope,
	generation: ReviewerScopeGeneration,
): boolean {
	const lines = scope.content.split('\n');
	if (lines[0] !== REVIEWER_TASK_SCOPE_HEADER) return false;
	const records = new Map<string, Record<string, unknown>>();
	for (const line of lines.slice(1)) {
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.path === 'string') records.set(parsed.path, parsed);
		} catch {
			return false;
		}
	}
	if (
		records.size !== generation.modifiedFileFingerprints.length ||
		scope.files.length !== generation.modifiedFiles.length
	) {
		return false;
	}
	return generation.modifiedFileFingerprints.every((fingerprint) => {
		const record = records.get(fingerprint.file);
		if (!record) return false;
		return fingerprint.kind === 'deleted'
			? record.state === 'deleted'
			: record.state === 'file' &&
					record.bytes === fingerprint.size &&
					record.sha256 === fingerprint.hash;
	});
}

/** Resolve the canonical capture root from the activated binding — never ambient for lanes. */
function resolveReviewerCaptureDirectory(input: {
	binding: ScopeBinding;
	callID: string;
	ambient: string;
}):
	| { ok: true; directory: string; identity: string }
	| { ok: false; detail: string } {
	const sessionRoot =
		resolveSessionWorkspaceDirectory(input.binding.childSessionId ?? '', '') ||
		input.ambient;
	const directory =
		input.binding.source === 'worktree_derived'
			? (standardWorktreeByCallID.get(input.callID)?.handle.worktreePath ??
				sessionRoot)
			: sessionRoot;
	if (!directory.trim()) {
		return { ok: false, detail: 'workspace root unavailable' };
	}
	const identity = canonicalWorkspaceIdentity(directory);
	if (!identity) {
		return { ok: false, detail: `workspace root ${directory} not resolvable` };
	}
	if (identity !== input.binding.workspaceIdentity) {
		return {
			ok: false,
			detail: `resolved workspace ${identity} does not match activated binding identity ${input.binding.workspaceIdentity}`,
		};
	}
	return { ok: true, directory, identity };
}

function typedReviewerScopeError(code: string, detail: string): Error {
	return new Error(`${code}: ${detail}`);
}

function freshnessDenial(
	outcome: FreshnessOutcome,
	generation: ReviewerScopeGeneration,
	attempt: number,
): Error {
	if (outcome.current === false && outcome.reason === 'capture_failed') {
		const { failure } = outcome;
		return typedReviewerScopeError(
			failure.retryable
				? 'REVIEWER_CAPTURE_RETRY_EXHAUSTED'
				: 'REVIEWER_CAPTURE_FAILED',
			`task ${generation.taskId} generation ${generation.generation}: file ${failure.file} capture failed (${failure.code}, retryable=${failure.retryable}, attempts=${attempt}/${REVIEWER_SCOPE_CAPTURE_ATTEMPTS}, responsible: architect). ACTION[architect]: ${
				failure.retryable
					? 're-dispatch the reviewer to retry capture, or route explicit manual review'
					: `resolve the ${failure.code} condition for the file, then re-dispatch the reviewer or route explicit manual review`
			}`,
		);
	}
	return typedReviewerScopeError(
		'REVIEWER_SCOPE_STALE',
		`task ${generation.taskId} generation ${generation.generation}: coder post-write fingerprints changed before reviewer dispatch (retryable=false, responsible: architect)`,
	);
}

function sleepBounded(ms: number): Promise<void> {
	// Deliberately a normal (ref'd) timer: an unref'd timer can leave the
	// resolve callback unscheduled when nothing else holds the event loop,
	// hanging the bounded retry. Bounded attempts + deadline cap total time.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Bounded inline retry for typed retryable capture failures (issue #2100 contract E). */
async function withCaptureRetry<T>(
	run: (attempt: number, deadlineAt: number) => Promise<T> | T,
	isRetryable: (value: T) => boolean,
	options: { deadlineMs?: number } = {},
): Promise<{ value: T; attemptsRun: number }> {
	const backoff = _internals.backoffMs ?? 100;
	const deadlineAt =
		Date.now() +
		(options.deadlineMs ??
			_internals.retryDeadlineMs ??
			REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS);
	let last: T | undefined;
	let attemptsRun = 0;
	for (
		let attempt = 1;
		attempt <= REVIEWER_SCOPE_CAPTURE_ATTEMPTS;
		attempt += 1
	) {
		// The deadline may skip a MIDDLE attempt (continue) but never the final
		// one — exhaustion must never be reported while a funded attempt slot
		// remains unspent, and the reported attempt count is always the true
		// number of executed attempts.
		if (
			attempt > 1 &&
			attempt < REVIEWER_SCOPE_CAPTURE_ATTEMPTS &&
			Date.now() > deadlineAt
		) {
			continue;
		}
		attemptsRun += 1;
		last = await run(attempt, deadlineAt);
		if (!isRetryable(last)) return { value: last, attemptsRun };
		if (attempt < REVIEWER_SCOPE_CAPTURE_ATTEMPTS) await sleepBounded(backoff);
	}
	return { value: last as T, attemptsRun };
}

/**
 * Small bounded git text probe (rev-parse and friends). Null on any failure,
 * timeout, or oversized output — never blocks indefinitely, never floods
 * stdout into memory, never leaks git errors into chat.
 */
async function runBoundedGitText(
	directory: string,
	args: readonly string[],
): Promise<string | null> {
	let child: child_process.ChildProcess | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		child = _internals.spawn(_internals.resolveGitExecutable(), [...args], {
			cwd: directory,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: NOCHANGE_STATUS_TIMEOUT_MS,
			windowsHide: true,
		});
		return await new Promise<string | null>((resolve) => {
			let settled = false;
			let stdoutBytes = 0;
			const chunks: Buffer[] = [];
			const finish = (value: string | null): void => {
				if (settled) return;
				settled = true;
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				resolve(value);
			};
			const killNull = (): void => {
				try {
					child?.kill();
				} catch {
					// Best-effort cleanup; the child may already have exited.
				}
				finish(null);
			};
			timeoutHandle = setTimeout(killNull, NOCHANGE_STATUS_TIMEOUT_MS);
			timeoutHandle.unref?.();
			child?.once('error', killNull);
			child?.stdout?.on('data', (chunk: Buffer | string) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += bytes.byteLength;
				if (stdoutBytes > NOCHANGE_TEXT_BYTES) {
					killNull();
					return;
				}
				chunks.push(bytes);
			});
			child?.once('close', (exitCode) => {
				finish(exitCode === 0 ? Buffer.concat(chunks).toString('utf-8') : null);
			});
		});
	} catch {
		return null;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		try {
			child?.kill();
		} catch {
			// Best-effort cleanup; the child may already have exited.
		}
	}
}

/** Minimal C-style unquote for core.quotePath porcelain paths (PR #3668 F-4/F-8). */
function unquotePorcelainPath(p: string): string {
	if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
		return p
			.slice(1, -1)
			.replace(/\\(["\\nt])/g, (_, e: string) =>
				e === 'n' ? '\n' : e === 't' ? '\t' : e,
			);
	}
	return p;
}

/**
 * Strip the repo-toplevel→capture-root prefix from a porcelain/diff path so
 * nested-root workspaces (project root a subdirectory of the git repo) get
 * capture-relative paths, matching the declared-scope and runtime-filter
 * bases (PR #3668 F-1). Returns null for paths outside the capture root —
 * they cannot belong to this generation's declared scope.
 */
function toCaptureRelativePath(
	p: string,
	capturePrefix: string,
): string | null {
	const unquoted = unquotePorcelainPath(p);
	const normalized = unquoted.replaceAll('\\', '/');
	if (capturePrefix === '') return normalized;
	if (normalized === capturePrefix) return '';
	if (normalized.startsWith(`${capturePrefix}/`)) {
		return normalized.slice(capturePrefix.length + 1);
	}
	return null;
}

/**
 * Bounded workspace-dirt enumeration for the no-change/reconciliation paths.
 * Returns the capture-root-relative non-runtime dirt paths plus the total
 * dirt count (paths outside the capture root count as dirt but cannot carry
 * declared scope), or null when git is unavailable — classification fails
 * closed on null. Runtime paths (.swarm/...) never count as dirt (same
 * rationale as the settlement side's filterSwarmRuntimePorcelain, #2271
 * bug 2); `--untracked-files=all` keeps per-file granularity so a wholly
 * untracked `.swarm/` directory cannot collapse a visible-code file out of
 * the verdict (PR #3668 F-4).
 */
async function captureWorkspaceDirtPaths(
	directory: string,
): Promise<{ inRoot: string[]; totalDirt: number } | null> {
	const toplevel = await runBoundedGitText(directory, [
		'rev-parse',
		'--show-toplevel',
	]);
	if (toplevel === null || toplevel.trim().length === 0) return null;
	const status = await runBoundedGitText(directory, [
		'status',
		'--porcelain',
		'--untracked-files=all',
	]);
	if (status === null) return null;
	const capturePrefix = path
		.relative(toplevel.trim(), path.resolve(directory))
		.replaceAll('\\', '/');
	const inRoot = new Set<string>();
	let totalDirt = 0;
	for (const line of status.split('\n')) {
		const trimmedLine = line.replace(/\r$/, '');
		if (trimmedLine.length < 4) continue;
		// Porcelain v1 line shape is exactly "XY <path>" (two status columns,
		// one space, path; rename: "XY O -> N") — the X column may itself be a
		// space (" M path"), so the line is NOT trimmed before the slice.
		for (const rawPath of trimmedLine.slice(3).split(' -> ')) {
			if (rawPath.length === 0) continue;
			const captureRelative = toCaptureRelativePath(rawPath, capturePrefix);
			if (captureRelative === null) {
				// Outside the capture root: another actor's tree area. Counts as
				// dirt for the clean verdict but can never carry declared scope.
				totalDirt += 1;
				continue;
			}
			if (isSwarmRuntimePath(captureRelative)) continue;
			totalDirt += 1;
			inRoot.add(captureRelative);
		}
	}
	return { inRoot: [...inRoot], totalDirt };
}

/**
 * Bounded `git status --porcelain` verdict for the no-change path. Only ever
 * answers clean/dirty/unverifiable — never blocks indefinitely, never floods
 * stdout into memory, never leaks git errors into chat.
 */
async function verifyWorkingTreeClean(
	directory: string,
): Promise<'clean' | 'dirty' | 'unverifiable'> {
	const dirt = await captureWorkspaceDirtPaths(directory);
	if (dirt === null) return 'unverifiable';
	return dirt.totalDirt === 0 ? 'clean' : 'dirty';
}

function reviewerManifestPromptBlock(input: {
	description: string;
	hash: string;
	headSha: string;
	workspaceIdentity: string;
	entries: Array<{
		path: string;
		state: 'file' | 'deleted';
		bytes?: number;
		sha256?: string;
		mode: string;
	}>;
}): string {
	const header = [
		'<reviewer_scope_manifest>',
		`description: ${input.description}`,
		`manifest_hash: ${input.hash}`,
		`head: ${input.headSha}`,
		`workspace: ${input.workspaceIdentity}`,
	];
	// Paths are coder-influenced strings: JSON-quoting neutralizes tag and
	// delimiter injection (a raw `</reviewer_scope_manifest>` in a filename
	// must never splice fake structure into the reviewer's prompt).
	const full = input.entries.map((entry) =>
		entry.state === 'deleted'
			? `${JSON.stringify(entry.path)} state=deleted delivery=${entry.mode}`
			: `${JSON.stringify(entry.path)} state=file bytes=${entry.bytes} sha256=${entry.sha256} delivery=${entry.mode}`,
	);
	const instruction = [
		'completeness: attributed — every attributed modified file (guardrail-observed, committed since dispatch, or a declared-scope working-tree change) is listed; none omitted.',
		'Every listed file must be verified against its sha256 (current bytes) before a verdict.',
		'Files with delivery=manual MUST be inspected through read-only tools; inline bytes were not attached.',
		'</reviewer_scope_manifest>',
	];
	const withEntries = [...header, ...full, ...instruction].join('\n');
	if (withEntries.length <= MANIFEST_PROMPT_BYTES) return withEntries;
	const pathsOnly = [
		...header,
		...input.entries.map((entry) => JSON.stringify(entry.path)),
		...instruction,
	].join('\n');
	if (pathsOnly.length <= MANIFEST_PROMPT_BYTES) return pathsOnly;
	return [
		...header,
		`files: ${input.entries.length} (manifest too large to list — inspect each declared file via read-only tools; delivery=manual for all)`,
		...instruction,
	].join('\n');
}

/** Append the exact manifest (bounded) to the reviewer Task prompt. Best-effort; never blocks. */
function injectReviewerManifestPrompt(
	args: unknown,
	scope: ReviewerTaskScope,
	hash: string,
): void {
	try {
		if (!args || typeof args !== 'object') return;
		const record = args as { prompt?: unknown };
		if (typeof record.prompt !== 'string') return;
		if (record.prompt.includes('<reviewer_scope_manifest>')) return;
		const deliveryByPath = new Map(scope.delivery.map((e) => [e.path, e.mode]));
		const entries = scope.files.map((file) => {
			const fingerprintLine = scope.content
				.split('\n')
				.map((line) => {
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						return typeof parsed.path === 'string' && parsed.path === file
							? parsed
							: null;
					} catch {
						return null;
					}
				})
				.find((parsed) => parsed !== null);
			const state: 'file' | 'deleted' =
				fingerprintLine?.state === 'deleted' ? 'deleted' : 'file';
			return {
				path: file,
				state,
				bytes:
					typeof fingerprintLine?.bytes === 'number'
						? fingerprintLine.bytes
						: undefined,
				sha256:
					typeof fingerprintLine?.sha256 === 'string'
						? fingerprintLine.sha256
						: undefined,
				mode: deliveryByPath.get(file) ?? 'manual',
			};
		});
		const block = reviewerManifestPromptBlock({
			description: REVIEWER_TASK_SCOPE_DESCRIPTION,
			hash,
			headSha: scope.headSha,
			workspaceIdentity: scope.workspaceIdentity,
			entries,
		});
		record.prompt = `${block}\n\n${record.prompt}`;
	} catch {
		// Advisory prompt augmentation must never block a claimed dispatch.
	}
}

/** Run only after the complete blocking before-chain approved this Task call. */
export async function beginApprovedReviewerScopeLifecycle(input: {
	directory: string;
	tool: unknown;
	args: unknown;
	parentSessionID: string;
	callID: string;
	maxBytes?: number;
}): Promise<ReviewerScopeLifecycleTransition | null> {
	if (!isTaskTool(input.tool)) return null;
	const taskId = await resolveReviewerScopeTaskId(input.directory, input.args);
	if (!taskId) return null;
	const target = lifecycleTarget(input.args);
	if (target === 'coder') {
		const binding = getScopeBindingForParentDispatch({
			parentSessionId: input.parentSessionID,
			dispatchCallId: input.callID,
		});
		if (!binding) return null;
		if (binding.taskId !== taskId) {
			// This throw fires after the fail-closed region, so the normal
			// before-chain cleanup never runs — abort any provisioned lane
			// first or the worktree/branch leaks (F-006).
			if (standardWorktreeByCallID.has(input.callID)) {
				try {
					await abortStandardWorktreeDispatch(
						input.callID,
						'cancelled',
						input.directory,
					);
				} catch {
					// Best-effort; the typed denial below is the payload.
				}
			}
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_BINDING_MISMATCH',
				`task ${taskId}: the activated scope binding names task ${binding.taskId} for this dispatch (retryable=true, responsible: architect). ACTION[architect]: re-declare scope for the exact task and redispatch`,
			);
		}
		const capture = resolveReviewerCaptureDirectory({
			binding,
			callID: input.callID,
			ambient: input.directory,
		});
		if (!capture.ok) {
			if (standardWorktreeByCallID.has(input.callID)) {
				try {
					await abortStandardWorktreeDispatch(
						input.callID,
						'cancelled',
						input.directory,
					);
				} catch {
					// Best-effort; the typed denial below is the payload.
				}
			}
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_BINDING_MISMATCH',
				`task ${taskId}: coder workspace root could not be bound (${capture.detail}) (retryable=true, responsible: architect). ACTION[architect]: verify the worktree lane/scope binding for this dispatch, then redispatch`,
			);
		}
		const rawArgs =
			input.args && typeof input.args === 'object'
				? (input.args as Record<string, unknown>)
				: null;
		// Issue #3655: record the dispatch-time HEAD so coder completion can
		// reconcile committed changes into the generation when guardrail
		// write-routing observed nothing. A null head (non-git workspace or a
		// failed rev-parse) reconciles as degraded — never as proof of no change.
		const dispatchGitHead = await resolveCurrentGitHeadAsync(capture.directory);
		return startReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
			coderCallID: input.callID,
			background:
				rawArgs?.background === true || rawArgs?.background === 'true',
			declaredFiles: binding.files,
			captureDirectory: capture.directory,
			workspaceIdentity: capture.identity,
			dispatchGitHead,
		})
			? 'coder_started'
			: null;
	}
	if (target === 'reviewer') {
		const ready = peekReadyReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
		});
		if (!ready) {
			const noChange = peekReviewerScopeGenerationByStatus({
				parentSessionID: input.parentSessionID,
				taskId,
				status: 'no_change',
			});
			if (noChange) {
				throw typedReviewerScopeError(
					'REVIEWER_SCOPE_NO_CHANGE',
					`task ${taskId} generation ${noChange.generation}: the coder made zero guardrail-observed writes and no committed or working-tree change exists within the declared reviewer scope — no reviewer pass is owed (retryable=true, responsible: architect). ACTION[architect]: satisfy acceptance deterministically, or re-dispatch the coder if changes were intended`,
				);
			}
			const pending = peekReviewerScopeGenerationByStatus({
				parentSessionID: input.parentSessionID,
				taskId,
				status: 'mergeback_pending',
			});
			if (pending) {
				throw typedReviewerScopeError(
					'REVIEWER_SCOPE_MERGEBACK_PENDING',
					`task ${taskId} generation ${pending.generation}: lane merge-back has not been verified against the primary checkout yet (retryable=true, responsible: architect). ACTION[architect]: wait for the merge-back advisory, then re-dispatch the reviewer`,
				);
			}
			const mismatch = peekReviewerScopeGenerationByStatus({
				parentSessionID: input.parentSessionID,
				taskId,
				status: 'mergeback_mismatch',
			});
			if (mismatch) {
				const mergebackReason =
					mismatch.mergeback && 'failedAt' in mismatch.mergeback
						? mismatch.mergeback.reason
						: 'unverified';
				throw typedReviewerScopeError(
					'REVIEWER_SCOPE_MERGEBACK_MISMATCH',
					`task ${taskId} generation ${mismatch.generation}: merge-back verification failed (${mergebackReason}) (retryable=true, responsible: architect). ACTION[architect]: resolve the lane merge conflict or re-dispatch the coder`,
				);
			}
			// Issue #3655: a generation still `collecting` at reviewer dispatch
			// is an attribution problem with a typed cause, not terminal
			// fingerprint drift. Zero routed files means attribution was empty
			// (or degraded — reconciliation could not prove the committed diff);
			// routed files without complete fingerprints is a capture problem
			// whose retryability follows the recorded failure class.
			const collecting = peekReviewerScopeGenerationByStatus({
				parentSessionID: input.parentSessionID,
				taskId,
				status: 'collecting',
			});
			if (collecting) {
				if (collecting.modifiedFiles.length === 0) {
					throw typedReviewerScopeError(
						'REVIEWER_ATTRIBUTION_EMPTY',
						`task ${taskId} generation ${collecting.generation}: coder attribution was empty — zero guardrail-observed writes were routed and no committed declared change was proven (declaredFiles=${collecting.declaredFiles.length}, routed=0, committed-in-scope=unproven-or-empty, retryable=true, responsible: architect). ACTION[architect]: inspect the workspace for writes that bypassed guardrails, or re-dispatch the coder`,
					);
				}
				const permanentCaptureFailure = collecting.captureFailures.find(
					(entry) => entry.retryable === false,
				);
				if (permanentCaptureFailure) {
					throw typedReviewerScopeError(
						'REVIEWER_CAPTURE_FAILED',
						`task ${taskId} generation ${collecting.generation}: file ${sanitizeDiagnosticText(permanentCaptureFailure.file, 120)} capture failed permanently (${permanentCaptureFailure.code}, retryable=false, responsible: architect). ACTION[architect]: resolve the ${permanentCaptureFailure.code} condition, then re-dispatch the coder so completion recaptures before dispatching the reviewer`,
					);
				}
				const shown = collecting.captureFailures
					.map((entry) => sanitizeDiagnosticText(entry.file, 120))
					.slice(0, 5)
					.join(', ');
				throw typedReviewerScopeError(
					'REVIEWER_CAPTURE_INCOMPLETE',
					`task ${taskId} generation ${collecting.generation}: ${collecting.modifiedFiles.length - collecting.modifiedFileFingerprints.length} file(s) have no stored fingerprint${shown ? ` (capture failures: ${shown})` : ''} (retryable=true, responsible: architect). ACTION[architect]: re-dispatch the coder so capture re-runs, or inspect the capture failures`,
				);
			}
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_STALE',
				`task ${taskId}: coder post-write fingerprints are incomplete or changed before reviewer dispatch (retryable=false, responsible: architect)`,
			);
		}
		// First freshness gate: typed transient failures get one bounded retry
		// pass (3 attempts / batch deadline, identity re-read each attempt);
		// genuine drift stays stale; infrastructure failure never discards.
		const freshFirst = await withCaptureRetry(
			(_attempt, deadlineAt) =>
				generationFingerprintsAreCurrent(
					peekReadyReviewerScopeGeneration({
						parentSessionID: input.parentSessionID,
						taskId,
					}) ?? ready,
					{ deadlineAt },
				),
			(outcome) =>
				outcome.current === false &&
				outcome.reason === 'capture_failed' &&
				outcome.failure.retryable,
		);
		if (freshFirst.value.current === false) {
			const outcome = freshFirst.value;
			if (outcome.reason === 'genuine_drift') {
				discardReviewerScopeGenerationForCoderCall({
					parentSessionID: input.parentSessionID,
					taskId,
					coderCallID: ready.coderCallID,
				});
			}
			throw freshnessDenial(outcome, ready, freshFirst.attemptsRun);
		}
		const build = await withCaptureRetry(
			(_attempt, deadlineAt) =>
				buildReviewerTaskScope(
					input.directory,
					ready.modifiedFiles,
					input.maxBytes,
					{
						taskId: ready.taskId,
						coderCallID: ready.coderCallID,
						generation: ready.generation,
						sessionIncarnation: ready.sessionIncarnation,
					},
					{ deadlineAt },
				),
			(result) => result.ok === false && result.retryable,
		);
		if (!build.value.ok) {
			const failure = build.value;
			throw typedReviewerScopeError(
				failure.retryable
					? 'REVIEWER_CAPTURE_RETRY_EXHAUSTED'
					: 'REVIEWER_CAPTURE_FAILED',
				`task ${ready.taskId} generation ${ready.generation}${failure.file ? `: file ${failure.file}` : ''}: scope build failed (${failure.code}, retryable=${failure.retryable}, attempts=${build.attemptsRun}/${REVIEWER_SCOPE_CAPTURE_ATTEMPTS}, responsible: architect). ACTION[architect]: ${
					failure.retryable
						? 're-dispatch the reviewer to retry capture, or route explicit manual review'
						: `resolve the ${failure.code} condition, then re-dispatch the reviewer or route explicit manual review`
				}`,
			);
		}
		const current = peekReadyReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
		});
		const exactGenerationStillCurrent =
			current !== null &&
			current.coderCallID === ready.coderCallID &&
			current.generation === ready.generation &&
			current.sessionIncarnation === ready.sessionIncarnation &&
			isReviewerScopeGenerationCurrent({
				parentSessionID: input.parentSessionID,
				taskId,
				coderCallID: ready.coderCallID,
				generation: ready.generation,
				sessionIncarnation: ready.sessionIncarnation,
			});
		if (
			!current ||
			!exactGenerationStillCurrent ||
			!generationFingerprintsAreCurrent(current, {
				deadlineAt: Date.now() + REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
			}).current ||
			!scopeMatchesGenerationFingerprints(build.value.scope, current)
		) {
			discardReviewerScopeGenerationForCoderCall({
				parentSessionID: input.parentSessionID,
				taskId,
				coderCallID: ready.coderCallID,
			});
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_STALE',
				`task ${taskId} generation ${ready.generation}: exact reviewer dispatch scope changed during capture (retryable=false, responsible: architect)`,
			);
		}
		// No await is permitted between the final byte/generation recheck above
		// and the exact claim plus immutable dispatch binding below.
		const claimed = claimReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
			reviewerCallID: input.callID,
		});
		if (
			!claimed ||
			claimed.coderCallID !== ready.coderCallID ||
			claimed.generation !== ready.generation ||
			claimed.sessionIncarnation !== ready.sessionIncarnation
		) {
			discardReviewerScopeGenerationClaim({
				parentSessionID: input.parentSessionID,
				taskId,
				reviewerCallID: input.callID,
			});
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_STALE',
				`task ${taskId}: exact reviewer dispatch scope could not be claimed (retryable=false, responsible: architect)`,
			);
		}
		const dispatchHash = computeScopeFingerprint(
			build.value.scope.content,
			build.value.scope.description,
		).hash;
		if (
			!attachReviewerScopeGenerationDispatchSnapshot({
				parentSessionID: input.parentSessionID,
				taskId,
				reviewerCallID: input.callID,
				snapshot: {
					hash: dispatchHash,
					description: build.value.scope.description,
					files: [...build.value.scope.files],
					headSha: build.value.scope.headSha,
					taskId: claimed.taskId,
					coderCallID: claimed.coderCallID,
					generation: claimed.generation,
					sessionIncarnation: claimed.sessionIncarnation,
				},
			})
		) {
			discardReviewerScopeGenerationClaim({
				parentSessionID: input.parentSessionID,
				taskId,
				reviewerCallID: input.callID,
			});
			throw typedReviewerScopeError(
				'REVIEWER_SCOPE_STALE',
				`task ${taskId}: exact reviewer dispatch scope could not be captured (retryable=false, responsible: architect)`,
			);
		}
		// Claim is durable; hand the reviewer the exact manifest it reviews under.
		injectReviewerManifestPrompt(input.args, build.value.scope, dispatchHash);
		return 'reviewer_claimed';
	}
	return null;
}

/**
 * Issue #3655: reconcile committed git attribution into a zero-routed-write
 * generation at coder completion — the shared-root counterpart of the
 * background ingestion bridge (stage-b-gates).
 *
 * - `routed` — at least one committed in-declared-scope file entered the
 *   generation (fingerprints captured or typed failures recorded); the caller
 *   continues into the completeness/ready path with a refreshed view.
 * - `proved-empty` — the committed diff was PROVEN to contain nothing in
 *   declared scope; classification falls to the working-tree verdict.
 * - `degraded` — attribution could not be proven (no dispatch head recorded,
 *   current head unresolvable, or a failed diff). Never treated as proof of
 *   no change; the generation stays `collecting` for the typed
 *   attribution-empty denial at reviewer dispatch.
 */
async function routeCommittedDeclaredChanges(
	parentSessionID: string,
	generation: ReviewerScopeGeneration,
): Promise<'routed' | 'proved-empty' | 'degraded' | 'overflow' | 'skipped'> {
	// PR #3668 feedback F-2: reconcile on EVERY completion whose declared scope
	// still has unrouted files (previously gated on zero routed writes, which
	// silently under-reported committed declared output when at least one
	// write was guardrail-observed). A fully routed scope needs no git work.
	const routedFiles = new Set(generation.modifiedFiles);
	const missingDeclared = generation.declaredFiles.filter(
		(file) => !routedFiles.has(file),
	);
	// An empty declared scope keeps the proved-empty classification (the
	// read-only no-change contract), never an empty ready publication.
	if (generation.declaredFiles.length > 0 && missingDeclared.length === 0) {
		return 'skipped';
	}
	const dispatchHead = generation.dispatchGitHead ?? null;
	if (dispatchHead === null) return 'degraded';
	const currentHead = await resolveCurrentGitHeadAsync(
		generation.captureDirectory,
	);
	if (currentHead === null) return 'degraded';
	// `relative: true` (F-1): the diff is run with cwd = captureDirectory, so
	// the returned paths are capture-root-relative even when the project root
	// is a subdirectory of the git repo; `../`-prefixed paths outside the root
	// cannot match declared scope.
	const committed = await committedFilesBetweenAsync(
		generation.captureDirectory,
		dispatchHead,
		currentHead,
		{ relative: true },
	);
	if (committed === null) return 'degraded';
	// Declared-scope working-tree changes (written but not committed, or never
	// guardrail-observed) join the union — capture-relative so nested roots
	// match (captureWorkspaceDirtPaths).
	const dirt = await captureWorkspaceDirtPaths(generation.captureDirectory);
	if (dirt === null) return 'degraded';
	const declaredDirt = dirt.inRoot.filter((file) =>
		isPathWithinDeclaredScope(
			file,
			generation.declaredFiles,
			generation.captureDirectory,
		),
	);
	const candidates = [
		...new Set([
			...committed.filter((file) => !isSwarmRuntimePath(file)),
			...declaredDirt,
		]),
	].filter((file) =>
		isPathWithinDeclaredScope(
			file,
			generation.declaredFiles,
			generation.captureDirectory,
		),
	);
	if (candidates.length === 0) return 'proved-empty';
	// F-3: the per-generation file cap DELETES the generation when exceeded;
	// detect it up front so routing never destroys the generation mid-loop and
	// the architect gets a typed, retryable advisory instead of a silent null.
	const capacity =
		MAX_REVIEWER_SCOPE_GENERATION_FILES - generation.modifiedFiles.length;
	if (candidates.length > capacity) {
		pushAdvisory(
			ensureAgentSession(parentSessionID),
			`REVIEWER_SCOPE_GENERATION_OVERFLOW: task ${generation.taskId} generation ${generation.generation}: ${candidates.length} declared-scope changes exceed the ${MAX_REVIEWER_SCOPE_GENERATION_FILES}-file generation cap (${capacity} slots remaining); the generation is retained unclassified. ACTION[architect]: split the task or narrow the declared scope, then re-dispatch the coder`,
		);
		return 'overflow';
	}
	let routed = 0;
	const deadlineAt = Date.now() + REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS;
	for (const file of candidates) {
		if (
			!recordReviewerScopeGenerationFile({
				parentSessionID,
				taskId: generation.taskId,
				coderCallID: generation.coderCallID,
				file,
			})
		) {
			continue;
		}
		routed += 1;
		// F-6/F-3: bounded attempts + batch deadline at this hook-path capture
		// site, matching the guardrails sibling convention.
		let fingerprint = null;
		for (
			let attempt = 1;
			attempt <= REVIEWER_SCOPE_CAPTURE_ATTEMPTS;
			attempt += 1
		) {
			const capture = captureReviewerScopeFileFingerprint(
				generation.captureDirectory,
				file,
				{ deadlineAt },
			);
			if (capture.kind !== 'capture_failed') {
				fingerprint = reviewerScopeCaptureToFingerprint(capture);
				break;
			}
			if (
				!capture.retryable ||
				Date.now() > deadlineAt ||
				attempt === REVIEWER_SCOPE_CAPTURE_ATTEMPTS
			) {
				recordReviewerScopeGenerationCaptureFailure({
					parentSessionID,
					taskId: generation.taskId,
					coderCallID: generation.coderCallID,
					file: capture.file,
					code: capture.code,
					retryable: capture.retryable,
				});
				break;
			}
		}
		if (fingerprint) {
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID,
				taskId: generation.taskId,
				coderCallID: generation.coderCallID,
				fingerprint,
			});
		}
	}
	// Files entered the generation even when every capture failed — the
	// completeness check and dispatch denials own that state (capture
	// incomplete / capture failed), not the empty-attribution class.
	return routed > 0 ? 'routed' : 'degraded';
}

/** Mark a synchronous coder terminal; background running placeholders are inert. */
export async function completeReviewerScopeLifecycle(input: {
	directory: string;
	tool: unknown;
	args: unknown;
	output: unknown;
	parentSessionID: string;
	callID: string;
}): Promise<ReviewerScopeLifecycleTransition | null> {
	if (!isTaskTool(input.tool)) return null;
	if (lifecycleTarget(input.args) !== 'coder') return null;
	const result = classifyTaskResult(input.output);
	if (result === 'running') return null;
	const taskId = await resolveReviewerScopeTaskId(input.directory, input.args);
	if (!taskId) {
		discardReviewerScopeGenerationForCoderCall({
			parentSessionID: input.parentSessionID,
			coderCallID: input.callID,
		});
		return null;
	}
	if (result === 'non_success') {
		discardReviewerScopeGenerationForCoderCall({
			parentSessionID: input.parentSessionID,
			taskId,
			coderCallID: input.callID,
		});
		return null;
	}
	const generation = getReviewerScopeGenerationForCoderCall({
		parentSessionID: input.parentSessionID,
		taskId,
		coderCallID: input.callID,
	});
	if (!generation) return null;
	if (generation.status !== 'collecting') return null;
	let scoped = generation;
	{
		// Issue #3655 (extended by PR #3668 feedback F-2): classify from
		// guardrail routing only after reconciling committed AND declared-scope
		// working-tree attribution — on every completion whose declared scope
		// still has unrouted files, not only the zero-routed case.
		const reconciliation = await routeCommittedDeclaredChanges(
			input.parentSessionID,
			scoped,
		);
		if (reconciliation === 'degraded') {
			// Committed attribution could not be proven (non-git workspace,
			// unresolvable HEAD, or a failed diff). A clean working tree is NOT
			// proof of no mutation here — retain the generation for the typed
			// attribution-empty denial at reviewer dispatch.
			pushAdvisory(
				ensureAgentSession(input.parentSessionID),
				`REVIEWER_ATTRIBUTION_DEGRADED: task ${taskId} generation ${scoped.generation}: committed-change reconciliation could not be proven (no dispatch git head, unresolvable current head, or failed committed diff); the generation is retained for a typed reviewer-dispatch denial. ACTION[architect]: verify git availability for the workspace, then re-dispatch the coder`,
			);
			return null;
		}
		if (reconciliation === 'overflow') {
			// The generation-cap advisory was already pushed by the
			// reconciliation; the generation stays collecting for the typed
			// (retryable) reviewer-dispatch denial. Never terminal.
			return null;
		}
		if (reconciliation === 'routed') {
			const refreshed = getReviewerScopeGenerationForCoderCall({
				parentSessionID: input.parentSessionID,
				taskId,
				coderCallID: input.callID,
			});
			if (
				!refreshed ||
				refreshed.status !== 'collecting' ||
				refreshed.modifiedFiles.length === 0
			) {
				// Routing raced with another transition; leave the recorded
				// state to the dispatch-time denial paths.
				return null;
			}
			scoped = refreshed;
		} else if (reconciliation === 'proved-empty') {
			// proved-empty: the committed diff and the declared-scope working
			// tree were proven to contain nothing attributable. Truthfulness
			// now rests on the rest of the working tree.
			const status = await verifyWorkingTreeClean(scoped.captureDirectory);
			if (status === 'clean') {
				return markReviewerScopeGenerationNoChange({
					parentSessionID: input.parentSessionID,
					taskId,
					coderCallID: input.callID,
				})
					? 'coder_no_change'
					: null;
			}
			// Dirty or unverifiable workspace with zero observed writes: changes
			// escaped guardrail observation. Fail closed — retained, actionable.
			pushAdvisory(
				ensureAgentSession(input.parentSessionID),
				`REVIEWER_SCOPE_UNATTRIBUTED_CHANGE: task ${taskId} generation ${scoped.generation}: the workspace diff was ${status === 'dirty' ? 'dirty' : 'not verifiable'} while zero guardrail-observed writes were routed. ACTION[architect]: inspect the workspace for writes that bypassed guardrails, then re-dispatch the coder`,
			);
			return null;
		}
		// 'skipped': every declared file was already routed — proceed to the
		// completeness/ready path with the existing generation view.
	}
	const generationScoped = scoped;
	const complete =
		generationScoped.modifiedFiles.length ===
			generationScoped.modifiedFileFingerprints.length &&
		generationScoped.modifiedFiles.every((file) =>
			generationScoped.modifiedFileFingerprints.some(
				(entry) => entry.file === file,
			),
		);
	if (!complete) {
		const missing =
			generationScoped.modifiedFiles.length -
			generationScoped.modifiedFileFingerprints.length;
		pushAdvisory(
			ensureAgentSession(input.parentSessionID),
			`REVIEWER_CAPTURE_INCOMPLETE: task ${taskId} generation ${generationScoped.generation}: ${missing} file(s) have no stored fingerprint after coder completion; the generation is retained but not reviewable yet. ACTION[architect]: retry the coder so capture re-runs, or inspect ${generationScoped.captureFailures
				.map((entry) => sanitizeDiagnosticText(entry.file, 120))
				.slice(0, 5)
				.join(', ')} capture failures (responsible: architect)`,
		);
		return null;
	}
	const laneIdentity = generationScoped.workspaceIdentity;
	// Both this identity and the merge-back verifier's primary identity derive
	// from the same plugin root (ctx.directory) in the single-host model; the
	// verifier records the exact primary identity it verified on settlement.
	const primaryIdentity = canonicalWorkspaceIdentity(input.directory);
	if (laneIdentity && primaryIdentity && laneIdentity !== primaryIdentity) {
		// Lane-captured bytes: merge-back verification publishes `ready`.
		markReviewerScopeGenerationMergebackPending({
			parentSessionID: input.parentSessionID,
			taskId,
			coderCallID: input.callID,
		});
		return null;
	}
	return markReviewerScopeGenerationReady({
		parentSessionID: input.parentSessionID,
		taskId,
		coderCallID: input.callID,
		// Arm the state-level lane gate whenever the primary identity is
		// computable, mirroring the background path's fail-closed routing.
		primaryWorkspaceIdentity: primaryIdentity ?? undefined,
	})
		? 'coder_ready'
		: null;
}
