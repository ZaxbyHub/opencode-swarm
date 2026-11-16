import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	findByBatchIdDetailed,
	readDelegationsDetailed,
	recordedPrReviewResultReceipt,
} from '../background/pending-delegations';
import type { PrReviewResultReceipt } from '../background/pr-review-contract';
import {
	resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeCleanAsync,
} from '../background/workspace-snapshot';
import {
	classifyPrWorkflowGitState,
	type PrWorkflowGitState,
} from '../git/pr-workflow-state';
import { isPrWorkflowAutoWakeSuppressed } from '../hooks/pr-workflow-auto-wake';
import {
	derivePrReviewCandidateInventoryForStatus,
	describePrWorkflowPublicationSection,
	type PrFeedbackInventoryAmendmentRecord,
	type PrWorkflowGateRecoveryRead,
	type PrWorkflowGateState,
	prReviewPhaseWindowForStatus,
	prWorkflowSessionFileStem,
	readPrWorkflowGateStateForRecovery,
} from '../hooks/pr-workflow-gate';
import { resolvePrWorkflowControllerSession } from '../hooks/pr-workflow-session-resolver';
import { validateSwarmPath } from '../hooks/utils';
import { deriveVerdictAttemptCounts } from '../pr-review/verdict-settlement.js';
import { bunSpawn } from '../utils/bun-compat';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';
import { createSwarmTool } from './create-tool';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_STDOUT_BYTES = 512 * 1024;
const MAX_DIRTY_FILES = 50;
const MAX_REMOTES = 20;
const MAX_REMOTE_URL_LEN = 200;
const MAX_FIELD_LEN = 240;
const MAX_RECOVERY_REASON_CODE_LEN = 120;
/**
 * Read-side bounds for the PR_REVIEW status projection (issue #3095). The
 * write-time caps (MAX_WORKFLOW_BATCHES = 128 lanes per batch array) bound
 * STATE, not OUTPUT — the projection truncates instead of unrolling so status
 * stays bounded on large runs.
 */
const PR_REVIEW_STATUS_LANE_ROWS_CAP = 30;
const PR_REVIEW_STATUS_INVENTORY_CAP = 40;
const PR_REVIEW_STATUS_FINDING_LINE_MAX = 240;
/** Per-lane finding-summary rows (issue #3095 AC2; #3188 parity cap of 5). */
const PR_REVIEW_STATUS_FINDINGS_PER_LANE = 5;
/** Bounds for structured finding-summary fields (id/severity/title). */
const PR_REVIEW_STATUS_FINDING_ID_MAX = 128;
const PR_REVIEW_STATUS_FINDING_SEVERITY_MAX = 32;
/**
 * F-04 degraded-source reason, used verbatim for the boundaries/laneCoverage
 * sources and the inventory arm when the recovery reader salvaged the gate
 * state and dropped every `prReview*` field.
 */
const SALVAGED_PROJECTION_REASON =
	'gate state was salvaged after schema validation failed; PR-review projection fields were dropped and their absence proves nothing';
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
	reason?:
		| 'no-session-context'
		| 'no-active-gate'
		| 'delegation-chain-uncertain';
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
	/**
	 * Issue #3095: bounded read-only PR_REVIEW projection (boundary settlement,
	 * per-lane coverage, derived candidate inventory). The key is present ONLY
	 * when the gate is active AND the mode is PR_REVIEW — never null, simply
	 * absent for PR_FEEDBACK and inactive gates so no PR_REVIEW content leaks
	 * into another mode's payload.
	 */
	prReviewProjection?: PrReviewStatusProjection;
}

/** Fixed boundary order for {@link PrReviewStatusProjection.boundaries}. */
const PR_REVIEW_BOUNDARY_ORDER = [
	'post_explorer',
	'post_reviewer',
	'post_critic',
] as const;

/**
 * settlementDigest mapping: the persisted per-phase verdict-settlement receipt
 * digest exists only for the reviewer and critic phases
 * (`PrReviewVerdictSettlementPhase`), so post_explorer maps to none.
 */
