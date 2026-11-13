/**
 * Pre-Check Batch Tool
 * Runs 4 verification tools in parallel: lint, secretscan, sast-scan, quality-budget
 * Returns unified result with gates_passed status
 */

import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { GateConfigOverrides, PluginConfig } from '../config';
import { loadGateOverrides } from '../config';
import type { SecretscanEvidence } from '../config/evidence-schema.js';
import { saveEvidence } from '../evidence/manager.js';
import { criticalWarn, warn } from '../utils';
import { runExternalTool } from '../utils/external-tool-runner';
import { sameExistingFilesystemPath } from '../utils/filesystem-identity.js';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';
import {
	assertProjectRoot,
	hasExplicitProjectBoundary,
	isStrictPathDescendant,
} from '../utils/project-boundary';
import { createSwarmTool } from './create-tool';
import type {
	LintResult,
	LintSuccessResult,
	ResolvedLinterCommand,
} from './lint';
import { detectResolvedLinter, _internals as lintInternals } from './lint';
import { resolveGatePreamble } from './phase-complete/gates/gate-helpers';
import type { QualityBudgetResult } from './quality-budget';
import { qualityBudget } from './quality-budget';
import type { SastScanFinding, SastScanResult } from './sast-scan';
import { sastScan } from './sast-scan';
import type {
	SecretFinding,
	SecretscanErrorResult,
	SecretscanResult,
} from './secretscan';
import {
	runSecretscan,
	runSecretscanOnFiles,
	SECRETSCAN_MAX_FINDINGS,
} from './secretscan';

// ============ Constants ============
const TOOL_TIMEOUT_MS = 60_000;
const MAX_COMBINED_BYTES = 500_000; // 500KB
const MAX_COMPACT_ERROR_BYTES = 4_096;
const CANCELLATION_SETTLEMENT_GRACE_MS = 1_000;
const MAX_CONCURRENT = 4;
const MAX_FILES = 100;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 2_000_000;
const GIT_MAX_STDERR_BYTES = 64_000;
const ALL_LINES_CHANGED = -1;
const MAX_CHANGED_LINE_ENTRIES = 200_000;

/**
 * Diff-base candidates walked in order (#3131). A candidate is only USABLE if
 * its committed diff can actually be acquired and parsed — a stale-but-
 * resolvable ref that overflows the stdout guard or the parser cap must fall
 * through to the next candidate instead of nulling the changed-line map.
 */
const DIFF_BASE_CANDIDATES = [
	'zaxbyhub/main',
	'upstream/main',
	'origin/main',
	'main',
	'origin/master',
	'master',
] as const;

/**
 * One diff-base candidate walk outcome (#3131).
 * - `unresolvable`: `git merge-base <ref> HEAD` completed non-zero (the
 *   normal "no merge base" answer) — try the next candidate.
 * - `unusable`: the candidate resolved, but its committed diff could not be
 *   acquired (stdout/stderr guard tripped — note the overflow KILLS the
 *   child, so the runner reports spawn-error WITH truncation flags; the
 *   flags are checked before the status), exited non-zero, or failed to
 *   parse — try the next candidate.
 * - `systemic`: abort, timeout, spawn failure, or executable-resolution
 *   failure — every later candidate would fail identically, so the walk
 *   stops (fail-closed, no fall-through).
 */
type DiffBaseAttempt = {
	ref: string;
	outcome: 'unresolvable' | 'unusable' | 'systemic' | 'ok';
};

type ClassifiedGitOutcome =
	| { kind: 'systemic' }
	| { kind: 'failed' }
	| { kind: 'ok'; stdout: string };

/**
 * Result-aware sibling of `runGit` (#3131): keeps the hardened executable
 * resolution (the caller resolves once and passes the same executable to
 * every call), array-form argv, explicit cwd, bounded output, and abort
 * plumbing, but reports WHY a call failed instead of collapsing every
 * failure to null. Classification order is load-bearing: truncation flags
 * are checked BEFORE the status field because an output-guard kill produces
 * `{status:'spawn-error', stdoutTruncated:true}` (external-tool-runner.ts
 * terminates the child on overflow) and must count as candidate-unusable,
 * not systemic.
 */
async function runGitClassified(
	args: string[],
	directory: string,
	abortSignal: AbortSignal | undefined,
	executable: string,
): Promise<ClassifiedGitOutcome> {
	if (abortSignal?.aborted) return { kind: 'systemic' };
	let result: Awaited<ReturnType<typeof runExternalTool>>;
	try {
		result = await _internals.runExternalTool({
			executable,
			args,
			cwd: directory,
			timeoutMs: GIT_TIMEOUT_MS,
			maxStdoutBytes: GIT_MAX_OUTPUT_BYTES,
			maxStderrBytes: GIT_MAX_STDERR_BYTES,
			abortSignal,
		});
	} catch {
		return { kind: 'systemic' };
	}
	if (result.status !== 'completed' && result.status !== 'spawn-error') {
		return { kind: 'systemic' };
	}
	if (
		result.status === 'spawn-error' &&
		!result.stdoutTruncated &&
		!result.stderrTruncated
	) {
		return { kind: 'systemic' };
	}
	// Timeout/abort teardown with uncollectable streams reports spawn-error
	// with BOTH truncation flags and EMPTY output (external-tool-runner
	// teardown path) — a systemic failure, not a candidate-unusable overflow:
	// a true overflow kill collects partial text, so non-empty stdout with
	// truncation flags stays the per-candidate `failed` below.
	if (
		result.status === 'spawn-error' &&
		result.stdoutTruncated &&
		result.stderrTruncated &&
		result.stdout === '' &&
		result.stderr === ''
	) {
		return { kind: 'systemic' };
	}
	if (result.status === 'completed' && result.exitCode !== 0) {
		return { kind: 'failed' };
	}
	if (result.stdoutTruncated || result.stderrTruncated) {
		return { kind: 'failed' };
	}
	return { kind: 'ok', stdout: result.stdout };
}

/**
 * Walk DIFF_BASE_CANDIDATES and return the first candidate whose committed
 * diff parses (#3131). The envelope is ALWAYS present so a null resolution
 * still carries the full attempt list for the named diagnostic.
 *
 * #3681 items 3-4 — base-selection authority (design note, AC4):
 * Local refs are UNTRUSTED inputs. Three successive heuristics for telling
 * an authoritative HEAD-equal acceptance from a planted/stale one were
 * disproved by executed counterexamples (branch-name match; reflog-top
 * `checkout:`; deferring to the first older resolvable base — a commit-
 * then-branch + planted ref, a cross-branch push HEAD:main, and a stale
 * intermediate remote ref each survive all three). With no network, committed-
 * hop authority CANNOT be proven from workspace state; the sound closures are
 * fetch-verified base selection (adds remote-tracking-ref mutation to a gate
 * path) or conservative fail-closed on every HEAD-equal acceptance (reverses
 * the #2918 F-002 fresh-branch contract pinned by
 * tests/unit/tools/pre-check-batch-merge-base-3131.test.ts:284-302 and would
 * false-NEW fresh-branch findings) — an OWNER decision tracked on #3681 and
 * in the trace ASK tracker, deliberately NOT resolved here. What this
 * resolver DOES ship: hadUnusableAttempt/acceptedCandidateRef provenance and
 * the differential `diff-base fall-through accepted` signal in the ranges
 * consumer. The sibling surface src/quality/git-base.ts (first-valid-wins,
 * #3676) must be decided TOGETHER with this one — same candidate-order
 * contract — via the authoritative-base follow-up issue.
 */
type DiffBaseResolution = {
	mergeBase: string;
	committedLines: Map<string, Set<number>>;
	mergeBaseEqualsHead: boolean;
	/** #3681 item 3: an earlier candidate in this walk produced an
	 * unusable committed diff (stdout overflow / parse failure), so a later
	 * acceptance silently narrows the committed hop vs the true base. */
	hadUnusableAttempt: boolean;
	/** Ref name of the accepted candidate (operator diagnostic). */
	acceptedCandidateRef: string;
};

type DiffBaseEnvelope = {
	attempted: DiffBaseAttempt[];
	resolution: DiffBaseResolution | null;
	failureCause?: 'git-executable' | 'head-resolution';
};

/**
 * Single-entry batch memo for the shared diff-base resolver (PR-feedback
 * FB-003): both consumers run back-to-back inside one pre_check_batch on
 * the same directory, and while HEAD is unchanged the resolution is purely
 * HEAD-derived, so the second consumer reuses the first consumer's envelope
 * instead of re-running the full candidate walk. Cleared at the top of
 * runPreCheckBatch (batch scope); the directory+headSha key self-invalidates
 * on any HEAD move. Disclosed residual: a fetch that moves a candidate ref
 * WITHOUT moving HEAD between two direct (non-batch) calls could serve a
 * stale mergeBase — same class as the existing changedLineRangesMemo batch
 * cache.
 */
let diffBaseResolutionMemo: {
	directory: string;
	headSha: string | null;
	envelope: DiffBaseEnvelope;
} | null = null;

/**
 * Per-directory cooldown for the always-visible diff-base failure
 * diagnostic (PR-feedback FB-001, AGENTS.md invariant 8): without it the
 * diagnostic re-emits on every gated batch and — before the batch memo —
 * fired twice per batch (once per consumer). Single-entry and bounded;
 * keyed by directory so distinct repositories never suppress each other.
 */
const DIFF_BASE_WARN_COOLDOWN_MS = 60_000;
let lastDiffBaseFailureWarn: { directory: string; atMs: number } | null = null;

/**
 * #3681 item 3(b): per-directory cooldown for the differential
 * fall-through-acceptance signal. Separate single-entry record from the
 * FB-001 failure diagnostic so neither suppresses the other (invariant 8;
 * same bounded shape as lastDiffBaseFailureWarn — one entry, replaced on
 * each emission, so distinct directories never suppress each other).
 */
let lastDiffBaseFallthroughWarn: { directory: string; atMs: number } | null =
	null;

/**
 * Walk DIFF_BASE_CANDIDATES and return the first candidate whose committed
 * diff parses (#3131). The envelope is ALWAYS present so a null resolution
 * still carries the full attempt list for the named diagnostic.
 */
