/**
 * Pure PR-review submission body renderer (issue #3096, Workstream C PR 1/2).
 *
 * Renders settled PR-review findings into the GitHub PR Review submission body
 * plus the inline-comment plan. STRICTLY pure: no filesystem, no network, no
 * clock — authorization and transport live in `src/tools/pr-review-submission.ts`
 * so any future preview surface (e.g. #3097 post-abort export) can reuse this
 * module without submission authority.
 */

import { redactEvidenceText } from '../security/evidence-redaction';

export const PR_REVIEW_INLINE_COMMENT_CAP = 20;

/** GitHub rejects oversized review bodies (~64 KiB); cap the rendered body below it. */
export const PR_REVIEW_BODY_CHAR_CAP = 60_000;

const SEVERITY_ORDER = [
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
] as const;

type RendererSeverity = (typeof SEVERITY_ORDER)[number];

export interface RendererFinding {
	finding_id: string;
	status: string;
	file_line: string;
	evidence: string;
	next_action: string;
	severity?: string;
	/**
	 * Issue #2906: order-stability of this finding's reviewer verdict across
	 * counterbalanced presentation orders. Only 'disagree' renders a marker
	 * (the token `order-unstable`); 'agree'/'single'/absent render nothing.
	 */
	order_agreement?: string;
}

export interface RendererCoverage {
	kind: string;
	unresolved_dimensions: string[];
}

export interface RenderReviewBodyInput {
	run_id: string;
	pr_head_sha: string;
	verdict?: string;
	base_verification?: string;
	coverage: RendererCoverage;
	findings: RendererFinding[];
	/**
	 * Issue #2906: order-unstable findings whose FINAL settled status keeps
	 * them out of `findings` (a DISPROVED row is not a finding and is never
	 * published as one). They are still order-unstable — the reviewer verdict
	 * flipped with presentation order — so they get their own section and are
	 * counted. Suppressing them entirely hid exactly the signal the
	 * counterbalancing control exists to produce.
	 */
	order_unstable_suppressed?: RendererFinding[];
	/** Previously posted comment/review bodies; findings whose rendered marker already appears are skipped (AC4 dedupe). */
	existingComments?: string[];
}

export interface RenderedInlineComment {
	path: string;
	line: number;
	body: string;
	finding_id: string;
}

export interface RenderedReviewBody {
	body: string;
	inlineComments: RenderedInlineComment[];
	/** finding ids skipped because their rendered marker already appears in existingComments. */
	skippedAsPosted: string[];
	/** inline comments dropped by the cap (disclosed in the body). */
	truncatedInlineComments: number;
	/** findings omitted from the body as dismissed (severity NONE at settlement). */
	dismissedCount: number;
	/**
	 * Issue #2906: findings rendered with the order-unstable marker — their
	 * reviewer verdict flipped across counterbalanced presentation orders.
	 */
	orderUnstableCount: number;
	/** true when the body exceeded PR_REVIEW_BODY_CHAR_CAP and was truncated with a disclosure. */
	bodyTruncated: boolean;
}

interface ParsedLocation {
	path: string;
	line: number;
}

function parseLocation(fileLine: string): ParsedLocation | null {
	const separator = fileLine.lastIndexOf(':');
	if (separator <= 0) return null;
	const lineText = fileLine.slice(separator + 1).trim();
	if (!/^\d+$/.test(lineText)) return null;
	const line = Number.parseInt(lineText, 10);
	if (!Number.isInteger(line) || line <= 0) return null;
	return { path: fileLine.slice(0, separator), line };
}

function severityOf(finding: RendererFinding): RendererSeverity {
	const value = (finding.severity ?? 'NONE').toUpperCase();
	return (SEVERITY_ORDER as readonly string[]).includes(value)
		? (value as RendererSeverity)
		: 'NONE';
}

function severityRank(severity: RendererSeverity): number {
	return SEVERITY_ORDER.indexOf(severity);
}

function singleLine(text: string, cap: number): string {
	const flattened = text.replace(/\s+/g, ' ').trim();
	return flattened.length > cap ? `${flattened.slice(0, cap - 1)}…` : flattened;
}

interface SurvivingFinding {
	finding: RendererFinding;
	location: ParsedLocation | null;
}

/**
 * The canonical already-posted marker: exactly what this renderer emits for a
 * finding in a body line or inline comment. Anchoring dedupe on the rendered
 * marker (bracket + trailing space) rather than the bare id prevents both
 * substring over-match (T-1 vs T-10) and gameable bare-id pre-posting.
 */