const PR_REVIEW_BOUNDARY_SETTLEMENT_PHASE: Partial<
	Record<(typeof PR_REVIEW_BOUNDARY_ORDER)[number], 'reviewer' | 'critic'>
> = {
	post_reviewer: 'reviewer',
	post_critic: 'critic',
};

/** One per-boundary settlement row (issue #3095 AC1). */
interface PrReviewStatusBoundaryRow {
	phase: (typeof PR_REVIEW_BOUNDARY_ORDER)[number];
	status: 'settled' | 'pending';
	runId: string | null;
	findingsPath: string | null;
	settlementDigest: string | null;
}

/** One bounded finding-summary entry on a lane row (issue #3095 AC2). */
interface PrReviewStatusFindingSummary {
	id: string;
	severity: string;
	title: string;
}

/** One per-lane coverage row (issue #3095 AC2). */
interface PrReviewStatusLaneRow {
	laneId: string;
	workflowLane: string;
	batchId: string;
	accepted: number;
	rejected: number;
	latestFinding: string;
	/** Bounded finding summaries (first 5 of the receipt envelope, in envelope order). */
	findings: PrReviewStatusFindingSummary[];
	/** True when the receipt carried more findings than the cap above. */
	findingsTruncated: boolean;
}

/**
 * The bounded derived-inventory projection (issue #3095 AC3). The
 * `unavailable` arm carries a bounded, sanitized reason — the derivation
 * degraded, it did not run and find nothing.
 */
type PrReviewStatusInventory =
	| {
			state: 'available';
			/** Sanitized DISPLAY copies of the first `cap` derived ids. */
			ids: string[];
			truncated: boolean;
			total: number;
			cap: number;
	  }
	| { state: 'unavailable'; reason: string };

/**
 * Typed read-health disclosure for a projection section (issue #3095, F-04):
 * an `unavailable` source must be visible as unavailable, never as a
 * healthy-but-empty section.
 */
type PrReviewStatusSourceHealth =
	| { state: 'ok' }
	| { state: 'unavailable'; reason: string };

/**
 * The whole PR_REVIEW projection. `inventory`'s `unavailable` arm means the
 * derivation could not run (unbound head, unreadable revision digest) —
 * degraded, never fabricated.
 */
interface PrReviewStatusProjection {
	boundaries: PrReviewStatusBoundaryRow[];
	/**
	 * Honest labelling of the checkpoint reference every boundary row carries:
	 * the gate persists NO per-boundary checkpoint — `prReviewArtifactBoundaries`
	 * is a flat enum array and `prReviewArtifactRunId`/`prReviewFindingsPath`
	 * are shared, last-write-wins fields — so a consumer must not read the
	 * per-row reference as per-boundary evidence (issue #3095 AC1; ported from
	 * the #3188 projection).
	 */
	checkpointScope: 'shared-last-write-wins';
	laneCoverage: PrReviewStatusLaneRow[];
	laneCoverageTruncated: boolean;
	/**
	 * Receipt-evidence admission disclosure (issue #3095, F-07). This
	 * observation surface admits receipts on (batch, lane, mode, dual-head)
	 * identity ONLY; the gate's enforcement admission additionally applies
	 * artifact-integrity checks (revision digest, source, digest, chars), the
	 * credited-lanes filter, and supersession. The value is
	 * `'lane-record-only'` today — the field exists so the weaker admission is
	 * visible rather than implied, and so a future gate-parity implementation
	 * can flip it without a shape change.
	 */
	laneCoverageAdmission: 'gate-parity' | 'lane-record-only';
	/**
	 * Per-item verdict attempt accounting (issue #3311 AC24), one row per item
	 * declared by the reviewer OR critic phase window: distinct window batches
	 * whose lanes declare the item, the required total (1 + retry budget), and
	 * the remaining budget. Rows are phase-labeled because the same item id can
	 * carry different counts in the two phases. Same derivation as the N-of-M
	 * BLOCKED text.
	 */
	verdictAttempts: Array<{
		itemId: string;
		attemptsUsed: number;
		attemptsRequired: number;
		remaining: number;
		phase: 'reviewer' | 'critic';
	}>;
	inventory: PrReviewStatusInventory;
	/**
	 * Per-section read health (issue #3095, F-04). `boundaries` and
	 * `laneCoverage` degrade to `unavailable` when the recovery reader
	 * salvaged the gate state and dropped every `prReview*` field — the rows
	 * are still emitted (shape stability), but no consumer may read them as
	 * authoritative coverage.
	 */
	sources: {
		boundaries: PrReviewStatusSourceHealth;
		laneCoverage: PrReviewStatusSourceHealth;
	};
}

