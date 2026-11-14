import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { coreEventsFilePath, readCoreEvents } from '../events/core-events.js';
import { readPrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import {
	type RenderReviewBodyInput,
	renderPrReviewSubmissionBody,
} from '../pr-review/render-review-body.js';
import { readVerdictSettlementReceipt } from '../pr-review/verdict-settlement.js';
import { atomicWriteSwarmFile } from '../utils/atomic-write.js';
import type {
	ExternalToolRunOptions,
	ExternalToolRunResult,
} from '../utils/external-tool-runner.js';
import { runExternalTool } from '../utils/external-tool-runner.js';
import { createSwarmTool } from './create-tool.js';
import { resolveGhBinary } from './gh-evidence.js';

/**
 * Controller-mediated, head-bound PR review submission (issue #3096, Workstream
 * C PR 1/2).
 *
 * Submits a SETTLED PR-review run to GitHub through the PR Review API
 * (`POST repos/<owner>/<repo>/pulls/<n>/reviews`), bound to the run's exact
 * `pr_head_sha` (`commit_id` pinning) with inline comments for findings that
 * carry file:line evidence.
 *
 * Authorization (fail-closed ladder, additive to every existing settlement and
 * gate path): refuses while any PR-workflow gate is active for the session
 * (submission opens only after `complete_pr_workflow` clears the gate), refuses
 * when the workflow for this head was aborted at/after the run's settlement
 * time, refuses unless the trigger-eval receipt and every findings record bind
 * to the declared head with at least one post_critic settlement record, and is
 * architect-only (no child-lane exposure). Disclosed residuals: a crashed
 * (never aborted, never completed) run with settled artifacts still passes, and
 * a submission invoked from a different session than the workflow session is
 * not caught by the session-scoped abort match.
 */

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const GH_MAX_STDERR_BYTES = 128 * 1024;

const PR_HEAD_SHA_PATTERN = /^[0-9a-f]{6,64}$/i;
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

interface SubmissionFailure {
	success: false;
	blocked?: boolean;
	type:
		| 'invalid-args'
		| 'gate-active'
		| 'gate-indeterminate'
		| 'aborted'
		| 'aborted-indeterminate'
		| 'head-mismatch'
		| 'not-settled'
		| 'nothing-new'
		| 'gh-not-found'
		| 'transport-failed'
		| 'payload-write-failed';
	message: string;
}

function failure(
	type: SubmissionFailure['type'],
	message: string,
	blocked = false,
): string {
	const payload: SubmissionFailure = { success: false, type, message };
	if (blocked) payload.blocked = true;
	return JSON.stringify(payload, null, 2);
}

interface TriggerEvalReceipt {
	run_id?: unknown;
	pr_head_sha?: unknown;
	evaluated_at?: unknown;
	base_verification?: unknown;
	coverage_degradations?: unknown;
}

interface PersistedFindingRecord {
	finding_id?: unknown;
	status?: unknown;
	file_line?: unknown;
	evidence?: unknown;
	next_action?: unknown;
	severity?: unknown;
	order_agreement?: unknown;
	boundary?: unknown;
	pr_head_sha?: unknown;
	recorded_at?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readJsonFile(absolutePath: string): unknown {
	let raw: string;
	try {
		raw = fs.readFileSync(absolutePath, 'utf-8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/**
 * Single-return helper so the G2 evidence-class gate can fold the payload
 * write target; its throw is converted to the same typed refusal safePath
 * produces (PRR-015 contract).
 */
function payloadArtifactPath(directory: string, runId: string): string {
	return validateSwarmPath(
		directory,
		path.join('pr-review', runId, 'submission-payload.json'),
	);
}

/**
 * validateSwarmPath throws on traversal-shaped inputs (PRR-015 probe:
 * run_id 'a..' passes RUN_ID_PATTERN but throws here). Convert that throw
 * into a typed refusal instead of the generic execution_error envelope.
 */
function safePath(
	directory: string,
	relativePath: string,
): { path: string } | { refusal: string } {
	try {
		return { path: validateSwarmPath(directory, relativePath) };
	} catch (error) {
		return {
			refusal: failure(
				'invalid-args',
				`Invalid pr_review_submission args: artifact path rejected (${error instanceof Error ? error.message : String(error)})`,
				false,
			),
		};
	}
}

function readFindingsRecords(
	absolutePath: string,
): PersistedFindingRecord[] | null | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(absolutePath, 'utf-8');
	} catch {
		return undefined;
	}
	const records: PersistedFindingRecord[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsedLine: unknown;
		try {
			parsedLine = JSON.parse(trimmed) as unknown;
		} catch {
			return null;
		}
		const parsed = asRecord(parsedLine);
		if (parsed === null) return null;
		records.push(parsed);
	}
	return records;
}

/**
 * Settlement time = max(findings recorded_at, trigger receipt evaluated_at).
 * All writers emit isoNow()-style UTC strings, so a lexicographic ISO-8601
 * comparison is sound; a missing evaluated_at is tolerated (frozen-check
 * receipts omit it — real receipts always carry it).
 */
function settlementTime(
	records: readonly PersistedFindingRecord[],
	receipt: TriggerEvalReceipt,
): string {
	let latest = '';
	for (const record of records) {
		if (typeof record.recorded_at === 'string' && record.recorded_at > latest) {
			latest = record.recorded_at;
		}
	}
	if (
		typeof receipt.evaluated_at === 'string' &&
		receipt.evaluated_at > latest
	) {
		latest = receipt.evaluated_at;
	}
	return latest;
}

type AbortScanResult = 'aborted' | 'clean' | 'indeterminate';

function hasAbortAfterSettlement(
	directory: string,
	sessionID: string,
	headSha: string,
	settledAt: string,
): AbortScanResult {
	// Fail closed on an indeterminate read: the events file existing but
	// yielding no readable window, or a truncated tail, means an abort may be
	// invisible — "not aborted" would be a fail-open authorization decision
	// (review PRR-009).
	const eventsFileExists = fs.existsSync(coreEventsFilePath(directory));
	const read = readCoreEvents(directory);
	if (read.coverage === 'truncated') return 'indeterminate';
	if (!eventsFileExists) return 'clean';
	if (read.text.trim() === '') return 'indeterminate';
	for (const line of read.text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsedEvent: unknown;
		try {
			parsedEvent = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		const parsed = asRecord(parsedEvent);
		if (parsed === null) continue;
		if (parsed.type !== 'pr_workflow_aborted') continue;
		if (parsed.sessionID !== sessionID) continue;
		// A PR_FEEDBACK abort for the same session must not over-block a
		// PR_REVIEW submission; match only when the recorded mode is absent
		// (conservative) or is this tool's mode.
		if (typeof parsed.mode === 'string' && parsed.mode !== 'PR_REVIEW') {
			continue;
		}
		if (
			typeof parsed.prHeadSha !== 'string' ||
			parsed.prHeadSha.toLowerCase() !== headSha
		) {
			continue;
		}
		const timestamp = parsed.timestamp;
		if (typeof timestamp !== 'string') continue;
		// The retained-events window is a bounded tail read; an abort scrolled
		// out of the window escapes this narrowing (disclosed residual class —
		// same shape as the crashed-run residual).
		if (settledAt === '' || timestamp >= settledAt) return 'aborted';
	}
	return 'clean';
}

type CoverageDerivation =
	| { coverage: RenderReviewBodyInput['coverage'] }
	| { refusal: string };

function deriveCoverage(
	directory: string,
	runId: string,
	receipt: TriggerEvalReceipt,
): CoverageDerivation {
	const disclosurePath = safePath(
		directory,
		path.join('pr-review', runId, 'coverage-disclosure.json'),
	);
	if ('refusal' in disclosurePath) return { refusal: disclosurePath.refusal };
	const rawDisclosure = readJsonFile(disclosurePath.path);
	// A CORRUPT disclosure (parse failure) must not degrade into the stronger
	// "Coverage kind: FULL" claim on a public artifact — refuse instead
	// (review PRR-002 / ma-p3). A MISSING disclosure is normal (no partial
	// base coverage was admitted) and falls through to the receipt.
	if (rawDisclosure === null) {
		return {
			refusal: failure(
				'not-settled',
				`Invalid pr_review_submission state: coverage disclosure for run ${runId} is corrupt (.swarm/pr-review/${runId}/coverage-disclosure.json); refusing to claim coverage`,
				true,
			),
		};
	}
	const disclosure = asRecord(rawDisclosure);
	const dimensionNames: string[] = [];
	const unresolvedFromDisclosure = disclosure?.unresolvedDimensions;
	if (Array.isArray(unresolvedFromDisclosure)) {
		// V2 records are objects {dimension, terminalState, reasonKind, ...};
		// tolerate string entries for forward compatibility.
		for (const entry of unresolvedFromDisclosure) {
			const record = asRecord(entry);
			const name =
				typeof record?.dimension === 'string'
					? record.dimension
					: typeof entry === 'string'
						? entry
						: null;
			if (typeof name === 'string') dimensionNames.push(name);
		}
	}
	const missingDimension = disclosure?.missingDimension;
	if (
		dimensionNames.length === 0 &&
		typeof missingDimension === 'string' &&
		missingDimension !== ''
	) {
		// Legacy V1 singular record.
		dimensionNames.push(missingDimension);
	}
	if (dimensionNames.length > 0) {
		return {
			coverage: { kind: 'PARTIAL', unresolved_dimensions: dimensionNames },
		};
	}
	const degradations = Array.isArray(receipt.coverage_degradations)
		? receipt.coverage_degradations
		: [];
	const reasons: string[] = [];
	for (const entry of degradations) {
		const record = asRecord(entry);
		if (typeof record?.reason === 'string') {
			reasons.push(
				typeof record.trigger_id === 'string'
					? `${record.trigger_id}: ${record.reason}`
					: record.reason,
			);
		}
	}
	if (reasons.length > 0) {
		return {
			coverage: { kind: 'PARTIAL', unresolved_dimensions: reasons },
		};
	}
	// Issue #3101 (review PRR-012): an admitted N-of-M verdict settlement is
	// also a coverage degradation — a run that settled dead verdict lanes must
	// never render `Coverage kind: FULL` on a public surface. Any per-phase
	// receipt under this run with at least one disclosed row downgrades the
	// claim (over-disclosure is the safe direction here; the gate's full-cover
	// consumption stays stricter than this public echo).
	const settlementReasons: string[] = [];
	for (const phase of ['reviewer', 'critic'] as const) {
		const settlementRead = readVerdictSettlementReceipt(
			directory,
			runId,
			phase,
		);
		if (
			settlementRead.status === 'ok' &&
			settlementRead.receipt.runId === runId &&
			settlementRead.receipt.items.length > 0
		) {
			settlementReasons.push(
				`verdict-settlement (${phase}): ${settlementRead.receipt.items.length} liveness-dead item(s) disclosed by N-of-M settlement`,
			);
		}
	}
	if (settlementReasons.length > 0) {
		return {
			coverage: {
				kind: 'PARTIAL',
				unresolved_dimensions: [...reasons, ...settlementReasons],
			},
		};
	}
	return { coverage: { kind: 'FULL', unresolved_dimensions: [] } };
}

function reviewEventFor(records: readonly PersistedFindingRecord[]): string {
	const blocking = records.some((record) => {
		const severity =
			typeof record.severity === 'string'
				? record.severity.toUpperCase()
				: 'NONE';
		return BLOCKING_SEVERITIES.has(severity);
	});
	return blocking ? 'REQUEST_CHANGES' : 'COMMENT';
}

async function fetchExistingCommentBodies(
	executable: string,
	directory: string,
	repoSlug: string,
	prNumber: number,
): Promise<{ bodies: string[] } | { refusal: string }> {
	const endpoints = [
		`repos/${repoSlug}/pulls/${prNumber}/comments?per_page=100`,
		`repos/${repoSlug}/pulls/${prNumber}/reviews?per_page=100`,
	];
	const bodies: string[] = [];
	for (const endpoint of endpoints) {
		const run: ExternalToolRunResult = await _internals.runExternalTool({
			executable,
			args: ['api', endpoint],
			cwd: directory,
			timeoutMs: GH_TIMEOUT_MS,
			maxStdoutBytes: GH_MAX_STDOUT_BYTES,
			maxStderrBytes: GH_MAX_STDERR_BYTES,
		});
		if (run.status === 'timeout') {
			return {
				refusal: failure(
					'transport-failed',
					`gh api ${endpoint} timed out after ${GH_TIMEOUT_MS}ms; refusing to submit without dedupe context`,
					true,
				),
			};
		}
		if (run.status !== 'completed') {
			return {
				refusal: failure(
					'transport-failed',
					`gh api ${endpoint} failed to start (${run.message ?? run.status}); refusing to submit without dedupe context`,
					true,
				),
			};
		}
		if (run.exitCode !== 0) {
			return {
				refusal: failure(
					'transport-failed',
					`gh api ${endpoint} exited ${run.exitCode}: ${run.stderr.split('\n')[0] ?? ''}; refusing to submit without dedupe context`,
					true,
				),
			};
		}
		if (run.stdoutTruncated) {
			return {
				refusal: failure(
					'transport-failed',
					`gh api ${endpoint} stdout exceeded the ${GH_MAX_STDOUT_BYTES}-byte read cap; dedupe context would be silently incomplete — refusing to submit`,
					true,
				),
			};
		}
		// A healthy-but-non-array body degrades to an empty list for this
		// endpoint (proceed); real GitHub success responses are arrays.
		let parsed: unknown;
		try {
			parsed = JSON.parse(run.stdout) as unknown;
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		for (const entry of parsed) {
			const record = asRecord(entry);
			if (typeof record?.body === 'string' && record.body !== '') {
				bodies.push(record.body);
			}
		}
	}
	return { bodies };
}

export const _internals: {
	resolveGhBinary: () => string | null;
	runExternalTool: (
		options: ExternalToolRunOptions,
	) => Promise<ExternalToolRunResult>;
} = {
	resolveGhBinary,
	runExternalTool,
};

export async function executePrReviewSubmission(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	// Step 0 — validate inside execute: callers may bypass the createSwarmTool
	// schema (tests and direct CLI use), and every refusal must precede any
	// transport. Message form satisfies /pr_head_sha|Invalid/i on every arm.
	const raw = asRecord(args);
	if (raw === null) {
		return failure(
			'invalid-args',
			'Invalid pr_review_submission args: expected an object with pr_number, repo, run_id, pr_head_sha',
		);
	}
	if (
		typeof raw.pr_number !== 'number' ||
		!Number.isInteger(raw.pr_number) ||
		raw.pr_number <= 0
	) {
		return failure(
			'invalid-args',
			`Invalid pr_review_submission args: pr_number must be a positive integer (got ${JSON.stringify(raw.pr_number) ?? 'null'})`,
		);
	}
	if (
		typeof raw.repo !== 'string' ||
		!REPO_SLUG_PATTERN.test(raw.repo.trim())
	) {
		return failure(
			'invalid-args',
			`Invalid pr_review_submission args: repo must be an owner/name slug (got ${JSON.stringify(raw.repo) ?? 'null'})`,
		);
	}
	if (
		typeof raw.run_id !== 'string' ||
		!RUN_ID_PATTERN.test(raw.run_id.trim())
	) {
		return failure(
			'invalid-args',
			`Invalid pr_review_submission args: run_id must match ${RUN_ID_PATTERN.source} (got ${JSON.stringify(raw.run_id) ?? 'null'})`,
		);
	}
	if (
		typeof raw.pr_head_sha !== 'string' ||
		!PR_HEAD_SHA_PATTERN.test(raw.pr_head_sha.trim())
	) {
		return failure(
			'invalid-args',
			`Invalid pr_review_submission args: pr_head_sha must be 6-64 hex characters (got ${JSON.stringify(raw.pr_head_sha) ?? 'null'})`,
		);
	}
	const prNumber = raw.pr_number;
	const repoSlug = raw.repo.trim();
	const runId = raw.run_id.trim();
	const headSha = raw.pr_head_sha.trim().toLowerCase();

	const sessionID = context.sessionID?.trim();
	if (!sessionID) {
		return failure(
			'invalid-args',
			'Invalid pr_review_submission args: a session ID is required (controller-only surface)',
			true,
		);
	}

	// Step b — the gate must be cleared: submission opens only after
	// complete_pr_workflow clears it. Any surviving PR-workflow gate state for
	// this session (PR_REVIEW or PR_FEEDBACK, including recovery states) means
	// the gate is still active; completion deletes the state file.
	let gateState: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		gateState = await readPrWorkflowGateState(directory, sessionID);
	} catch (error) {
		// A corrupt/unreadable gate state is an indeterminate authorization
		// signal — fail closed with a typed refusal instead of the generic
		// execution_error envelope (review PRR-015).
		return failure(
			'gate-indeterminate',
			`BLOCKED: PR workflow gate state for this session could not be read safely (${error instanceof Error ? error.message : String(error)}); repair or abort the gate before submitting`,
			true,
		);
	}
	if (gateState !== null) {
		return failure(
			'gate-active',
			`BLOCKED: an active ${gateState.mode} gate exists for this session; the submission path opens only after complete_pr_workflow clears the gate`,
			true,
		);
	}

	// Read the run's durable artifacts (needed for the abort recency anchor and
	// the equality checks below). Missing/corrupt artifacts refuse.
	const receiptPath = safePath(
		directory,
		path.join('pr-review', runId, 'trigger-eval.json'),
	);
	if ('refusal' in receiptPath) return receiptPath.refusal;
	const receipt = asRecord(
		readJsonFile(receiptPath.path),
	) as TriggerEvalReceipt | null;
	if (receipt === null) {
		return failure(
			'not-settled',
			`Invalid pr_review_submission state: trigger evaluation receipt for run ${runId} is missing or unreadable (.swarm/pr-review/${runId}/trigger-eval.json)`,
			true,
		);
	}
	const recordPath = safePath(
		directory,
		path.join('pr-review', runId, 'findings.jsonl'),
	);
	if ('refusal' in recordPath) return recordPath.refusal;
	const records = readFindingsRecords(recordPath.path);
	if (!records) {
		return failure(
			'not-settled',
			`Invalid pr_review_submission state: findings artifact for run ${runId} is missing or corrupt (.swarm/pr-review/${runId}/findings.jsonl)`,
			true,
		);
	}

	// Step b2 — abort narrowing with a recency anchor: an abort at/after the
	// run's settlement time refuses (the settled run was aborted); an abort
	// before settlement belongs to an earlier run and does not block a later
	// re-run's submission (the documented abort-and-retry recovery flow). An
	// INDERTERMINATE read (existing events file, no readable window, or a
	// truncated tail) also refuses — "not aborted" would be fail-open.
	const abortScan = hasAbortAfterSettlement(
		directory,
		sessionID,
		headSha,
		settlementTime(records, receipt),
	);
	if (abortScan === 'indeterminate') {
		return failure(
			'aborted-indeterminate',
			`BLOCKED: the aborted-run scan for head ${headSha} could not be completed (events store unreadable or truncated); refusing to submit without a determinate authorization signal`,
			true,
		);
	}
	if (abortScan === 'aborted') {
		return failure(
			'aborted',
			`BLOCKED: the PR workflow for head ${headSha} was aborted at/after this run's settlement; aborted runs are out of scope (#3097)`,
			true,
		);
	}

	// Step c — head binding against the trigger receipt envelope.
	if (receipt.run_id !== runId) {
		return failure(
			'head-mismatch',
			`Invalid pr_review_submission state: trigger evaluation receipt run_id ${JSON.stringify(receipt.run_id) ?? 'null'} does not match the requested run ${runId}`,
			true,
		);
	}
	const receiptHead =
		typeof receipt.pr_head_sha === 'string'
			? receipt.pr_head_sha.trim().toLowerCase()
			: '';
	if (receiptHead === '' || receiptHead !== headSha) {
		return failure(
			'head-mismatch',
			`Invalid pr_review_submission state: pr_head_sha mismatch — trigger evaluation receipt for run ${runId} is bound to ${JSON.stringify(receipt.pr_head_sha) ?? 'null'}, not ${headSha}`,
			true,
		);
	}

	// Step d — settlement: at least one post_critic record and every record on
	// the declared head.
	const hasPostCritic = records.some(
		(record) => record.boundary === 'post_critic',
	);
	if (!hasPostCritic) {
		return failure(
			'not-settled',
			`Invalid pr_review_submission state: run ${runId} has no post_critic boundary record in findings.jsonl (run not settled)`,
			true,
		);
	}
	const mixedHead = records.some((record) => {
		const recordHead =
			typeof record.pr_head_sha === 'string'
				? record.pr_head_sha.trim().toLowerCase()
				: '';
		return recordHead !== headSha;
	});
	if (mixedHead) {
		return failure(
			'head-mismatch',
			`Invalid pr_review_submission state: pr_head_sha mismatch — findings.jsonl for run ${runId} contains records bound to a different head`,
			true,
		);
	}

	// PRR-001: findings.jsonl ACCUMULATES one record per finding per boundary
	// (post_explorer → post_reviewer → post_critic), so rendering all records
	// would publish superseded pre-critic versions and derive the event from
	// stale severities. Only post_critic records are the settled authoritative
	// view (the gate's exact-inventory enforcement guarantees every finding id
	// is present there), and DISPROVED records are not findings — drop them.
	const settledRecords = records.filter(
		(record) =>
			record.boundary === 'post_critic' && record.status !== 'DISPROVED',
	);

	// Issue #2906: a DISPROVED record is not published as a finding, but an
	// ORDER-UNSTABLE one still carries the counterbalancing signal (the
	// reviewer verdict flipped with presentation order) and must not vanish
	// with the drop. Those rows ride a separate renderer input so they are
	// listed and counted without entering the findings list or the derived
	// review event.
	const suppressedOrderUnstable = records.filter(
		(record) =>
			record.boundary === 'post_critic' &&
			record.status === 'DISPROVED' &&
			record.order_agreement === 'disagree',
	);

	const derived = deriveCoverage(directory, runId, receipt);
	if ('refusal' in derived) return derived.refusal;
	const coverage = derived.coverage;
	const event = reviewEventFor(settledRecords);
	const toRendererFinding = (record: (typeof records)[number]) => ({
		finding_id: typeof record.finding_id === 'string' ? record.finding_id : '',
		status: typeof record.status === 'string' ? record.status : '',
		file_line: typeof record.file_line === 'string' ? record.file_line : '',
		evidence: typeof record.evidence === 'string' ? record.evidence : '',
		next_action:
			typeof record.next_action === 'string' ? record.next_action : '',
		severity: typeof record.severity === 'string' ? record.severity : undefined,
		order_agreement:
			typeof record.order_agreement === 'string'
				? record.order_agreement
				: undefined,
	});
	const rendererInput: RenderReviewBodyInput = {
		run_id: runId,
		pr_head_sha: headSha,
		verdict: event,
		base_verification:
			typeof receipt.base_verification === 'string'
				? receipt.base_verification
				: undefined,
		coverage,
		order_unstable_suppressed: suppressedOrderUnstable.map(toRendererFinding),
		findings: settledRecords.map((record) => ({
			finding_id:
				typeof record.finding_id === 'string' ? record.finding_id : '',
			status: typeof record.status === 'string' ? record.status : '',
			file_line: typeof record.file_line === 'string' ? record.file_line : '',
			evidence: typeof record.evidence === 'string' ? record.evidence : '',
			next_action:
				typeof record.next_action === 'string' ? record.next_action : '',
			severity:
				typeof record.severity === 'string' ? record.severity : undefined,
			order_agreement:
				typeof record.order_agreement === 'string'
					? record.order_agreement
					: undefined,
		})),
	};

	// Transport seam functions are read from _internals at CALL TIME (tests
	// swap them per-invocation).
	const executable = _internals.resolveGhBinary();
	if (!executable) {
		return failure(
			'gh-not-found',
			'gh was not found on PATH and no override is configured; a GitHub submission requires the gh CLI (there is no unauthenticated POST fallback)',
			true,
		);
	}

	// Step f — existing-comments fetch (dedupe context), strictly BEFORE the
	// POST. Failure refuses rather than risking duplicate posts.
	const existing = await fetchExistingCommentBodies(
		executable,
		directory,
		repoSlug,
		prNumber,
	);
	if ('refusal' in existing) return existing.refusal;
	rendererInput.existingComments = existing.bodies;

	const rendered = renderPrReviewSubmissionBody(rendererInput);
	if (
		rendered.inlineComments.length === 0 &&
		rendererInput.findings.length > 0 &&
		rendererInput.findings.every((finding) =>
			rendered.skippedAsPosted.includes(finding.finding_id),
		)
	) {
		return failure(
			'nothing-new',
			'nothing new to submit — every finding for this run is already present on the PR (idempotent no-op)',
			true,
		);
	}

	// Step g — write the payload under the run directory (provenance copy) and
	// POST it with commit_id pinned to the exact declared head.
	const payload = {
		commit_id: headSha,
		body: rendered.body,
		event,
		comments: rendered.inlineComments.map((comment) => ({
			path: comment.path,
			line: comment.line,
			body: comment.body,
		})),
	};
	// The payload WRITE target must stay a foldable single-return-helper
	// local (the G2 evidence-class gate resolves `helper(dir, runId)` locals,
	// not property reads off union objects), so this site uses the
	// try/catch form instead of safePath; the refusal contract is identical.
	let payloadPath: string;
	try {
		payloadPath = payloadArtifactPath(directory, runId);
	} catch (error) {
		return failure(
			'invalid-args',
			`Invalid pr_review_submission args: artifact path rejected (${error instanceof Error ? error.message : String(error)})`,
			false,
		);
	}
	try {
		fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
		fs.writeFileSync(
			payloadPath,
			`${JSON.stringify(payload, null, 2)}\n`,
			'utf-8',
		);
	} catch (error) {
		return failure(
			'payload-write-failed',
			`failed to persist the submission payload copy (.swarm/pr-review/${runId}/submission-payload.json): ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const run = await _internals.runExternalTool({
		executable,
		args: [
			'api',
			`repos/${repoSlug}/pulls/${prNumber}/reviews`,
			'--method',
			'POST',
			'--input',
			payloadPath,
		],
		cwd: directory,
		timeoutMs: GH_TIMEOUT_MS,
		maxStdoutBytes: GH_MAX_STDOUT_BYTES,
		maxStderrBytes: GH_MAX_STDERR_BYTES,
	});
	if (run.status === 'timeout') {
		return failure(
			'transport-failed',
			`gh api repos/${repoSlug}/pulls/${prNumber}/reviews timed out after ${GH_TIMEOUT_MS}ms (the review may or may not have been created; dedupe on resubmit; payload preserved at .swarm/pr-review/${runId}/submission-payload.json)`,
			true,
		);
	}
	if (run.status !== 'completed') {
		return failure(
			'transport-failed',
			`gh api repos/${repoSlug}/pulls/${prNumber}/reviews failed to start (${run.message ?? run.status})`,
			true,
		);
	}
	if (run.exitCode !== 0) {
		return failure(
			'transport-failed',
			`gh api repos/${repoSlug}/pulls/${prNumber}/reviews exited ${run.exitCode}: ${run.stderr.split('\n')[0] ?? ''}`,
			true,
		);
	}
	let review: { id?: unknown; html_url?: unknown } = {};
	try {
		review = JSON.parse(run.stdout) as { id?: unknown; html_url?: unknown };
	} catch {
		// A non-JSON success body still means the review was created; surface
		// the raw first line instead of the parsed fields.
	}
	let nativeReceipt = false;
	if (
		event === 'COMMENT' &&
		coverage.kind === 'FULL' &&
		typeof review.id === 'number' &&
		Number.isSafeInteger(review.id) &&
		review.id > 0
	) {
		try {
			const completion = asRecord(
				readJsonFile(
					validateSwarmPath(
						directory,
						path.join('pr-review', runId, 'native-completion.json'),
					),
				),
			);
			if (
				completion?.run_id === runId &&
				completion.head === headSha &&
				typeof completion.url === 'string' &&
				completion.url.toLowerCase() ===
					`https://github.com/${repoSlug}/pull/${prNumber}`.toLowerCase() &&
				completion.session_id === sessionID &&
				completion.coverage === 'COMPLETE' &&
				completion.verdict === 'APPROVE'
			) {
				await atomicWriteSwarmFile(
					validateSwarmPath(
						directory,
						path.join('pr-review', runId, 'native-submission.json'),
					),
					JSON.stringify({
						run_id: runId,
						head: headSha,
						repo: repoSlug,
						pr: prNumber,
						review_id: review.id,
						body_sha256: createHash('sha256')
							.update(rendered.body.trimEnd())
							.digest('hex'),
					}) + '\n',
				);
				nativeReceipt = true;
			}
		} catch {
			// Publication already succeeded. Missing evidence keeps release admission closed.
		}
	}
	return JSON.stringify(
		{
			success: true,
			run_id: runId,
			pr_head_sha: headSha,
			event,
			inline_comment_count: rendered.inlineComments.length,
			skipped_as_posted: rendered.skippedAsPosted.length,
			truncated_inline_comments: rendered.truncatedInlineComments,
			dismissed_findings: rendered.dismissedCount,
			body_truncated: rendered.bodyTruncated,
			coverage_kind: coverage.kind,
			native_release_receipt: nativeReceipt,
			posted_review_id: typeof review.id === 'number' ? review.id : null,
			review_url: typeof review.html_url === 'string' ? review.html_url : null,
			payload_path: `.swarm/pr-review/${runId}/submission-payload.json`,
		},
		null,
		2,
	);
}

export const pr_review_submission: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
		description:
			'submit a settled, head-bound PR review to GitHub through the gh PR Review API after the PR_REVIEW gate clears; architect-only, refuses while a gate is active or the run was aborted after settlement',
		args: {
			pr_number: z
				.number()
				.int()
				.positive()
				.describe('Pull request number to submit the review to'),
			repo: z
				.string()
				.trim()
				.regex(REPO_SLUG_PATTERN)
				.describe('owner/name repository slug'),
			run_id: z
				.string()
				.trim()
				.regex(RUN_ID_PATTERN)
				.describe('settled PR-review run id under .swarm/pr-review/'),
			pr_head_sha: z
				.string()
				.trim()
				.regex(PR_HEAD_SHA_PATTERN)
				.describe('exact PR head sha the run is bound to (commit_id pin)'),
		},
		execute: executePrReviewSubmission,
	});