async function resolveValidatedDiffBase(
	directory: string,
	abortSignal?: AbortSignal,
): Promise<DiffBaseEnvelope> {
	let executable: string;
	try {
		executable = await resolveGitExecutableAsync();
	} catch {
		// Executable resolution failed before any candidate was tried; the
		// cause discriminator makes logDiffBaseResolutionFailure name the
		// real cause instead of an untried candidate list.
		return { attempted: [], resolution: null, failureCause: 'git-executable' };
	}
	// Resolve HEAD once for the #3092 PRR-002 shadow check below. A
	// non-SHA/unresolvable HEAD (degenerate repository) leaves headSha null —
	// the shadow check is skipped and the candidate walk proceeds on its own
	// merits (a repository without a resolvable HEAD fails the diff legs
	// anyway).
	const headResult = await runGitClassified(
		['rev-parse', 'HEAD'],
		directory,
		abortSignal,
		executable,
	);
	if (headResult.kind === 'systemic') {
		return {
			attempted: [],
			resolution: null,
			failureCause: 'head-resolution',
		};
	}
	// A non-repository directory (or an unborn HEAD) makes rev-parse exit
	// non-zero; every merge-base probe would fail identically, so the doomed
	// walk is skipped and the cause is named (FB-001).
	if (headResult.kind === 'failed') {
		return {
			attempted: [],
			resolution: null,
			failureCause: 'head-resolution',
		};
	}
	const headSha =
		headResult.kind === 'ok' &&
		/^[0-9a-f]{40,64}$/i.test(headResult.stdout.trim())
			? headResult.stdout.trim().toLowerCase()
			: null;
	if (
		headSha !== null &&
		diffBaseResolutionMemo &&
		diffBaseResolutionMemo.directory === directory &&
		diffBaseResolutionMemo.headSha === headSha
	) {
		return diffBaseResolutionMemo.envelope;
	}
	const attempted: DiffBaseAttempt[] = [];
	for (const baseBranch of DIFF_BASE_CANDIDATES) {
		const mergeBaseResult = await runGitClassified(
			['merge-base', baseBranch, 'HEAD'],
			directory,
			abortSignal,
			executable,
		);
		if (mergeBaseResult.kind === 'systemic') {
			attempted.push({ ref: baseBranch, outcome: 'systemic' });
			return { attempted, resolution: null };
		}
		if (mergeBaseResult.kind !== 'ok') {
			attempted.push({ ref: baseBranch, outcome: 'unresolvable' });
			continue;
		}
		const candidate = mergeBaseResult.stdout.trim();
		if (!candidate || !/^[0-9a-f]{40,64}$/i.test(candidate)) {
			attempted.push({ ref: baseBranch, outcome: 'unresolvable' });
			continue;
		}
		// #3092 review (PRR-002) + 4.5 review F1: a merge-base equal to HEAD
		// means the committed hop is empty and NON-AUTHORITATIVE (HEAD sits
		// on the default branch itself, no branch commits yet, or the ref was
		// planted/shadowed at the tip). The resolver still ACCEPTS the
		// candidate (the untracked/staged legs of the union remain
		// authoritative — the #2918 F-002 ignored-file contract depends on a
		// non-null map in this geometry) but flags it so each consumer can
		// fail closed where the empty hop is load-bearing: the ambiguity
		// consumer refuses the discount unconditionally, and the ranges
		// consumer returns null when the HEAD-equal base was reached by
		// FALLING THROUGH a candidate that failed validation (a non-null
		// empty map would mark every committed finding PRE-EXISTING — the
		// SAST fail-open the review found); a FIRST-resolvable HEAD-equal
		// base keeps the pre-fix map (see the consumer guard for the
		// residual first-candidate planted-ref trust).
		const mergeBaseEqualsHead =
			headSha !== null && candidate.toLowerCase() === headSha;
		const diffResult = await runGitClassified(
			[
				'-c',
				'core.quotePath=false',
				'diff',
				'--no-ext-diff',
				'--no-color',
				'--no-prefix',
				'-U0',
				`${candidate}..HEAD`,
				'--',
			],
			directory,
			abortSignal,
			executable,
		);
		if (diffResult.kind === 'systemic') {
			attempted.push({ ref: baseBranch, outcome: 'systemic' });
			return { attempted, resolution: null };
		}
		if (diffResult.kind !== 'ok') {
			attempted.push({ ref: baseBranch, outcome: 'unusable' });
			continue;
		}
		const committedLines = parseDiffLineRangesChecked(diffResult.stdout, true);
		if (!committedLines) {
			attempted.push({ ref: baseBranch, outcome: 'unusable' });
			continue;
		}
		attempted.push({ ref: baseBranch, outcome: 'ok' });
		const resolved = {
			attempted,
			resolution: {
				mergeBase: candidate,
				committedLines,
				mergeBaseEqualsHead,
				hadUnusableAttempt: attempted.some(
					(entry) => entry.outcome === 'unusable',
				),
				acceptedCandidateRef: baseBranch,
			},
		};
		if (headSha !== null) {
			diffBaseResolutionMemo = { directory, headSha, envelope: resolved };
		}
		return resolved;
	}
	// FB-001: a repository whose default branch is not main/master fails
	// every fixed candidate (permanent fail-closed + a CRITICAL-WARN on every
	// gated batch). Derive one extra candidate from the remote's symbolic
	// HEAD — lazily, only on this total-failure path (one bounded spawn; a
	// repo without origin/HEAD exits non-zero and is skipped silently) — and
	// walk it with the same validated acceptance as the fixed list.
	if (!abortSignal?.aborted) {
		const symbolicResult = await runGitClassified(
			['symbolic-ref', 'refs/remotes/origin/HEAD'],
			directory,
			abortSignal,
			executable,
		);
		const symbolicRef =
			symbolicResult.kind === 'ok'
				? symbolicResult.stdout.trim().replace(/^refs\/remotes\//, '')
				: null;
		if (
			symbolicRef &&
			/^[A-Za-z0-9._/-]+$/.test(symbolicRef) &&
			!(DIFF_BASE_CANDIDATES as readonly string[]).includes(symbolicRef)
		) {
			const baseBranch = symbolicRef;
			const mergeBaseResult = await runGitClassified(
				['merge-base', baseBranch, 'HEAD'],
				directory,
				abortSignal,
				executable,
			);
			if (mergeBaseResult.kind === 'systemic') {
				attempted.push({ ref: baseBranch, outcome: 'systemic' });
				return { attempted, resolution: null };
			}
			if (mergeBaseResult.kind === 'ok') {
				const candidate = mergeBaseResult.stdout.trim();
				if (candidate && /^[0-9a-f]{40,64}$/i.test(candidate)) {
					const mergeBaseEqualsHead =
						headSha !== null && candidate.toLowerCase() === headSha;
					const diffResult = await runGitClassified(
						[
							'-c',
							'core.quotePath=false',
							'diff',
							'--no-ext-diff',
							'--no-color',
							'--no-prefix',
							'-U0',
							`${candidate}..HEAD`,
							'--',
						],
						directory,
						abortSignal,
						executable,
					);
					if (diffResult.kind === 'systemic') {
						attempted.push({ ref: baseBranch, outcome: 'systemic' });
						return { attempted, resolution: null };
					}
					if (diffResult.kind === 'ok') {
						const committedLines = parseDiffLineRangesChecked(
							diffResult.stdout,
							true,
						);
						if (committedLines) {
							attempted.push({ ref: baseBranch, outcome: 'ok' });
							const resolved = {
								attempted,
								resolution: {
									mergeBase: candidate,
									committedLines,
									mergeBaseEqualsHead,
									hadUnusableAttempt: attempted.some(
										(entry) => entry.outcome === 'unusable',
									),
									acceptedCandidateRef: baseBranch,
								},
							};
							if (headSha !== null) {
								diffBaseResolutionMemo = {
									directory,
									headSha,
									envelope: resolved,
								};
							}
							return resolved;
						}
					}
				}
				attempted.push({ ref: baseBranch, outcome: 'unusable' });
			} else {
				attempted.push({ ref: baseBranch, outcome: 'unresolvable' });
			}
		}
	}
	if (headSha !== null) {
		const exhausted = { attempted, resolution: null };
		diffBaseResolutionMemo = { directory, headSha, envelope: exhausted };
	}
	return { attempted, resolution: null };
}

/**
 * Bounded named diagnostic when NO diff base produced a usable committed
 * diff (#3131 AC3). Today the null is silent and indistinguishable from "git
 * unavailable"; this names every candidate tried and why each failed, on the
 * always-visible operational channel (criticalWarn is un-gated — the
 * operator must act or gating silently degrades). Emission is cooled down
 * per directory (FB-001, AGENTS.md invariant 8): both diff-base consumers
 * run in the same batch, and the diagnostic must not flood the channel on
 * every gated batch. The remedy is conditional — "fetch the remote tracking
 * refs" only helps when a candidate ref exists but is stale (some outcome
 * was `unusable`); an all-`unresolvable` walk means the refs do not exist in
 * this repository at all, so the advice names the actual requirement.
 */
function logDiffBaseResolutionFailure(
	directory: string,
	attempted: DiffBaseAttempt[],
	failureCause?: 'git-executable' | 'head-resolution',
): void {
	const nowMs = Date.now();
	if (
		lastDiffBaseFailureWarn &&
		lastDiffBaseFailureWarn.directory === directory &&
		nowMs - lastDiffBaseFailureWarn.atMs < DIFF_BASE_WARN_COOLDOWN_MS
	) {
		return;
	}
	lastDiffBaseFailureWarn = { directory, atMs: nowMs };
	const detail =
		failureCause === 'git-executable'
			? 'the git executable could not be resolved, so no candidate was tried'
			: failureCause === 'head-resolution'
				? 'resolving HEAD failed (timeout, spawn failure, non-repository directory, or aborted), so no candidate was tried'
				: `no usable diff base among candidates tried (${attempted
						.map((entry) => `${entry.ref}=${entry.outcome}`)
						.join(', ')})`;
	const allUnresolvable =
		attempted.length > 0 &&
		attempted.every((entry) => entry.outcome === 'unresolvable');
	const remedy = failureCause
		? ''
		: allUnresolvable
			? ' — none of the candidate refs exists in this repository; ensure one of them points at the default branch (a local branch or its remote-tracking ref)'
			: ' — fetch the remote tracking refs so a stale candidate resolves';
	criticalWarn(
		`changed-line base resolution failed: ${detail}${remedy} — changed-line classification is fail-closed (all findings treated as new)`,
	);
}

export const _internals: {
	qualityBudget: typeof qualityBudget;
	runLintWrapped: typeof runLintWrapped;
	runSecretscanWrapped: typeof runSecretscanWrapped;
	runSastScanWrapped: typeof runSastScanWrapped;
	runQualityBudgetWrapped: typeof runQualityBudgetWrapped;
	runWithTimeout: typeof runWithTimeout;
	getChangedLineRanges: typeof getChangedLineRanges;
	getChangedLineAmbiguousFiles: typeof getChangedLineAmbiguousFiles;
	saveEvidence: typeof saveEvidence;
	runExternalTool: typeof runExternalTool;
	detectResolvedLinter: typeof detectResolvedLinter;
	runLintOnFiles: typeof runLintOnFiles;
	platform: () => NodeJS.Platform;
	serializePreCheckResult: typeof serializePreCheckResult;
	resolveGatePreamble: typeof resolveGatePreamble;
	runPreCheckBatch: typeof runPreCheckBatch;
	loadGateOverrides: typeof loadGateOverrides;
	MAX_COMBINED_BYTES: number;
} = {
	qualityBudget,
	runLintWrapped,
	runSecretscanWrapped,
	runSastScanWrapped,
	runQualityBudgetWrapped,
	runWithTimeout,
	getChangedLineRanges,
	getChangedLineAmbiguousFiles,
	saveEvidence,
	runExternalTool,
	detectResolvedLinter,
	runLintOnFiles,
	platform: () => process.platform,
	serializePreCheckResult,
	resolveGatePreamble,
	runPreCheckBatch,
	loadGateOverrides,
	MAX_COMBINED_BYTES,
};

// ============ Input/Output Types ============
export interface PreCheckBatchInput {
	/** List of specific files to check (optional) */
	files?: string[];
	/** Directory to scan */
	directory: string;
	/** SAST severity threshold (default: medium) */
	sast_threshold?: 'low' | 'medium' | 'high' | 'critical';
	/**
	 * Optional legacy plugin-config carrier for the gates slices. The public
	 * tool boundary no longer populates it (agents cannot pass config); direct
	 * callers/tests may. `gates` below takes precedence.
	 * @deprecated prefer the `gates` field (issue #2524).
	 */
	config?: PluginConfig;
	/**
	 * User-written gate overrides (issue #2524) — loaded from the project/user
	 * config files by the public tool boundary via `loadGateOverrides`.
	 */
	gates?: GateConfigOverrides;
	/**
	 * Current phase number (positive integer >= 1).
	 * When provided, enables SAST baseline diffing: only findings absent from
	 * the phase-scoped baseline (.swarm/evidence/{phase}/sast-baseline.json) drive the
	 * fail verdict. Capture the baseline before first coder delegation via sast_scan
	 * with capture_baseline:true.
	 */
	phase?: number;
	/** Effective QA-profile value derived internally by the public tool boundary. */
	sast_enabled?: boolean;
}

export interface ToolResult<T> {
	/** Whether the tool was executed */
	ran: boolean;
	/** Tool result if successful */
	result?: T;
	/** Error message if failed */
	error?: string;
	/** Successful result payload was omitted from a compact serialized response. */
	result_omitted?: boolean;
	/** Duration in milliseconds */
	duration_ms: number;
}

interface SecretscanGateDecision {
	passed: boolean;
	summary: string;
	result?: SecretscanResult;
	/** TOTAL findings (Math.max(count, findings.length)) — evidence-visible. */
	findingsCount: number;
	/** #3092: findings on coder-changed lines (drives the gate). */
	newFindingsCount?: number;
	/** #3092: findings on unchanged lines (visible, non-gating). */
	preexistingFindingsCount?: number;
	/** #3092: a non-null changed-line map existed at classification time. */
	diffScoped?: boolean;
}

/** #3092: diff-scoped classification input for evaluateSecretscanGate. */
export interface SecretscanClassification {
	newFindings: SecretFinding[];
	preexistingFindings: SecretFinding[];
	diffScoped: boolean;
}

function formatIncompletePaths(
	incompletePaths: Array<{ path: string; reason: string }>,
	maxEntries = 3,
): string {
	const visible = incompletePaths.slice(0, maxEntries).map((entry) => {
		return `${entry.path} (${entry.reason})`;
	});
	const suffix =
		incompletePaths.length > maxEntries
			? ` (+${incompletePaths.length - maxEntries} more)`
			: '';
	return `${visible.join('; ')}${suffix}`;
}

function evaluateSecretscanGate(
	toolResult: ToolResult<SecretscanResult | SecretscanErrorResult>,
	requestedFiles: number,
	/**
	 * #3092: diff-scoped classification of the scan's findings. When omitted
	 * (legacy callers / zero-finding scans needing no classification), any
	 * finding fails the gate — the pre-#3092 behavior.
	 */
	classification?: SecretscanClassification,
): SecretscanGateDecision {
	if (toolResult.error) {
		return {
			passed: false,
			summary: `Secretscan wrapper error: ${toolResult.error}`,
			findingsCount: 0,
		};
	}
	if (!toolResult.ran || !toolResult.result) {
		return {
			passed: false,
			summary: 'Secretscan did not return a result',
			findingsCount: 0,
		};
	}
	if ('error' in toolResult.result) {
		return {
			passed: false,
			summary: `Secretscan error: ${toolResult.result.error}`,
			findingsCount: 0,
		};
	}

	const result = toolResult.result;
	if (
		typeof result.incomplete_files !== 'number' ||
		!Array.isArray(result.incomplete_paths)
	) {
		return {
			passed: false,
			summary:
				'Secretscan failed: scanner returned incomplete coverage metadata',
			result,
			findingsCount: Math.max(result.count, result.findings.length),
		};
	}
	const findingsCount = Math.max(result.count, result.findings.length);
	const failures: string[] = [];
	// #2918 vacuous coverage: every requested file was deliberately skipped by
	// secretscan scan policy (extension exclusion), with zero findings and zero
	// incomplete coverage — there was nothing the policy allows scanning.
	// Normative predicate — semantically equivalent on producer-emitted integers at
	// every enforcing site (gate, decoder, check_gate_status, stage-a-repair; all
	// but this gate also add stricter integer-format guards): evaluated over the
	// result fields; a result MISSING policy_skipped_files/requested_files is
	// non-vacuous (fail-closed) and never invalid.
	const vacuousCoverage =
		result.files_scanned === 0 &&
		typeof result.policy_skipped_files === 'number' &&
		typeof result.requested_files === 'number' &&
		result.requested_files > 0 &&
		result.policy_skipped_files >= result.requested_files &&
		result.count === 0 &&
		result.findings.length === 0 &&
		result.incomplete_files === 0 &&
		result.incomplete_paths.length === 0;
	// #3092: only findings on coder-changed lines gate. Without a
	// classification (legacy shape, or a producer that found findings but
	// never classified them), every finding counts as new — fail-closed.
	const newFindingsCount = classification
		? classification.newFindings.length
		: findingsCount;
	if (newFindingsCount > 0) {
		failures.push(`${newFindingsCount} new secret finding(s) on changed lines`);
	}
	if (result.truncated === true) {
		failures.push(`results truncated at ${SECRETSCAN_MAX_FINDINGS} findings`);
	}
	if (result.incomplete_files > 0 || result.incomplete_paths.length > 0) {
		const incompletePaths =
			result.incomplete_paths.length > 0
				? `; incomplete paths: ${formatIncompletePaths(result.incomplete_paths)}`
				: '';
		failures.push(
			`${result.incomplete_files} incomplete file(s)${incompletePaths}`,
		);
	}
	if (result.count !== result.findings.length) {
		failures.push(
			`findings/count mismatch (reported ${result.count}, actual ${result.findings.length})`,
		);
	}
	if (requestedFiles > 0 && result.files_scanned === 0 && !vacuousCoverage) {
		// #3107 feedback: name the ignore file when it caused the zero
		// coverage, so a clean all-ignored batch is diagnosable instead of a
		// bare "zero requested files scanned".
		failures.push(
			typeof result.ignored_files === 'number' && result.ignored_files > 0
				? `${result.ignored_files} requested file(s) suppressed by .secretscanignore; no file scanned`
				: 'zero requested files scanned',
		);
	}

	// Statistics prefix is a pinned surface (substring pins in
	// pre-check-batch-secretscan-evidence.test.ts): keep it byte-stable and
	// append the #3092 clauses only where classification ran (findings > 0),
	// so zero-finding summaries stay byte-identical to the pre-#3092 shape.
	let statistics = `Secretscan: ${findingsCount} finding(s), ${result.files_scanned} files scanned, ${result.skipped_files} skipped`;
	if (classification) {
		statistics += `, ${classification.newFindings.length} new secret finding(s) on changed lines (${classification.preexistingFindings.length} pre-existing)`;
	}
	if (vacuousCoverage) {
		statistics += `, all ${result.requested_files} requested file(s) skipped by secretscan scan policy (vacuous coverage)`;
	}
	const passedSummary = classification?.diffScoped
		? `${statistics}; secretscan green = zero new secrets on changed lines`
		: statistics;
	return {
		passed: failures.length === 0,
		summary:
			failures.length > 0
				? `${statistics}; failed: ${failures.join('; ')}`
				: passedSummary,
		result,
		findingsCount,
		...(classification && {
			newFindingsCount: classification.newFindings.length,
			preexistingFindingsCount: classification.preexistingFindings.length,
			diffScoped: classification.diffScoped,
		}),
	};
}

export interface PreCheckBatchResult {
	/** Structured producer status. Optional only for legacy serialized results. */
	batch_status?: 'completed' | 'skipped' | 'invalid';
	/** Overall gate status: true if all security gates pass */
	gates_passed: boolean;
	/** Lint tool result */
	lint: ToolResult<LintResult>;
	/** Secretscan tool result */
	secretscan: ToolResult<SecretscanResult | SecretscanErrorResult>;
	/** SAST scan tool result */
	sast_scan: ToolResult<SastScanResult>;
	/** Quality budget tool result */
	quality_budget: ToolResult<QualityBudgetResult>;
	/** Total duration in milliseconds */
	total_duration_ms: number;
	/** Pre-existing SAST findings on unchanged lines, requiring reviewer triage */
	sast_preexisting_findings?: SastScanFinding[];
	/**
	 * #3092: pre-existing secret findings on unchanged lines — visible in the
	 * scan result and persisted evidence, never gating; reviewer triage input
	 * and the hook decoder's diff-scope proof.
	 */
	secretscan_preexisting_findings?: SecretFinding[];
	/** Optional Semgrep exited nonzero with no findings; SAST coverage is incomplete. */
	sast_degraded?: boolean;
	/** SAST was intentionally disabled by the effective QA profile. */
	sast_skipped?: boolean;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	const marker = '... (truncated)';
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
	let result = '';
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (usedBytes + characterBytes > budget) break;
		result += character;
		usedBytes += characterBytes;
	}
	return `${result}${marker}`;
}

