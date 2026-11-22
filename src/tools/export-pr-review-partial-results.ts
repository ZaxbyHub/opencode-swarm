import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { PR_REVIEW_FINDINGS_MAX_BYTES } from '../background/pr-review-contract.js';
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
} from '../background/pr-review-trigger-contract.js';
import { coreEventsFilePath, readCoreEvents } from '../events/core-events.js';
import { readPrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { isoNow } from '../pr-review/persistence.js';
import {
	type RendererFinding,
	renderPrReviewSubmissionBody,
} from '../pr-review/render-review-body.js';
import {
	clampRedactedText,
	redactEvidenceText,
} from '../security/evidence-redaction';
import { atomicWriteSwarmFile } from '../utils/atomic-write.js';
import { createSwarmTool } from './create-tool.js';

/**
 * Post-abort partial-results export (issue #3097, Workstream C PR 2/2).
 *
 * A PR_REVIEW workflow that legitimately ends via `abort_pr_workflow` has no
 * authorized export of its validated findings: the live handoff path requires
 * an active gate (`write_pr_review_artifact` entry check) and couples to
 * feedback consent, while `pr_review_submission` refuses aborted runs by
 * design. This tool is the missing third surface: it requires the gate to be
 * GONE and an abort event to bind the session + head AND postdate the run's
 * reservation, reads the surviving run artifacts (run reservation,
 * trigger-eval receipt, findings), and writes a partial, explicitly
 * NON-AUTHORITATIVE export artifact. It never implies review completion or
 * feedback consent: it does not touch the feedback-consent machinery, never
 * writes the handoff completion marker, and issues no verdict — findings
 * without a recorded severity are listed as such, never "dismissed".
 */

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Full commit SHAs only: the receipt and every findings row bind the full head. */
const PR_HEAD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const ExportArgsSchema = z
	.object({
		run_id: z.string().trim().regex(RUN_ID_PATTERN),
		pr_head_sha: z.string().trim().regex(PR_HEAD_SHA_PATTERN),
	})
	.strict();

type ExportRefusalType =
	| 'invalid-args'
	| 'invalid-session'
	| 'gate-active'
	| 'gate-indeterminate'
	| 'not-aborted'
	| 'abort-scan-indeterminate'
	| 'reservation-mismatch'
	| 'receipt-missing'
	| 'receipt-unsupported'
	| 'head-mismatch'
	| 'no-findings'
	| 'invalid-findings'
	| 'artifact-too-large'
	| 'io-error';

/**
 * Findings artifact cap + envelope/summary margin; refusal is typed, never
 * truncation. The artifact re-embeds every finding (structured rows plus the
 * rendered body) with 2-space indentation, measuring ~2.4x the compact JSONL
 * source at 10 MiB scale (measured in review run pr3140-20261008), so the
 * margin must exceed the re-expansion, not just the envelope.
 */
const POST_ABORT_EXPORT_MAX_BYTES =
	PR_REVIEW_FINDINGS_MAX_BYTES + 24 * 1024 * 1024;
const RESERVATION_MAX_BYTES = 16 * 1024;

/**
 * Bounds mirroring `PrReviewFindingObjectSchema`
 * (src/background/pr-review-contract.ts) — a redaction placeholder can be
 * LONGER than the secret it replaces, so the redacted value is clamped back
 * inside its bound or the exported row fails its schema on read.
 */
const PR_REVIEW_FINDING_EVIDENCE_MAX = 20_000;
const PR_REVIEW_FINDING_FILE_LINE_MAX = 1_000;
const PR_REVIEW_FINDING_CATEGORY_MAX = 128;
const PR_REVIEW_FINDING_PROVENANCE_MAX = 256;
/** The disclosure writer caps the file at 4 KiB (src/pr-review/completion.ts). */
const DISCLOSURE_MAX_BYTES = 4 * 1024;

interface AbortEvent {
	timestamp: string;
	/** Undefined means the event did not record a count — disclosed as unknown. */
	openLanes?: number;
	presumedStaleLanes?: string[];
}

interface ReceiptShape {
	schema_version?: unknown;
	run_id?: unknown;
	pr_head_sha?: unknown;
	base_ref?: unknown;
	base_sha?: unknown;
	evaluated_at?: unknown;
	base_verification?: unknown;
	rows?: unknown;
	coverage_degradations?: unknown;
}

interface PersistedFindingRowBase {
	finding_id: string;
	status: string;
	file_line: string;
	evidence: string;
	next_action: string;
	severity?: string;
	critic_status?: string;
	/** Issue #2906: retained when supplied; the post-abort body reuses the renderer. */
	order_agreement?: string;
	provenance?: string[];
	boundary: string;
	pr_head_sha: string;
	recorded_at: string;
}

/**
 * Tolerant reader shape: unknown fields from a newer plugin are retained
 * (issue #2491 F-009 posture) so the salvage artifact does not silently
 * erase forward-compatible data during a mixed-version rollout.
 */
type PersistedFindingRow = PersistedFindingRowBase & Record<string, unknown>;

function failure(type: ExportRefusalType, message: string): string {
	return JSON.stringify({ success: false, type, message });
}

function success(result: Record<string, unknown>): string {
	return JSON.stringify({ success: true, ...result });
}

/** Refusal-safe fs error: the code only — raw messages carry absolute host paths. */
function fsErrorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : 'fs-error';
}

