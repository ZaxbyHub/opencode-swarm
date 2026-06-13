/**
 * Reviewer receipt collector (auto-review machinery, piece A).
 *
 * Parses the mandated reviewer OUTPUT FORMAT (`VERDICT:` / `RISK:` /
 * `ISSUES:` / `FIXES:`) from a returning reviewer Task delegation and
 * persists it as a durable review receipt under `.swarm/review-receipts/`
 * via the existing receipt store (scope-fingerprinted over the delegation
 * prompt, which defines the reviewed scope).
 *
 * Before this collector, reviewer verdicts existed only as free text inside
 * the architect's context — re-reviews and drift verification had no durable
 * machine-readable record of what the reviewer decided. Knowledge-directive
 * lines (`DIRECTIVE_COMPLIANCE`) are handled separately by
 * `reviewer-verdict-parser.ts`; this module covers the main verdict block.
 *
 * Fail-open: parsing or persistence failures never block tool execution.
 */

import { stripKnownSwarmPrefix } from '../config/schema.js';
import * as logger from '../utils/logger.js';
import {
	type BlockingFinding,
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
} from './review-receipt.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';

// ============================================================================
// Output parsing
// ============================================================================

export type ParsedReviewSeverity = 'critical' | 'high' | 'medium';

export interface ParsedReviewIssue {
	/** Raw issue line (trimmed, bullet stripped) */
	text: string;
	/** Severity inferred from a CRITICAL/HIGH/MEDIUM/LOW/INFO tag, default medium */
	severity: ParsedReviewSeverity;
	/** `path:line` reference when one appears in the line */
	location?: string;
}

export interface ParsedReviewerOutput {
	verdict: 'approved' | 'rejected';
	/** RISK: LOW | MEDIUM | HIGH | CRITICAL (uppercased), when present */
	risk?: string;
	/** Blocking/non-blocking issue lines from the ISSUES section */
	issues: ParsedReviewIssue[];
	/** Required-change lines from the FIXES section */
	fixes: string[];
}

const SECTION_FIELDS = [
	'VERDICT',
	'REUSE_RE_VERIFICATION',
	'RISK',
	'ISSUES',
	'SKILL_COMPLIANCE',
	'DIRECTIVE_COMPLIANCE',
	'FIXES',
];

/** Matches `path/to/file.ts:123` style references. */
const LOCATION_PATTERN = /([\w./-]+\.[A-Za-z]{1,8}):(\d{1,6})/;

function inferSeverity(line: string): ParsedReviewSeverity {
	const upper = line.toUpperCase();
	if (upper.includes('CRITICAL')) return 'critical';
	if (upper.includes('HIGH')) return 'high';
	return 'medium';
}

/**
 * Collects the body lines of a named section (e.g. `ISSUES:`) up to the next
 * known section header. Returns trimmed, non-empty lines with leading list
 * bullets stripped.
 */
function collectSectionLines(lines: string[], section: string): string[] {
	const headerPattern = new RegExp(`^\\s*${section}\\s*:\\s*(.*)$`, 'i');
	const nextSectionPattern = new RegExp(
		`^\\s*(${SECTION_FIELDS.join('|')})\\s*:`,
		'i',
	);
	const collected: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (!inSection) {
			const m = line.match(headerPattern);
			if (m) {
				inSection = true;
				const inline = m[1]?.trim();
				if (inline && !/^(none|n\/a)\.?$/i.test(inline)) collected.push(inline);
			}
			continue;
		}
		if (nextSectionPattern.test(line)) break;
		const cleaned = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
		if (cleaned) collected.push(cleaned);
	}
	return collected;
}

/**
 * Line-anchored verdict matcher. Anchoring is load-bearing (adversarial
 * review 1a): the reviewed diff or the reviewer's quoted evidence can contain
 * the literal string `VERDICT: APPROVED` mid-line (e.g. when the diff touches
 * reviewer fixtures or prompt templates), and an unanchored first-match would
 * record a false APPROVED receipt and suppress the rejection advisory —
 * fail-open in the unsafe direction.
 */
const VERDICT_LINE_PATTERN =
	/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(APPROVED|REJECTED)\b/gim;
const RISK_LINE_PATTERN =
	/^\s*(?:\*\*)?RISK(?:\*\*)?\s*:\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/gim;