interface PrWorkflowStatusResult {
	success: true;
	sessionID: string | null;
	git: PrWorkflowStatusGitState;
	checkout: PrWorkflowGitState;
	gate: PrWorkflowStatusGateSummary;
	/**
	 * Issue #2108: publication-generation summary (generation, state, target,
	 * attempts, invalidation reason, recovery instructions) — the operator
	 * surface for inspecting the armed/invalidated publication window without
	 * editing state files. Null when the workflow has no publication state.
	 */
	publication: string | null;
	nextStep: string;
	/**
	 * Issue #2511 (workstream D, AC6): bounded operator recovery section —
	 * delegation-store read health, controller identity, durable gate
	 * progress, auto-wake suspension, and action-circuit observability.
	 * Additive optional field; every pre-existing field (including the
	 * top-level nextStep) is unchanged.
	 */
	recovery?: PrWorkflowStatusRecoverySection;
}

/** Bounded delegation-store read outcome for the recovery section (issue #2511). */
interface PrWorkflowStatusRecoveryDelegationRead {
	state: 'ok' | 'uncertain';
	/** Bounded stable reason string; present only when state is 'uncertain'. */
	reasonCode?: string;
}

/** Bounded action-circuit observation for the recovery section (issue #2511). */
interface PrWorkflowStatusRecoveryActionCircuits {
	state: 'none-observed' | 'blocking' | 'unavailable';
	count?: number;
}

/**
 * Issue #2511 (workstream D, AC6): bounded operator recovery section. Every
 * value is either observed or typed-unavailable — nothing is invented. The
 * delegation-store read is advisory (`readDelegationsDetailed` retries once
 * internally on an uncertain first attempt, which is the accepted budget);
 * action circuits are keyed by the exact session + invocation + semantic
 * action digest, and a tool execution carries no live invocationID, so that
 * field is 'unavailable' rather than a guessed count.
 */