/** Flattens untrusted single-line values before they reach the summary (singleLine semantics). */
function flattenLine(value: string, cap: number): string {
	const flattened = value.replace(/\s+/g, ' ').trim();
	return flattened.length > cap ? `${flattened.slice(0, cap - 1)}…` : flattened;
}

/**
 * Bounded abort scan over the retained core-events window (the
 * `hasAbortAfterSettlement` predicates of #3118, inverted: an abort is the
 * PRECONDITION). Returns the newest matching event. `truncated` coverage
 * fails closed: history beyond the read bound is unverifiable, so an abort
 * outside the retained window can neither be confirmed nor ruled out. An
 * existing-but-unreadable events file is likewise indeterminate; a missing
 * file is a definitive not-aborted.
 */
export function findAbortEventForHead(
	directory: string,
	sessionID: string,
	headSha: string,
): { event: AbortEvent | null; indeterminate: boolean } {
	if (!fs.existsSync(coreEventsFilePath(directory))) {
		return { event: null, indeterminate: false };
	}
	const read = readCoreEvents(directory);
	if (read.coverage === 'truncated' || read.text.trim() === '') {
		return { event: null, indeterminate: true };
	}
	const head = headSha.toLowerCase();
	let match: AbortEvent | null = null;
	for (const line of read.text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type !== 'pr_workflow_aborted') continue;
		if (parsed.sessionID !== sessionID) continue;
		const mode = parsed.mode;
		if (mode !== undefined && mode !== 'PR_REVIEW') continue;
		const eventHead =
			typeof parsed.prHeadSha === 'string'
				? parsed.prHeadSha.toLowerCase()
				: null;
		if (eventHead !== head) continue;
		// A matching event without a readable timestamp cannot anchor the
		// ordering bound; skip it rather than letting it veto an earlier
		// well-formed match (last-match-wins).
		if (typeof parsed.timestamp !== 'string' || parsed.timestamp === '') {
			continue;
		}
		match = {
			timestamp: parsed.timestamp,
			openLanes:
				typeof parsed.openLanes === 'number' ? parsed.openLanes : undefined,
			presumedStaleLanes: Array.isArray(parsed.presumedStaleLanes)
				? parsed.presumedStaleLanes.filter(
						(entry): entry is string => typeof entry === 'string',
					)
				: [],
		};
	}
	return { event: match, indeterminate: false };
}

async function readBoundedJson(
	absolutePath: string,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	const stat = await fs.promises.stat(absolutePath);
	if (!stat.isFile() || stat.size > maxBytes) {
		throw new Error(`not a bounded regular file (max ${maxBytes} bytes)`);
	}
	const text = await fs.promises.readFile(absolutePath, 'utf8');
	if (Buffer.byteLength(text, 'utf8') > maxBytes) {
		throw new Error(`exceeds ${maxBytes} bytes after read`);
	}
	const decoded = JSON.parse(text) as unknown;
	if (
		decoded === null ||
		typeof decoded !== 'object' ||
		Array.isArray(decoded)
	) {
		throw new Error('not a JSON object');
	}
	return decoded as Record<string, unknown>;
}