/**
 * Parse the reviewer agent's mandated output block. Returns null when no
 * unambiguous line-anchored `VERDICT: APPROVED|REJECTED` is present —
 * including when multiple anchored verdict lines DISAGREE (ambiguous output
 * fails toward "no machine-readable verdict", never toward approval).
 */
export function parseReviewerOutput(text: string): ParsedReviewerOutput | null {
	if (!text || typeof text !== 'string') return null;
	const verdictTokens = [...text.matchAll(VERDICT_LINE_PATTERN)].map((m) =>
		m[1].toUpperCase(),
	);
	if (verdictTokens.length === 0) return null;
	const uniqueVerdicts = new Set(verdictTokens);
	if (uniqueVerdicts.size > 1) return null;
	const verdict = verdictTokens[0] === 'APPROVED' ? 'approved' : 'rejected';

	// Risk is informational — take the last anchored occurrence (the mandated
	// block follows any preamble/quoting).
	const riskTokens = [...text.matchAll(RISK_LINE_PATTERN)].map((m) =>
		m[1].toUpperCase(),
	);
	const risk = riskTokens.at(-1);
	const lines = text.split(/\r?\n/);

	const issues: ParsedReviewIssue[] = collectSectionLines(lines, 'ISSUES')
		.slice(0, 50)
		.map((line) => {
			const location = line.match(LOCATION_PATTERN)?.[0];
			return {
				text: line.slice(0, 500),
				severity: inferSeverity(line),
				location,
			};
		});

	const fixes = collectSectionLines(lines, 'FIXES')
		.slice(0, 50)
		.map((line) => line.slice(0, 500));

	return {
		verdict,
		risk,
		issues,
		fixes,
	};
}

// ============================================================================
// tool.execute.after collector
// ============================================================================

export interface ReviewerReceiptInput {
	tool: unknown;
	args?: unknown;
	sessionID?: unknown;
}

export interface ReviewerReceiptOutput {
	output?: unknown;
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

/**
 * `tool.execute.after` collector. When a reviewer Task returns, parse its
 * verdict block and persist a durable review receipt. No-op for non-reviewer
 * delegations, missing prompts/outputs, or unparseable verdicts. Never throws.
 *
 * Returns the persisted receipt path (for tests/telemetry) or null.
 */
export async function collectReviewerReceiptAfter(
	directory: string,
	input: ReviewerReceiptInput,
	output: ReviewerReceiptOutput,
): Promise<string | null> {
	try {
		if (!isTaskTool(input.tool)) return null;
		const parsedArgs = parseDelegationArgs(input.args);
		if (!parsedArgs) return null;
		if (
			stripKnownSwarmPrefix(parsedArgs.targetAgent).toLowerCase() !== 'reviewer'
		) {
			return null;
		}
		const argsRecord =
			input.args && typeof input.args === 'object'
				? (input.args as Record<string, unknown>)
				: null;
		const prompt =
			argsRecord && typeof argsRecord.prompt === 'string'
				? argsRecord.prompt
				: '';
		const transcript = typeof output.output === 'string' ? output.output : '';
		if (!prompt || !transcript) return null;

		const parsed = parseReviewerOutput(transcript);
		if (!parsed) return null;

		const sessionId =
			typeof input.sessionID === 'string' ? input.sessionID : undefined;

		const receipt =
			parsed.verdict === 'approved'
				? buildApprovedReceipt({
						agent: 'reviewer',
						sessionId,
						scopeContent: prompt,
						scopeDescription: 'reviewer-task-prompt',
						checkedAspects: ['code-review'],
						validatedClaims: [
							`VERDICT: APPROVED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
						],
						caveats: parsed.issues.map((i) => i.text),
					})
				: buildRejectedReceipt({
						agent: 'reviewer',
						sessionId,
						scopeContent: prompt,
						scopeDescription: 'reviewer-task-prompt',
						blockingFindings: parsed.issues.map(
							(i): BlockingFinding => ({
								location: i.location ?? 'unknown',
								summary: i.text,
								severity: i.severity,
							}),
						),
						evidenceReferences: parsed.issues
							.map((i) => i.location)
							.filter((loc): loc is string => Boolean(loc)),
						passConditions: parsed.fixes,
						summary: `Reviewer REJECTED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
					});

		return await persistReviewReceipt(directory, receipt);
	} catch (err) {
		logger.warn(
			`[review-receipt-collector] failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
