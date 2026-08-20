import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeCleanAsync,
} from '../background/workspace-snapshot';
import {
	classifyPrWorkflowGitState,
	type PrWorkflowGitState,
} from '../git/pr-workflow-state';
import {
	type PrFeedbackInventoryAmendmentRecord,
	type PrWorkflowGateState,
	prWorkflowSessionFileStem,
	readPrWorkflowGateStateForRecovery,
} from '../hooks/pr-workflow-gate';
import { validateSwarmPath } from '../hooks/utils';
import { bunSpawn } from '../utils/bun-compat';
import { createSwarmTool } from './create-tool';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_STDOUT_BYTES = 512 * 1024;
const MAX_DIRTY_FILES = 50;
const MAX_REMOTES = 20;
const MAX_REMOTE_URL_LEN = 200;
const MAX_FIELD_LEN = 240;
const RECEIPT_DIR = 'pr-workflow-checkouts';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Truncate to an exact UTF-8 byte budget. `String.prototype.length`/`.slice`
 * operate on UTF-16 code units, not bytes — for multi-byte content (non-ASCII
 * filenames, emoji) that under-counts real byte size and can split a
 * surrogate pair at the cut point. Round-tripping through TextEncoder/Decoder
 * truncates by actual byte count and safely replaces any multi-byte sequence
 * severed at the boundary instead of leaving a lone surrogate.
 */
function truncateToByteBudget(value: string, maxBytes: number): string {
	const encoded = utf8Encoder.encode(value);
	if (encoded.length <= maxBytes) return value;
	return utf8Decoder.decode(encoded.subarray(0, maxBytes));
}

interface PrWorkflowStatusGitState {
	head: string | null;
	branch: string | null;
	/**
	 * `null` means git could not determine detached-vs-branch state at all (the
	 * `rev-parse --abbrev-ref HEAD` read failed) — distinct from `false`, which
	 * asserts a verified non-detached branch checkout. Collapsing the failure
	 * into `false` would assert "not detached" when the truth is "unknown".
	 */
	detached: boolean | null;
	isClean: boolean | null;
	dirtyFileCount: number;
	dirtyFiles: Array<{ status: string; path: string }>;
	dirtyFilesTruncated: boolean;
	remotes: Array<{ name: string; url: string }>;
	remotesTruncated: boolean;
}

interface PrWorkflowStatusGateSummary {
	active: boolean;
	reason?: 'no-session-context' | 'no-active-gate';
	mode?: PrWorkflowGateState['mode'];
	prHeadBound?: boolean;
	prHeadSha?: string | null;
	prFeedbackTargetUrl?: string | null;
	prReviewBaseRef?: string | null;
	prReviewBaseSha?: string | null;
	prReviewDepthTier?: PrWorkflowGateState['prReviewDepthTier'] | null;
	baseDispatchBatches?: number;
	validationBatches?: number;
	feedbackVerificationBatches?: number;
	checkoutReceiptFiles?: number | null;
	activatedAt?: string;
	updatedAt?: string;
	revision?: number;
	/**
	 * Issue #2242 R4 (W-5): the durable bytes failed schema validation and this
	 * summary is a best-effort salvage. Present only when it is true, so an
	 * ordinary healthy gate response is byte-identical to before.
	 */
	stateSalvaged?: boolean;
	stateSalvageDisclosure?: string;
	/**
	 * Issue #2242 R3 (W-2): entries appended to the PR_FEEDBACK inventory after
	 * its first declaration. Present only when at least one amendment exists.
	 */
	inventoryAmendments?: PrFeedbackInventoryAmendmentRecord[];
}

interface PrWorkflowStatusResult {
	success: true;
	sessionID: string | null;
	git: PrWorkflowStatusGitState;
	checkout: PrWorkflowGitState;
	gate: PrWorkflowStatusGateSummary;
	nextStep: string;
}

/**
 * Lightweight neutralizer for short, author-influenced Git strings (branch
 * names, remote URLs, changed paths). A PR branch/remote is attacker-controlled
 * text; this strips control characters and the markdown/HTML metacharacters that
 * could break a downstream renderer, then bounds the length. It deliberately
 * does NOT use the heavyweight `neutralizeUntrustedMarkdown` fenced wrapper,
 * which is for large prose blobs, not single structured fields.
 */