function readFindingsRows(text: string): PersistedFindingRow[] {
	const rows: PersistedFindingRow[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === '') continue;
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (decoded === null || typeof decoded !== 'object') {
			throw new Error(`line ${index + 1} is not a findings record`);
		}
		const record = decoded as Record<string, unknown>;
		const findingId = typeof record.finding_id === 'string';
		const required =
			findingId &&
			typeof record.status === 'string' &&
			typeof record.file_line === 'string' &&
			typeof record.evidence === 'string' &&
			typeof record.next_action === 'string' &&
			typeof record.boundary === 'string' &&
			typeof record.pr_head_sha === 'string' &&
			typeof record.recorded_at === 'string';
		if (!required) {
			throw new Error(
				`line ${index + 1} violates the persisted findings shape`,
			);
		}
		const row: PersistedFindingRow = {
			finding_id: record.finding_id as string,
			status: record.status as string,
			file_line: record.file_line as string,
			evidence: record.evidence as string,
			next_action: record.next_action as string,
			...(typeof record.severity === 'string'
				? { severity: record.severity }
				: {}),
			...(typeof record.critic_status === 'string'
				? { critic_status: record.critic_status }
				: {}),
			...(Array.isArray(record.provenance)
				? {
						provenance: record.provenance.filter(
							(entry): entry is string => typeof entry === 'string',
						),
					}
				: {}),
			boundary: record.boundary as string,
			pr_head_sha: record.pr_head_sha as string,
			recorded_at: record.recorded_at as string,
		};
		// Retain forward-compatible unknown fields (issue #2491 F-009): the
		// salvage artifact must not silently erase data a newer plugin wrote.
		const known = new Set([
			'finding_id',
			'status',
			'file_line',
			'evidence',
			'next_action',
			'severity',
			'critic_status',
			'provenance',
			'boundary',
			'pr_head_sha',
			'recorded_at',
		]);
		for (const [key, value] of Object.entries(record)) {
			if (!known.has(key)) row[key] = value;
		}
		rows.push(row);
	}
	return rows;
}

/**
 * The export write goes through the canonical swarm writer (fsync, bounded
 * rename retry, cache invalidation); the local wrapper only ensures the
 * parent directory exists. Keeping the same `_internals.atomicWrite` seam
 * preserves the io-error test seam.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteSwarmFile(filePath, content);
}

function safeSwarmPath(directory: string, relativePath: string): string | null {
	try {
		return validateSwarmPath(directory, relativePath);
	} catch {
		return null;
	}
}

/**
 * Single-return path helper for the export WRITE site: the G2 evidence-class
 * scanner folds a write target only when it resolves through path.join /
 * validateSwarmPath / a same-file single-return helper (the #3118
 * payloadArtifactPath precedent), so the write keeps a plain string target.
 */
function exportArtifactPath(directory: string, runId: string): string {
	return validateSwarmPath(
		directory,
		path.join('pr-review', runId, 'post-abort-export.json'),
	);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Silence computation: absence is listed, never smoothed over. */
function computeSilence(
	receipt: ReceiptShape,
	abortEvent: AbortEvent,
	receiptVersion: 1 | 2,
): {
	untestedFamilies: string[];
	notTriggeredFamilies: string[];
	familiesSource: string;
} {
	const receiptRows = Array.isArray(receipt.rows) ? receipt.rows : [];
	const degraded = new Set(
		(Array.isArray(receipt.coverage_degradations)
			? receipt.coverage_degradations
			: []
		)
			.map((entry) =>
				entry &&
				typeof entry === 'object' &&
				typeof (entry as Record<string, unknown>).trigger_id === 'string'
					? ((entry as Record<string, unknown>).trigger_id as string)
					: null,
			)
			.filter((entry): entry is string => entry !== null),
	);
	const matchedFamilies = new Set<string>();
	const notTriggered: string[] = [];
	const matchedLaneByFamily = new Map<string, string>();
	for (const entry of receiptRows) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const triggerId = asString(row.trigger_id);
		if (!triggerId) continue;
		if (row.result === 'MATCHED') {
			matchedFamilies.add(triggerId);
			const laneId = asString(row.source_lane_id);
			if (laneId) matchedLaneByFamily.set(triggerId, laneId);
		} else if (row.result === 'NOT_TRIGGERED' && receiptVersion === 2) {
			notTriggered.push(triggerId);
		}
	}
	const presumedStale = new Set(abortEvent.presumedStaleLanes ?? []);
	const untested: string[] = [];
	for (const family of PR_REVIEW_REQUIRED_TRIGGER_IDS) {
		if (!matchedFamilies.has(family)) {
			// Canonical family with no MATCHED row: either never evaluated in
			// the retained receipt (absent entirely), explicitly not triggered
			// (v2 only), or — for a legacy v1 receipt, whose rows are
			// MATCHED-only — recorded only in the receipt-level no-match count.
			// Every such case is silence, never a coverage claim.
			if (!notTriggered.includes(family)) untested.push(family);
			continue;
		}
		if (degraded.has(family)) {
			untested.push(family);
			continue;
		}
		const laneId = matchedLaneByFamily.get(family);
		if (laneId && presumedStale.has(laneId)) untested.push(family);
	}
	return {
		untestedFamilies: untested,
		notTriggeredFamilies: notTriggered,
		familiesSource: receiptVersion === 1 ? 'v1-receipt-rows' : 'v2-rows',
	};
}

