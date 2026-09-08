/**
 * Reviewer DIRECTIVE_COMPLIANCE support (Swarm Learning System, Change 2 /
 * Task 2.1).
 *
 * The reviewer must emit a per-membership verdict for every knowledge directive shown
 * during the phase. This module owns:
 *   - DIRECTIVE_COMPLIANCE_OUTPUT_SPEC: the static format documentation embedded
 *     in the reviewer system prompt (always present).
 *   - buildDirectiveComplianceBlock: the dynamic, per-phase list of exact
 *     trace + entry memberships
 *     to verify (with priorities + any verification_predicate), injected into the
 *     reviewer's delegation prompt at runtime.
 *
 * The verdict grammar is intentionally parser-friendly and mirrors the ack
 * markers used elsewhere so a single reviewer-verdict parser can consume it.
 */

import type { DirectivePriority } from '../hooks/knowledge-types.js';

/** Marker tag wrapping the per-phase "directives to verify" block. */
export const DIRECTIVES_TO_VERIFY_TAG = '<directives_to_verify>';

/**
 * Hard character ceiling for the rendered compliance block (issue #2628,
 * mirroring the #2045 delegate-block bound). The effective budget is
 * `min(inject_char_budget ?? DIRECTIVE_COMPLIANCE_DEFAULT_CHAR_BUDGET,
 * DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP)`; overflow drops NON-critical entries
 * only — critical obligations are always rendered (see below), so a phase's
 * blocking set can never be hidden from the one agent that resolves it.
 */
export const DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP = 24_000;

/** Default budget when the caller has no configured injection budget. */
export const DIRECTIVE_COMPLIANCE_DEFAULT_CHAR_BUDGET = 24_000;

/**
 * Per-entry lesson/verification_predicate render cap. The pair identity,
 * priority, and predicate PRESENCE stay exact; only the prose payload is
 * truncated so a single huge entry cannot eat the whole budget.
 */
const MAX_FIELD_RENDER_CHARS = 400;

/** A directive the reviewer must produce a verdict for. */
export interface DirectiveToVerify {
	/** Exact retrieval membership this verdict must close. */
	trace_id: string;
	entry_id: string;
	/** Session recorded with the originating retrieval membership. */
	session_id: string;
	cohort_id?: string;
	source_link_id?: string;
	prior_terminal_outcome?: 'violated' | 'contradicted';
	prior_terminal_event_id?: string;
	priority: DirectivePriority;
	lesson?: string;
	verification_predicate?: string;
}

/**
 * Static spec embedded in the reviewer system prompt. Documents the mandatory
 * DIRECTIVE_COMPLIANCE output section and its verdict grammar. Since #2628 the
 * shown set carries at most one obligation per entry, so "every listed pair"
 * is the whole contract — pair identity is still copied exactly.
 */
export const DIRECTIVE_COMPLIANCE_OUTPUT_SPEC = `DIRECTIVE_COMPLIANCE: one line per listed obligation. Copy the encoded trace_id and entry_id tokens exactly from the DIRECTIVES TO VERIFY block. Use exactly one of:
  VERIFIED:<trace_id>:<entry_id> evidence=<file:line | predicate_passed>
  VIOLATED:<trace_id>:<entry_id> evidence=<file:line | failing_predicate>
  N/A:<trace_id>:<entry_id> reason=<why it does not apply to this change>
Every listed trace_id + entry_id pair MUST appear exactly once in your verdicts. If a directive carries a verification_predicate, you MUST run it and report predicate_passed / failing_predicate as the evidence. Omitting a listed CRITICAL pair is itself a VIOLATED verdict.`;

const PRIORITY_RANK: Record<DirectivePriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

const CORRELATION_TOKEN_PATTERN = /^[^:\s]{1,512}$/;

/** Encode arbitrary correlation identifiers into one delimiter-safe token. */
export function encodeDirectiveCorrelationId(value: string): string {
	return encodeURIComponent(value);
}

/** Decode one correlation token, rejecting malformed or unbounded values. */
export function decodeDirectiveCorrelationId(token: string): string | null {
	if (!CORRELATION_TOKEN_PATTERN.test(token)) return null;
	try {
		const decoded = decodeURIComponent(token);
		return decoded.length > 0 && decoded.length <= 512 ? decoded : null;
	} catch {
		return null;
	}
}

function renderOptionalText(value: string): string {
	return JSON.stringify(value);
}