function postedMarker(findingId: string): string {
	return `[${findingId}] `;
}

/**
 * Renderer-behavior constraints (AC4), applied in order:
 * 1. skip findings whose rendered marker already appears in an existing
 *    comment/review body (anchored match, not bare-substring);
 * 2. consolidate a repeated finding_id to its first record;
 * 3. consolidate distinct findings with identical location + evidence into one
 *    comment (the first finding_id wins and names the group).
 */
function selectSurvivors(
	findings: readonly RendererFinding[],
	existingComments: readonly string[],
): { survivors: SurvivingFinding[]; skippedAsPosted: string[] } {
	const skippedAsPosted: string[] = [];
	const seenIds = new Set<string>();
	const seenLocations = new Set<string>();
	const survivors: SurvivingFinding[] = [];
	for (const finding of findings) {
		const id = singleLine(finding.finding_id ?? '', 128);
		const marker = postedMarker(id);
		if (existingComments.some((comment) => comment.includes(marker))) {
			if (!seenIds.has(id)) skippedAsPosted.push(id);
			seenIds.add(id);
			continue;
		}
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		// #3844: the location is reviewer-authored free text ("path:line"
		// plus prose), and the prose can quote a credential. It is redacted
		// BEFORE it is parsed, so neither the published body line nor the
		// inline-comment path can carry one.
		const rawFileLine = finding.file_line ?? '';
		const fileLine = redactEvidenceText(rawFileLine);
		// An inline comment targets a REAL repository path. When the
		// redaction CHANGED the path, the path itself carried a
		// credential-shaped component, so the redacted path names a file
		// that does not exist — publishing it would make the submission
		// invalid (GitHub rejects a comment on a nonexistent path). The
		// finding then stays a body-only entry: the body line shows the
		// redacted location and no inline comment is emitted.
		const rawLocation = parseLocation(rawFileLine);
		const redactedLocation = parseLocation(fileLine);
		const location =
			rawLocation &&
			redactedLocation &&
			rawLocation.path === redactedLocation.path &&
			rawLocation.line === redactedLocation.line
				? rawLocation
				: null;
		const evidence = singleLine(finding.evidence ?? '', 400);
		const locationKey = location
			? `${location.path}:${location.line}:${evidence}`
			: `${fileLine}:::${evidence}`;
		if (seenLocations.has(locationKey)) continue;
		seenLocations.add(locationKey);
		survivors.push({ finding, location });
	}
	return { survivors, skippedAsPosted };
}