function boundUntrusted(value: string, maxLen: number): string {
	const cleaned = value
		.replace(/[\p{Cc}]/gu, ' ')
		.replace(/[`<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/**
 * Bounded, killable, non-interactive Git read (AGENTS.md invariant 3). Array
 * form, explicit cwd, ignored stdin, capped stdout, timeout, best-effort kill in
 * finally. Never runs a PR-controlled script — only fixed read verbs are passed.
 */
async function runGitCapture(
	directory: string,
	args: string[],
): Promise<string | null> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
		timeout: GIT_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
		]);
		if (exitCode !== 0) return null;
		return truncateToByteBudget(stdout, GIT_MAX_STDOUT_BYTES);
	} catch {
		return null;
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort; Git may already have exited.
		}
	}
}

async function resolveBranch(
	directory: string,
): Promise<{ branch: string | null; detached: boolean | null }> {
	const raw = await _internals.runGitCapture(directory, [
		'rev-parse',
		'--abbrev-ref',
		'HEAD',
	]);
	// `runGitCapture` collapses every failure class (non-zero exit, spawn
	// error, timeout) into `null` alike. Reporting `detached: false` here
	// would assert a verified non-detached branch when the truth is "git
	// failed and we never found out" — report the unknown state instead of
	// guessing at it.
	if (raw === null) return { branch: null, detached: null };
	const value = raw.trim();
	// `--abbrev-ref HEAD` prints the literal "HEAD" for a detached checkout.
	// That is the PR_REVIEW steady state and a valid pre-bind PR_FEEDBACK intake
	// state; the feedback controller attaches the unique exact tracking ref.
	if (!value || value === 'HEAD') return { branch: null, detached: true };
	return { branch: boundUntrusted(value, MAX_FIELD_LEN), detached: false };
}

function parseDirtyFiles(porcelain: string | null): {
	dirtyFiles: Array<{ status: string; path: string }>;
	dirtyFileCount: number;
	dirtyFilesTruncated: boolean;
} {
	if (!porcelain) {
		return { dirtyFiles: [], dirtyFileCount: 0, dirtyFilesTruncated: false };
	}
	const lines = porcelain.split('\n').filter((line) => line.length >= 4);
	const dirtyFiles: Array<{ status: string; path: string }> = [];
	for (const line of lines) {
		if (dirtyFiles.length >= MAX_DIRTY_FILES) break;
		const status = line.slice(0, 2).trim() || '??';
		const rawPath = line.slice(3);
		dirtyFiles.push({
			status: boundUntrusted(status, 4),
			path: boundUntrusted(rawPath, MAX_FIELD_LEN),
		});
	}
	return {
		dirtyFiles,
		dirtyFileCount: lines.length,
		dirtyFilesTruncated: lines.length > dirtyFiles.length,
	};
}

function parseRemotes(remoteOutput: string | null): {
	remotes: Array<{ name: string; url: string }>;
	remotesTruncated: boolean;
} {
	if (!remoteOutput) return { remotes: [], remotesTruncated: false };
	const byName = new Map<string, string>();
	for (const line of remoteOutput.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// `git remote -v` rows are "<name>\t<url> (fetch|push)"; keep the first
		// URL seen per remote so fetch/push duplicates collapse to one entry.
		const [name, rest] = trimmed.split(/\s+/, 2);
		if (!name || !rest || byName.has(name)) continue;
		const url = rest.replace(/\s+\((?:fetch|push)\)\s*$/i, '');
		byName.set(
			boundUntrusted(name, 64),
			boundUntrusted(url, MAX_REMOTE_URL_LEN),
		);
	}
	const entries = [...byName.entries()];
	const remotes = entries
		.slice(0, MAX_REMOTES)
		.map(([name, url]) => ({ name, url }));
	return { remotes, remotesTruncated: entries.length > remotes.length };
}

/**
 * Best-effort count of durable checkout-preservation receipts for THIS session
 * only. Reads the session-scoped receipt directory under `.swarm`; never
 * enumerates other sessions. ENOENT (no preparations yet) is 0; any other read
 * failure is reported as null rather than throwing an observe-only tool.
 */
async function countCheckoutReceiptFiles(
	directory: string,
	sessionID: string,
): Promise<number | null> {
	try {
		const receiptDirectory = validateSwarmPath(
			directory,
			path.join(RECEIPT_DIR, prWorkflowSessionFileStem(sessionID)),
		);
		const entries = await fsp.readdir(receiptDirectory, {
			withFileTypes: true,
		});
		return entries.filter(
			(entry) => entry.isFile() && /^[0-9a-f]{40,64}\.json$/i.test(entry.name),
		).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		return null;
	}
}

function describeNextStep(
	gate: PrWorkflowStatusGateSummary,
	git: PrWorkflowStatusGitState,
	checkout: PrWorkflowGitState,
): string {
	if (
		checkout.kind === 'recovery-required' ||
		checkout.kind === 'indeterminate'
	) {
		return `Manual Git recovery required. code=${checkout.code} retryable=false required_action=${checkout.requiredAction}`;
	}
	if (!gate.active) {
		return 'No active PR workflow gate for this session. Activate with `/swarm pr-review <pr-ref>` or `/swarm pr-feedback <pr-ref>` before PR-workflow tool calls are admitted.';
	}
	if (!gate.prHeadBound) {
		return gate.mode === 'PR_FEEDBACK'
			? 'PR_FEEDBACK gate active; PR head not yet bound. If the working tree is dirty, preserve it with prepare_pr_workflow_checkout (omit paths to include tracked and untracked changes). Prefer the intended exact tracking checkout, then bind; if this workflow inherited an already-detached exact intake head, bind it directly and the controller will attach the unique exact local/remote tracking ref. Ambiguity or an existing mismatched upstream fails closed.'
			: 'PR_REVIEW gate active; PR head not yet bound. If the working tree is dirty, preserve it with prepare_pr_workflow_checkout (omit paths to include tracked and untracked changes), then bind the exact detached PR head.';
	}
	if (git.isClean === false) {
		return `${gate.mode} gate active and head bound, but the working tree is dirty. Read-only observation only; the gate keeps writes and non-tracking fetches fail-closed.`;
	}
	if (git.isClean === null) {
		return `${gate.mode} gate active and head bound, but this session could not determine whether the working tree is clean (git status failed). Treat the tree state as unknown and verify manually before assuming it is clean; read-only observation only.`;
	}
	return `${gate.mode} gate active and head bound. Continue read-only review using the admitted observe/validate tools (diff, gh_evidence, repo_map, lint check, etc.).`;
}

function summarizeGate(
	state: PrWorkflowGateState | null,
	receiptFiles: number | null,
	salvage?: { salvaged: boolean; disclosure?: string },
): PrWorkflowStatusGateSummary {
	if (!state) {
		return { active: false, reason: 'no-active-gate' };
	}
	return {
		active: true,
		...(salvage?.salvaged
			? {
					stateSalvaged: true,
					stateSalvageDisclosure: salvage.disclosure,
				}
			: {}),
		mode: state.mode,
		prHeadBound: Boolean(state.prHeadSha),
		prHeadSha: state.prHeadSha ?? null,
		prFeedbackTargetUrl: state.prFeedbackTargetUrl
			? boundUntrusted(state.prFeedbackTargetUrl, MAX_FIELD_LEN)
			: null,
		prReviewBaseRef: state.prReviewBaseRef
			? boundUntrusted(state.prReviewBaseRef, MAX_FIELD_LEN)
			: null,
		prReviewBaseSha: state.prReviewBaseSha ?? null,
		prReviewDepthTier: state.prReviewDepthTier ?? null,
		baseDispatchBatches: state.prReviewBaseDispatches?.length ?? 0,
		validationBatches: state.prReviewValidationBatches?.length ?? 0,
		feedbackVerificationBatches: state.prFeedbackVerifications?.length ?? 0,
		...(state.prFeedbackInventoryAmendments?.length
			? { inventoryAmendments: state.prFeedbackInventoryAmendments }
			: {}),
		checkoutReceiptFiles: receiptFiles,
		activatedAt: state.activatedAt,
		updatedAt: state.updatedAt,
		revision: state.revision,
	};
}

async function executePrWorkflowStatus(
	directory: string,
	rawSessionID: string | undefined,
): Promise<string> {
	const sessionID = rawSessionID?.trim() ? rawSessionID.trim() : null;

	const [head, isClean, branchInfo, porcelain, remoteOutput, liveCheckout] =
		await Promise.all([
			_internals.resolveCurrentGitHeadAsync(directory),
			_internals.resolveIsWorkingTreeCleanAsync(directory),
			resolveBranch(directory),
			_internals.runGitCapture(directory, [
				'status',
				'--porcelain=v1',
				'--untracked-files=all',
			]),
			_internals.runGitCapture(directory, ['remote', '-v']),
			_internals.classifyGitState(directory),
		]);

	const dirty = parseDirtyFiles(porcelain);
	const { remotes, remotesTruncated } = parseRemotes(remoteOutput);
	const git: PrWorkflowStatusGitState = {
		head,
		branch: branchInfo.branch,
		detached: branchInfo.detached,
		isClean,
		dirtyFileCount: dirty.dirtyFileCount,
		dirtyFiles: dirty.dirtyFiles,
		dirtyFilesTruncated: dirty.dirtyFilesTruncated,
		remotes,
		remotesTruncated,
	};

	// Session-pinned gate read ONLY. The gate is resolved from the caller's own
	// sessionID; we never enumerate .swarm/pr-workflow-gates/* to "find the
	// active gate", which would leak a sibling session's state.
	let gate: PrWorkflowStatusGateSummary;
	let activeState: PrWorkflowGateState | null = null;
	if (!sessionID) {
		gate = { active: false, reason: 'no-session-context' };
	} else {
		// Issue #2242 R4 (W-5): observation must survive gate-state corruption —
		// a schema-invalid state previously made this read-only tool throw, so an
		// operator could not even SEE the state they were stuck on. Unparseable
		// bytes still fail. This tool and abort_pr_workflow are the only two
		// callers of the recovery reader.
		const recovery = await _internals.readPrWorkflowGateStateForRecovery(
			directory,
			sessionID,
		);
		activeState = recovery?.state ?? null;
		const receiptFiles = activeState
			? await countCheckoutReceiptFiles(directory, sessionID)
			: null;
		gate = summarizeGate(
			activeState,
			receiptFiles,
			recovery
				? { salvaged: recovery.salvaged, disclosure: recovery.disclosure }
				: undefined,
		);
	}
	const recovery = activeState?.checkoutRecovery;
	const checkout: PrWorkflowGitState = recovery
		? {
				kind:
					recovery.code === 'GIT_STATE_INDETERMINATE'
						? 'indeterminate'
						: 'recovery-required',
				code: recovery.code,
				retryable: false,
				requiredAction: recovery.requiredAction,
				evidence: recovery.evidence,
			}
		: liveCheckout;

	const result: PrWorkflowStatusResult = {
		success: true,
		sessionID,
		git,
		checkout,
		gate,
		nextStep: describeNextStep(gate, git, checkout),
	};
	return JSON.stringify(result, null, 2);
}

export const pr_workflow_status: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Read-only architect observation of local git state (HEAD, branch, clean/dirty with a bounded changed-file list, remotes) plus a session-pinned PR workflow gate summary (mode, bound PR head, base ref/sha, depth tier, dispatch/validation batch counts). Use to observe state under the fail-closed PR_REVIEW/PR_FEEDBACK gate. Never executes PR-controlled scripts and never reads another session gate.',
		args: {},
		execute: async (_args: unknown, directory: string, ctx?: ToolContext) =>
			executePrWorkflowStatus(directory, ctx?.sessionID),
	});

/** Test seam mirroring gh-evidence's `_internals` (issue #507 DI convention). */
export const _internals: {
	readPrWorkflowGateStateForRecovery: typeof readPrWorkflowGateStateForRecovery;
	resolveCurrentGitHeadAsync: typeof resolveCurrentGitHeadAsync;
	resolveIsWorkingTreeCleanAsync: typeof resolveIsWorkingTreeCleanAsync;
	runGitCapture: typeof runGitCapture;
	classifyGitState: typeof classifyPrWorkflowGitState;
	truncateToByteBudget: typeof truncateToByteBudget;
} = {
	readPrWorkflowGateStateForRecovery,
	resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeCleanAsync,
	runGitCapture,
	classifyGitState: classifyPrWorkflowGitState,
	truncateToByteBudget,
};