function compactToolResult(toolResult: ToolResult<unknown>) {
	return {
		ran: toolResult.ran,
		duration_ms: toolResult.duration_ms,
		...(toolResult.error !== undefined && {
			error: truncateUtf8(toolResult.error, MAX_COMPACT_ERROR_BYTES),
		}),
		...(toolResult.error === undefined &&
			toolResult.result !== undefined && { result_omitted: true }),
	};
}

/**
 * Serialize the public result below the decoder's stricter byte ceiling. When
 * detailed diagnostics exceed the aggregate budget, preserve every control
 * field and replace optional payloads with bounded, UTF-8-safe summaries.
 */
function serializePreCheckResult(result: PreCheckBatchResult): string {
	const serialized = JSON.stringify(result, null, 2);
	if (Buffer.byteLength(serialized, 'utf8') <= MAX_COMBINED_BYTES) {
		return serialized;
	}

	const compact = {
		batch_status: result.batch_status,
		gates_passed: result.gates_passed,
		...(result.sast_degraded !== undefined && {
			sast_degraded: result.sast_degraded,
		}),
		...(result.sast_skipped !== undefined && {
			sast_skipped: result.sast_skipped,
		}),
		lint: compactToolResult(result.lint),
		secretscan: compactToolResult(result.secretscan),
		sast_scan: compactToolResult(result.sast_scan),
		quality_budget: compactToolResult(result.quality_budget),
		total_duration_ms: result.total_duration_ms,
		output_truncated: true,
	};
	return JSON.stringify(compact, null, 2);
}

// ============ Security Validation ============

/**
 * Check if path is a Windows absolute path with drive letter (e.g., C:\ or C:/)
 * Node's path.isAbsolute() doesn't detect Windows paths correctly on POSIX systems
 */
function isWindowsAbsolutePath(inputPath: string): boolean {
	// Match drive letter paths: A: through Z: (case-insensitive) followed by :\ or :/
	return /^[A-Za-z]:[/\\]/.test(inputPath);
}

/**
 * Validate path to prevent traversal attacks
 * @param inputPath - The path to validate (can be relative or absolute)
 * @param baseDir - The base directory to resolve relative paths against
 * @param workspaceDir - The workspace root directory for absolute path validation
 */
function validatePath(
	inputPath: unknown,
	baseDir: string,
	workspaceDir: string,
): string | null {
	// Strict type guard - reject non-string inputs fail-closed before any path operations
	if (typeof inputPath !== 'string') {
		return 'path must be a string';
	}

	if (!inputPath || inputPath.trim().length === 0) {
		return 'path is required';
	}

	let resolved: string;
	const isWinAbs = isWindowsAbsolutePath(inputPath);

	// Handle absolute paths - use Windows path module for Windows absolute paths,
	// POSIX path module otherwise
	if (isWinAbs) {
		// For Windows absolute paths, resolve using win32 semantics
		resolved = path.win32.resolve(inputPath);
	} else if (path.isAbsolute(inputPath)) {
		resolved = path.resolve(inputPath);
	} else {
		resolved = path.resolve(baseDir, inputPath);
	}

	const workspaceResolved = isWindowsAbsolutePath(workspaceDir)
		? path.win32.resolve(workspaceDir)
		: path.resolve(workspaceDir);

	// CRITICAL: Do NOT allow path == workspace anchor as valid bypass
	// This prevents attackers from using the workspace directory itself as their validation anchor
	// Always enforce traversal check against the TRUE workspace boundary
	// The resolved path must be within workspace, not equal to it (except for the specific base dir case below)

	// Ensure the resolved path is within workspace directory
	// Use win32 relative for Windows paths to handle cross-platform correctly
	let relative: string;
	if (isWinAbs) {
		relative = path.win32.relative(workspaceResolved, resolved);
	} else {
		relative = path.relative(workspaceResolved, resolved);
	}

	// Path traversal: starts with '..' means going up from workspace
	if (relative.startsWith('..')) {
		return 'path traversal detected';
	}

	return null;
}

function isAcceptedProjectRootForPlatform(
	dir: string,
	workspaceDir: string,
	platform: NodeJS.Platform,
	hasExplicitBoundary: boolean,
	exactPhysicalRoot = false,
): boolean {
	if (exactPhysicalRoot) return true;
	const pathApi = platform === 'win32' ? path.win32 : path;
	const directoryKey = pathApi.resolve(dir).replace(/\\/g, '/');
	const workspaceKey = pathApi.resolve(workspaceDir).replace(/\\/g, '/');
	const normalizedDirectoryKey =
		platform === 'win32' ? directoryKey.toLowerCase() : directoryKey;
	const normalizedWorkspaceKey =
		platform === 'win32' ? workspaceKey.toLowerCase() : workspaceKey;
	if (normalizedDirectoryKey === normalizedWorkspaceKey) return true;

	const relative = pathApi.relative(workspaceDir, dir);
	const isStrictDescendant =
		relative !== '' &&
		relative !== '..' &&
		!relative.startsWith(`..${pathApi.sep}`) &&
		!pathApi.isAbsolute(relative);
	return isStrictDescendant && hasExplicitBoundary;
}

export const _test_exports = { isAcceptedProjectRootForPlatform };

/**
 * Validate the directory input
 * @param dir - The directory to validate
 * @param workspaceDir - The workspace root directory
 */