export function renderPrReviewSubmissionBody(
	input: RenderReviewBodyInput,
): RenderedReviewBody {
	const existingComments = Array.isArray(input.existingComments)
		? input.existingComments
		: [];
	const liveFindings = (input.findings ?? []).filter(
		(finding) => severityOf(finding) !== 'NONE',
	);
	const dismissedCount = (input.findings ?? []).length - liveFindings.length;
	const { survivors, skippedAsPosted } = selectSurvivors(
		liveFindings,
		existingComments,
	);

	// Stable severity grouping: rank first, input order within a group.
	const grouped = survivors
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const rankDiff =
				severityRank(severityOf(a.entry.finding)) -
				severityRank(severityOf(b.entry.finding));
			return rankDiff !== 0 ? rankDiff : a.index - b.index;
		})
		.map((row) => row.entry);

	const lines: string[] = [];
	lines.push(
		`PR review submission for run ${input.run_id} at head ${input.pr_head_sha}.` +
			(input.verdict ? ` Report verdict: ${input.verdict}.` : ''),
	);
	lines.push('');
	lines.push('## Findings');
	let orderUnstableCount = 0;
	for (const severity of SEVERITY_ORDER) {
		if (severity === 'NONE') continue;
		const group = grouped.filter(
			(entry) => severityOf(entry.finding) === severity,
		);
		if (group.length === 0) continue;
		lines.push('');
		lines.push(`### ${severity}`);
		for (const entry of group) {
			const id = singleLine(entry.finding.finding_id ?? '', 128);
			const location = singleLine(
				redactEvidenceText(entry.finding.file_line ?? ''),
				200,
			);
			// status is findings.jsonl-derived like every other interpolated
			// field, so it gets the same singleLine flattening/cap before it
			// can reach the published body.
			const status =
				typeof entry.finding.status === 'string' &&
				entry.finding.status !== '' &&
				entry.finding.status.toUpperCase() !== 'CONFIRMED'
					? ` (${singleLine(redactEvidenceText(entry.finding.status), 64).toLowerCase()})`
					: '';
			// Issue #2906: only a flipping verdict (order_agreement 'disagree')
			// renders the order-unstable marker; when nothing is unstable the
			// token must not appear anywhere in the body.
			const orderUnstable =
				entry.finding.order_agreement === 'disagree' ? ' (order-unstable)' : '';
			if (orderUnstable) orderUnstableCount += 1;
			lines.push(
				`- [${id}]${status}${orderUnstable} ${location} — ${singleLine(redactEvidenceText(entry.finding.evidence ?? ''), 400)}`,
			);
		}
	}
	// Issue #2906: an order-unstable finding whose settled status is DISPROVED
	// is never published as a finding (a disproved row is not a finding), but
	// suppressing it would drop the counterbalancing signal on exactly the
	// flips most worth reading. It is listed here with its final status.
	const suppressedUnstable = (input.order_unstable_suppressed ?? []).filter(
		(finding) => finding.order_agreement === 'disagree',
	);
	if (suppressedUnstable.length > 0) {
		orderUnstableCount += suppressedUnstable.length;
		lines.push('');
		lines.push('## Order-unstable (not published as findings)');
		lines.push(
			'These items flipped verdict between the counterbalanced presentation orders and did not survive as findings. They are listed for order-effect review only.',
		);
		for (const finding of suppressedUnstable) {
			const id = singleLine(finding.finding_id ?? '', 128);
			const location = singleLine(
				redactEvidenceText(finding.file_line ?? ''),
				200,
			);
			const status = singleLine(
				redactEvidenceText(finding.status ?? ''),
				64,
			).toLowerCase();
			lines.push(
				`- [${id}] (order-unstable, ${status}) ${location} — ${singleLine(redactEvidenceText(finding.evidence ?? ''), 400)}`,
			);
		}
	}
	// ONE summary sentence carries the TOTAL across the findings list and the
	// suppressed section, whatever the mix (two summaries with different
	// totals read as a contradiction).
	if (orderUnstableCount > 0) {
		lines.push('');
		lines.push(
			`> ${orderUnstableCount} finding(s) order-unstable across counterbalanced reviewer passes (verdict flipped with presentation order).`,
		);
	}
	if (dismissedCount > 0) {
		lines.push('');
		lines.push(
			`> ${dismissedCount} settled finding(s) with no live severity (dismissed) omitted.`,
		);
	}

	lines.push('');
	lines.push('## Coverage');
	if (
		input.coverage?.kind &&
		input.coverage.kind !== 'FULL' &&
		Array.isArray(input.coverage.unresolved_dimensions) &&
		input.coverage.unresolved_dimensions.length > 0
	) {
		lines.push(`- Coverage kind: ${input.coverage.kind}`);
		lines.push(
			`- Unresolved dimensions: ${input.coverage.unresolved_dimensions
				.map((name) => singleLine(name, 120))
				.join(', ')}`,
		);
	} else {
		lines.push('- Coverage kind: FULL');
	}
	if (input.base_verification === 'bound_fallback') {
		lines.push(
			'- Base verification: bound fallback (scope bound without live verification)',
		);
	}

	const commentable = grouped.filter((entry) => entry.location !== null);
	const capped = commentable.slice(0, PR_REVIEW_INLINE_COMMENT_CAP);
	const truncatedInlineComments = commentable.length - capped.length;
	if (truncatedInlineComments > 0) {
		lines.push('');
		lines.push(
			`> Truncated: ${truncatedInlineComments} finding(s) omitted from inline comments (inline comment cap: ${PR_REVIEW_INLINE_COMMENT_CAP}). All findings remain listed above.`,
		);
	}

	let body = lines.join('\n');
	let bodyTruncated = false;
	if (body.length > PR_REVIEW_BODY_CHAR_CAP) {
		body = `${body.slice(0, PR_REVIEW_BODY_CHAR_CAP)}\n\n> Truncated: review body exceeded the ${PR_REVIEW_BODY_CHAR_CAP}-character cap; remaining findings omitted.`;
		bodyTruncated = true;
	}

	const inlineComments: RenderedInlineComment[] = capped.map((entry) => ({
		path: singleLine(entry.location!.path, 300),
		line: entry.location!.line,
		body: `[${singleLine(entry.finding.finding_id ?? '', 128)}] ${singleLine(redactEvidenceText(entry.finding.evidence ?? ''), 400)}`,
		finding_id: entry.finding.finding_id,
	}));

	return {
		body,
		inlineComments,
		skippedAsPosted,
		truncatedInlineComments,
		dismissedCount,
		orderUnstableCount,
		bodyTruncated,
	};
}