type BaseCoverageState = {
	status: 'unknown' | 'unresolved' | 'unreadable';
	unresolved_dimensions?: string[];
	note?: string;
};

function renderSummary(input: {
	runId: string;
	head: string;
	workflowInstanceId: string;
	abortedAt: string;
	receipt: ReceiptShape;
	receiptVersion: 1 | 2;
	rows: PersistedFindingRow[];
	untestedFamilies: string[];
	notTriggeredFamilies: string[];
	boundariesReached: string[];
	baseCoverage: BaseCoverageState;
	abortEvent: AbortEvent;
}): {
	text: string;
	bodyTruncated: boolean;
	truncatedInlineComments: number;
} {
	const dims = input.baseCoverage.unresolved_dimensions ?? [];
	const dimensionLine =
		dims.length > 0
			? dims.map((name) => flattenLine(name, 120)).join(', ')
			: 'dimension names not recorded in the disclosure record';
	const coverage =
		input.baseCoverage.status === 'unresolved'
			? {
					kind: 'PARTIAL (post-abort)',
					unresolved_dimensions:
						dims.length > 0
							? dims
							: ['dimension names not recorded in the disclosure record'],
				}
			: input.baseCoverage.status === 'unreadable'
				? {
						kind: `UNKNOWN (post-abort; ${flattenLine(
							input.baseCoverage.note ?? 'coverage-disclosure.json unreadable',
							200,
						)})`,
						unresolved_dimensions: [dimensionLine],
					}
				: {
						kind: 'UNKNOWN (post-abort; no coverage-disclosure.json)',
						unresolved_dimensions: [
							'base-dimension coverage not settled (no partial-base-coverage admission found)',
						],
					};
	// Render only the LATEST record per finding id (findings.jsonl accumulates
	// one record per boundary; the earliest record can carry a superseded
	// severity), and only rows with a LIVE severity — rows whose severity is
	// absent, canonical NONE, or non-canonical would trigger the renderer's
	// "(dismissed) omitted" line, which imports verdict semantics this export
	// must not carry; they are listed separately below, never "dismissed".
	const LIVE_SEVERITIES = new Set([
		'CRITICAL',
		'HIGH',
		'MEDIUM',
		'LOW',
		'INFO',
	]);
	const hasLiveSeverity = (row: PersistedFindingRow): boolean =>
		row.severity !== undefined &&
		LIVE_SEVERITIES.has(row.severity.trim().toUpperCase());
	const latestById = new Map<string, PersistedFindingRow>();
	for (const row of input.rows) latestById.set(row.finding_id, row);
	const latestRows = [...latestById.values()];
	const rendererRows = latestRows.filter(hasLiveSeverity);
	const severitylessIds = latestRows
		.filter((row) => !hasLiveSeverity(row))
		.map((row) => row.finding_id);
	const rendererFindings: RendererFinding[] = rendererRows.map((row) => ({
		finding_id: row.finding_id,
		status: row.status,
		file_line: row.file_line,
		evidence: row.evidence,
		next_action: row.next_action,
		// Identical normalization to hasLiveSeverity: the renderer does not
		// trim, so a padded-but-live value must land canonical or it would
		// trip the renderer's "(dismissed) omitted" line after passing the
		// filter above.
		severity: row.severity?.trim().toUpperCase(),
		order_agreement: row.order_agreement,
	}));
	const rendered = renderPrReviewSubmissionBody({
		run_id: input.runId,
		pr_head_sha: input.head,
		coverage,
		findings: rendererFindings,
		...(asString(input.receipt.base_verification) === 'bound_fallback'
			? { base_verification: 'bound_fallback' as const }
			: {}),
	});
	// Replace the renderer's hardcoded submission header: this artifact is
	// not a submission, and the summary must not open with one.
	const renderedLines = rendered.body.split('\n');
	if (
		renderedLines[0]?.startsWith('PR review submission for run ') ||
		renderedLines[0]?.startsWith('Post-abort partial-results export for run ')
	) {
		renderedLines[0] = `Post-abort partial-results export for run ${input.runId} at head ${input.head} (not a review submission).`;
	}
	const lines: string[] = [];
	lines.push(
		`> PARTIAL — NON-AUTHORITATIVE post-abort salvage export for run ${flattenLine(input.runId, 128)} at head ${flattenLine(input.head, 64)}.`,
	);
	lines.push(
		'> This is NOT a review submission, NOT review completion, and implies NO feedback consent. The review ended via abort_pr_workflow; the findings below are the run-bound validated partial record only.',
	);
	lines.push(
		`> Provenance: workflow_instance ${flattenLine(input.workflowInstanceId, 128)}; aborted_at ${flattenLine(input.abortedAt, 40)}; trigger receipt (v${input.receiptVersion}) evaluated_at ${flattenLine(asString(input.receipt.evaluated_at) ?? '(absent)', 40)} at base ${flattenLine(asString(input.receipt.base_sha) ?? '(absent)', 64)} (${flattenLine(asString(input.receipt.base_ref) ?? '(absent)', 128)})${asString(input.receipt.base_verification) === 'bound_fallback' ? '; base verification: bound fallback (scope bound without live verification)' : ''}.`,
	);
	lines.push('');
	lines.push(renderedLines.join('\n'));
	lines.push('');
	lines.push('## Silence disclosure');
	lines.push(
		input.untestedFamilies.length > 0
			? `- Untested families (assigned-but-receiptless or coverage-degraded; listed, not smoothed over): ${input.untestedFamilies.map((name) => flattenLine(name, 120)).join(', ')}`
			: '- Untested families: none recorded in the retained trigger receipt.',
	);
	if (input.notTriggeredFamilies.length > 0) {
		lines.push(
			`- Evaluated, not triggered: ${input.notTriggeredFamilies.map((name) => flattenLine(name, 120)).join(', ')}`,
		);
	}
	lines.push(
		`- Boundaries reached: ${input.boundariesReached.length > 0 ? input.boundariesReached.map((name) => flattenLine(name, 40)).join(', ') : '(none)'}`,
	);
	lines.push(
		`- Base coverage: ${input.baseCoverage.status}${dims.length > 0 ? ` (${dimensionLine})` : input.baseCoverage.note ? ` (${flattenLine(input.baseCoverage.note, 200)})` : ''}.`,
	);
	const laneLine =
		input.abortEvent.openLanes === undefined
			? 'open_lanes unknown (not recorded on the abort event)'
			: `open_lanes ${input.abortEvent.openLanes}`;
	lines.push(
		`- Abort lane state: ${laneLine}; presumed-stale lanes ${(input.abortEvent.presumedStaleLanes ?? []).length > 0 ? (input.abortEvent.presumedStaleLanes ?? []).map((id) => flattenLine(id, 128)).join(', ') : '(none disclosed)'}. Lanes settled uncollected at abort are NOT claimed as tested.`,
	);
	if (severitylessIds.length > 0) {
		lines.push(
			`- Rows without a recorded severity (carried in the findings array; NOT settled verdicts and NOT dismissed): ${severitylessIds.map((id) => flattenLine(id, 128)).join(', ')}`,
		);
	}
	if (input.receiptVersion === 1) {
		lines.push(
			'- Family evidence source: legacy v1 trigger receipt; its per-family rows are MATCHED-only, so families absent from the receipt are listed as untested.',
		);
	}
	if (rendered.bodyTruncated || rendered.truncatedInlineComments > 0) {
		lines.push(
			`- Rendered body truncation: ${rendered.bodyTruncated ? 'body exceeded the character cap; ' : ''}${rendered.truncatedInlineComments > 0 ? `${rendered.truncatedInlineComments} finding(s) beyond the inline-comment cap; ` : ''}the findings array above remains complete.`,
		);
	}
	lines.push(
		'> Family-level lane settlement receipts live in the delegation ledger, which this export deliberately does not read; no family-level settlement is claimed.',
	);
	return {
		text: lines.join('\n'),
		bodyTruncated: rendered.bodyTruncated,
		truncatedInlineComments: rendered.truncatedInlineComments,
	};
}