function validateDirectory(dir: string, workspaceDir: string): string | null {
	if (!dir || dir.length === 0) {
		return 'directory is required';
	}

	if (dir.length > 500) {
		return 'directory path too long';
	}

	// A sibling lexical spelling may still be the exact physical workspace root
	// (for example, a Windows junction). Authorize only that fail-closed equality
	// before lexical traversal; foreign or missing roots continue through the
	// ordinary boundary checks below.
	const exactPhysicalRoot = sameExistingFilesystemPath(dir, workspaceDir);
	if (!exactPhysicalRoot) {
		// Validate directory against the TRUE workspace boundary. Use workspaceDir
		// as both base and boundary, never the untrusted input as its own anchor.
		const traversalCheck = validatePath(dir, workspaceDir, workspaceDir);
		if (traversalCheck) return traversalCheck;
	}

	const platform = _internals.platform();
	if (
		!isAcceptedProjectRootForPlatform(
			dir,
			workspaceDir,
			platform,
			hasExplicitProjectBoundary(dir),
			exactPhysicalRoot,
		)
	) {
		return 'directory must resolve to the project root';
	}

	return null;
}

// ============ Timeout Helper ============

/**
 * Run a function with timeout
 */
async function runWithTimeout<T>(
	operation: (abortSignal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parentSignal?: AbortSignal,
	waitForCancellationSettlement = false,
): Promise<T> {
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let parentAbortListener: (() => void) | undefined;
	if (parentSignal?.aborted) throw new Error('Tool execution cancelled');
	const parentAbortPromise = new Promise<never>((_, reject) => {
		if (!parentSignal) return;
		parentAbortListener = () => {
			reject(new Error('Tool execution cancelled'));
			controller.abort();
		};
		parentSignal.addEventListener('abort', parentAbortListener, { once: true });
		if (parentSignal.aborted) parentAbortListener();
	});
	if (controller.signal.aborted) return await parentAbortPromise;
	const operationPromise = operation(controller.signal);
	try {
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new Error(`Timeout after ${timeoutMs}ms`));
				controller.abort();
			}, timeoutMs);
		});
		return await Promise.race([
			operationPromise,
			timeoutPromise,
			parentAbortPromise,
		]);
	} catch (error) {
		if (controller.signal.aborted && waitForCancellationSettlement) {
			let settlementTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					operationPromise.then(
						() => undefined,
						() => undefined,
					),
					new Promise<void>((resolve) => {
						settlementTimer = setTimeout(
							resolve,
							CANCELLATION_SETTLEMENT_GRACE_MS,
						);
					}),
				]);
			} finally {
				if (settlementTimer !== undefined) clearTimeout(settlementTimer);
			}
		}
		throw error;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		if (parentAbortListener && parentSignal) {
			parentSignal.removeEventListener('abort', parentAbortListener);
		}
	}
}

// ============ Wrapper Functions ============

/**
 * Run lint with detection and timeout
 */
