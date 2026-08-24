import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutoReviewConfig } from '../config/schema.js';
import { MAX_EPHEMERAL_PROMPT_BYTE_LIMIT } from '../evaluation/ephemeral-agent-dispatcher.js';
import {
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
	type ReviewFindingSeverity,
	ReviewScopeStaleError,
	removeReviewReceipt,
} from '../hooks/review-receipt.js';
import { parseReviewerOutput } from '../hooks/review-receipt-collector.js';
import { telemetry } from '../telemetry.js';
import type { ModelOverride } from '../utils/model-dispatch-fallback.js';
import {
	isQuotaError,
	isTransientProviderError,
} from '../utils/provider-error-classification.js';
import type {
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from './contracts.js';
import {
	collectReviewDiff,
	type InclusiveLineRange,
	type ReviewDiffResult,
	type ReviewDiffSelector,
} from './diff-source.js';
import {
	type AutoReviewEvidence,
	type AutoReviewEvidenceFinding,
	materializeAutoReviewManifest,
	persistAutoReviewEvidence,
	readAutoReviewEvidenceForPhase,
	validateAutoReviewEvidenceIntegrity,
} from './evidence.js';
import {
	canonicalizeValidationCandidates,
	runFindingValidation,
} from './finding-validator.js';

export type ReviewEngineTrigger =
	| 'task_completion'
	| 'phase_completion'
	| 'plan_completion'
	| 'manual';

export interface RunReviewEngineInput {
	directory: string;
	sessionID: string;
	trigger: ReviewEngineTrigger;
	phase?: number;
	selector?: ReviewDiffSelector;
	config: AutoReviewConfig;
	dispatcher: ReviewModelDispatcher;
	reviewerAgent: string;
	validatorAgent: string;
	reviewerModel?: ModelOverride;
	reviewerFallbackModels?: ModelOverride[];
	validatorModel?: ModelOverride;
	validatorFallbackModels?: readonly ModelOverride[];
	injectAdvisory?: (sessionID: string, message: string) => void;
}

export interface ReviewEngineResult {
	status: 'completed' | 'clean' | 'error';
	/** Parsed reviewer verdict when a model response completed successfully. */
	reviewVerdict?: 'approved' | 'rejected';
	blocked: boolean;
	blockReason?:
		| 'DIFF_COLLECTION_FAILED'
		| 'REVIEW_DISPATCH_FAILED'
		| 'INCOMPLETE_REVIEW_EVIDENCE'
		| 'INCOMPLETE_SCOPE'
		| 'INCOMPLETE_VALIDATION'
		| 'REVIEW_SCOPE_STALE'
		| 'EVIDENCE_PERSISTENCE_FAILED'
		| 'CONFIRMED_FINDINGS';
	message: string;
	findings: AutoReviewEvidenceFinding[];
	blockingFindings: AutoReviewEvidenceFinding[];
	validationComplete: boolean;
	receiptPath?: string;
	evidencePath?: string;
	scopeHash?: string;
	manifestHash?: string;
	scopeComplete?: boolean;
	scopeWarnings?: string[];
	scopeFileList?: string[];
	scopeFileListComplete?: boolean;
	reviewModel?: string;
	modelCalls: number;
}

interface ReviewPromptFileInventory {
	files: string[];
	totalFiles: number;
	omittedFiles: number;
	complete: boolean;
}

interface ReviewPromptRequest {
	prompt: string;
	requestBytes: number;
	promptByteLimit: number;
	fits: boolean;
	fileInventory?: ReviewPromptFileInventory;
}

type CollectedReviewScope = Extract<
	ReviewDiffResult,
	{ status: 'ok' | 'clean' }
>;

function scopeFreshnessMismatches(
	reviewed: CollectedReviewScope,
	current: CollectedReviewScope,
): string[] {
	const mismatches: string[] = [];
	const compare = (field: string, left: unknown, right: unknown): void => {
		if (left !== right) mismatches.push(field);
	};
	compare('status', reviewed.status, current.status);
	compare('scopeHash', reviewed.scopeHash, current.scopeHash);
	compare('manifestHash', reviewed.manifest.hash, current.manifest.hash);
	compare('canonicalText', reviewed.canonicalText, current.canonicalText);
	compare('reviewTextBytes', reviewed.reviewTextBytes, current.reviewTextBytes);
	compare(
		'selector',
		JSON.stringify(reviewed.selector),
		JSON.stringify(current.selector),
	);
	compare(
		'completeness',
		JSON.stringify(reviewed.completeness),
		JSON.stringify(current.completeness),
	);
	compare(
		'includesWorkingTree',
		reviewed.staleness.includesWorkingTree,
		current.staleness.includesWorkingTree,
	);
	return mismatches;
}

function createScopeVerifier(
	input: RunReviewEngineInput,
	reviewed: CollectedReviewScope,
	maxBytes: number,
): () => Promise<boolean> {
	return async () => {
		const current = await _internals.collectReviewDiff({
			directory: input.directory,
			selector: input.selector,
			maxBytes,
		});
		return (
			current.status !== 'error' &&
			scopeFreshnessMismatches(reviewed, current).length === 0
		);
	};
}

async function stalePersistenceResult(
	input: RunReviewEngineInput,
	maxBytes: number,
	message: string,
	modelCalls: number,
): Promise<ReviewEngineResult> {
	const current = await _internals.collectReviewDiff({
		directory: input.directory,
		selector: input.selector,
		maxBytes,
	});
	const result = emptyResult(
		'error',
		`${message} Stale review artifacts were discarded and provide no current coverage.`,
		input.config.final_review.mode === 'gate',
		input.config.final_review.mode === 'gate'
			? 'REVIEW_SCOPE_STALE'
			: undefined,
	);
	result.modelCalls = modelCalls;
	if (current.status !== 'error') {
		result.scopeHash = current.scopeHash;
		result.manifestHash = current.manifest.hash;
		result.scopeComplete = current.completeness.complete;
		Object.assign(result, scopeResultFields(current));
	}
	input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
	return result;
}

function scopeResultFields(
	diff: Extract<ReviewDiffResult, { status: 'ok' | 'clean' }>,
	promptRequest?: ReviewPromptRequest,
): Pick<
	ReviewEngineResult,
	'scopeWarnings' | 'scopeFileList' | 'scopeFileListComplete'
> {
	if (diff.completeness.complete) return { scopeWarnings: [] };
	const fallback = diff.completeness.fileListFallback;
	const promptInventory = promptRequest?.fileInventory;
	const warnings = [
		'Review scope was incomplete; findings cover only the supplied diff subset and must not be treated as a whole-diff verdict.',
	];
	if (promptInventory && promptInventory.omittedFiles > 0) {
		warnings.push(
			`Review prompt changed-file inventory included ${promptInventory.files.length} of ${promptInventory.totalFiles} file name(s); ${promptInventory.omittedFiles} name(s) were omitted to stay within the ${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT}-byte isolated-session ceiling. The full bounded collector inventory remains in durable scope evidence.`,
		);
	} else if (fallback) {
		warnings.push(
			`Bounded changed-file fallback lists ${fallback.files.length} file(s) and is ${fallback.complete ? 'complete' : 'itself incomplete'}.`,
		);
	}
	return {
		scopeWarnings: warnings,
		scopeFileList: promptInventory?.files ?? fallback?.files,
		scopeFileListComplete: promptInventory?.complete ?? fallback?.complete,
	};
}

export const REVIEW_SYSTEM_PROMPT = [
	'You are an isolated repository-aware code review model.',
	'Review only defects introduced by the supplied exact diff. Inspect the repository when needed, but never edit it.',
	'Do not report pre-existing issues, speculation, style-only preferences, or locations outside changed hunks.',
	'A finding must identify a concrete impact and a current-side line overlapping the diff.',
	'If there is no finding the author would definitely want to fix, prefer an empty findings array.',
	'',
	'Your complete response must be at most 800 output tokens.',
	'Emit each of these legacy fields exactly once, in this order:',
	'VERDICT: APPROVED | REJECTED',
	'REUSE_RE_VERIFICATION: VERIFIED | DUPLICATION_DETECTED | SKIPPED',
	'RISK: LOW | MEDIUM | HIGH | CRITICAL',
	'ISSUES: none (see structured findings JSON)',
	'ACCEPTANCE_SATISFACTION: SATISFIED | PARTIAL | NOT_SATISFIED — concise evidence',
	'TASK: task id or unknown',
	'SKILL_COMPLIANCE: COMPLIANT | PARTIAL | VIOLATED — concise evidence',
	'DIRECTIVE_COMPLIANCE: one line per supplied directive, or none',
	'FIXES: required changes if rejected, otherwise none',
	'',
	'Then emit exactly one fenced json block and no other JSON block.',
	'The JSON object is strict: no additional keys are allowed at the root or finding level.',
	'The root keys are exactly findings, verdict, and overall_confidence.',
	'findings is an array of at most 50 objects. Each finding has exactly these keys:',
	'- title: non-empty string, at most 200 characters',
	'- body: non-empty string, at most 2000 characters',
	'- severity: exactly critical | high | medium | low | info',
	'- confidence: finite number from 0 through 1',
	'- file: non-empty repository-relative path, at most 500 characters',
	'- line_start: integer from 1 through 10000000',
	'- line_end: integer from line_start through 10000000',
	'verdict is exactly APPROVED or REJECTED and must match the legacy VERDICT.',
	'overall_confidence is a finite number from 0 through 1.',
	'```json',
	'{"findings":[{"title":"Concrete defect","body":"Concrete impact and reproduction path.","severity":"high","confidence":0.95,"file":"src/example.ts","line_start":10,"line_end":10}],"verdict":"REJECTED","overall_confidence":0.95}',
	'```',
].join('\n');

interface BuildReviewPromptInput {
	trigger: ReviewEngineTrigger;
	diff: Extract<ReviewDiffResult, { status: 'ok' }>;
	phase?: number;
}

function renderReviewPrompt(
	input: BuildReviewPromptInput,
	renderedFallbackFiles: readonly string[],
	omittedFallbackFiles: number,
): string {
	const { diff } = input;
	const exactRange = diff.selector.kind === 'range';
	const reviewTargetKind =
		diff.selector.kind === 'range'
			? 'exact-committed-range'
			: diff.selector.kind === 'working-tree'
				? 'checkout-index-working-tree'
				: 'checkout-history-index-working-tree';
	const fallback = diff.completeness.fileListFallback;
	const promptFallbackComplete =
		fallback?.complete && omittedFallbackFiles === 0;
	return [
		`TASK: Review the complete ${input.trigger.replaceAll('_', ' ')} diff.`,
		input.phase ? `PHASE: ${input.phase}` : '',
		`REVIEW_SELECTOR: ${JSON.stringify(diff.selector)}`,
		`REVIEW_TARGET_KIND: ${reviewTargetKind}`,
		`SCOPE_HASH: ${diff.scopeHash}`,
		`BASE_REF: ${diff.baseRef ?? 'none'}`,
		`BASE_SHA: ${diff.baseSha ?? 'none'}`,
		`RESOLVED_BASE_SHA: ${diff.baseSha ?? 'none'}`,
		exactRange ? `RESOLVED_FROM_SHA: ${diff.baseSha ?? 'none'}` : '',
		exactRange ? `RESOLVED_TO_SHA: ${diff.rangeToSha ?? 'none'}` : '',
		exactRange ? `REVIEW_TARGET_SHA: ${diff.rangeToSha ?? 'none'}` : '',
		`MERGE_BASE: ${diff.mergeBase ?? 'none'}`,
		`CHECKOUT_HEAD_SHA: ${diff.headSha}`,
		exactRange
			? `CHECKOUT_MATCHES_REVIEW_TARGET: ${diff.headSha === diff.rangeToSha}`
			: '',
		`REVIEW_SCOPE_INCLUDES_WORKING_TREE: ${diff.staleness.includesWorkingTree}`,
		`SCOPE_COMPLETE: ${diff.completeness.complete}`,
		diff.completeness.complete
			? ''
			: 'SCOPE_WARNING: INCOMPLETE. The diff block is a bounded subset. Never describe this as a whole-diff approval or infer findings from unsupplied content.',
		fallback ? `FILE_LIST_FALLBACK_COMPLETE: ${promptFallbackComplete}` : '',
		fallback && omittedFallbackFiles > 0
			? `FILE_LIST_FALLBACK_SOURCE_COMPLETE: ${fallback.complete}`
			: '',
		fallback && omittedFallbackFiles > 0
			? `FILE_LIST_FALLBACK_INCLUDED: ${renderedFallbackFiles.length}`
			: '',
		fallback && omittedFallbackFiles > 0
			? `FILE_LIST_FALLBACK_TOTAL: ${fallback.files.length}`
			: '',
		fallback && omittedFallbackFiles > 0
			? `FILE_LIST_FALLBACK_OMITTED: ${omittedFallbackFiles}`
			: '',
		fallback && omittedFallbackFiles > 0
			? 'FILE_LIST_FALLBACK_WARNING: INCOMPLETE PROMPT INVENTORY. Some changed path names are omitted only to satisfy the isolated-session byte ceiling. Review only supplied diff content and listed names; do not infer omitted paths.'
			: '',
		fallback
			? omittedFallbackFiles > 0
				? `FILE_LIST_FALLBACK (${renderedFallbackFiles.length} of ${fallback.files.length} changed path(s), names only; do not infer file contents):`
				: `FILE_LIST_FALLBACK (${fallback.files.length} changed path(s), names only; do not infer file contents):`
			: '',
		...renderedFallbackFiles.map((file) => JSON.stringify(file)),
		'DIFF:',
		'```diff',
		diff.canonicalText,
		'```',
	]
		.filter(Boolean)
		.join('\n');
}

function reviewRequestBytes(prompt: string): number {
	return (
		Buffer.byteLength(REVIEW_SYSTEM_PROMPT, 'utf8') +
		Buffer.byteLength(prompt, 'utf8')
	);
}

function buildReviewPromptRequest(
	input: BuildReviewPromptInput,
): ReviewPromptRequest {
	const fallback = input.diff.completeness.fileListFallback;
	// Keep the collector-owned list intact for scope hashing and durable evidence.
	// Only this rendered prompt projection may omit tail entries.
	const allFiles = fallback?.files ?? [];
	let prompt = renderReviewPrompt(input, allFiles, 0);
	let requestBytes = reviewRequestBytes(prompt);
	if (requestBytes <= MAX_EPHEMERAL_PROMPT_BYTE_LIMIT) {
		return {
			prompt,
			requestBytes,
			promptByteLimit: requestBytes,
			fits: true,
			fileInventory: fallback
				? {
						files: allFiles,
						totalFiles: allFiles.length,
						omittedFiles: 0,
						complete: fallback.complete,
					}
				: undefined,
		};
	}

	let lowerBound = 0;
	let upperBound = allFiles.length;
	// Each JSON-rendered path contributes a non-empty line, so request size is
	// monotonic by prefix length. Select the largest prefix under the hard cap.
	while (lowerBound < upperBound) {
		const candidateCount = Math.ceil((lowerBound + upperBound) / 2);
		const candidatePrompt = renderReviewPrompt(
			input,
			allFiles.slice(0, candidateCount),
			allFiles.length - candidateCount,
		);
		if (
			reviewRequestBytes(candidatePrompt) <= MAX_EPHEMERAL_PROMPT_BYTE_LIMIT
		) {
			lowerBound = candidateCount;
		} else {
			upperBound = candidateCount - 1;
		}
	}

	const renderedFiles = allFiles.slice(0, lowerBound);
	const omittedFiles = allFiles.length - renderedFiles.length;
	prompt = renderReviewPrompt(input, renderedFiles, omittedFiles);
	requestBytes = reviewRequestBytes(prompt);
	return {
		prompt,
		requestBytes,
		promptByteLimit: Math.min(requestBytes, MAX_EPHEMERAL_PROMPT_BYTE_LIMIT),
		fits: requestBytes <= MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
		fileInventory: fallback
			? {
					files: renderedFiles,
					totalFiles: allFiles.length,
					omittedFiles,
					complete: fallback.complete && omittedFiles === 0,
				}
			: undefined,
	};
}

export function buildReviewPrompt(input: BuildReviewPromptInput): string {
	return buildReviewPromptRequest(input).prompt;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function normalizedRelativePath(file: string): string | null {
	if (
		file.length === 0 ||
		file.length > 500 ||
		hasControlCharacter(file) ||
		/^[A-Za-z]:[\\/]/.test(file) ||
		file.startsWith('\\\\') ||
		file.startsWith('//') ||
		path.isAbsolute(file)
	) {
		return null;
	}
	const normalized = file.replaceAll('\\', '/');
	const segments = normalized.split('/');
	if (
		segments.some((segment) => segment === '..' || segment === '') ||
		normalized.startsWith('/')
	) {
		return null;
	}
	return normalized.replace(/^\.\//, '');
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function rangesOverlap(
	start: number,
	end: number,
	ranges: InclusiveLineRange[],
): boolean {
	return ranges.some((range) => start <= range.end && end >= range.start);
}

function anchorExactRangeFinding(
	diff: Extract<ReviewDiffResult, { status: 'ok' }>,
	normalized: string,
	start: number,
	end: number,
): string | undefined {
	if (!diff.rangeToSha || !/^[0-9a-f]{6,64}$/i.test(diff.rangeToSha)) {
		return 'exact_range_target_unavailable';
	}
	const ranges = diff.changedLines.get(normalized);
	if (!ranges || !rangesOverlap(start, end, ranges)) {
		return 'line_range_does_not_overlap_diff';
	}

	// Exact-range diffs are collected from the resolved target commit, not the
	// current checkout. A parsed target-side path plus a current-side changed
	// line therefore proves that the finding anchors to rangeToSha. Deleted and
	// old-side rename paths have no target-side changed lines and remain
	// unanchored.
	const file = diff.files.get(normalized);
	if (
		!file?.newPath ||
		file.newPath !== normalized ||
		file.kind === 'deleted'
	) {
		return 'nonexistent_target_path';
	}
	return undefined;
}

function anchorFinding(
	directory: string,
	diff: Extract<ReviewDiffResult, { status: 'ok' }>,
	finding: ReturnType<typeof canonicalizeValidationCandidates>[number],
	minConfidence: number,
): AutoReviewEvidenceFinding {
	let anchorRejection: string | undefined;
	const normalized = normalizedRelativePath(finding.file);
	if (!diff.completeness.complete || diff.completeness.truncated) {
		anchorRejection = 'incomplete_or_truncated_scope';
	} else if (!normalized) {
		anchorRejection = 'unsafe_or_absolute_path';
	} else if (diff.selector.kind === 'range') {
		anchorRejection = anchorExactRangeFinding(
			diff,
			normalized,
			finding.line_start,
			finding.line_end,
		);
	} else {
		let root: string;
		let currentPath: string;
		try {
			root = fs.realpathSync(directory);
			currentPath = fs.realpathSync(
				path.resolve(root, ...normalized.split('/')),
			);
		} catch {
			return {
				...finding,
				file: normalized,
				anchored: false,
				anchor_rejection: 'nonexistent_current_path',
				effective_severity:
					finding.confidence < minConfidence ? 'info' : finding.severity,
			};
		}
		if (!isWithinRoot(root, currentPath)) {
			anchorRejection = 'path_outside_project';
		} else {
			const ranges = diff.changedLines.get(normalized);
			if (
				!ranges ||
				!rangesOverlap(finding.line_start, finding.line_end, ranges)
			) {
				anchorRejection = 'line_range_does_not_overlap_diff';
			}
		}
	}
	return {
		...finding,
		file: normalized ?? finding.file,
		anchored: anchorRejection === undefined,
		anchor_rejection: anchorRejection,
		effective_severity:
			finding.confidence < minConfidence ? 'info' : finding.severity,
	};
}

function isGateSeverity(severity: ReviewFindingSeverity): boolean {
	return severity === 'critical' || severity === 'high';
}

function reviewModelLabel(model: ModelOverride | undefined): string {
	return model ? `${model.providerID}/${model.modelID}` : 'default';
}

async function dispatchReviewerWithFallback(
	input: RunReviewEngineInput,
	prompt: string,
	timeoutMs: number,
	promptByteLimit: number,
): Promise<{ result: ReviewDispatchResult; attempts: ReviewDispatchResult[] }> {
	const models = [input.reviewerModel, ...(input.reviewerFallbackModels ?? [])];
	const attempts: ReviewDispatchResult[] = [];
	for (let index = 0; index < models.length; index++) {
		// Opens the lifecycle for the attempt the next statement dispatches, so the
		// `delegation_end` below is never a phantom completion with no start. One
		// begin PER ATTEMPT: the end is emitted per attempt too (retry_index), so a
		// single begin per logical review would leave fallback attempts unpaired.
		// Emitted before the await deliberately — if the dispatch throws, the
		// resulting begin-without-end is the correct signal that a delegation
		// started and never completed, not a leak.
		telemetry.delegationBegin(
			input.sessionID,
			input.reviewerAgent,
			input.trigger,
		);
		const result = await input.dispatcher.dispatch({
			directory: input.directory,
			parentSessionId: input.sessionID,
			agentName: input.reviewerAgent,
			model: models[index],
			system: REVIEW_SYSTEM_PROMPT,
			prompt,
			title: `auto review (${input.trigger})`,
			timeoutMs,
			promptByteLimit,
		});
		attempts.push(result);
		telemetry.delegationEnd(
			input.sessionID,
			input.reviewerAgent,
			input.trigger,
			result.status,
			{ ...result.costFields, gate: 'auto_review', retry_index: index },
		);
		if (result.status === 'completed') return { result, attempts };
		const detail = result.error ?? result.status;
		const taskCompletionTimeout =
			input.trigger === 'task_completion' &&
			(result.status === 'timeout' || /auto-review timed out/i.test(detail));
		const transient =
			result.status === 'timeout' || isTransientProviderError(detail);
		if (taskCompletionTimeout || !transient || index === models.length - 1) {
			return { result, attempts };
		}
		const nextModel = models[index + 1];
		const fromModel = reviewModelLabel(models[index]);
		const toModel = reviewModelLabel(nextModel);
		telemetry.modelFallback(
			input.sessionID,
			input.reviewerAgent,
			fromModel,
			toModel,
			'transient_model_error',
		);
		input.injectAdvisory?.(
			input.sessionID,
			`MODEL FALLBACK: auto-review reviewer failed over to "${toModel}" (fallback ${index + 1}) after a transient/quota dispatch error.`,
		);
	}
	// The primary attempt is always present, including when its model is undefined.
	return { result: attempts[0], attempts };
}

function addCost(
	evidence: AutoReviewEvidence,
	dispatches: ReviewDispatchResult[],
): void {
	evidence.cost.model_calls = dispatches.length;
	evidence.cost.prompt_bytes = dispatches.reduce(
		(sum, dispatch) => sum + dispatch.promptBytes,
		0,
	);
	for (const dispatch of dispatches) {
		const fields = dispatch.costFields;
		evidence.cost.tokens_input += fields?.tokens_input ?? 0;
		evidence.cost.tokens_output += fields?.tokens_output ?? 0;
		evidence.cost.tokens_reasoning += fields?.tokens_reasoning ?? 0;
		evidence.cost.tokens_cache += fields?.tokens_cache ?? 0;
		if (typeof fields?.cost_usd === 'number') {
			evidence.cost.cost_usd = (evidence.cost.cost_usd ?? 0) + fields.cost_usd;
			evidence.cost.cost_source =
				fields.cost_source === 'estimated'
					? 'estimated'
					: evidence.cost.cost_source === 'estimated'
						? 'estimated'
						: 'reported';
		}
	}
}

function baseEvidence(
	input: RunReviewEngineInput,
	diff: Extract<ReviewDiffResult, { status: 'ok' | 'clean' }>,
	status: AutoReviewEvidence['review']['status'],
): AutoReviewEvidence {
	return {
		schema_version: 2,
		timestamp: new Date().toISOString(),
		trigger: input.trigger,
		session_id: input.sessionID,
		phase: input.phase,
		scope: {
			hash: diff.scopeHash,
			selector: diff.selector,
			head_sha: diff.headSha,
			base_ref: diff.baseRef,
			base_sha: diff.baseSha,
			merge_base: diff.mergeBase,
			range_to_sha: diff.rangeToSha,
			review_text_bytes: diff.reviewTextBytes,
			completeness: diff.completeness,
		},
		policy: {
			mode: input.config.final_review.mode,
			min_confidence: input.config.min_confidence,
			structured_findings: input.config.structured_findings,
			validate_findings: input.config.validate_findings,
			digest: undefined,
		},
		review: { status },
		findings: [],
		validation_complete: true,
		blocking_finding_ids: [],
		cost: {
			model_calls: 0,
			diff_bytes: diff.reviewTextBytes,
			prompt_bytes: 0,
			tokens_input: 0,
			tokens_output: 0,
			tokens_reasoning: 0,
			tokens_cache: 0,
			cost_usd: null,
			cost_source: 'unavailable',
		},
	};
}

function advisoryMessage(
	input: RunReviewEngineInput,
	result: ReviewEngineResult,
): string {
	const prefix = `[AUTO-REVIEW ${input.trigger.toUpperCase()}]`;
	const scopeWarnings = result.scopeWarnings ?? [];
	if (result.status === 'error') {
		return [`${prefix} ${result.message}`, ...scopeWarnings].join('\n');
	}
	if (result.findings.length === 0) {
		return [
			result.scopeComplete === false
				? `${prefix} No findings were reported in the reviewed subset; the scope was incomplete.`
				: `${prefix} No findings reported.`,
			...scopeWarnings,
		].join('\n');
	}
	const items = result.findings.slice(0, 5).map((finding) => {
		const validation = finding.validation
			? ` ${finding.validation.disposition}`
			: '';
		const anchor = finding.anchored
			? ''
			: ` rejected-anchor=${finding.anchor_rejection}`;
		return `- [${finding.effective_severity.toUpperCase()}${validation}] ${finding.file}:${finding.line_start} ${finding.title}${anchor}`;
	});
	return [
		`${prefix} ${result.findings.length} finding(s); ${result.blockingFindings.length} confirmed blocker(s).`,
		...scopeWarnings,
		...items,
	].join('\n');
}

function emptyResult(
	status: ReviewEngineResult['status'],
	message: string,
	blocked: boolean,
	blockReason?: ReviewEngineResult['blockReason'],
): ReviewEngineResult {
	return {
		status,
		blocked,
		blockReason,
		message,
		findings: [],
		blockingFindings: [],
		validationComplete: false,
		modelCalls: 0,
	};
}

async function persistErrorResult(
	input: RunReviewEngineInput,
	diff: CollectedReviewScope,
	result: ReviewEngineResult,
	error: string,
	dispatches: ReviewDispatchResult[],
	promptRequest?: ReviewPromptRequest,
): Promise<ReviewEngineResult> {
	const evidence = baseEvidence(input, diff, 'error');
	evidence.scope.manifest = await materializeAutoReviewManifest(
		input.directory,
		diff.manifest,
		input.config,
	);
	evidence.policy.digest = evidence.scope.manifest.review_policy_digest;
	evidence.review.error = error;
	addCost(evidence, dispatches);
	try {
		result.evidencePath = await _internals.persistEvidence(
			input.directory,
			evidence,
		);
	} catch {
		if (input.config.final_review.mode === 'gate') {
			result.blocked = true;
			result.blockReason = 'EVIDENCE_PERSISTENCE_FAILED';
		}
	}
	result.scopeHash = diff.scopeHash;
	result.manifestHash = evidence.scope.manifest.hash;
	result.scopeComplete = diff.completeness.complete;
	Object.assign(result, scopeResultFields(diff, promptRequest));
	return result;
}

export async function runReviewEngine(
	input: RunReviewEngineInput,
): Promise<ReviewEngineResult> {
	const gateMode = input.config.final_review.mode === 'gate';
	const maxBytes =
		input.trigger === 'task_completion'
			? input.config.max_diff_kb * 1024
			: input.config.final_review.max_diff_bytes;
	const timeoutMs =
		input.trigger === 'task_completion'
			? input.config.timeout_ms
			: input.config.final_review.timeout_ms;
	const diff = await _internals.collectReviewDiff({
		directory: input.directory,
		selector: input.selector,
		maxBytes,
	});
	if (diff.status === 'error') {
		const result = emptyResult(
			'error',
			`Diff collection failed: ${diff.reason}`,
			gateMode,
			gateMode ? 'DIFF_COLLECTION_FAILED' : undefined,
		);
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}
	if (diff.status === 'clean') {
		const evidence = baseEvidence(input, diff, 'clean');
		evidence.scope.manifest = await materializeAutoReviewManifest(
			input.directory,
			diff.manifest,
			input.config,
		);
		evidence.policy.digest = evidence.scope.manifest.review_policy_digest;
		let evidencePath: string | undefined;
		try {
			evidencePath = await _internals.persistEvidence(
				input.directory,
				evidence,
				{ verifyCurrent: createScopeVerifier(input, diff, maxBytes) },
			);
		} catch (error) {
			if (error instanceof ReviewScopeStaleError) {
				return stalePersistenceResult(
					input,
					maxBytes,
					'Review scope changed before clean evidence could be committed.',
					0,
				);
			}
			// Gate mode requires a durable verdict, even for a clean scope.
		}
		const blocked = gateMode && !evidencePath;
		return {
			...emptyResult(
				'clean',
				'Review scope is clean.',
				blocked,
				blocked ? 'EVIDENCE_PERSISTENCE_FAILED' : undefined,
			),
			validationComplete: true,
			scopeHash: diff.scopeHash,
			manifestHash: evidence.scope.manifest.hash,
			scopeComplete: diff.completeness.complete,
			...scopeResultFields(diff),
			evidencePath,
		};
	}

	const promptRequest = buildReviewPromptRequest({
		trigger: input.trigger,
		diff,
		phase: input.phase,
	});
	const reviewManifest = await materializeAutoReviewManifest(
		input.directory,
		diff.manifest,
		input.config,
	);
	if (
		input.phase !== undefined &&
		(input.trigger === 'phase_completion' ||
			input.trigger === 'plan_completion')
	) {
		const existing = _internals.readPhaseEvidence(input.directory, input.phase);
		const integrity = existing
			? validateAutoReviewEvidenceIntegrity(input.directory, existing, {
					scopeHash: diff.scopeHash,
					phase: input.phase,
					trigger: input.trigger,
					policy: {
						mode: input.config.final_review.mode,
						min_confidence: input.config.min_confidence,
						structured_findings: input.config.structured_findings,
						validate_findings: input.config.validate_findings,
					},
					scopeContent: diff.canonicalText,
				})
			: undefined;
		if (
			existing?.review.status === 'completed' &&
			existing.schema_version === 2 &&
			existing.scope.manifest?.hash === reviewManifest.hash &&
			integrity?.ok &&
			integrity.receipt
		) {
			const validationsById = new Map(
				(integrity.receipt.finding_validations ?? []).map((validation) => [
					validation.finding_id,
					validation,
				]),
			);
			const findings = canonicalizeValidationCandidates(
				integrity.receipt.structured_findings ?? [],
			).map((candidate) => {
				const anchored = anchorFinding(
					input.directory,
					diff,
					candidate,
					input.config.min_confidence,
				);
				return {
					...anchored,
					validation: validationsById.get(candidate.finding_id),
				};
			});
			const validationCandidates = findings.filter(
				(finding) =>
					finding.anchored && isGateSeverity(finding.effective_severity),
			);
			const validationRequired =
				(input.config.validate_findings || gateMode) &&
				validationCandidates.length > 0;
			const validationComplete =
				!validationRequired ||
				validationCandidates.every((finding) => finding.validation);
			const blockingFindings = validationCandidates.filter(
				(finding) => finding.validation?.disposition === 'CONFIRMED',
			);
			const blocked =
				gateMode &&
				(!diff.completeness.complete ||
					!validationComplete ||
					blockingFindings.length > 0);
			return {
				status: 'completed',
				reviewVerdict: integrity.receipt.verdict,
				blocked,
				blockReason: blocked
					? !diff.completeness.complete
						? 'INCOMPLETE_SCOPE'
						: !validationComplete
							? 'INCOMPLETE_VALIDATION'
							: 'CONFIRMED_FINDINGS'
					: undefined,
				message: 'Reused fresh auto-review evidence for the unchanged scope.',
				findings,
				blockingFindings,
				validationComplete,
				receiptPath: existing.receipt_path,
				evidencePath: path.join(
					input.directory,
					'.swarm',
					'evidence',
					String(input.phase),
					'auto-review.json',
				),
				scopeHash: existing.scope.hash,
				manifestHash: existing.scope.manifest?.hash,
				scopeComplete: diff.completeness.complete,
				...scopeResultFields(diff, promptRequest),
				reviewModel: existing.review.model,
				modelCalls: 0,
			};
		}
	}

	if (!promptRequest.fits) {
		const error =
			`Rendered review prompt requires ${promptRequest.requestBytes} bytes after omitting all fallback file names, ` +
			`exceeding the ${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT}-byte isolated-session ceiling.`;
		const result = await persistErrorResult(
			input,
			diff,
			emptyResult(
				'error',
				`Review dispatch failed: ${error}`,
				gateMode,
				gateMode ? 'REVIEW_DISPATCH_FAILED' : undefined,
			),
			error,
			[],
			promptRequest,
		);
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}

	const dispatched = await dispatchReviewerWithFallback(
		input,
		promptRequest.prompt,
		timeoutMs,
		promptRequest.promptByteLimit,
	);
	if (dispatched.result.status !== 'completed') {
		const dispatchDetail = dispatched.result.error ?? dispatched.result.status;
		const quotaAnnotation = isQuotaError(dispatchDetail)
			? ' (model quota/usage limit exhausted across all configured fallbacks)'
			: '';
		const result = await persistErrorResult(
			input,
			diff,
			emptyResult(
				'error',
				`Review dispatch failed${quotaAnnotation}: ${dispatchDetail}`,
				gateMode,
				gateMode ? 'REVIEW_DISPATCH_FAILED' : undefined,
			),
			dispatchDetail,
			dispatched.attempts,
			promptRequest,
		);
		result.modelCalls = dispatched.attempts.length;
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}

	const parsed = parseReviewerOutput(dispatched.result.text, {
		structured: input.config.structured_findings,
	});
	if (!parsed) {
		const result = await persistErrorResult(
			input,
			diff,
			emptyResult(
				'error',
				'Reviewer returned no machine-readable verdict.',
				gateMode,
				gateMode ? 'INCOMPLETE_REVIEW_EVIDENCE' : undefined,
			),
			'Reviewer returned no machine-readable verdict.',
			dispatched.attempts,
			promptRequest,
		);
		result.modelCalls = dispatched.attempts.length;
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}
	const legacyVerdicts = [
		...dispatched.result.text.matchAll(
			/^\s*VERDICT\s*:\s*(APPROVED|REJECTED)\s*$/gim,
		),
	];
	const legacyVerdict = legacyVerdicts.at(-1)?.[1]?.toLowerCase();
	if (legacyVerdict && legacyVerdict !== parsed.verdict) {
		const result = await persistErrorResult(
			input,
			diff,
			emptyResult(
				'error',
				'Reviewer legacy and structured verdicts disagree.',
				gateMode,
				gateMode ? 'INCOMPLETE_REVIEW_EVIDENCE' : undefined,
			),
			'Reviewer legacy and structured verdicts disagree.',
			dispatched.attempts,
			promptRequest,
		);
		result.modelCalls = dispatched.attempts.length;
		return result;
	}

	const candidates = canonicalizeValidationCandidates(
		parsed.structuredFindings ?? [],
	);
	let findings = candidates.map((candidate) =>
		anchorFinding(
			input.directory,
			diff,
			candidate,
			input.config.min_confidence,
		),
	);
	const validationCandidates = findings.filter(
		(finding) => finding.anchored && isGateSeverity(finding.effective_severity),
	);
	let validationComplete = true;
	let validationError: string | undefined;
	const allDispatches = [...dispatched.attempts];
	if (
		(input.config.validate_findings || gateMode) &&
		validationCandidates.length > 0
	) {
		const validation = await runFindingValidation({
			dispatcher: input.dispatcher,
			directory: input.directory,
			parentSessionId: input.sessionID,
			agentName: input.validatorAgent,
			model: input.validatorModel,
			fallbackModels: input.validatorFallbackModels,
			timeoutMs: input.config.validation_timeout_ms,
			findings: validationCandidates,
			scopeContext: {
				selector: diff.selector,
				canonicalText: diff.canonicalText,
				scopeHash: diff.scopeHash,
				headSha: diff.headSha,
				baseRef: diff.baseRef,
				baseSha: diff.baseSha,
				mergeBase: diff.mergeBase,
				rangeToSha: diff.rangeToSha,
				completeness: diff.completeness,
			},
		});
		validationComplete = validation.complete;
		validationError = validation.error;
		for (const [retryIndex, attempt] of validation.attempts.entries()) {
			allDispatches.push(attempt);
			// This loop REPLAYS attempts that already completed inside
			// runFindingValidation, so begin and end are emitted adjacently rather
			// than around the real dispatch. That is honest here: the payload has no
			// duration or start-timestamp field, so pairing in this schema is
			// structural (count + identity), never temporal. Emitting from the same
			// variables on the next statement makes the triple match by construction.
			telemetry.delegationBegin(
				input.sessionID,
				input.validatorAgent,
				input.trigger,
			);
			telemetry.delegationEnd(
				input.sessionID,
				input.validatorAgent,
				input.trigger,
				attempt.status,
				{
					...attempt.costFields,
					gate: 'finding_validation',
					retry_index: retryIndex,
				},
			);
		}
		const byId = new Map(
			validation.validations.map((item) => [item.finding_id, item]),
		);
		findings = findings.map((finding) => ({
			...finding,
			validation: byId.get(finding.finding_id),
		}));
	}

	const currentScope = await _internals.collectReviewDiff({
		directory: input.directory,
		selector: input.selector,
		maxBytes,
	});
	if (currentScope.status === 'error') {
		const result = emptyResult(
			'error',
			`Review scope freshness check failed after model dispatch: ${currentScope.reason}. Stale reviewer and validator output was discarded and provides no current coverage.`,
			gateMode,
			gateMode ? 'REVIEW_SCOPE_STALE' : undefined,
		);
		result.modelCalls = allDispatches.length;
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}
	const freshnessMismatches = scopeFreshnessMismatches(diff, currentScope);
	if (freshnessMismatches.length > 0) {
		const staleMessage =
			`Review scope changed during model dispatch (${freshnessMismatches.join(', ')}). ` +
			'Stale reviewer and validator output was discarded and provides no current coverage.';
		const result = await persistErrorResult(
			input,
			currentScope,
			emptyResult(
				'error',
				staleMessage,
				gateMode,
				gateMode ? 'REVIEW_SCOPE_STALE' : undefined,
			),
			staleMessage,
			allDispatches,
		);
		result.modelCalls = allDispatches.length;
		input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
		return result;
	}

	const blockingFindings = findings.filter(
		(finding) =>
			finding.anchored &&
			isGateSeverity(finding.effective_severity) &&
			finding.validation?.disposition === 'CONFIRMED',
	);
	const evidence = baseEvidence(input, diff, 'completed');
	evidence.scope.manifest = reviewManifest;
	evidence.policy.digest = reviewManifest.review_policy_digest;
	evidence.review = {
		status: 'completed',
		output_mode: parsed.outputMode,
		overall_confidence: parsed.overallConfidence,
		model: dispatched.result.modelId,
		duration_ms: dispatched.result.durationMs,
	};
	evidence.findings = findings;
	evidence.validation_complete = validationComplete;
	evidence.validation_error = validationError;
	evidence.blocking_finding_ids = blockingFindings.map(
		(finding) => finding.finding_id,
	);
	addCost(evidence, allDispatches);

	let receiptPath: string | undefined;
	let receiptId: string | undefined;
	try {
		const receipt =
			parsed.verdict === 'approved'
				? buildApprovedReceipt({
						agent: input.reviewerAgent,
						sessionId: input.sessionID,
						scopeContent: diff.canonicalText,
						scopeDescription: `${input.trigger}-review`,
						checkedAspects: ['correctness', 'security', 'regressions'],
						validatedClaims: ['structured review completed'],
						caveats: findings
							.filter((finding) => !finding.anchored)
							.map(
								(finding) =>
									`${finding.title}: ${finding.anchor_rejection ?? 'unanchored'}`,
							),
						structuredFindings: parsed.structuredFindings,
						reviewOverallConfidence: parsed.overallConfidence,
						findingValidations: findings
							.map((finding) => finding.validation)
							.filter((item): item is NonNullable<typeof item> =>
								Boolean(item),
							),
					})
				: buildRejectedReceipt({
						agent: input.reviewerAgent,
						sessionId: input.sessionID,
						scopeContent: diff.canonicalText,
						scopeDescription: `${input.trigger}-review`,
						blockingFindings: findings.map((finding) => ({
							location: `${finding.file}:${finding.line_start}`,
							summary: finding.body,
							line: finding.line_start,
							severity: finding.severity,
							finding_id: finding.finding_id,
							title: finding.title,
							body: finding.body,
							confidence: finding.confidence,
							file: finding.file,
							line_start: finding.line_start,
							line_end: finding.line_end,
							effective_severity: finding.effective_severity,
							validator_disposition: finding.validation?.disposition,
							validator_confidence: finding.validation?.confidence,
							validator_evidence: finding.validation?.evidence,
							anchor_status: finding.anchored ? 'anchored' : 'unanchored',
							anchor_reason: finding.anchor_rejection,
						})),
						evidenceReferences: findings.map(
							(finding) => `${finding.file}:${finding.line_start}`,
						),
						passConditions: parsed.fixes,
						summary: `${input.trigger} review`,
						structuredFindings: parsed.structuredFindings,
						reviewOverallConfidence: parsed.overallConfidence,
						findingValidations: findings
							.map((finding) => finding.validation)
							.filter((item): item is NonNullable<typeof item> =>
								Boolean(item),
							),
					});
		receiptId = receipt.id;
		receiptPath = await _internals.persistReceipt(input.directory, receipt, {
			verifyCurrent: createScopeVerifier(input, diff, maxBytes),
		});
		evidence.receipt_path = receiptPath;
	} catch (error) {
		if (error instanceof ReviewScopeStaleError) {
			return stalePersistenceResult(
				input,
				maxBytes,
				'Review scope changed before the review receipt could be committed.',
				allDispatches.length,
			);
		}
		evidence.review.error = `receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	let blocked = false;
	let blockReason: ReviewEngineResult['blockReason'];
	if (gateMode && !diff.completeness.complete) {
		blocked = true;
		blockReason = 'INCOMPLETE_SCOPE';
	} else if (gateMode && parsed.outputMode !== 'structured') {
		blocked = true;
		blockReason = 'INCOMPLETE_REVIEW_EVIDENCE';
	} else if (gateMode && !validationComplete) {
		blocked = true;
		blockReason = 'INCOMPLETE_VALIDATION';
	} else if (gateMode && !receiptPath) {
		blocked = true;
		blockReason = 'EVIDENCE_PERSISTENCE_FAILED';
	} else if (gateMode && blockingFindings.length > 0) {
		blocked = true;
		blockReason = 'CONFIRMED_FINDINGS';
	}

	let evidencePath: string | undefined;
	try {
		evidencePath = await _internals.persistEvidence(input.directory, evidence, {
			verifyCurrent: createScopeVerifier(input, diff, maxBytes),
		});
	} catch (error) {
		if (receiptPath && receiptId) {
			await removeReviewReceipt(input.directory, receiptPath, receiptId).catch(
				() => {},
			);
			receiptPath = undefined;
			evidence.receipt_path = undefined;
		}
		if (error instanceof ReviewScopeStaleError) {
			return stalePersistenceResult(
				input,
				maxBytes,
				'Review scope changed before auto-review evidence could be committed.',
				allDispatches.length,
			);
		}
		if (gateMode) {
			blocked = true;
			blockReason = 'EVIDENCE_PERSISTENCE_FAILED';
		}
	}
	const result: ReviewEngineResult = {
		status: 'completed',
		reviewVerdict: parsed.verdict,
		blocked,
		blockReason,
		message: blocked
			? `Review gate blocked: ${blockReason}`
			: `Review completed with ${findings.length} finding(s).`,
		findings,
		blockingFindings,
		validationComplete,
		receiptPath,
		evidencePath,
		scopeHash: diff.scopeHash,
		manifestHash: reviewManifest.hash,
		scopeComplete: diff.completeness.complete,
		...scopeResultFields(diff, promptRequest),
		reviewModel: dispatched.result.modelId,
		modelCalls: allDispatches.length,
	};
	input.injectAdvisory?.(input.sessionID, advisoryMessage(input, result));
	return result;
}

export const _internals: {
	collectReviewDiff: typeof collectReviewDiff;
	persistEvidence: typeof persistAutoReviewEvidence;
	persistReceipt: typeof persistReviewReceipt;
	readPhaseEvidence: typeof readAutoReviewEvidenceForPhase;
} = {
	collectReviewDiff,
	persistEvidence: persistAutoReviewEvidence,
	persistReceipt: persistReviewReceipt,
	readPhaseEvidence: readAutoReviewEvidenceForPhase,
};
