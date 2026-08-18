/**
 * Reviewer receipt collector (auto-review machinery, piece A).
 *
 * Parses the mandated reviewer OUTPUT FORMAT (`VERDICT:` / `RISK:` /
 * `ISSUES:` / `FIXES:`) from a returning reviewer Task delegation and
 * persists it as a durable review receipt under `.swarm/review-receipts/`
 * via the existing receipt store. Scope is derived from guardrails-observed
 * modified files and their current content, never architect-authored prose.
 *
 * Before this collector, reviewer verdicts existed only as free text inside
 * the architect's context — re-reviews and drift verification had no durable
 * machine-readable record of what the reviewer decided. Knowledge-directive
 * lines (`DIRECTIVE_COMPLIANCE`) are handled separately by
 * `reviewer-verdict-parser.ts`; this module covers the main verdict block.
 *
 * Fail-open: parsing or persistence failures never block tool execution.
 */

import {
	extractReviewFindingsFromAgentOutput,
	type FindingValidation,
	type ReviewFinding,
} from '../agents/agent-output-schema.js';
import {
	type AutoReviewConfig,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import {
	canonicalizeValidationCandidates,
	type FindingValidationResult,
	type FindingValidationScheduler,
	runFindingValidation,
	type ValidationCandidate,
} from '../review/finding-validator.js';
import {
	optionalModelOverride,
	type ReviewAgentModelRegistry,
	resolveReviewFallbackModels,
} from '../review/runtime.js';
import {
	discardReviewerScopeGenerationClaim,
	isReviewerScopeGenerationCurrent,
	peekReviewerScopeGenerationClaim,
} from '../state.js';
import { telemetry } from '../telemetry.js';
import * as logger from '../utils/logger.js';
import {
	type BlockingFinding,
	buildApprovedReceipt,
	buildRejectedReceipt,
	computeScopeFingerprint,
	persistReviewReceipt,
	type ReviewFindingSeverity,
	updateReviewReceiptValidations,
} from './review-receipt.js';
import {
	buildReviewerTaskScope,
	type ReviewerTaskScope,
	resolveReviewerScopeTaskId,
	resolveReviewerTaskScope,
} from './review-receipt-scope.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { classifyTaskResult } from './task-result-classifier.js';

// ============================================================================
// Output parsing
// ============================================================================

export type ParsedReviewSeverity = ReviewFindingSeverity;

export interface ParsedReviewIssue {
	/** Raw issue line (trimmed, bullet stripped) */
	text: string;
	/** Severity inferred from a CRITICAL/HIGH/MEDIUM/LOW/INFO tag, default medium */
	severity: ParsedReviewSeverity;
	/** `path:line` reference when one appears in the line */
	location?: string;
	/** Machine-readable source finding, when structured output parsed. */
	finding?: ReviewFinding;
}

export interface ParsedReviewerOutput {
	verdict: 'approved' | 'rejected';
	/** RISK: LOW | MEDIUM | HIGH | CRITICAL (uppercased), when present */
	risk?: string;
	/** Blocking/non-blocking issue lines from the ISSUES section */
	issues: ParsedReviewIssue[];
	/** Required-change lines from the FIXES section */
	fixes: string[];
	outputMode: 'structured' | 'legacy';
	overallConfidence?: number;
	structuredFindings?: ReviewFinding[];
}

const SECTION_FIELDS = [
	'VERDICT',
	'REUSE_RE_VERIFICATION',
	'RISK',
	'ISSUES',
	'ACCEPTANCE_SATISFACTION',
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
	if (upper.includes('LOW')) return 'low';
	if (upper.includes('INFO')) return 'info';
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
		if (nextSectionPattern.test(line) || /^\s*```/.test(line)) break;
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
// Trailing \s*$ is load-bearing (adversarial review 1b): without it,
// `VERDICT: APPROVED | REJECTED` (a format-spec line that reviewers sometimes
// quote verbatim) matches with capture "APPROVED", then disagrees with the
// actual `VERDICT: REJECTED` line and returns null — silently suppressing the
// rejection advisory (fail-open). The $ ensures only clean verdict lines match.
const VERDICT_LINE_PATTERN =
	/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(APPROVED|REJECTED)\s*$/gim;
const RISK_LINE_PATTERN =
	/^\s*(?:\*\*)?RISK(?:\*\*)?\s*:\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/gim;

/**
 * Parse the reviewer agent's mandated output block. Returns null when no
 * single unambiguous line-anchored `VERDICT: APPROVED|REJECTED` is present,
 * including missing, duplicate, or contradictory verdict lines. A structured
 * verdict must match that single legacy line so ambiguous output fails toward
 * "no machine-readable verdict", never toward approval.
 */
export function parseReviewerOutput(
	text: string,
	options: { structured?: boolean } = {},
): ParsedReviewerOutput | null {
	if (!text || typeof text !== 'string') return null;
	const structured =
		options.structured === false
			? {
					findings: [],
					review: undefined,
					error: 'structured parsing disabled',
				}
			: extractReviewFindingsFromAgentOutput(text);
	const verdictTokens = [...text.matchAll(VERDICT_LINE_PATTERN)].map((m) =>
		m[1].toUpperCase(),
	);
	if (verdictTokens.length !== 1) return null;
	const legacyVerdict = verdictTokens[0];
	if (structured.review) {
		if (structured.review.verdict !== legacyVerdict) return null;
		const riskTokens = [...text.matchAll(RISK_LINE_PATTERN)].map((m) =>
			m[1].toUpperCase(),
		);
		const fixes = collectSectionLines(text.split(/\r?\n/), 'FIXES')
			.slice(0, 50)
			.map((line) => line.slice(0, 500));
		return {
			verdict:
				structured.review.verdict === 'APPROVED' ? 'approved' : 'rejected',
			risk: riskTokens.at(-1),
			issues: structured.findings.map((finding) => ({
				text: `${finding.title}: ${finding.body}`.slice(0, 500),
				severity: finding.severity,
				location: `${finding.file}:${finding.line_start}`,
				finding,
			})),
			fixes,
			outputMode: 'structured',
			overallConfidence: structured.review.overall_confidence,
			structuredFindings: structured.findings,
		};
	}
	const verdict = legacyVerdict === 'APPROVED' ? 'approved' : 'rejected';

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
		outputMode: 'legacy',
	};
}

// ============================================================================
// tool.execute.after collector
// ============================================================================

export interface ReviewerReceiptInput {
	tool: unknown;
	args?: unknown;
	sessionID?: unknown;
	callID?: unknown;
}

export interface ReviewerReceiptOutput {
	output?: unknown;
	state?: unknown;
	status?: unknown;
	error?: unknown;
	errors?: unknown;
	metadata?: unknown;
	result?: unknown;
}

export interface ReviewerReceiptTranscriptInput {
	targetAgent?: string;
	prompt?: string;
	transcript: string;
	sessionID?: string;
	sessionId?: string;
	taskId?: string;
	reviewerCallID?: string;
	/** Production collectors consume the exact claimed coder generation. */
	consumeHandoff?: boolean;
}

export interface ReviewerReceiptValidationOptions {
	dispatcher?: ReviewModelDispatcher;
	config?: AutoReviewConfig;
	generatedAgentNames?: Iterable<string>;
	agentModelRegistry?: ReviewAgentModelRegistry;
	injectAdvisory?: (sessionID: string, message: string) => void;
	/** Shared only within the owning plugin instance. */
	validationScheduler?: FindingValidationScheduler;
}

const STAGE_B_VALIDATION_TASK_ID = 'reviewer-task-validation';

/** Test seam for the otherwise process-global telemetry sink. */
export const _internals = {
	// Both halves of the delegation lifecycle go through the seam so a test that
	// stubs one necessarily controls the other; an asymmetric seam would let a
	// stubbed-throwing sink emit half a pair.
	delegationBegin: telemetry.delegationBegin,
	delegationEnd: telemetry.delegationEnd,
	resolveReviewerTaskScope,
	buildReviewerTaskScope,
	persistReviewReceipt,
	updateReviewReceiptValidations,
};

function findingId(finding: ReviewFinding | undefined): string | undefined {
	return finding
		? canonicalizeValidationCandidates([finding])[0]?.finding_id
		: undefined;
}

function effectiveSeverityForFinding(
	finding: ReviewFinding,
	minConfidence: number,
): ReviewFindingSeverity {
	// Match the shared review engine exactly: equality retains the declared
	// severity, while only confidence strictly below the threshold is demoted.
	return finding.confidence < minConfidence ? 'info' : finding.severity;
}

function isValidationCandidate(
	finding: ReviewFinding,
	minConfidence: number,
): boolean {
	const effectiveSeverity = effectiveSeverityForFinding(finding, minConfidence);
	return effectiveSeverity === 'high' || effectiveSeverity === 'critical';
}

function validatorForReviewer(reviewer: string): string {
	const base = stripKnownSwarmPrefix(reviewer);
	const prefix =
		base === reviewer
			? ''
			: reviewer.slice(0, reviewer.length - 'reviewer'.length);
	return `${prefix}critic_finding_validator`;
}

function validationErrorText(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return detail.trim() || 'unknown validation error';
}

function emitStageBValidationTelemetry(
	sessionID: string,
	validatorAgent: string,
	result: string,
	costFields: Parameters<typeof telemetry.delegationEnd>[4],
): void {
	try {
		// Inside the SAME try as its end, so a throwing sink skips both halves
		// rather than emitting an orphan. Like the engine's validation replay, this
		// runs after the attempt already completed; the payload carries no duration
		// or start timestamp, so pairing here is structural, not temporal.
		_internals.delegationBegin(
			sessionID,
			validatorAgent,
			STAGE_B_VALIDATION_TASK_ID,
		);
		_internals.delegationEnd(
			sessionID,
			validatorAgent,
			STAGE_B_VALIDATION_TASK_ID,
			result,
			costFields,
		);
	} catch (error) {
		logger.warn(
			`[review-receipt-collector] validation telemetry failed: ${validationErrorText(error)}`,
		);
	}
}

function materializeValidationOutcome(
	candidates: ValidationCandidate[],
	result: FindingValidationResult,
): FindingValidation[] {
	if (result.complete) return result.validations;
	const candidateIds = new Set(
		candidates.map((candidate) => candidate.finding_id),
	);
	const byId = new Map(
		result.validations
			.filter((validation) => candidateIds.has(validation.finding_id))
			.map((validation) => [validation.finding_id, validation]),
	);
	const reason = (
		result.error ?? 'validator did not return a complete exact-ID result'
	).slice(0, 1900);
	return candidates.map(
		(candidate) =>
			byId.get(candidate.finding_id) ?? {
				finding_id: candidate.finding_id,
				disposition: 'UNVERIFIED',
				confidence: 0,
				evidence: `Validation incomplete: ${reason}`,
			},
	);
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

function hasExactScopeIdentity(
	scope: ReviewerTaskScope,
): scope is ReviewerTaskScope & {
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
} {
	return (
		typeof scope.taskId === 'string' &&
		typeof scope.coderCallID === 'string' &&
		typeof scope.generation === 'number' &&
		typeof scope.sessionIncarnation === 'string'
	);
}

async function reviewerScopeRemainsCurrent(input: {
	directory: string;
	sessionID: string;
	scope: ReviewerTaskScope;
	maxBytes: number;
	reviewerCallID?: string;
}): Promise<boolean> {
	if (!hasExactScopeIdentity(input.scope)) return true;
	if (input.reviewerCallID) {
		const claim = peekReviewerScopeGenerationClaim({
			parentSessionID: input.sessionID,
			taskId: input.scope.taskId,
			reviewerCallID: input.reviewerCallID,
		});
		if (
			!claim ||
			claim.coderCallID !== input.scope.coderCallID ||
			claim.generation !== input.scope.generation ||
			claim.sessionIncarnation !== input.scope.sessionIncarnation
		) {
			return false;
		}
	}
	const currentScope = await _internals.buildReviewerTaskScope(
		input.directory,
		input.scope.files,
		input.maxBytes,
		{
			taskId: input.scope.taskId,
			coderCallID: input.scope.coderCallID,
			generation: input.scope.generation,
			sessionIncarnation: input.scope.sessionIncarnation,
		},
	);
	return (
		currentScope !== null &&
		isReviewerScopeGenerationCurrent({
			parentSessionID: input.sessionID,
			taskId: input.scope.taskId,
			coderCallID: input.scope.coderCallID,
			generation: input.scope.generation,
			sessionIncarnation: input.scope.sessionIncarnation,
		}) &&
		currentScope.headSha === input.scope.headSha &&
		currentScope.content === input.scope.content &&
		currentScope.description === input.scope.description &&
		JSON.stringify(currentScope.files) === JSON.stringify(input.scope.files)
	);
}

function discardConsumedReviewerClaim(input: {
	sessionID: string;
	reviewerCallID?: string;
	scope: ReviewerTaskScope;
}): void {
	if (!input.reviewerCallID || !hasExactScopeIdentity(input.scope)) return;
	discardReviewerScopeGenerationClaim({
		parentSessionID: input.sessionID,
		taskId: input.scope.taskId,
		reviewerCallID: input.reviewerCallID,
	});
}

export async function collectReviewerReceiptFromTranscript(
	directory: string,
	input: ReviewerReceiptTranscriptInput,
	validationOptions: ReviewerReceiptValidationOptions = {},
): Promise<string | null> {
	try {
		const validationConfig = validationOptions.config;
		if (validationConfig?.enabled !== true) return null;
		if (
			input.targetAgent &&
			stripKnownSwarmPrefix(input.targetAgent).toLowerCase() !== 'reviewer'
		) {
			return null;
		}
		const sessionID = input.sessionID ?? input.sessionId;
		if (!sessionID) return null;
		const scope = await _internals.resolveReviewerTaskScope(
			directory,
			sessionID,
			validationConfig.max_diff_kb * 1024,
			input.consumeHandoff
				? {
						consumeHandoff: true,
						expectedTaskId: input.taskId,
						reviewerCallID: input.reviewerCallID,
					}
				: undefined,
		);
		if (!scope) return null;
		if (
			!(await reviewerScopeRemainsCurrent({
				directory,
				sessionID,
				scope,
				maxBytes: validationConfig.max_diff_kb * 1024,
				reviewerCallID: input.reviewerCallID,
			}))
		) {
			discardConsumedReviewerClaim({
				sessionID,
				reviewerCallID: input.reviewerCallID,
				scope,
			});
			return null;
		}
		if (!input.transcript) {
			discardConsumedReviewerClaim({
				sessionID,
				reviewerCallID: input.reviewerCallID,
				scope,
			});
			return null;
		}

		const parsed = parseReviewerOutput(input.transcript, {
			structured: validationConfig.structured_findings !== false,
		});
		if (!parsed) {
			discardConsumedReviewerClaim({
				sessionID,
				reviewerCallID: input.reviewerCallID,
				scope,
			});
			return null;
		}
		const minConfidence = validationConfig.min_confidence;

		const receipt =
			parsed.verdict === 'approved'
				? buildApprovedReceipt({
						agent: 'reviewer',
						sessionId: sessionID,
						scopeContent: scope.content,
						scopeDescription: scope.description,
						checkedAspects: ['code-review'],
						validatedClaims: [
							`VERDICT: APPROVED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
						],
						caveats: parsed.issues.map((i) => i.text),
						structuredFindings: parsed.structuredFindings,
						reviewOverallConfidence: parsed.overallConfidence,
					})
				: buildRejectedReceipt({
						agent: 'reviewer',
						sessionId: sessionID,
						scopeContent: scope.content,
						scopeDescription: scope.description,
						blockingFindings: parsed.issues.map(
							(i): BlockingFinding => ({
								location: i.location ?? 'unknown',
								summary: i.text,
								severity: i.severity,
								finding_id: findingId(i.finding),
								line: i.finding?.line_start,
								title: i.finding?.title,
								body: i.finding?.body,
								confidence: i.finding?.confidence,
								file: i.finding?.file,
								line_start: i.finding?.line_start,
								line_end: i.finding?.line_end,
								effective_severity: i.finding
									? effectiveSeverityForFinding(i.finding, minConfidence)
									: undefined,
							}),
						),
						evidenceReferences: parsed.issues
							.map((i) => i.location)
							.filter((loc): loc is string => Boolean(loc)),
						passConditions: parsed.fixes,
						summary: `Reviewer REJECTED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
						structuredFindings: parsed.structuredFindings,
						reviewOverallConfidence: parsed.overallConfidence,
					});

		if (
			!(await reviewerScopeRemainsCurrent({
				directory,
				sessionID,
				scope,
				maxBytes: validationConfig.max_diff_kb * 1024,
				reviewerCallID: input.reviewerCallID,
			}))
		) {
			discardConsumedReviewerClaim({
				sessionID,
				reviewerCallID: input.reviewerCallID,
				scope,
			});
			return null;
		}
		let scopeBecameStale = false;
		let receiptPath: string;
		try {
			receiptPath = await _internals.persistReviewReceipt(directory, receipt, {
				verifyCurrent: async () => {
					const current = await reviewerScopeRemainsCurrent({
						directory,
						sessionID,
						scope,
						maxBytes: validationConfig.max_diff_kb * 1024,
						reviewerCallID: input.reviewerCallID,
					});
					if (!current) scopeBecameStale = true;
					return current;
				},
			});
		} catch (error) {
			if (scopeBecameStale) {
				discardConsumedReviewerClaim({
					sessionID,
					reviewerCallID: input.reviewerCallID,
					scope,
				});
			}
			throw error;
		}
		discardConsumedReviewerClaim({
			sessionID,
			reviewerCallID: input.reviewerCallID,
			scope,
		});
		const candidates =
			parsed.structuredFindings?.filter((finding) =>
				isValidationCandidate(finding, minConfidence),
			) ?? [];
		if (
			sessionID &&
			validationOptions.dispatcher &&
			validationConfig?.enabled &&
			validationConfig.validate_findings &&
			candidates.length > 0
		) {
			const reviewer = input.targetAgent ?? 'reviewer';
			const canonicalCandidates = canonicalizeValidationCandidates(candidates);
			const validatorAgent = validatorForReviewer(reviewer);
			const immutableScope: ReviewerTaskScope = {
				...scope,
				files: [...scope.files],
			};
			const receiptIdentity = {
				id: receipt.id,
				scopeHash: receipt.scope_fingerprint.hash,
				scopeDescription: receipt.scope_fingerprint.scope_description,
			};
			const persistAndAdvise = async (
				result: FindingValidationResult,
			): Promise<void> => {
				for (const attempt of result.attempts) {
					emitStageBValidationTelemetry(
						sessionID,
						validatorAgent,
						attempt.status,
						{
							...attempt.costFields,
							gate: 'finding_validation',
						},
					);
				}
				const validationScopeIsCurrent = async (): Promise<boolean> => {
					if (!hasExactScopeIdentity(immutableScope)) return true;
					const current = await reviewerScopeRemainsCurrent({
						directory,
						sessionID,
						scope: immutableScope,
						maxBytes: validationConfig.max_diff_kb * 1024,
					});
					const currentFingerprint = current
						? computeScopeFingerprint(
								immutableScope.content,
								immutableScope.description,
							)
						: null;
					return (
						current &&
						currentFingerprint?.hash === receiptIdentity.scopeHash &&
						currentFingerprint.scope_description ===
							receiptIdentity.scopeDescription
					);
				};
				const discardStaleValidation = (): void => {
					const message =
						'Independent finding validation was discarded as stale because the exact reviewed scope changed before validation completed.';
					logger.warn(`[review-receipt-collector] ${message}`);
					try {
						validationOptions.injectAdvisory?.(sessionID, message);
					} catch (error) {
						logger.warn(
							`[review-receipt-collector] validation advisory injection failed: ${validationErrorText(error)}`,
						);
					}
				};
				if (!(await validationScopeIsCurrent())) {
					discardStaleValidation();
					return;
				}
				const validations = materializeValidationOutcome(
					canonicalCandidates,
					result,
				);
				let validationScopeBecameStale = false;
				try {
					await _internals.updateReviewReceiptValidations(
						receiptPath,
						validations,
						{
							expectedIdentity: receiptIdentity,
							verifyCurrent: async () => {
								const current = await validationScopeIsCurrent();
								if (!current) validationScopeBecameStale = true;
								return current;
							},
						},
					);
				} catch (error) {
					if (validationScopeBecameStale) {
						discardStaleValidation();
						return;
					}
					logger.warn(
						`[review-receipt-collector] validation persistence failed: ${validationErrorText(error)}`,
					);
					try {
						validationOptions.injectAdvisory?.(
							sessionID,
							`Independent finding validation completed but was not persisted: ${validationErrorText(error)}. Receipt: ${receiptPath}`,
						);
					} catch (advisoryError) {
						logger.warn(
							`[review-receipt-collector] validation advisory injection failed: ${validationErrorText(advisoryError)}`,
						);
					}
					return;
				}
				const counts = {
					confirmed: validations.filter(
						(item) => item.disposition === 'CONFIRMED',
					).length,
					disproved: validations.filter(
						(item) => item.disposition === 'DISPROVED',
					).length,
					unverified: validations.filter(
						(item) => item.disposition === 'UNVERIFIED',
					).length,
				};
				try {
					validationOptions.injectAdvisory?.(
						sessionID,
						result.complete
							? `Independent finding validation completed: ${counts.confirmed} confirmed, ${counts.disproved} disproved, ${counts.unverified} unverified. Receipt: ${receiptPath}`
							: `Independent finding validation was incomplete: ${result.error ?? 'unknown error'}. ${counts.unverified} finding(s) recorded as UNVERIFIED. Receipt: ${receiptPath}`,
					);
				} catch (error) {
					logger.warn(
						`[review-receipt-collector] validation advisory injection failed: ${validationErrorText(error)}`,
					);
				}
			};
			const validationIdentity = [
				sessionID,
				receipt.id,
				immutableScope.taskId ?? 'legacy-task',
				immutableScope.coderCallID ?? 'legacy-coder-call',
				String(immutableScope.generation ?? 'legacy-generation'),
				immutableScope.sessionIncarnation ?? 'legacy-incarnation',
			].join('\0');
			const validationScheduler = validationOptions.validationScheduler;
			if (!validationScheduler) {
				await persistAndAdvise({
					complete: false,
					candidates: canonicalCandidates,
					validations: [],
					attempts: [],
					error:
						'validation scheduling refused because the owning plugin instance did not provide its bounded validation scheduler',
				});
				return receiptPath;
			}
			const scheduled = validationScheduler.schedule(
				validationIdentity,
				() =>
					runFindingValidation({
						dispatcher: validationOptions.dispatcher!,
						directory,
						parentSessionId: sessionID,
						agentName: validatorAgent,
						model: optionalModelOverride(validationConfig.validation_model),
						fallbackModels: resolveReviewFallbackModels(
							validatorAgent,
							validationOptions.agentModelRegistry,
						),
						timeoutMs: validationConfig.validation_timeout_ms,
						findings: canonicalCandidates,
						scopeContext: {
							selector: { kind: 'working-tree' },
							canonicalText: immutableScope.content,
							scopeHash: receiptIdentity.scopeHash,
							headSha: immutableScope.headSha,
							completeness: {
								complete: true,
								truncated: false,
								skipReasons: [],
							},
							scopeDescription: immutableScope.description,
							files: [...immutableScope.files],
						},
					}),
				persistAndAdvise,
				(error) =>
					persistAndAdvise({
						complete: false,
						candidates: canonicalCandidates,
						validations: [],
						attempts: [],
						error: `validator execution failed: ${validationErrorText(error)}`,
					}),
			);
			if (!scheduled) {
				await persistAndAdvise({
					complete: false,
					candidates: canonicalCandidates,
					validations: [],
					attempts: [],
					error:
						'validation scheduling refused because this exact receipt generation is already being validated or the 256-validation capacity is full',
				});
			}
		}
		return receiptPath;
	} catch (err) {
		logger.warn(
			`[review-receipt-collector] failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
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
	validationOptions: ReviewerReceiptValidationOptions = {},
): Promise<string | null> {
	try {
		if (validationOptions.config?.enabled !== true) return null;
		if (!isTaskTool(input.tool)) return null;
		const taskResult = classifyTaskResult(output);
		if (taskResult === 'running') return null;
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
		const sessionID =
			typeof input.sessionID === 'string' ? input.sessionID : undefined;
		const reviewerCallID =
			typeof input.callID === 'string' ? input.callID : undefined;
		if (!sessionID) return null;
		const taskId = reviewerCallID
			? await resolveReviewerScopeTaskId(directory, input.args)
			: undefined;
		if (reviewerCallID && !taskId) {
			discardReviewerScopeGenerationClaim({
				parentSessionID: sessionID,
				reviewerCallID,
			});
			return null;
		}
		if (reviewerCallID && taskId && taskResult !== 'success') {
			discardReviewerScopeGenerationClaim({
				parentSessionID: sessionID,
				taskId,
				reviewerCallID,
			});
			return null;
		}

		return await collectReviewerReceiptFromTranscript(
			directory,
			{
				targetAgent: parsedArgs.targetAgent,
				prompt,
				transcript,
				sessionID,
				taskId: taskId ?? undefined,
				reviewerCallID,
				consumeHandoff: reviewerCallID !== undefined,
			},
			validationOptions,
		);
	} catch (err) {
		logger.warn(
			`[review-receipt-collector] failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