/** Truncate prose payloads so one huge entry cannot consume the budget. The
 * post-stringify `</` escape (`\/` is valid JSON and round-trips through
 * JSON.parse) keeps a crafted lesson from embedding a literal
 * `</directives_to_verify>` close tag that would truncate the parsed
 * verify-set at reconcile time. */
function renderTruncatedOptionalText(value: string): string {
	const truncated =
		value.length > MAX_FIELD_RENDER_CHARS
			? `${value.slice(0, MAX_FIELD_RENDER_CHARS)}...`
			: value;
	// The per-field cap is a prose-hygiene limit measured in UTF-16 code units;
	// budget admission is measured in UTF-8 bytes (Buffer.byteLength below), so
	// multi-byte content cannot widen the block's ceiling — it only changes how
	// much prose one field carries.
	return renderOptionalText(truncated).replace(/<\//g, '<\\/');
}

function parseOptionalText(value: string): string | undefined {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function renderDirectiveLines(d: DirectiveToVerify): string[] {
	const lines = [
		`- trace_id: ${encodeDirectiveCorrelationId(d.trace_id)}`,
		`  entry_id: ${encodeDirectiveCorrelationId(d.entry_id)}`,
		`  session_id: ${encodeDirectiveCorrelationId(d.session_id)}`,
	];
	if (d.cohort_id) {
		lines.push(`  cohort_id: ${encodeDirectiveCorrelationId(d.cohort_id)}`);
	}
	if (d.source_link_id) {
		lines.push(
			`  source_link_id: ${encodeDirectiveCorrelationId(d.source_link_id)}`,
		);
	}
	if (d.prior_terminal_outcome) {
		lines.push(`  prior_terminal_outcome: ${d.prior_terminal_outcome}`);
	}
	if (d.prior_terminal_event_id) {
		lines.push(
			`  prior_terminal_event_id: ${encodeDirectiveCorrelationId(d.prior_terminal_event_id)}`,
		);
	}
	lines.push(`  priority: ${d.priority}`);
	if (d.lesson)
		lines.push(`  lesson: ${renderTruncatedOptionalText(d.lesson)}`);
	if (d.verification_predicate) {
		lines.push(
			`  verification_predicate: ${renderTruncatedOptionalText(d.verification_predicate)}`,
		);
	}
	return lines;
}

/**
 * Render the per-phase "DIRECTIVES TO VERIFY" block injected into the reviewer's
 * delegation prompt. Deterministic (sorted by priority then entry + trace) and
 * bounded (issue #2628): non-critical entries that no longer fit the effective
 * budget are dropped lowest-priority-first with a count note; CRITICAL entries
 * are always rendered — even beyond the budget, with a distinct overflow notice
 * — because hiding one would permanently block the phase-complete gate. Returns
 * null when there is nothing to verify (no block emitted).
 */
export function buildDirectiveComplianceBlock(
	directives: DirectiveToVerify[],
	charBudget?: number,
): string | null {
	if (directives.length === 0) return null;
	// Reserve the fixed post-loop tail (notices allowance + closing tag + blank
	// line + the static output spec) so admission accounting covers the ENTIRE
	// rendered block, keeping the ceiling genuinely hard (PR #2636 review).
	const tailReserve =
		Buffer.byteLength(
			`</directives_to_verify>\n\n${DIRECTIVE_COMPLIANCE_OUTPUT_SPEC}`,
			'utf-8',
		) + 256; // + bounded allowance for the two count-only notice lines
	const effectiveBudget = Math.max(
		0,
		Math.min(
			charBudget ?? DIRECTIVE_COMPLIANCE_DEFAULT_CHAR_BUDGET,
			DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP,
		) - tailReserve,
	);
	const sorted = [...directives].sort((a, b) => {
		const pr =
			(PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
		if (pr !== 0) return pr;
		if (a.entry_id !== b.entry_id) {
			return a.entry_id < b.entry_id ? -1 : 1;
		}
		return a.trace_id < b.trace_id ? -1 : a.trace_id > b.trace_id ? 1 : 0;
	});
	const lines: string[] = [];
	lines.push('<directives_to_verify>');
	lines.push(
		'Produce a DIRECTIVE_COMPLIANCE verdict for EVERY trace_id + entry_id pair below. Copy the encoded tokens exactly and run any verification_predicate provided.',
	);
	let usedBytes = Buffer.byteLength(lines.join('\n'), 'utf-8');
	const omittedNonCritical: string[] = [];
	let criticalOverflowCount = 0;
	for (const d of sorted) {
		const entryLines = renderDirectiveLines(d);
		const entryBytes = Buffer.byteLength(entryLines.join('\n'), 'utf-8') + 1;
		if (d.priority === 'critical') {
			lines.push(...entryLines);
			usedBytes += entryBytes;
			if (usedBytes > effectiveBudget) criticalOverflowCount += 1;
			continue;
		}
		if (usedBytes + entryBytes > effectiveBudget) {
			omittedNonCritical.push(d.entry_id);
			continue;
		}
		lines.push(...entryLines);
		usedBytes += entryBytes;
	}
	if (criticalOverflowCount > 0) {
		lines.push(
			`critical overflow: ${criticalOverflowCount} critical directive(s) rendered beyond the char budget`,
		);
	}
	if (omittedNonCritical.length > 0) {
		lines.push(
			`(+${omittedNonCritical.length} non-critical directive(s) omitted this phase; they remain live and will resurface)`,
		);
	}
	lines.push('</directives_to_verify>');
	lines.push('');
	lines.push(DIRECTIVE_COMPLIANCE_OUTPUT_SPEC);
	return lines.join('\n');
}

/**
 * Recover the directives a reviewer was asked to verify by parsing a
 * `<directives_to_verify>` block back out of its delegation prompt. Used by the
 * after-hook so reconciliation honors exactly what was shown (anti-spoofing).
 * Returns [] when no block is present.
 */
export function parseDirectivesToVerifyBlock(
	text: string,
): DirectiveToVerify[] {
	if (!text || !text.includes(DIRECTIVES_TO_VERIFY_TAG)) return [];
	const start = text.indexOf(DIRECTIVES_TO_VERIFY_TAG);
	const end = text.indexOf('</directives_to_verify>', start);
	const body = end >= 0 ? text.slice(start, end) : text.slice(start);
	const out: DirectiveToVerify[] = [];
	let current: Partial<DirectiveToVerify> | null = null;
	const flush = (): void => {
		if (
			current &&
			typeof current.trace_id === 'string' &&
			typeof current.entry_id === 'string' &&
			typeof current.session_id === 'string' &&
			Boolean(current.prior_terminal_outcome) ===
				Boolean(current.prior_terminal_event_id) &&
			current.priority
		) {
			out.push(current as DirectiveToVerify);
		}
		current = null;
	};
	for (const line of body.split('\n')) {
		const traceM = /^- trace_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (traceM) {
			flush();
			const traceId = decodeDirectiveCorrelationId(traceM[1]);
			current = traceId ? { trace_id: traceId } : null;
			continue;
		}
		if (!current) continue;
		const entryM = /^\s+entry_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (entryM) {
			const entryId = decodeDirectiveCorrelationId(entryM[1]);
			if (entryId) current.entry_id = entryId;
			continue;
		}
		const sessionM = /^\s+session_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (sessionM) {
			const sessionId = decodeDirectiveCorrelationId(sessionM[1]);
			if (sessionId) current.session_id = sessionId;
			continue;
		}
		const prM = /^\s+priority:\s*(low|medium|high|critical)\s*$/.exec(line);
		if (prM) {
			current.priority = prM[1] as DirectivePriority;
			continue;
		}
		const cohortM = /^\s+cohort_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (cohortM) {
			const cohortId = decodeDirectiveCorrelationId(cohortM[1]);
			if (cohortId) current.cohort_id = cohortId;
			continue;
		}
		const sourceLinkM = /^\s+source_link_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (sourceLinkM) {
			const sourceLinkId = decodeDirectiveCorrelationId(sourceLinkM[1]);
			if (sourceLinkId) current.source_link_id = sourceLinkId;
			continue;
		}
		const priorOutcomeM =
			/^\s+prior_terminal_outcome:\s*(violated|contradicted)\s*$/.exec(line);
		if (priorOutcomeM) {
			current.prior_terminal_outcome = priorOutcomeM[1] as
				| 'violated'
				| 'contradicted';
			continue;
		}
		const priorEventM =
			/^\s+prior_terminal_event_id:\s*([^:\s]{1,512})\s*$/.exec(line);
		if (priorEventM) {
			const eventId = decodeDirectiveCorrelationId(priorEventM[1]);
			if (eventId) current.prior_terminal_event_id = eventId;
			continue;
		}
		const predM = /^\s+verification_predicate:\s*("(?:[^"\\]|\\.)*")\s*$/.exec(
			line,
		);
		if (predM) {
			current.verification_predicate = parseOptionalText(predM[1]);
			continue;
		}
		const lessonM = /^\s+lesson:\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line);
		if (lessonM) current.lesson = parseOptionalText(lessonM[1]);
	}
	flush();
	return out;
}