export const _internals = {
	atomicWrite,
	findAbortEventForHead,
	readGateState: readPrWorkflowGateState,
};

export async function executeExportPrReviewPartialResults(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = ExportArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			'invalid-args',
			`Invalid post-abort export args: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID)
		return failure('invalid-session', 'an active sessionID is required');
	const runId = parsed.data.run_id;
	const declaredHead = parsed.data.pr_head_sha.toLowerCase();

	// Gate must be GONE: while a gate is active the live handoff path is the
	// only authorized surface (and this tool must never become a parallel
	// live path around the consent machinery).
	let gateState: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		gateState = await _internals.readGateState(directory, sessionID);
	} catch (error) {
		return failure(
			'gate-indeterminate',
			`could not read the PR workflow gate state (fs ${fsErrorCode(error)})`,
		);
	}
	if (gateState !== null) {
		return failure(
			'gate-active',
			'an active PR workflow gate exists for this session; the live handoff path remains the authorized surface until the workflow is aborted',
		);
	}

	// Abort evidence is the precondition (the #3118 abort scan, inverted).
	const abortScan = _internals.findAbortEventForHead(
		directory,
		sessionID,
		declaredHead,
	);
	if (abortScan.indeterminate) {
		return failure(
			'abort-scan-indeterminate',
			'the retained events window is truncated or unreadable; abort evidence for the declared head cannot be verified',
		);
	}
	const abortEvent = abortScan.event;
	if (!abortEvent) {
		return failure(
			'not-aborted',
			`no pr_workflow_aborted event binds session ${sessionID} to head ${declaredHead}`,
		);
	}

	const relativeRunDir = path.join('pr-review', runId);
	const resolve = (name: string): string | null =>
		safeSwarmPath(directory, path.join(relativeRunDir, name));

	// Run reservation: proves the run belongs to this session and carries the
	// workflow instance identity (closes the cross-session gap #3118 disclosed).
	const reservationPath = resolve('run-reservation.json');
	if (!reservationPath) {
		return failure(
			'invalid-args',
			`run_id "${runId}" does not resolve to a contained path below the project .swarm directory`,
		);
	}
	let reservation: Record<string, unknown>;
	try {
		reservation = await readBoundedJson(reservationPath, RESERVATION_MAX_BYTES);
	} catch (error) {
		return failure(
			'reservation-mismatch',
			`expected a bounded readable run reservation for run "${runId}" (fs ${fsErrorCode(error)})`,
		);
	}
	if (reservation.run_id !== runId) {
		return failure(
			'reservation-mismatch',
			`run "${runId}" reservation content mismatch`,
		);
	}
	if (reservation.session_id !== sessionID) {
		return failure(
			'reservation-mismatch',
			`run "${runId}" is reserved by a different session`,
		);
	}
	const workflowInstanceId = asString(reservation.workflow_instance_id);
	if (!workflowInstanceId) {
		return failure(
			'reservation-mismatch',
			`run "${runId}" reservation lacks a workflow_instance_id`,
		);
	}
	// Ordering bound: the abort must postdate THIS run's reservation, so a
	// stale abort from an earlier workflow at the same head cannot authorize
	// (or mislabel) this run's export.
	const reservedAt = asString(reservation.reserved_at);
	if (!reservedAt) {
		return failure(
			'reservation-mismatch',
			`run "${runId}" reservation lacks a readable reserved_at`,
		);
	}
	if (abortEvent.timestamp < reservedAt) {
		return failure(
			'not-aborted',
			`the newest pr_workflow_aborted event for this session and head predates run "${runId}"'s reservation; it belongs to an earlier workflow and does not authorize this export`,
		);
	}

	// Trigger-eval receipt: the run/head/base binding evidence.
	const receiptPath = resolve('trigger-eval.json');
	if (!receiptPath) {
		return failure('invalid-args', 'trigger-eval path failed containment');
	}
	let receipt: ReceiptShape;
	try {
		receipt = (await readBoundedJson(
			receiptPath,
			PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
		)) as ReceiptShape;
	} catch (error) {
		return failure(
			'receipt-missing',
			`expected a bounded readable trigger-eval receipt for run "${runId}" (fs ${fsErrorCode(error)})`,
		);
	}
	const receiptVersion =
		receipt.schema_version === 1 ? 1 : receipt.schema_version === 2 ? 2 : null;
	if (receiptVersion === null) {
		return failure(
			'receipt-unsupported',
			`trigger-eval receipt schema_version ${JSON.stringify(receipt.schema_version)} is not supported (expected 1 or 2)`,
		);
	}
	const receiptRunId = asString(receipt.run_id);
	const receiptHead = asString(receipt.pr_head_sha);
	if (receiptRunId !== runId || !receiptHead) {
		return failure(
			'head-mismatch',
			`trigger-eval receipt does not bind run "${runId}" (bound ${JSON.stringify(receiptRunId)})`,
		);
	}
	if (receiptHead.toLowerCase() !== declaredHead) {
		return failure(
			'head-mismatch',
			`trigger-eval receipt binds head ${receiptHead}, not the declared head ${declaredHead}`,
		);
	}

	// Findings: every persisted row must bind to the declared head.
	const findingsPath = resolve('findings.jsonl');
	if (!findingsPath) {
		return failure('invalid-args', 'findings path failed containment');
	}
	let findingsText: string;
	try {
		const stat = await fs.promises.stat(findingsPath);
		if (!stat.isFile() || stat.size > PR_REVIEW_FINDINGS_MAX_BYTES) {
			throw new Error(
				`not a bounded regular file (max ${PR_REVIEW_FINDINGS_MAX_BYTES} bytes)`,
			);
		}
		findingsText = await fs.promises.readFile(findingsPath, 'utf8');
		if (
			Buffer.byteLength(findingsText, 'utf8') > PR_REVIEW_FINDINGS_MAX_BYTES
		) {
			throw new Error(
				`exceeds ${PR_REVIEW_FINDINGS_MAX_BYTES} bytes after read`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return failure(
				'no-findings',
				`no findings artifact exists for run "${runId}"`,
			);
		}
		return failure(
			'invalid-findings',
			`could not read the findings artifact (fs ${fsErrorCode(error)})`,
		);
	}
	let rows: PersistedFindingRow[];
	try {
		rows = readFindingsRows(findingsText);
	} catch (error) {
		return failure(
			'invalid-findings',
			`the findings artifact violates the persisted findings shape: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (rows.length === 0) {
		return failure(
			'no-findings',
			`run "${runId}" persisted zero findings rows; there is no validated partial record to export`,
		);
	}
	for (const row of rows) {
		if (row.pr_head_sha.toLowerCase() !== declaredHead) {
			return failure(
				'head-mismatch',
				`finding ${row.finding_id} binds head ${row.pr_head_sha}, not the declared head ${declaredHead}`,
			);
		}
	}

	// Optional coverage disclosure (partial base coverage admitted pre-abort).
	// Absent stays honestly unknown; present-but-unreadable or foreign-bound
	// is disclosed as such, never smoothed into "absent".
	let baseCoverage: BaseCoverageState = { status: 'unknown' };
	const disclosurePath = resolve('coverage-disclosure.json');
	if (disclosurePath) {
		try {
			const disclosure = await readBoundedJson(
				disclosurePath,
				DISCLOSURE_MAX_BYTES,
			);
			const disclosureRunId = asString(disclosure.runId);
			const disclosureHead = asString(disclosure.prHeadSha);
			if (
				(disclosureRunId !== undefined && disclosureRunId !== runId) ||
				(disclosureHead !== undefined &&
					disclosureHead.toLowerCase() !== declaredHead)
			) {
				baseCoverage = {
					status: 'unreadable',
					note: 'coverage-disclosure.json is bound to a different run or head; ignored',
				};
			} else {
				const unresolved = Array.isArray(disclosure.unresolvedDimensions)
					? disclosure.unresolvedDimensions
					: [];
				const dimensions = unresolved
					.map((entry) =>
						entry &&
						typeof entry === 'object' &&
						typeof (entry as Record<string, unknown>).dimension === 'string'
							? ((entry as Record<string, unknown>).dimension as string)
							: null,
					)
					.filter((entry): entry is string => entry !== null);
				if (dimensions.length === 0) {
					// Legacy v1 disclosure shape: a single missingDimension string.
					const missingDimension = asString(disclosure.missingDimension);
					if (missingDimension) dimensions.push(missingDimension);
				}
				baseCoverage = {
					status: 'unresolved',
					unresolved_dimensions: dimensions,
				};
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// Absent: honest unknown.
			} else {
				baseCoverage = {
					status: 'unreadable',
					note: `coverage-disclosure.json could not be read as a bounded JSON object (fs ${fsErrorCode(error)})`,
				};
			}
		}
	}

	const boundariesReached = [...new Set(rows.map((row) => row.boundary))];
	const silence = computeSilence(receipt, abortEvent, receiptVersion);
	const renderedSummary = renderSummary({
		runId,
		head: declaredHead,
		workflowInstanceId,
		abortedAt: abortEvent.timestamp,
		receipt,
		receiptVersion,
		rows,
		untestedFamilies: silence.untestedFamilies,
		notTriggeredFamilies: silence.notTriggeredFamilies,
		boundariesReached,
		baseCoverage,
		abortEvent,
	});
	const exportedAt = isoNow();
	const artifact = {
		kind: 'post-abort-partial-export' as const,
		schema_version: 1,
		partial: true,
		authoritative: false,
		run_id: runId,
		pr_head_sha: declaredHead,
		workflow_instance_id: workflowInstanceId,
		aborted_at: abortEvent.timestamp,
		exported_at: exportedAt,
		provenance: {
			receipt_schema_version: receiptVersion,
			base_ref: asString(receipt.base_ref) ?? '',
			base_sha: asString(receipt.base_sha) ?? '',
			evaluated_at: asString(receipt.evaluated_at) ?? '',
			base_verification: asString(receipt.base_verification) ?? null,
			receipt_run_id: receiptRunId ?? '',
			receipt_pr_head_sha: receiptHead,
		},
		// #3844: post-fix rows are redacted at their own write boundary;
		// pre-fix rows still on disk can be raw, so the exporter normalizes
		// every row again at ITS write (idempotent over placeholders).
		findings: rows.map((row) => {
			const { boundary: lane, pr_head_sha: _boundHead, ...rest } = row;
			return {
				...rest,
				evidence: clampRedactedText(
					redactEvidenceText(row.evidence),
					PR_REVIEW_FINDING_EVIDENCE_MAX,
				),
				...(typeof row.file_line === 'string'
					? {
							file_line: clampRedactedText(
								redactEvidenceText(row.file_line),
								PR_REVIEW_FINDING_FILE_LINE_MAX,
							),
						}
					: {}),
				...(typeof row.category === 'string'
					? {
							category: clampRedactedText(
								redactEvidenceText(row.category),
								PR_REVIEW_FINDING_CATEGORY_MAX,
							),
						}
					: {}),
				...(Array.isArray(row.provenance)
					? {
							provenance: row.provenance.map((entry) =>
								clampRedactedText(
									redactEvidenceText(entry),
									PR_REVIEW_FINDING_PROVENANCE_MAX,
								),
							),
						}
					: {}),
				severity: row.severity ?? 'NONE',
				lane,
			};
		}),
		silence: {
			untested_families: silence.untestedFamilies,
			not_triggered_families: silence.notTriggeredFamilies,
			boundaries_reached: boundariesReached,
			base_coverage: baseCoverage,
			families_source: silence.familiesSource,
		},
		abort_lane_state: {
			open_lanes: abortEvent.openLanes ?? ('unknown' as const),
			presumed_stale_lane_ids: abortEvent.presumedStaleLanes ?? [],
			note: 'lanes settled uncollected at abort are not claimed as tested',
		},
		summary_truncation: {
			body_truncated: renderedSummary.bodyTruncated,
			truncated_inline_comments: renderedSummary.truncatedInlineComments,
		},
		summary: redactEvidenceText(renderedSummary.text),
	};
	const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
	const serializedBytes = Buffer.byteLength(serialized, 'utf8');
	if (serializedBytes > POST_ABORT_EXPORT_MAX_BYTES) {
		return failure(
			'artifact-too-large',
			`the export artifact would be ${serializedBytes} bytes (cap ${POST_ABORT_EXPORT_MAX_BYTES}); refusing rather than truncating`,
		);
	}
	let exportPath: string;
	try {
		exportPath = exportArtifactPath(directory, runId);
	} catch (error) {
		return failure(
			'invalid-args',
			`run_id "${runId}" does not resolve to a contained export path: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// Re-check the gate immediately before the write: the export must never
	// complete under a gate that was re-armed while the reads ran.
	try {
		const gateRecheck = await _internals.readGateState(directory, sessionID);
		if (gateRecheck !== null) {
			return failure(
				'gate-active',
				'a PR workflow gate was activated while the export was being prepared; the live handoff path is the authorized surface',
			);
		}
	} catch (error) {
		return failure(
			'gate-indeterminate',
			`could not re-read the PR workflow gate state before writing (fs ${fsErrorCode(error)})`,
		);
	}
	try {
		await _internals.atomicWrite(exportPath, serialized);
	} catch (error) {
		return failure(
			'io-error',
			`the export artifact could not be written (fs ${fsErrorCode(error)})`,
		);
	}
	const relativeExportPath = path
		.join(relativeRunDir, 'post-abort-export.json')
		.split(path.sep)
		.join('/');
	const distinctFindingIds = new Set(rows.map((row) => row.finding_id));
	return success({
		run_id: runId,
		pr_head_sha: declaredHead,
		path: relativeExportPath,
		finding_count: distinctFindingIds.size,
		record_count: rows.length,
		untested_family_count: silence.untestedFamilies.length,
		partial: true,
		authoritative: false,
	});
}

export const export_pr_review_partial_results: ReturnType<
	typeof createSwarmTool
> = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Export the validated partial results of an ABORTED PR_REVIEW run as a partial, non-authoritative artifact bound per-item to receipt-authenticated findings (issue #3097). Requires the PR workflow gate to be cleared and a pr_workflow_aborted event binding the session and declared full pr_head_sha and postdating the run reservation; verifies the run reservation belongs to the calling session and the trigger-eval receipt and every persisted findings row bind to the declared head. Writes .swarm/pr-review/<run_id>/post-abort-export.json with per-item lane/severity/provenance disclosure, silence representation (assigned-but-receiptless families listed as untested), and an explicit PARTIAL / NON-AUTHORITATIVE banner. Never implies review completion or feedback consent: does not touch feedback-consent.json or the handoff completion marker, and refuses while a gate is still active (re-checked before the write). Idempotent re-export.',
	args: {
		run_id: ExportArgsSchema.shape.run_id,
		pr_head_sha: ExportArgsSchema.shape.pr_head_sha,
	},
	execute: executeExportPrReviewPartialResults,
});