async function runLintWrapped(
	files: string[] | undefined,
	directory: string,
	_gates?: GateConfigOverrides,
	abortSignal?: AbortSignal,
): Promise<ToolResult<LintResult>> {
	const start = process.hrtime.bigint();

	try {
		const resolvedLinter = await _internals.detectResolvedLinter(
			directory,
			abortSignal,
		);

		if (!resolvedLinter) {
			return {
				ran: false,
				error: 'No linter found (biome or eslint)',
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// If files are provided, run lint on those specific files only
		if (files && files.length > 0) {
			const filteredResult = await _internals.runLintOnFiles(
				resolvedLinter,
				files,
				directory,
				abortSignal,
			);
			return {
				ran: true,
				result: filteredResult,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - run lint on entire directory (current behavior)
		const result = await lintInternals.runResolvedLint(
			resolvedLinter,
			'check',
			directory,
			abortSignal,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run lint on specific files only
 */
async function runLintOnFiles(
	resolvedLinter: ResolvedLinterCommand,
	files: string[],
	workspaceDir: string,
	abortSignal?: AbortSignal,
): Promise<LintResult> {
	if (resolvedLinter.source === 'legacy-test-probe') {
		return lintInternals.runResolvedLint(
			resolvedLinter,
			'check',
			workspaceDir,
			abortSignal,
		);
	}
	// Security: Validate all resolved file paths before use
	const validatedFiles: string[] = [];
	for (const file of files) {
		// Hardened: Explicit type guard for non-string entries fail-closed
		if (typeof file !== 'string') {
			continue;
		}
		// Resolve the path first
		const resolvedPath = path.resolve(file);
		// Validate the resolved path against workspace
		const validationError = validatePath(
			resolvedPath,
			workspaceDir,
			workspaceDir,
		);
		if (validationError) {
			// Skip invalid files - fail closed
			continue;
		}
		validatedFiles.push(resolvedPath);
	}

	// Fail closed if no valid files after validation
	if (validatedFiles.length === 0) {
		return {
			success: false,
			mode: 'check',
			linter: resolvedLinter.linter,
			command: [],
			error: 'No valid files after security validation',
		};
	}

	// Resolve binary using the same hierarchy as detectAvailableLinter
	// (local → ancestor → PATH) so detection and execution are consistent.
	let args: string[];
	if (resolvedLinter.linter === 'biome') {
		args = [...resolvedLinter.argsPrefix, 'check', ...validatedFiles];
	} else {
		args = [...resolvedLinter.argsPrefix, ...validatedFiles];
	}
	const command = [...resolvedLinter.displayPrefix, ...args];

	try {
		const execution = await _internals.runExternalTool({
			executable: resolvedLinter.executable,
			args,
			cwd: workspaceDir,
			timeoutMs: TOOL_TIMEOUT_MS,
			maxStdoutBytes: 512_000,
			maxStderrBytes: 512_000,
			abortSignal,
		});
		if (execution.status !== 'completed') {
			return {
				success: false,
				mode: 'check',
				linter: resolvedLinter.linter,
				command,
				error: execution.message ?? `Execution ${execution.status}`,
			};
		}
		const exitCode = execution.exitCode ?? 1;
		let output = execution.stdout;
		if (execution.stderr) {
			output += (output ? '\n' : '') + execution.stderr;
		}
		if (execution.stdoutTruncated || execution.stderrTruncated) {
			output += '\n... (output truncated)';
		}

		const result: LintSuccessResult = {
			success: true,
			mode: 'check',
			linter: resolvedLinter.linter,
			command,
			exitCode,
			output,
		};

		if (exitCode === 0) {
			result.message = `${resolvedLinter.linter} check completed successfully with no issues`;
		} else if (
			resolvedLinter.linter === 'biome' &&
			output.includes('No files were processed')
		) {
			// #2918: biome exits 1 with "No files were processed in the specified
			// paths" when every path is ignored by its configuration (docs-only
			// batches). The old message claimed issues were found — false when
			// zero files were processed. Informational semantics unchanged.
			result.message = `${resolvedLinter.linter} check processed no files (all specified paths ignored by biome configuration)`;
		} else {
			result.message = `${resolvedLinter.linter} check found issues (exit code ${exitCode}).`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			mode: 'check',
			linter: resolvedLinter.linter,
			command,
			error:
				error instanceof Error
					? `Execution failed: ${error.message}`
					: 'Execution failed: unknown error',
		};
	}
}

/**
 * Run secretscan with timeout
 */
async function runSecretscanWrapped(
	files: string[] | undefined,
	directory: string,
	_gates?: GateConfigOverrides,
	abortSignal?: AbortSignal,
	/**
	 * #2918: raw declared file count captured BEFORE the batch's validation
	 * drop loop — the gate's request basis. Plumbed into the scan result's
	 * requested_files so a dropped entry keeps requested > policy counter
	 * (non-vacuous, fail-closed).
	 */
	rawRequestedFiles?: number,
): Promise<ToolResult<SecretscanResult | SecretscanErrorResult>> {
	const start = process.hrtime.bigint();

	try {
		// If files are provided, run secretscan with explicit file scope
		if (files && files.length > 0) {
			const result = await runWithTimeout(
				() => runSecretscanOnFiles(files, directory, rawRequestedFiles),
				TOOL_TIMEOUT_MS,
				abortSignal,
			);
			return {
				ran: true,
				result,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - scan entire directory (current behavior)
		const result = await runWithTimeout(
			() => runSecretscan(directory),
			TOOL_TIMEOUT_MS,
			abortSignal,
			true,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run SAST scan with timeout
 */
async function runSastScanWrapped(
	changedFiles: string[],
	directory: string,
	severityThreshold: 'low' | 'medium' | 'high' | 'critical',
	gates?: GateConfigOverrides,
	phase?: number,
	abortSignal?: AbortSignal,
): Promise<ToolResult<SastScanResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			(signal) =>
				sastScan(
					{
						changed_files: changedFiles,
						severity_threshold: severityThreshold,
						phase,
						abort_signal: signal,
					},
					directory,
					gates,
				),
			TOOL_TIMEOUT_MS,
			abortSignal,
			true,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run quality budget with timeout
 */
async function runQualityBudgetWrapped(
	changedFiles: string[],
	directory: string,
	gates?: GateConfigOverrides,
	abortSignal?: AbortSignal,
): Promise<ToolResult<QualityBudgetResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			(signal) =>
				_internals.qualityBudget(
					{
						changed_files: changedFiles,
						config: gates?.quality_budget,
					},
					directory,
					signal,
				),
			TOOL_TIMEOUT_MS,
			abortSignal,
			true,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

// ============ Changed-Line Detection ============

/** Severity levels that trigger the gate (legacy changed-line triage) */
const GATE_SEVERITIES = new Set(['high', 'critical']);

const SEVERITY_ORDER_PCB: Record<string, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

/** Whether a finding severity meets or exceeds the given threshold. */
function meetsThresholdForTriage(
	severity: string,
	threshold: 'low' | 'medium' | 'high' | 'critical',
): boolean {
	return (
		(SEVERITY_ORDER_PCB[severity] ?? 0) >= (SEVERITY_ORDER_PCB[threshold] ?? 1)
	);
}

async function runGit(
	args: string[],
	directory: string,
	abortSignal?: AbortSignal,
): Promise<string | null> {
	// Resolution failure (every candidate rejected) maps onto this function's
	// existing "any failure -> null" contract, same as a failed runExternalTool
	// call would — no new throw introduced at this call site.
	let gitExecutable: string;
	try {
		gitExecutable = await resolveGitExecutableAsync();
	} catch {
		return null;
	}
	const result = await _internals.runExternalTool({
		executable: gitExecutable,
		args,
		cwd: directory,
		timeoutMs: GIT_TIMEOUT_MS,
		maxStdoutBytes: GIT_MAX_OUTPUT_BYTES,
		maxStderrBytes: GIT_MAX_STDERR_BYTES,
		abortSignal,
	});
	if (
		result.status !== 'completed' ||
		result.exitCode !== 0 ||
		result.stdoutTruncated
	) {
		return null;
	}
	return result.stdout;
}

function decodeGitQuotedPath(value: string): string | null {
	if (!value.startsWith('"')) return value;
	if (!value.endsWith('"')) return null;
	const bytes: number[] = [];
	const appendText = (text: string) => {
		bytes.push(...Buffer.from(text, 'utf8'));
	};
	for (let index = 1; index < value.length - 1; index++) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return null;
		const char = String.fromCodePoint(codePoint);
		if (char !== '\\') {
			appendText(char);
			if (char.length === 2) index++;
			continue;
		}
		index++;
		if (index >= value.length - 1) return null;
		const escaped = value[index];
		const simple: Record<string, string> = {
			'\\': '\\',
			'"': '"',
			t: '\t',
			n: '\n',
			r: '\r',
			b: '\b',
			f: '\f',
			v: '\v',
		};
		if (simple[escaped] !== undefined) {
			appendText(simple[escaped]);
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			for (let count = 0; count < 2; count++) {
				const next = value[index + 1];
				if (!next || !/[0-7]/.test(next)) break;
				octal += next;
				index++;
			}
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		return null;
	}
	return Buffer.from(bytes).toString('utf8');
}

function normalizeRepoPathKey(repoPath: string): string {
	const normalized = repoPath.replace(/\\/g, '/');
	return _internals.platform() === 'win32' || _internals.platform() === 'darwin'
		? normalized.toLowerCase()
		: normalized;
}

function normalizeDiffPath(rawPath: string): string | null {
	const pathToken = rawPath.startsWith('"')
		? rawPath
		: rawPath.split('\t', 1)[0];
	const decoded = decodeGitQuotedPath(pathToken);
	if (
		decoded === null ||
		decoded === '/dev/null' ||
		decoded.trim().length === 0
	) {
		return null;
	}
	// Every producer diff uses --no-prefix. A literal leading `a/` or `b/` is
	// therefore part of the repository path and must never be stripped: doing so
	// would make a newly changed security finding look pre-existing.
	return normalizeRepoPathKey(decoded);
}

/**
 * Parse unified diff output (with -U0) to extract added/modified line numbers per file.
 * Returns a Map from normalised file path → Set of changed line numbers.
 */
export function parseDiffLineRanges(
	diffOutput: string,
): Map<string, Set<number>> {
	return parseDiffLineRangesChecked(diffOutput, false) ?? new Map();
}

function parseDiffLineRangesChecked(
	diffOutput: string,
	requireGitFileHeaders: boolean,
): Map<string, Set<number>> | null {
	const result = new Map<string, Set<number>>();
	let currentFile: string | null = null;
	let inGitFile = false;
	let expectingDestination = false;
	let destinationSeen = false;
	let destinationNeedsHunk = false;
	let collectedLines = 0;
	// #3681 item 1: hunk-body state. While a hunk still owes body lines,
	// `--- ` / `+++ ` / `@@` / `diff --git` prefixes are CONTENT (a deleted
	// line whose text begins `-- ` renders as `--- <content>`, an added line
	// beginning `++ ` renders as `+++ <content>`) — never file-header
	// boundaries. Without this, the parser reattributed the rest of a hunk
	// to a phantom file key and the SAST PRE-EXISTING classification lost
	// real changed lines (fail-open). Both counters come from the `@@`
	// header; any prefix other than `+`/`-`/`\ ` while armed, an
	// over-delivered side, or EOF while armed fails CLOSED (null) — every
	// consumer treats null as "no discount", the safe direction.
	let oldRemaining = 0;
	let newRemaining = 0;

	for (const rawLine of diffOutput.split(/\r?\n/)) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (oldRemaining > 0 || newRemaining > 0) {
			if (line.startsWith('+')) {
				if (newRemaining === 0) return null;
				newRemaining--;
				continue;
			}
			if (line.startsWith('-')) {
				if (oldRemaining === 0) return null;
				oldRemaining--;
				continue;
			}
			// `\ No newline at end of file` is hunk metadata and consumes
			// neither side's count.
			if (line.startsWith('\\')) continue;
			// Context line (single leading space) consumes both sides.
			if (line.startsWith(' ')) {
				if (oldRemaining === 0 || newRemaining === 0) return null;
				oldRemaining--;
				newRemaining--;
				continue;
			}
			// `@@`, `diff --git`, `--- `, `+++ `, or any other shape while
			// armed means the hunk under-delivered: fail closed.
			return null;
		}
		if (line.startsWith('diff --git ')) {
			if (expectingDestination || destinationNeedsHunk) return null;
			inGitFile = true;
			currentFile = null;
			expectingDestination = false;
			destinationSeen = false;
			continue;
		}
		if (line.startsWith('--- ') && (inGitFile || !requireGitFileHeaders)) {
			if (expectingDestination || destinationNeedsHunk) return null;
			expectingDestination = true;
			continue;
		}
		if (line.startsWith('+++ ')) {
			if (requireGitFileHeaders && (!inGitFile || !expectingDestination)) {
				return null;
			}
			const rawDestination = line.slice(4);
			currentFile = normalizeDiffPath(rawDestination);
			if (currentFile === null && rawDestination.trim() !== '/dev/null') {
				return null;
			}
			expectingDestination = false;
			destinationSeen = true;
			destinationNeedsHunk = true;
			if (!currentFile) continue;
			if (!result.has(currentFile)) {
				result.set(currentFile, new Set());
			}
			continue;
		}
		// @@ -old,count +new,count @@ — anchor regex to hunk header structure
		if (!line.startsWith('@@')) continue;
		if (
			expectingDestination ||
			(requireGitFileHeaders && (!inGitFile || !destinationSeen))
		) {
			return null;
		}
		const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!match) return null;
		const oldCount = match[1] !== undefined ? Number.parseInt(match[1], 10) : 1;
		const start = Number.parseInt(match[2], 10);
		const count = match[3] !== undefined ? Number.parseInt(match[3], 10) : 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			(count > 0 && start < 1) ||
			count > MAX_CHANGED_LINE_ENTRIES ||
			start + count - 1 > Number.MAX_SAFE_INTEGER ||
			collectedLines + count > MAX_CHANGED_LINE_ENTRIES ||
			!Number.isSafeInteger(oldCount) ||
			oldCount < 0 ||
			oldCount > MAX_CHANGED_LINE_ENTRIES
		) {
			return null;
		}
		destinationNeedsHunk = false;
		// Arm the hunk-body counters (#3681 item 1); the loop consumes the
		// body before any further header prefix can be trusted.
		oldRemaining = oldCount;
		newRemaining = count;
		if (!currentFile) continue;
		const lines = result.get(currentFile);
		if (!lines) return null;
		for (let index = 0; index < count; index++) {
			lines.add(start + index);
		}
		collectedLines += count;
	}
	if (
		expectingDestination ||
		destinationNeedsHunk ||
		oldRemaining > 0 ||
		newRemaining > 0
	) {
		return null;
	}

	return result;
}

function mergeChangedLines(
	target: Map<string, Set<number>>,
	source: Map<string, Set<number>>,
): void {
	for (const [file, sourceLines] of source) {
		const targetLines = target.get(file) ?? new Set<number>();
		for (const line of sourceLines) targetLines.add(line);
		target.set(file, targetLines);
	}
}

function parseUntrackedStatus(output: string): string[] | null {
	if (output.length > 0 && !output.endsWith('\0')) return null;

	const untracked: string[] = [];
	const records = output.split('\0');
	for (let index = 0; index < records.length - 1; index++) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== ' ') return null;

		const status = record.slice(0, 2);
		const filePath = record.slice(3);
		if (!filePath || !isKnownPorcelainStatus(status)) return null;
		if (status === '??' || status === '!!') {
			untracked.push(normalizeRepoPathKey(filePath));
		}

		if (/[RC]/.test(status)) {
			const sourcePath = records[++index];
			if (!sourcePath || looksLikePorcelainStatusRecord(sourcePath))
				return null;
		}
	}
	return untracked;
}

function isKnownPorcelainStatus(status: string): boolean {
	if (status === '??' || status === '!!') return true;
	if (/U/.test(status)) {
		return new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(status);
	}
	return status !== '  ' && /^[ MTADRC]{2}$/.test(status);
}

function looksLikePorcelainStatusRecord(value: string): boolean {
	return (
		value.length >= 4 &&
		value[2] === ' ' &&
		isKnownPorcelainStatus(value.slice(0, 2))
	);
}

/**
 * Files whose changed-line evidence mixes more than one Git hop (#3092).
 *
 * `getChangedLineRanges` unions three diffs written in different coordinate
 * systems — `mergeBase..HEAD` in HEAD coordinates, `--cached HEAD` in index
 * coordinates, and the worktree diff — while secretscan findings carry
 * WORKTREE line numbers (the file on disk). A file changed in a committed or
 * staged hop and then edited again (staged and/or unstaged) can have its
 * committed/staged line numbers shifted in the worktree, so the union's
 * membership test alone cannot prove a finding pre-existing: a staged secret
 * with an unstaged insertion above it lands outside the union and would read
 * as untouched. Every finding in such a multi-hop file classifies as NEW.
 * The set is keyed by `normalizeRepoPathKey`, matching the changed-line map.
 * Returns null when a Git source is unavailable — callers must then treat
 * every finding as NEW (fail-closed).
 */
export async function getChangedLineAmbiguousFiles(
	directory: string,
	abortSignal?: AbortSignal,
	requestedFiles: string[] = [],
): Promise<Set<string> | null> {
	// #3131: same validated base selection as getChangedLineRanges — both
	// consumers of the diff base must resolve the SAME usable candidate, so a
	// stale first ref cannot inflate this committed hop either. The scoped
	// `--name-only` diff below then runs against the resolved mergeBase.
	// (#3092 PRR-002 HEAD-shadow rejection lives in the resolver itself.)
	const { attempted, resolution, failureCause } =
		await resolveValidatedDiffBase(directory, abortSignal);
	if (!resolution) {
		logDiffBaseResolutionFailure(directory, attempted, failureCause);
		return null;
	}
	// #3092 review (PRR-002), original guard retained: a merge-base equal to
	// HEAD means the committed hop is empty and NON-AUTHORITATIVE — fail
	// closed, nothing gets the discount (worktree-only edits before the
	// first branch commit also lose it; residual: a ref planted at an
	// INTERMEDIATE commit can still shrink the hop — same git-state trust
	// the SAST classification inherits; full mitigation requires
	// fetch-verified refs).
	if (resolution.mergeBaseEqualsHead) {
		return null;
	}
	const mergeBase = resolution.mergeBase;

	// :(literal) pathspec magic (#3092 review PRR-005): coder-supplied names
	// are file paths, not fnmatch patterns — glob metacharacters in real
	// filenames ([id].tsx, w?.ts) must match exactly, and an under-matching
	// pattern silently empties the committed/status sets (fail-open).
	const literalPathspecs = requestedFiles
		.map((file) => path.relative(directory, file).replace(/\\/g, '/'))
		.filter(
			(file) => file.length > 0 && file !== '..' && !file.startsWith('../'),
		)
		.map((file) => `:(literal)${file}`);
	const statusArgs = [
		'-c',
		'core.quotePath=false',
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
		...(literalPathspecs.length > 0 ? ['--', ...literalPathspecs] : []),
	];
	const [committedNames, status] = await Promise.all([
		runGit(
			[
				'-c',
				'core.quotePath=false',
				'diff',
				'--name-only',
				'--no-ext-diff',
				'--no-color',
				'--no-prefix',
				'-z',
				`${mergeBase}..HEAD`,
				'--',
				...(literalPathspecs.length > 0 ? literalPathspecs : []),
			],
			directory,
			abortSignal,
		),
		runGit(statusArgs, directory, abortSignal),
	]);
	if (committedNames === null || status === null) return null;

	// -z keeps git from C-quoting special names and from newline ambiguity,
	// so these keys join the raw -z status records below without .trim()
	// damage (#3092 review PRR-006). Renames emit both endpoints as separate
	// NUL records; the deleted-side key never appears in staged/unstaged, so
	// marking it is inert.
	const committed = new Set(
		committedNames.split('\0').filter(Boolean).map(normalizeRepoPathKey),
	);

	// Per-file staged/unstaged dirtiness from the XY columns. Rename/copy
	// records carry the source path as a second NUL record (parseUntrackedStatus
	// precedent); the source path is not itself a worktree-dirty signal.
	const staged = new Set<string>();
	const unstaged = new Set<string>();
	if (status.length > 0 && !status.endsWith('\0')) return null;
	const records = status.split('\0');
	for (let index = 0; index < records.length - 1; index++) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== ' ') return null;
		const statusCode = record.slice(0, 2);
		const filePath = record.slice(3);
		if (!filePath || !isKnownPorcelainStatus(statusCode)) return null;
		if (statusCode !== '??' && statusCode !== '!!') {
			const key = normalizeRepoPathKey(filePath);
			if (/[MADRCU]/.test(statusCode[0])) staged.add(key);
			if (/[MADRCU]/.test(statusCode[1])) unstaged.add(key);
		}
		if (/[RC]/.test(statusCode)) {
			const sourcePath = records[++index];
			if (!sourcePath || looksLikePorcelainStatusRecord(sourcePath)) {
				return null;
			}
		}
	}

	const ambiguous = new Set<string>();
	// committed hop (mergeBase..HEAD) + any index/worktree dirtiness:
	// HEAD-coordinate lines may be shifted by the later hop(s).
	for (const key of committed) {
		if (staged.has(key) || unstaged.has(key)) ambiguous.add(key);
	}
	// staged + unstaged: index-coordinate lines may be shifted by the
	// unstaged hop.
	for (const key of staged) {
		if (unstaged.has(key)) ambiguous.add(key);
	}
	return ambiguous;
}

/**
 * Get the union of committed, staged, unstaged, and untracked changed lines.
 * A known empty union is authoritative; null means a required Git source was
 * unavailable or malformed and callers must classify findings fail-closed.
 */
export async function getChangedLineRanges(
	directory: string,
	abortSignal?: AbortSignal,
	requestedFiles: string[] = [],
): Promise<Map<string, Set<number>> | null> {
	// #3131: the diff base is the first candidate whose committed diff is
	// actually USABLE — a stale-but-resolvable ref whose diff trips the stdout
	// guard or the parser cap falls through to the next candidate instead of
	// nulling the whole map. A total failure carries a named diagnostic.
	const { attempted, resolution, failureCause } =
		await resolveValidatedDiffBase(directory, abortSignal);
	if (!resolution) {
		logDiffBaseResolutionFailure(directory, attempted, failureCause);
		return null;
	}
	// #3092 PRR-002 for the ranges consumer (4.5 review F1, final-critic
	// refinement): a HEAD-equal base hands classifySastFindings an
	// authoritative-looking empty committed hop — every committed finding
	// PRE-EXISTING, gate open where base was fail-closed. But a branch with
	// no commits past its base is the ORDINARY fresh-ref geometry: at base
	// the first-valid-wins walk accepted that candidate and the
	// staged/unstaged/untracked legs stayed authoritative (#2918 F-002
	// ignored-file contract). Fail closed ONLY when the HEAD-equal base was
	// reached by FALLING THROUGH an earlier candidate that resolved but
	// failed validation (overflow/planted-ref signature); when it is the
	// first resolvable candidate, keep the pre-fix behavior.
	const headEqualFromFallThrough =
		resolution.mergeBaseEqualsHead &&
		attempted.some((entry) => entry.outcome === 'unusable');
	if (headEqualFromFallThrough) {
		criticalWarn(
			'changed-line base resolution: the selected diff base equals HEAD after another candidate failed validation (overflow or planted-ref signature; empty committed hop is non-authoritative) — changed-line classification is fail-closed (all findings treated as new); fetch the remote tracking refs',
		);
		return null;
	}
	// #3681 item 3(b): an accepted NON-HEAD candidate after an earlier
	// candidate failed validation silently narrows the committed hop — at the
	// #3131 base this shape failed closed to null, and the fall-through fix
	// (deliberate, FB-001) made it silent. Differential signal only: the
	// ordinary stale-upstream geometry (first resolvable candidate accepted,
	// no prior unusable attempt) stays quiet; emission is cooled down per
	// directory (invariant 8). The classification itself remains as disclosed
	// pending the #3681 items 3a/4 owner adjudication (see resolver docstring).
	if (!resolution.mergeBaseEqualsHead && resolution.hadUnusableAttempt) {
		const nowMs = Date.now();
		if (
			!(
				lastDiffBaseFallthroughWarn &&
				lastDiffBaseFallthroughWarn.directory === directory &&
				nowMs - lastDiffBaseFallthroughWarn.atMs < DIFF_BASE_WARN_COOLDOWN_MS
			)
		) {
			lastDiffBaseFallthroughWarn = { directory, atMs: nowMs };
			criticalWarn(
				`changed-line base resolution: diff-base fall-through accepted — an earlier candidate produced an unusable committed diff (stdout overflow or parse failure); accepted ${resolution.acceptedCandidateRef} at ${resolution.mergeBase.slice(0, 10)}; committed changes between the skipped candidate and the accepted base classify PRE-EXISTING (advisory)`,
			);
		}
	}
	const { committedLines } = resolution;

	const commonDiffArgs = [
		'-c',
		'core.quotePath=false',
		'diff',
		'--no-ext-diff',
		'--no-color',
		'--no-prefix',
		'-U0',
	];
	const requestedPathspecs = requestedFiles
		.map((file) => path.relative(directory, file).replace(/\\/g, '/'))
		.filter(
			(file) => file.length > 0 && file !== '..' && !file.startsWith('../'),
		);
	// #3681 item 2: `:(literal)` argv decoration parity with the ambiguity
	// consumer's literalPathspecs (#3092 PRR-005). Plain pathspecs let Git
	// glob-expand a bracket/brace filename (requesting `app/a[b].ts` also
	// admitted `app/ab.ts`, whose findings then read as NEW without the
	// caller requesting that file). The RAW relative paths stay the map
	// keys and the requestedKeys prefix logic below — decoration is applied
	// ONLY at argv construction.
	const literalPathspecs = requestedPathspecs.map(
		(file) => `:(literal)${file}`,
	);
	const statusArgs = [
		'-c',
		'core.quotePath=false',
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
		...(requestedPathspecs.length > 0 ? ['--ignored=matching'] : []),
		...(literalPathspecs.length > 0 ? ['--', ...literalPathspecs] : []),
	];
	// #3131: the committed leg was already acquired and parsed by
	// resolveValidatedDiffBase (it IS the validation), so only the staged,
	// unstaged, and status legs run here.
	const [staged, unstaged, status] = await Promise.all([
		runGit(
			[...commonDiffArgs, '--cached', 'HEAD', '--'],
			directory,
			abortSignal,
		),
		runGit([...commonDiffArgs, '--'], directory, abortSignal),
		runGit(statusArgs, directory, abortSignal),
	]);
	if (staged === null || unstaged === null || status === null) {
		// REL-4: the base-resolution failure is loud; keep the leg failure
		// from being the only silent fail-closed path (debug-gated — the
		// operator-facing criticalWarn channel is reserved for must-act-on).
		warn(
			'pre-check: a staged/unstaged/status git leg failed — changed-line classification is fail-closed (all findings treated as new)',
		);
		return null;
	}

	const stagedLines = parseDiffLineRangesChecked(staged, true);
	const unstagedLines = parseDiffLineRangesChecked(unstaged, true);
	if (!stagedLines || !unstagedLines) {
		warn(
			'pre-check: a staged/unstaged diff could not be parsed — changed-line classification is fail-closed (all findings treated as new)',
		);
		return null;
	}

	const result = new Map<string, Set<number>>();
	mergeChangedLines(result, committedLines);
	mergeChangedLines(result, stagedLines);
	mergeChangedLines(result, unstagedLines);
	const untracked = parseUntrackedStatus(status);
	if (untracked === null) return null;
	const requestedKeys = requestedPathspecs.map(normalizeRepoPathKey);
	for (const file of untracked) {
		result.set(file, new Set([ALL_LINES_CHANGED]));
		// With --ignored=matching Git reports an ignored directory (for example
		// `!! generated/`) instead of an explicitly requested descendant. Mark
		// only the caller's exact requested files beneath that record as changed;
		// otherwise a finding in an ignored file can be misclassified as old.
		if (file.endsWith('/')) {
			for (const requestedFile of requestedKeys) {
				if (requestedFile.startsWith(file)) {
					result.set(requestedFile, new Set([ALL_LINES_CHANGED]));
				}
			}
		}
	}
	return result;
}

/**
 * Classify SAST findings as "new" (on changed lines) or "pre-existing" (unchanged lines).
 * A finding is "new" if its file+line intersects the changed line ranges from git diff.
 * If line ranges cannot be determined (git unavailable), all findings are treated as new (fail-closed).
 */
export function classifySastFindings(
	findings: SastScanFinding[],
	changedLineRanges: Map<string, Set<number>> | null,
	directory: string,
): { newFindings: SastScanFinding[]; preexistingFindings: SastScanFinding[] } {
	// Fail-closed: if we can't determine changed lines, treat all as new
	if (!changedLineRanges) {
		return { newFindings: findings, preexistingFindings: [] };
	}

	const newFindings: SastScanFinding[] = [];
	const preexistingFindings: SastScanFinding[] = [];
	const platform = _internals.platform();
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const resolvedDirectory = pathApi.resolve(directory);

	for (const finding of findings) {
		const filePath = finding.location.file;
		let normalised: string;
		try {
			if (
				typeof filePath !== 'string' ||
				filePath.length === 0 ||
				filePath.includes('\0')
			) {
				newFindings.push(finding);
				continue;
			}
			const resolvedFinding = pathApi.isAbsolute(filePath)
				? pathApi.resolve(filePath)
				: pathApi.resolve(resolvedDirectory, filePath);
			const relative = pathApi.relative(resolvedDirectory, resolvedFinding);
			if (
				pathApi.isAbsolute(relative) ||
				relative === '..' ||
				relative.startsWith(`..${pathApi.sep}`)
			) {
				newFindings.push(finding);
				continue;
			}
			normalised = normalizeRepoPathKey(relative);
		} catch {
			newFindings.push(finding);
			continue;
		}

		const changedLines = changedLineRanges.get(normalised);
		if (
			changedLines?.has(ALL_LINES_CHANGED) ||
			changedLines?.has(finding.location.line)
		) {
			newFindings.push(finding);
		} else {
			preexistingFindings.push(finding);
		}
	}

	return { newFindings, preexistingFindings };
}

/**
 * Classify secret findings as "new" (on coder-changed lines) or "pre-existing"
 * (unchanged lines) for the diff-scoped secretscan gate (#3092).
 *
 * Strictly fail-closed — unlike `classifySastFindings`, whose missing-key and
 * empty-set arms deliberately read as pre-existing (pinned by
 * tests/unit/tools/pre-check-batch-sast-preexisting.test.ts), a secret
 * finding is PRE-EXISTING only when EVERY condition holds:
 *
 *   - the changed-line map is non-null,
 *   - the finding's normalized repo-relative key is present in the map,
 *   - the file's changed-line set is non-empty,
 *   - the set does not carry the ALL_LINES_CHANGED sentinel (a fully-changed
 *     file makes every finding new), and
 *   - the finding's line is a safe positive integer and NOT a member of the
 *     changed set — the secret sits on a line the coder did not touch.
 *
 * Everything else is NEW: null map, missing key, empty set, ALL-set, a line
 * that IS a changed line, unresolvable / zero / negative / non-integer lines,
 * malformed or root-escaping paths, and any resolution error. Never throws —
 * a failure to resolve classifies the finding as NEW.
 */
export function classifySecretFindings(
	findings: SecretFinding[],
	changedLineRanges: Map<string, Set<number>> | null,
	directory: string,
	/**
	 * #3092: files whose changed-line evidence mixes more than one Git hop
	 * (`getChangedLineAmbiguousFiles`). Findings in these files classify as
	 * NEW — the unioned map's line numbers for them are not in worktree
	 * coordinates, so non-membership cannot prove a line untouched.
	 */
	ambiguousFiles?: Set<string>,
): { newFindings: SecretFinding[]; preexistingFindings: SecretFinding[] } {
	// Fail-closed: if we can't determine changed lines, treat all as new
	if (!changedLineRanges) {
		return { newFindings: findings, preexistingFindings: [] };
	}

	const newFindings: SecretFinding[] = [];
	const preexistingFindings: SecretFinding[] = [];
	const platform = _internals.platform();
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const resolvedDirectory = pathApi.resolve(directory);

	for (const finding of findings) {
		const filePath = finding.path;
		const line = finding.line;
		if (
			typeof filePath !== 'string' ||
			filePath.length === 0 ||
			filePath.includes('\0') ||
			typeof line !== 'number' ||
			!Number.isSafeInteger(line) ||
			line < 1
		) {
			newFindings.push(finding);
			continue;
		}
		let changedLines: Set<number> | undefined;
		try {
			const resolvedFinding = pathApi.isAbsolute(filePath)
				? pathApi.resolve(filePath)
				: pathApi.resolve(resolvedDirectory, filePath);
			const relative = pathApi.relative(resolvedDirectory, resolvedFinding);
			if (
				pathApi.isAbsolute(relative) ||
				relative === '..' ||
				relative.startsWith(`..${pathApi.sep}`)
			) {
				newFindings.push(finding);
				continue;
			}
			const normalised = normalizeRepoPathKey(relative);
			if (ambiguousFiles?.has(normalised)) {
				// Multi-hop file: map coordinates are not scanner coordinates.
				newFindings.push(finding);
				continue;
			}
			changedLines = changedLineRanges.get(normalised);
		} catch {
			newFindings.push(finding);
			continue;
		}
		if (
			changedLines !== undefined &&
			changedLines.size > 0 &&
			!changedLines.has(ALL_LINES_CHANGED) &&
			!changedLines.has(line)
		) {
			preexistingFindings.push(finding);
		} else {
			newFindings.push(finding);
		}
	}

	return { newFindings, preexistingFindings };
}

/**
 * Run all 4 pre-check tools in parallel with concurrency limit
 * @param input - The pre-check batch input
 * @param workspaceDir - Optional workspace directory for traversal validation (injected project root from createSwarmTool, or input.directory)
 */
export async function runPreCheckBatch(
	input: PreCheckBatchInput,
	workspaceDir?: string,
	contextDir?: string,
	abortSignal?: AbortSignal,
): Promise<PreCheckBatchResult> {
	// Batch scope for the shared diff-base memo (FB-003): the two consumers
	// run back-to-back inside THIS batch; a fresh batch re-walks so a fetch
	// that moved candidate refs between batches is honored.
	diffBaseResolutionMemo = null;
	// Use provided workspaceDir or fall back to input directory, then plugin context directory
	const effectiveWorkspaceDir = (workspaceDir ||
		input.directory ||
		contextDir) as string;
	const {
		files,
		directory,
		sast_threshold = 'medium',
		gates: gatesOverrides,
		phase,
		sast_enabled = true,
	} = input;
	// Legacy direct callers may still carry the parsed gates on `input.config`;
	// the tool boundary supplies the user-written overrides via `input.gates`
	// (issue #2524). The fallback narrows to the ONLY slices this module
	// consumes (sast_scan.enabled, quality_budget) so a parsed config's
	// Zod-materialized default lists can never masquerade as user intent for
	// the sections the wrappers forward elsewhere.
	const gates =
		gatesOverrides ??
		(input.config?.gates
			? {
					sast_scan: input.config.gates.sast_scan,
					quality_budget: input.config.gates.quality_budget,
				}
			: undefined);

	// Validate directory
	const dirError = validateDirectory(directory, effectiveWorkspaceDir);
	if (dirError) {
		warn(`pre_check_batch: Invalid directory: ${dirError}`);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: dirError, duration_ms: 0 },
			secretscan: { ran: false, error: dirError, duration_ms: 0 },
			sast_scan: { ran: false, error: dirError, duration_ms: 0 },
			quality_budget: { ran: false, error: dirError, duration_ms: 0 },
			total_duration_ms: 0,
		};
	}

	// Early fail-closed check: if no files provided at all, fail immediately
	if (!files || files.length === 0) {
		warn(
			'pre_check_batch: No files provided, skipping all tools (fail-closed)',
		);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: 'No files provided', duration_ms: 0 },
			secretscan: { ran: false, error: 'No files provided', duration_ms: 0 },
			sast_scan: { ran: false, error: 'No files provided', duration_ms: 0 },
			quality_budget: {
				ran: false,
				error: 'No files provided',
				duration_ms: 0,
			},
			total_duration_ms: 0,
		};
	}

	// Determine files to check
	// If files are provided, use them; otherwise scan directory for changed files
	// For simplicity in batch mode, we'll scan the entire directory
	const changedFiles: string[] = [];
	// #2918: the gate's request basis is the RAW declared count, captured
	// BEFORE the validation drop loop below — a dropped entry (invalid path,
	// non-string) keeps requested_files above the policy-skip counter, so the
	// vacuous-coverage predicate can never be satisfied over a laundered batch.
	const rawDeclaredCount = files.length;

	// Validate each file path
	for (const file of files) {
		// Hardened: Explicit type guard for non-string entries fail-closed
		if (typeof file !== 'string') {
			warn(`pre_check_batch: Non-string file entry rejected: ${String(file)}`);
			continue;
		}
		const fileError = validatePath(file, directory, effectiveWorkspaceDir);
		if (fileError) {
			warn(`pre_check_batch: Invalid file path: ${file}`);
			continue;
		}
		changedFiles.push(path.resolve(directory, file));
	}

	// Early return if no valid files after validation
	if (changedFiles.length === 0) {
		warn(
			'pre_check_batch: No valid files after validation, skipping all tools (fail-closed)',
		);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: 'No files provided', duration_ms: 0 },
			secretscan: { ran: false, error: 'No files provided', duration_ms: 0 },
			sast_scan: { ran: false, error: 'No files provided', duration_ms: 0 },
			quality_budget: {
				ran: false,
				error: 'No files provided',
				duration_ms: 0,
			},
			total_duration_ms: 0,
		};
	}

	// #2209: fail fast when the directory is not a valid project root for
	// evidence writes. isAcceptedProjectRootForPlatform's equality branch
	// (directory === workspaceDir — the CLI-invoked-from-a-subdirectory case)
	// bypasses the explicit-boundary check, so a boundary-less subdirectory of
	// an existing Swarm project used to pass validation above and surface the
	// violation only at evidence-write time — inconsistently (secretscan
	// swallowed it; sast_scan/quality_budget failed). assertProjectRoot is the
	// same invariant the evidence writers enforce (reused, unmodified): a
	// directory with its own boundary marker passes, a standalone directory
	// with no `.swarm`-bearing ancestor passes, and a subdirectory nested
	// under a `.swarm/`-owning project root throws — still BEFORE any tool
	// executes (this runs after the no-files fail-closed checks so their
	// distinct 'No files provided' contract is preserved).
	try {
		assertProjectRoot(directory);
	} catch (error) {
		const rootError = error instanceof Error ? error.message : String(error);
		warn(`pre_check_batch: Project-root validation failed: ${rootError}`);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: rootError, duration_ms: 0 },
			secretscan: { ran: false, error: rootError, duration_ms: 0 },
			sast_scan: { ran: false, error: rootError, duration_ms: 0 },
			quality_budget: { ran: false, error: rootError, duration_ms: 0 },
			total_duration_ms: 0,
		};
	}

	// Limit files to prevent abuse
	if (changedFiles.length > MAX_FILES) {
		throw new Error(
			`Input exceeds maximum file count: ${changedFiles.length} > ${MAX_FILES}`,
		);
	}

	// Run all tools in parallel with concurrency limit
	const limit = pLimit(MAX_CONCURRENT);
	// Config kill switch composes as AND with the QA-profile value: a user's
	// `gates.sast_scan.enabled: false` skips SAST through the SAME
	// `{ran:false}` + `sast_skipped:true` branch the profile disable uses, so
	// downstream consumers see one shape for "did not run" (issue #2524).
	const sastDisabledByConfig = gates?.sast_scan?.enabled === false;

	const [lintResult, secretscanResult, sastScanResult, qualityBudgetResult] =
		await Promise.all([
			limit(() =>
				_internals.runLintWrapped(changedFiles, directory, gates, abortSignal),
			),
			limit(() =>
				_internals.runSecretscanWrapped(
					changedFiles,
					directory,
					gates,
					abortSignal,
					rawDeclaredCount,
				),
			),
			sast_enabled && !sastDisabledByConfig
				? limit(() =>
						_internals.runSastScanWrapped(
							changedFiles,
							directory,
							sast_threshold,
							gates,
							phase,
							abortSignal,
						),
					)
				: Promise.resolve<ToolResult<SastScanResult>>({
						ran: false,
						duration_ms: 0,
					}),
			limit(() =>
				_internals.runQualityBudgetWrapped(
					changedFiles,
					directory,
					gates,
					abortSignal,
				),
			),
		]);

	// Calculate total duration
	const totalDuration =
		lintResult.duration_ms +
		secretscanResult.duration_ms +
		sastScanResult.duration_ms +
		qualityBudgetResult.duration_ms;

	// Determine gates_passed:
	// - Security tools (secretscan, sast_scan) are HARD GATES - failures block merging
	// - Quality tools (lint, quality_budget) are informational only - do NOT block gates_passed
	let gatesPassed = true;

	// Check lint (informational only - does NOT block gates_passed)
	if (lintResult.ran && lintResult.result) {
		const lintRes = lintResult.result;
		if ('success' in lintRes && lintRes.success === false) {
			warn('pre_check_batch: Lint found issues (informational only)');
		}
	} else if (lintResult.error) {
		warn(
			`pre_check_batch: Lint error (informational only): ${lintResult.error}`,
		);
	}

	// Check secretscan (hard gate - MUST pass)
	// #2918: request basis is the raw declared count (pre-drop), matching the
	// scan result's requested_files — not the post-drop changedFiles.length.
	//
	// #3092: the gate is diff-scoped — findings classify as new (coder-changed
	// lines) vs pre-existing (unchanged lines) against the SAME changed-line
	// map producer the SAST legacy arm consumes. The map is computed lazily
	// ONCE per batch through the `_internals.getChangedLineRanges` seam (so
	// test overrides keep controlling both arms), and only when a consumer
	// needs it (secretscan found something, or SAST legacy-mode gate findings
	// exist).
	let changedLineRangesMemo: Map<string, Set<number>> | null | undefined;
	const getChangedLineRangesMemoized = async (): Promise<Map<
		string,
		Set<number>
	> | null> => {
		if (changedLineRangesMemo === undefined) {
			changedLineRangesMemo = await _internals.getChangedLineRanges(
				directory,
				abortSignal,
				changedFiles,
			);
		}
		return changedLineRangesMemo;
	};
	let secretscanClassification: SecretscanClassification | undefined;
	let secretscanPreexistingFindings: SecretFinding[] | undefined;
	const secretscanScanFindings =
		secretscanResult.ran &&
		secretscanResult.result &&
		!('error' in secretscanResult.result)
			? secretscanResult.result.findings
			: [];
	if (secretscanScanFindings.length > 0) {
		const changedLineRanges = await getChangedLineRangesMemoized();
		// #3092 fail-closed: findings in files whose changed-line evidence
		// mixes Git hops (coordinate mismatch vs scanner worktree lines) are
		// NEW; if the ambiguity source is unavailable, NOTHING gets the
		// pre-existing discount — no classification runs at all, so no
		// finding is carried as pre-existing or announced as non-gating.
		const ambiguousFiles = await _internals.getChangedLineAmbiguousFiles(
			directory,
			abortSignal,
			changedFiles,
		);
		if (ambiguousFiles === null) {
			secretscanClassification = {
				newFindings: secretscanScanFindings,
				preexistingFindings: [],
				// #3128 review PRR-023: no classification ran in this arm, so no
				// finding was ever tested against the map — report the scan as
				// not diff-scoped rather than implying a discount was earned.
				diffScoped: false,
			};
		} else {
			const { newFindings, preexistingFindings } = classifySecretFindings(
				secretscanScanFindings,
				changedLineRanges,
				directory,
				ambiguousFiles,
			);
			secretscanClassification = {
				newFindings,
				preexistingFindings,
				diffScoped: changedLineRanges !== null,
			};
			if (preexistingFindings.length > 0) {
				secretscanPreexistingFindings = preexistingFindings;
				warn(
					`pre_check_batch: Secretscan found ${preexistingFindings.length} pre-existing secret finding(s) on unchanged lines - visible, non-gating, passed to reviewer for triage`,
				);
			}
		}
	}
	const secretscanDecision = evaluateSecretscanGate(
		secretscanResult,
		rawDeclaredCount,
		secretscanClassification,
	);
	if (!secretscanDecision.passed) {
		gatesPassed = false;
		warn(`pre_check_batch: ${secretscanDecision.summary} - GATE FAILED`);
	}

	// v6.33: Persist secretscan results to evidence bundle
	if (secretscanResult.ran || secretscanResult.error) {
		try {
			const scanResult = secretscanDecision.result;
			const secretscanEvidence: SecretscanEvidence = {
				task_id: 'secretscan',
				type: 'secretscan',
				timestamp: new Date().toISOString(),
				agent: 'pre_check_batch',
				verdict: secretscanDecision.passed ? 'pass' : 'fail',
				summary: secretscanDecision.summary,
				findings_count: secretscanDecision.findingsCount,
				scan_directory: scanResult?.scan_dir ?? directory,
				files_scanned: scanResult?.files_scanned ?? 0,
				skipped_files: scanResult?.skipped_files ?? 0,
				// #3107 feedback: audit signal for ignore-file suppressions
				// (diagnosability only — never part of the vacuous predicate).
				ignored_files: scanResult?.ignored_files ?? 0,
				// #2918: vacuous-coverage predicate inputs for downstream
				// consumers (decoder parity, check_gate_status, stage-a-repair).
				// Missing on legacy evidence ⇒ non-vacuous ⇒ previous behavior.
				policy_skipped_files: scanResult?.policy_skipped_files ?? 0,
				requested_files: scanResult?.requested_files ?? rawDeclaredCount,
				// #3092: diff-scoped classification counters, emitted on EVERY
				// evidence write that has a scan result (0 when classification
				// did not run) so downstream fallbacks never degrade a
				// zero-new pass back onto the pre-fix total-findings wedge.
				new_findings_count: secretscanDecision.newFindingsCount ?? 0,
				preexisting_findings_count:
					secretscanDecision.preexistingFindingsCount ?? 0,
				diff_scoped: secretscanDecision.diffScoped ?? false,
				incomplete_files: scanResult?.incomplete_files ?? changedFiles.length,
				incomplete_paths: scanResult?.incomplete_paths ?? [
					{ path: '.', reason: 'missing_coverage_metadata' },
				],
			};
			await _internals.saveEvidence(
				directory,
				'secretscan',
				secretscanEvidence,
				abortSignal,
			);
		} catch (e) {
			// #2209: an evidence persistence failure is a runtime-state failure
			// and must fail the scan identically to sast_scan/quality_budget
			// (whose saveEvidence errors propagate into their ToolResult.error
			// and hard-fail the gate). The gate evaluation above already ran on
			// the clean scan result, so fail the gate directly here and surface
			// the error on the payload.
			const persistError = `Failed to persist secretscan evidence: ${
				e instanceof Error ? e.message : String(e)
			}`;
			secretscanResult.error = persistError;
			gatesPassed = false;
			warn(`pre_check_batch: ${persistError} - GATE FAILED`);
		}
	}

	// Check SAST scan (hard gate with pre-existing finding classification)
	let sastPreexistingFindings: SastScanFinding[] | undefined;
	let sastDegraded = false;
	if (sastScanResult.ran && sastScanResult.result) {
		const sastResult = sastScanResult.result;

		if (sastResult.error) {
			if (
				sastResult.failure_kind === 'semgrep_process_exit' &&
				sastResult.findings.length === 0
			) {
				sastDegraded = true;
				warn(
					`pre_check_batch: SAST coverage degraded (${sastResult.error}) - continuing without a gate failure`,
				);
			} else {
				gatesPassed = false;
				warn(
					`pre_check_batch: SAST scan error (${sastResult.error}) - GATE FAILED`,
				);
			}
		} else if (sastResult.baseline_used) {
			// Baseline diff mode: verdict is driven ONLY by new_findings in sastScan.
			// Populate reviewer triage with pre_existing_findings and moved findings
			// (reflow-matched: same finding at a new position/window, #2302) — both
			// are known pre-existing debt and never gate. Use sast_threshold as
			// triage filter so mediums are not silently dropped when threshold is
			// 'medium' or lower.
			const sastCarryFindings = [
				...(sastResult.pre_existing_findings ?? []),
				...(sastResult.moved_findings ?? []),
			];
			if (sastCarryFindings.length > 0) {
				sastPreexistingFindings = sastCarryFindings.filter((f) =>
					meetsThresholdForTriage(f.severity, sast_threshold),
				);
				if (sastPreexistingFindings.length > 0) {
					warn(
						`pre_check_batch: SAST baseline diff found ${sastPreexistingFindings.length} pre-existing/moved finding(s) - passing to reviewer for triage`,
					);
				}
			}
			// Verdict is already correctly set by sastScan — do not override.
			// (#2210 note: a result carrying `error` was already consumed by the
			// `if (sastResult.error)` branch above, so this branch is by
			// construction the findings-driven case.)
			if (sastResult.verdict === 'fail') {
				gatesPassed = false;
				warn(
					'pre_check_batch: SAST scan found new findings above threshold - GATE FAILED',
				);
			}
		} else if (sastResult.verdict === 'fail') {
			// Legacy mode (no baseline): classify HIGH/CRITICAL findings by changed lines
			const gateFindings = sastResult.findings.filter((f) =>
				GATE_SEVERITIES.has(f.severity),
			);

			if (gateFindings.length > 0) {
				// #3092: reads through the batch-lazy memo (same seam as the
				// secretscan arm) so the map is computed at most once and
				// `_internals.getChangedLineRanges` overrides steer both arms.
				//
				// #3128 review PRR-023 (documented asymmetry): the SAST arm does
				// NOT receive the multi-hop ambiguity set — its missing-key and
				// empty-set arms intentionally read as PRE-EXISTING (pinned by
				// tests/unit/tools/pre-check-batch-sast-preexisting.test.ts), so
				// the same staged/committed line-shift coordinate mismatch fixed
				// for secrets remains live for SAST. Do not widen this arm
				// without re-adjudicating those pins.
				const changedLineRanges = await getChangedLineRangesMemoized();
				const { newFindings, preexistingFindings } = classifySastFindings(
					gateFindings,
					changedLineRanges,
					directory,
				);

				if (newFindings.length > 0) {
					// New findings on changed lines → hard block
					gatesPassed = false;
					warn(
						`pre_check_batch: SAST scan found ${newFindings.length} new HIGH/CRITICAL finding(s) on changed lines - GATE FAILED`,
					);
				} else if (preexistingFindings.length > 0) {
					// All HIGH/CRITICAL findings are pre-existing on unchanged lines
					// Do NOT block coder — carry findings forward for reviewer triage
					sastPreexistingFindings = preexistingFindings;
					warn(
						`pre_check_batch: SAST scan found ${preexistingFindings.length} pre-existing HIGH/CRITICAL finding(s) on unchanged lines - passing to reviewer for triage`,
					);
				}
			} else {
				// SAST failed but no HIGH/CRITICAL findings (lower severity only)
				// Original behavior: fail the gate. (#2210 note: a result carrying
				// `error` was already consumed by the `if (sastResult.error)`
				// branch above.)
				gatesPassed = false;
				warn('pre_check_batch: SAST scan found vulnerabilities - GATE FAILED');
			}
		}
	} else if (sastScanResult.error) {
		// Error in SAST - fail closed
		gatesPassed = false;
		warn(
			`pre_check_batch: SAST scan error - GATE FAILED: ${sastScanResult.error}`,
		);
	}

	// Check quality budget (informational only - does NOT block gates_passed)
	if (qualityBudgetResult.ran && qualityBudgetResult.result) {
		if (qualityBudgetResult.result.verdict === 'fail') {
			warn('pre_check_batch: Quality budget exceeded (informational only)');
		}
	} else if (qualityBudgetResult.error) {
		warn(
			`pre_check_batch: Quality budget error (informational only): ${qualityBudgetResult.error}`,
		);
	}

	// Build result
	const result: PreCheckBatchResult = {
		batch_status: [
			lintResult,
			secretscanResult,
			sastScanResult,
			qualityBudgetResult,
		].every((toolResult) => toolResult.ran === false)
			? 'skipped'
			: 'completed',
		gates_passed: gatesPassed,
		lint: lintResult,
		secretscan: secretscanResult,
		sast_scan: sastScanResult,
		quality_budget: qualityBudgetResult,
		total_duration_ms: Math.round(totalDuration),
		...(sastDegraded && { sast_degraded: true }),
		...((!sast_enabled || sastDisabledByConfig) && { sast_skipped: true }),
		...(sastPreexistingFindings &&
			sastPreexistingFindings.length > 0 && {
				sast_preexisting_findings: sastPreexistingFindings,
			}),
		// #3092: pre-existing secret findings (visible, non-gating) — reviewer
		// triage input and the decoder's diff-scope proof.
		...(secretscanPreexistingFindings &&
			secretscanPreexistingFindings.length > 0 && {
				secretscan_preexisting_findings: secretscanPreexistingFindings,
			}),
	};

	return result;
}