interface PrWorkflowStatusRecoverySection {
	/** From the shared resolver outcome; null when the chain is uncertain. */
	controllerSessionID: string | null;
	delegationRead: PrWorkflowStatusRecoveryDelegationRead;
	/** Durable gate revision + updatedAt from the bound gate state; null when no gate. */
	lastProgress: { revision: number; updatedAt: string } | null;
	wakeSuspension: { suspended: boolean };
	actionCircuits: PrWorkflowStatusRecoveryActionCircuits;
	/** Short executable recovery guidance; the top-level nextStep is unchanged. */
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
	// Resolution failure (every candidate rejected) maps onto this function's
	// existing "any failure -> null" contract, same as a spawn failure would —
	// no new throw introduced at this call site.
	let gitExecutable: string;
	try {
		gitExecutable = await resolveGitExecutableAsync();
	} catch {
		return null;
	}
	const proc = bunSpawn([gitExecutable, ...args], {
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

/**
 * Advisory delegation-store read for the recovery section (issue #2511,
 * workstream D). `ok` covers both a loaded and a healthy-empty store; an
 * explicitly uncertain read stays typed 'uncertain' with a bounded reason
 * code — absence is never read as fact here.
 */
function describeDelegationRead(
	directory: string,
): PrWorkflowStatusRecoveryDelegationRead {
	try {
		const outcome = _internals.readDelegationsDetailed(directory);
		if (outcome.status === 'ok') return { state: 'ok' };
		return {
			state: 'uncertain',
			reasonCode: boundUntrusted(outcome.reason, MAX_RECOVERY_REASON_CODE_LEN),
		};
	} catch {
		// The reader is documented never to throw; if it ever does, the store
		// state is genuinely unknown — report typed uncertainty, never 'ok'.
		return { state: 'uncertain', reasonCode: 'reader-threw' };
	}
}

/** Short executable recovery guidance for the recovery section (issue #2511). */
function describeRecoveryNextStep(
	delegationReadState: PrWorkflowStatusRecoveryDelegationRead['state'],
): string {
	if (delegationReadState === 'uncertain') {
		return 'Delegation store read is uncertain: repair the store, then re-run pr_workflow_status; if abandoning the workflow, abort via abort_pr_workflow.';
	}
	return 'Re-run pr_workflow_status after any store repair; if abandoning the workflow, abort via abort_pr_workflow.';
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
		if (gate.reason === 'delegation-chain-uncertain') {
			return 'PR workflow gate ownership could not be resolved from this session delegation chain (cycle, depth limit, or missing ancestor). Treat the workflow state as unknown and use read-only recovery inspection; do not perform PR-workflow writes.';
		}
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

/**
 * Bound a one-line finding summary for display: strip control characters and
 * the markdown/HTML metacharacters (same character classes as
 * {@link boundUntrusted} — receipt fields are lane-agent-authored text and a
 * schema cap bounds length, not content), collapse whitespace, then cap to
 * the char limit without splitting a surrogate pair (code-point-aware, unlike
 * a bare `slice`).
 */
function boundFindingLine(line: string): string {
	const cleaned = line
		.replace(/[\p{Cc}]/gu, ' ')
		.replace(/[`<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const chars = Array.from(cleaned);
	if (chars.length <= PR_REVIEW_STATUS_FINDING_LINE_MAX) return cleaned;
	return `${chars.slice(0, PR_REVIEW_STATUS_FINDING_LINE_MAX - 1).join('')}…`;
}

/**
 * Issue #3095: build the bounded, read-only PR_REVIEW projection over the
 * state this tool already resolved. Everything here is derived at READ time
 * from persisted gate state and retained receipt envelopes — nothing is
 * duplicated to disk (AC4).
 *
 * COST DISCLOSURE (this projection is not spawn-free): the AC3 inventory
 * read runs the gate's revision-digest computation (three bounded git
 * processes plus changed-file hashing) on every bound PR_REVIEW call, and
 * the AC2 receipt lookup performs one delegation-store read per DISTINCT
 * emitted batch on top of the recovery section's own read. On a degraded
 * store each of those reads retries once (25 ms) and appends to the durable
 * delegation-health ledger — a read can observably write. The healthy-path
 * no-write pin lives in the lane-coverage suite.
 *
 * `projectionDropped` marks a recovery read that salvaged the gate state and
 * dropped every `prReview*` field: the boundary/lane sections still project
 * their (degenerate) shape but their sources are marked `unavailable` —
 * healthy-but-empty would be a fabrication (F-04).
 */
async function buildPrReviewProjection(
	directory: string,
	state: PrWorkflowGateState,
	projectionDropped: boolean,
): Promise<PrReviewStatusProjection> {
	// AC1 — per-boundary settlement phase with the persisted checkpoint
	// reference. Boundary settlement lives as the boundary-name set plus the
	// shared run-level artifact reference; the digest anchor exists only for
	// the reviewer/critic verdict-settlement phases and is surfaced only on
	// SETTLED rows (a pending boundary never cites a digest even when the
	// state already carries one).
	const settledPhases = new Set(state.prReviewArtifactBoundaries ?? []);
	const runId = state.prReviewArtifactRunId ?? null;
	const findingsPath = state.prReviewFindingsPath ?? null;
	const digests = state.prReviewVerdictSettlementDigests ?? {};
	const boundaries: PrReviewStatusBoundaryRow[] = PR_REVIEW_BOUNDARY_ORDER.map(
		(phase) => {
			const settlementPhase = PR_REVIEW_BOUNDARY_SETTLEMENT_PHASE[phase];
			const settled = settledPhases.has(phase);
			return {
				phase,
				status: settled ? ('settled' as const) : ('pending' as const),
				runId,
				findingsPath,
				settlementDigest:
					settled && settlementPhase
						? (digests[settlementPhase] ?? null)
						: null,
			};
		},
	);

	// AC2 — one row per lane declared by the base dispatches, in declaration
	// order, capped so a 128-batch state cannot unroll into the output.
	const declaredLanes: Array<{
		laneId: string;
		workflowLane: string;
		batchId: string;
	}> = [];
	for (const batch of state.prReviewBaseDispatches ?? []) {
		for (const lane of batch.lanes ?? []) {
			declaredLanes.push({
				laneId: lane.laneId,
				workflowLane: lane.workflowLane,
				batchId: batch.batchId,
			});
		}
	}
	const laneCoverageTruncated =
		declaredLanes.length > PR_REVIEW_STATUS_LANE_ROWS_CAP;
	const emittedLanes = declaredLanes.slice(0, PR_REVIEW_STATUS_LANE_ROWS_CAP);

	const rejectionCounts = new Map<string, number>();
	for (const entry of state.prReviewSubmitRejections ?? []) {
		if (!entry.laneId) continue;
		rejectionCounts.set(
			entry.laneId,
			(rejectionCounts.get(entry.laneId) ?? 0) + 1,
		);
	}

	// Receipt lookup, one store read per emitted batch (gate-owner session —
	// never the raw caller). The store's epistemic contract
	// (findByBatchIdDetailed's docstring) forbids treating an unreadable store
	// as an empty batch, mirroring the derivation's own "UNKNOWN, not absent"
	// stance: an uncertain read — or an unexpected throw, guarded with the same
	// defensiveness as describeDelegationRead — marks that batch's rows
	// 'receipt-uncertain' instead of claiming 'no-receipt'.
	const receiptsByLane = new Map<string, PrReviewResultReceipt>();
	const uncertainBatches = new Set<string>();
	const headSha = state.prHeadSha;
	for (const batchId of new Set(emittedLanes.map((lane) => lane.batchId))) {
		try {
			const outcome = _internals.findByBatchIdDetailed(directory, batchId, {
				parentSessionId: state.sessionID,
			});
			if (outcome.status === 'uncertain') {
				uncertainBatches.add(batchId);
				continue;
			}
			for (const record of outcome.value) {
				if (record.laneId == null || record.mode !== 'swarm-pr-review:base') {
					continue;
				}
				// Dual-head identity, mirroring the derivation's canonical filter:
				// the record's workspace must be bound to this gate's PR head on
				// BOTH prHeadSha and gitHead before its receipt speaks for a lane.
				if (
					record.workspace?.prHeadSha !== headSha ||
					record.workspace?.gitHead !== headSha
				) {
					continue;
				}
				const receipt = recordedPrReviewResultReceipt(record);
				if (!receipt) continue;
				const key = `${batchId}\0${record.laneId}`;
				// First receipt-bearing match in store order wins. Publication
				// enforces one receipt per (parent, child, batch, lane), so two
				// records can still match one (batch, lane) only across different
				// children (e.g. a retry); stable store iteration order makes the
				// pick deterministic either way.
				if (!receiptsByLane.has(key)) receiptsByLane.set(key, receipt);
			}
		} catch {
			uncertainBatches.add(batchId);
		}
	}

	const laneCoverage: PrReviewStatusLaneRow[] = emittedLanes.map((lane) => {
		const uncertain = uncertainBatches.has(lane.batchId);
		const receipt = uncertain
			? undefined
			: receiptsByLane.get(`${lane.batchId}\0${lane.laneId}`);
		const findings = receipt?.envelope.findings ?? [];
		const lastFinding = findings[findings.length - 1];
		const latestFinding = uncertain
			? 'receipt-uncertain'
			: receipt
				? lastFinding
					? boundFindingLine(
							`${lastFinding.severity} ${lastFinding.id}: ${lastFinding.title}`,
						)
					: receipt.envelope.outcome === 'CLEAN'
						? 'clean'
						: 'incomplete'
				: 'no-receipt';
		// Bounded finding summaries (ported from the #3188 projection): the
		// first PR_REVIEW_STATUS_FINDINGS_PER_LANE findings in envelope order,
		// each field sanitized as a display copy — the identity keys on the row
		// (laneId/batchId) stay raw so consumers can join against gate state.
		// An uncertain batch has no admitted receipt, hence no findings.
		const findingsTruncated =
			findings.length > PR_REVIEW_STATUS_FINDINGS_PER_LANE;
		const findingSummaries: PrReviewStatusFindingSummary[] = findings
			.slice(0, PR_REVIEW_STATUS_FINDINGS_PER_LANE)
			.map((finding) => ({
				id: boundUntrusted(finding.id, PR_REVIEW_STATUS_FINDING_ID_MAX),
				severity: boundUntrusted(
					finding.severity,
					PR_REVIEW_STATUS_FINDING_SEVERITY_MAX,
				),
				title: boundUntrusted(finding.title, PR_REVIEW_STATUS_FINDING_LINE_MAX),
			}));
		return {
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			batchId: lane.batchId,
			accepted: findings.length,
			rejected: rejectionCounts.get(lane.laneId) ?? 0,
			latestFinding,
			findings: findingSummaries,
			findingsTruncated,
		};
	});

	// AC3 — the derived candidate inventory, reused (not reimplemented) from
	// the gate and bounded here. The `unavailable` arm carries the gate's
	// bounded, sanitized reason: degraded, never fabricated. A salvage-dropped
	// state skips the derivation entirely — running it over a state whose
	// discovery sources were dropped would fabricate the CLEAN-REVIEW sentinel
	// (absence claimed from dropped evidence, the inventory flavor of F-04).
	const inventory: PrReviewStatusInventory = projectionDropped
		? {
				state: 'unavailable',
				reason: SALVAGED_PROJECTION_REASON,
			}
		: await (async (): Promise<PrReviewStatusInventory> => {
				const derived = await derivePrReviewCandidateInventoryForStatus(
					directory,
					state,
				);
				if (derived.state === 'unavailable') {
					return {
						state: 'unavailable',
						reason: boundUntrusted(
							derived.reason,
							PR_REVIEW_STATUS_FINDING_LINE_MAX,
						),
					};
				}
				return {
					state: 'available',
					// Sanitized DISPLAY copies: the derivation validates row shape
					// but not id content, so a lane-authored candidate id can carry
					// markdown/HTML metacharacters or run to thousands of chars.
					// `total` counts the unsanitized derivation so truncation
					// arithmetic stays honest.
					ids: derived.inventory
						.slice(0, PR_REVIEW_STATUS_INVENTORY_CAP)
						.map((id) => boundUntrusted(id, PR_REVIEW_STATUS_FINDING_ID_MAX)),
					truncated: derived.inventory.length > PR_REVIEW_STATUS_INVENTORY_CAP,
					total: derived.inventory.length,
					cap: PR_REVIEW_STATUS_INVENTORY_CAP,
				};
			})();

	// F-04: a salvaged read that dropped every prReview* field cannot vouch
	// for absence — mark the derived sections unavailable with a bounded
	// reason instead of projecting healthy-but-empty.
	const salvagedSource = (): PrReviewStatusSourceHealth =>
		projectionDropped
			? { state: 'unavailable', reason: SALVAGED_PROJECTION_REASON }
			: { state: 'ok' };

	// Issue #3311 (AC24): per-item verdict attempt accounting over the SAME
	// phase windows the N-of-M admission reads (single derivation — the window
	// wrapper is exported by the gate so this projection can never hand-roll a
	// drifting filter). The BLOCKED text fires per phase (reviewer AND critic),
	// so rows are derived over BOTH windows and each row carries its phase: an
	// item id can be declared in both phases with different counts, and the
	// consumer must be able to match the row to the phase of the message it is
	// reading. Reviewer rows come first (the common blocked phase).
	const verdictPhases = ['reviewer', 'critic'] as const;
	const verdictAttempts = verdictPhases.flatMap((phase) =>
		deriveVerdictAttemptCounts({
			window: prReviewPhaseWindowForStatus(state, phase),
			unclaimed: [
				...new Set(
					prReviewPhaseWindowForStatus(state, phase).flatMap((batch) =>
						batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []),
					),
				),
			],
		}).map((row) => ({ ...row, phase })),
	);

	return {
		boundaries,
		checkpointScope: 'shared-last-write-wins',
		laneCoverage,
		laneCoverageTruncated,
		laneCoverageAdmission: 'lane-record-only',
		inventory,
		verdictAttempts,
		sources: {
			boundaries: salvagedSource(),
			laneCoverage: salvagedSource(),
		},
	};
}

/**
 * Resolve a lane's own session to the nearest ancestor with a durable gate.
 * This follows only the authenticated caller's delegation chain; it never
 * enumerates sibling gate files. The index hook performs the same resolution
 * before enforcement, so the observer must report the gate it is actually
 * operating under as well.
 *
 * Issue #2511 (workstream D): the bounded walk itself now routes through the
 * shared enforcement resolver machinery
 * (`resolvePrWorkflowControllerSession` in pr-workflow-session-resolver.ts),
 * so status and enforcement resolve session identity the same way, under the
 * same 16-hop depth cap (the resolver's MAX_PARENT_DEPTH). Only the outcome
 * MAPPING is status-specific — the shared walk reports typed uncertainty for
 * a missing/cyclic/depth-exhausted chain, which this tool renders as
 * `sessionID: null` (reason 'delegation-chain-uncertain'), while enforcement
 * falls back to its own original-session semantics.
 */
async function resolveWorkflowGate(
	directory: string,
	sessionID: string,
): Promise<{
	sessionID: string | null;
	recovery: PrWorkflowGateRecoveryRead | null;
}> {
	const outcome = await _internals.resolvePrWorkflowControllerSession({
		directory,
		sessionID,
		readGate: (candidate) =>
			_internals.readPrWorkflowGateStateForRecovery(directory, candidate),
	});
	if (outcome.kind === 'gate-owner') {
		return { sessionID: outcome.sessionID, recovery: outcome.gate };
	}
	if (outcome.kind === 'no-gate') {
		return { sessionID: outcome.sessionID, recovery: null };
	}
	return { sessionID: null, recovery: null };
}

async function resolveWorkflowGateSession(
	directory: string,
	sessionID: string,
): Promise<string | null> {
	return (await resolveWorkflowGate(directory, sessionID)).sessionID;
}

async function executePrWorkflowStatus(
	directory: string,
	rawSessionID: string | undefined,
): Promise<string> {
	const sessionID = rawSessionID?.trim() ? rawSessionID.trim() : null;
	const resolvedGate = sessionID
		? await resolveWorkflowGate(directory, sessionID)
		: null;
	const gateSessionID = resolvedGate?.sessionID ?? null;

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
	if (!gateSessionID) {
		gate = {
			active: false,
			reason: sessionID ? 'delegation-chain-uncertain' : 'no-session-context',
		};
	} else {
		// Issue #2242 R4 (W-5): observation must survive gate-state corruption —
		// a schema-invalid state previously made this read-only tool throw, so an
		// operator could not even SEE the state they were stuck on. Unparseable
		// bytes still fail. This tool and abort_pr_workflow are the only two
		// callers of the recovery reader.
		const recovery = resolvedGate?.recovery ?? null;
		activeState = recovery?.state ?? null;
		const receiptFiles = activeState
			? await countCheckoutReceiptFiles(directory, gateSessionID)
			: null;
		gate = summarizeGate(
			activeState,
			receiptFiles,
			recovery
				? { salvaged: recovery.salvaged, disclosure: recovery.disclosure }
				: undefined,
		);
		// Issue #3095: the PR_REVIEW-only projection. The key is set ONLY here —
		// inactive gates and PR_FEEDBACK gates serialize without it entirely.
		// A schema-invalid gate state that was SALVAGED by the recovery reader
		// drops every prReview* field; the projection still runs (shape
		// stability) but flags its derived sections unavailable (F-04).
		if (activeState?.mode === 'PR_REVIEW') {
			gate.prReviewProjection = await buildPrReviewProjection(
				directory,
				activeState,
				recovery?.prReviewProjectionDropped ?? false,
			);
		}
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

	// Issue #2511 (workstream D, AC6): bounded operator recovery section.
	// controllerSessionID comes straight from the shared resolver outcome
	// (null when the chain is uncertain); wakeSuspension is keyed to the
	// CALLER's session because auto-wake suppression is observed on the
	// session that runs this tool; actionCircuits is typed 'unavailable' —
	// circuits are keyed by the exact session + invocation + semantic action
	// digest and a tool execution carries no live invocationID, so no bounded
	// read is reachable and no count is invented.
	const delegationRead = describeDelegationRead(directory);
	const recoverySection: PrWorkflowStatusRecoverySection = {
		controllerSessionID: gateSessionID,
		delegationRead,
		lastProgress: activeState
			? {
					revision: activeState.revision,
					updatedAt: activeState.updatedAt,
				}
			: null,
		wakeSuspension: {
			suspended: sessionID
				? _internals.isPrWorkflowAutoWakeSuppressed(directory, sessionID)
				: false,
		},
		actionCircuits: { state: 'unavailable' },
		nextStep: describeRecoveryNextStep(delegationRead.state),
	};

	const result: PrWorkflowStatusResult = {
		success: true,
		sessionID,
		git,
		checkout,
		gate,
		publication: activeState
			? describePrWorkflowPublicationSection(activeState)
			: null,
		nextStep: describeNextStep(gate, git, checkout),
		recovery: recoverySection,
	};
	return JSON.stringify(result, null, 2);
}

export const pr_workflow_status: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Read-only architect observation of local git state (HEAD, branch, clean/dirty with a bounded changed-file list, remotes) plus a session-pinned PR workflow gate summary (mode, bound PR head, base ref/sha, depth tier, dispatch/validation batch counts) and, for an active PR_REVIEW gate, a bounded projection of boundary settlement, per-lane coverage, and the derived candidate inventory. Use to observe state under the fail-closed PR_REVIEW/PR_FEEDBACK gate. Never executes PR-controlled scripts and never reads another session gate.',
		args: {},
		execute: async (_args: unknown, directory: string, ctx?: ToolContext) =>
			executePrWorkflowStatus(directory, ctx?.sessionID),
	});

/** Test seam mirroring gh-evidence's `_internals` (issue #507 DI convention). */
export const _internals: {
	readPrWorkflowGateStateForRecovery: typeof readPrWorkflowGateStateForRecovery;
	readDelegationsDetailed: typeof readDelegationsDetailed;
	isPrWorkflowAutoWakeSuppressed: typeof isPrWorkflowAutoWakeSuppressed;
	resolvePrWorkflowControllerSession: typeof resolvePrWorkflowControllerSession;
	resolveCurrentGitHeadAsync: typeof resolveCurrentGitHeadAsync;
	resolveIsWorkingTreeCleanAsync: typeof resolveIsWorkingTreeCleanAsync;
	runGitCapture: typeof runGitCapture;
	classifyGitState: typeof classifyPrWorkflowGitState;
	truncateToByteBudget: typeof truncateToByteBudget;
	resolveWorkflowGateSession: typeof resolveWorkflowGateSession;
	/** Batch receipt lookup for the lane-coverage projection (F-01 test seam). */
	findByBatchIdDetailed: typeof findByBatchIdDetailed;
	/** Pure field sanitizers (direct hostile-input unit suites). */
	boundUntrusted: typeof boundUntrusted;
	boundFindingLine: typeof boundFindingLine;
} = {
	readPrWorkflowGateStateForRecovery,
	readDelegationsDetailed,
	isPrWorkflowAutoWakeSuppressed,
	resolvePrWorkflowControllerSession,
	resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeCleanAsync,
	runGitCapture,
	classifyGitState: classifyPrWorkflowGitState,
	truncateToByteBudget,
	resolveWorkflowGateSession,
	findByBatchIdDetailed,
	boundUntrusted,
	boundFindingLine,
};