// ============ Tool Definition ============

/**
 * Pre-check batch tool - runs 4 verification tools in parallel
 * Returns unified result with gates_passed status
 */
export const pre_check_batch: ReturnType<typeof tool> = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Run multiple verification tools in parallel: lint, secretscan, SAST scan, and quality budget. Returns unified result with gates_passed status. Security findings and incomplete SAST runs are hard failures; a Semgrep nonzero process exit with zero findings is returned as explicit sast_degraded coverage and does not block.',
	args: {
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Specific files to check (optional, scans directory if not provided)',
			),
		directory: z
			.string()
			.describe(
				'Project root directory — ordinary workspace subdirectories are rejected; direct .git or .opencode project boundaries are accepted',
			),
		sast_threshold: z
			.enum(['low', 'medium', 'high', 'critical'])
			.optional()
			.describe(
				'Minimum severity for SAST findings to cause failure (default: medium)',
			),
		phase: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				'Current phase number (positive integer >= 1). When provided, enables SAST baseline diffing: only findings absent from the phase-scoped baseline fail the gate.',
			),
	},
	async execute(args: unknown, directory: string, ctx): Promise<string> {
		// Validate arguments
		if (!args || typeof args !== 'object') {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				secretscan: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				sast_scan: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				quality_budget: {
					ran: false,
					error: 'Invalid arguments',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		if (
			!directory ||
			typeof directory !== 'string' ||
			directory.trim() === ''
		) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				secretscan: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				sast_scan: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				quality_budget: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		const typedArgs = args as PreCheckBatchInput;

		if (!typedArgs.directory) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: 'directory is required', duration_ms: 0 },
				secretscan: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				sast_scan: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				quality_budget: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		// Resolve directory to absolute path first to ensure consistent behavior
		// This handles cases where path.isAbsolute may not detect Windows paths correctly
		const resolvedDirectory = path.resolve(typedArgs.directory);

		// Determine workspace anchor: use the injected project root (directory parameter)
		// rather than the user-supplied arg value, to prevent self-validation bypass
		const workspaceAnchor = path.resolve(directory);

		// Reject subdirectory: if arg resolves inside project root, hard-reject
		if (
			isStrictPathDescendant(resolvedDirectory, workspaceAnchor) &&
			!hasExplicitProjectBoundary(resolvedDirectory)
		) {
			const subDirError = `directory "${typedArgs.directory}" is a subdirectory of the project root — pre_check_batch requires the project root directory "${workspaceAnchor}"`;
			const subDirResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: subDirError, duration_ms: 0 },
				secretscan: { ran: false, error: subDirError, duration_ms: 0 },
				sast_scan: { ran: false, error: subDirError, duration_ms: 0 },
				quality_budget: { ran: false, error: subDirError, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(subDirResult);
		}

		// Validate directory using the resolved path against the true workspace anchor
		const dirError = validateDirectory(resolvedDirectory, workspaceAnchor);
		if (dirError) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: dirError, duration_ms: 0 },
				secretscan: { ran: false, error: dirError, duration_ms: 0 },
				sast_scan: { ran: false, error: dirError, duration_ms: 0 },
				quality_budget: { ran: false, error: dirError, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		// Run pre-check batch
		try {
			let sastEnabled = true;
			try {
				const preamble = await _internals.resolveGatePreamble(
					resolvedDirectory,
					ctx?.sessionID,
				);
				if (preamble.resolved && preamble.effectiveGates) {
					sastEnabled = preamble.effectiveGates.sast_enabled;
				}
			} catch {
				warn(
					'pre_check_batch: QA-gate profile resolution failed; keeping SAST enabled',
				);
			}
			const rawPhase = (typedArgs as unknown as Record<string, unknown>).phase;
			const safePhase =
				typeof rawPhase === 'number' &&
				Number.isInteger(rawPhase) &&
				rawPhase >= 1
					? rawPhase
					: undefined;

			const result = await _internals.runPreCheckBatch(
				{
					files: typedArgs.files,
					directory: resolvedDirectory,
					sast_threshold: typedArgs.sast_threshold,
					config: typedArgs.config,
					gates: _internals.loadGateOverrides(resolvedDirectory),
					phase: safePhase,
					sast_enabled: sastEnabled,
				},
				workspaceAnchor,
				directory,
				ctx?.abort,
			);

			return serializePreCheckResult(result);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error';
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: errorMessage, duration_ms: 0 },
				secretscan: { ran: false, error: errorMessage, duration_ms: 0 },
				sast_scan: { ran: false, error: errorMessage, duration_ms: 0 },
				quality_budget: { ran: false, error: errorMessage, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}
	},
});
