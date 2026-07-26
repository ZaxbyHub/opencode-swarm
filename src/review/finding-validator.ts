import { createHash } from 'node:crypto';
import {
	extractFindingValidationsFromAgentOutput,
	type FindingValidation,
	type ReviewFinding,
} from '../agents/agent-output-schema.js';
import { FALLBACK_MODELS_MAX } from '../config/schema.js';
import { MAX_EPHEMERAL_PROMPT_BYTE_LIMIT } from '../evaluation/ephemeral-agent-dispatcher.js';
import type { ModelOverride } from '../utils/model-dispatch-fallback.js';
import { isTransientProviderError } from '../utils/provider-error-classification.js';
import type {
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from './contracts.js';
import type {
	ReviewDiffCompleteness,
	ReviewDiffSelector,
} from './diff-source.js';

export interface ValidationCandidate extends ReviewFinding {
	finding_id: string;
	duplicate_count: number;
}

export interface FindingValidationResult {
	complete: boolean;
	candidates: ValidationCandidate[];
	validations: FindingValidation[];
	/**
	 * Every model dispatch attempted, in configured order.
	 *
	 * Callers own telemetry and aggregate cost accounting from this list. The
	 * validator deliberately emits no telemetry so synchronous engine review and
	 * asynchronous receipt validation cannot double-count the same attempt.
	 */
	attempts: readonly ReviewDispatchResult[];
	error?: string;
	/** Terminal completed or failed attempt retained for compatibility. */
	dispatch?: ReviewDispatchResult;
}

export interface FindingValidationScopeContext {
	selector: ReviewDiffSelector;
	canonicalText: string;
	scopeHash: string;
	headSha: string;
	baseRef?: string;
	baseSha?: string;
	mergeBase?: string;
	rangeToSha?: string;
	completeness: ReviewDiffCompleteness;
	/** Optional Stage-B manifest description when canonicalText is not a diff. */
	scopeDescription?: string;
	/** Exact files represented by a Stage-B reviewer manifest. */
	files?: string[];
}

export interface RunFindingValidationInput {
	dispatcher: ReviewModelDispatcher;
	directory: string;
	parentSessionId?: string;
	agentName: string;
	model?: ModelOverride;
	/** Plugin-instance-local configured fallback chain, in declared order. */
	fallbackModels?: readonly ModelOverride[];
	timeoutMs: number;
	findings: Array<ReviewFinding | ValidationCandidate>;
	/**
	 * Exact bounded scope reviewed by the originating reviewer.
	 *
	 * Receipt-only callers may omit this when they do not own canonical diff
	 * evidence. The shared review engine always supplies it so arbitrary ranges
	 * remain bound to their resolved target even when that target is not checked
	 * out in the validator's working directory.
	 */
	scopeContext?: FindingValidationScopeContext;
	abortSignal?: AbortSignal;
}

export const MAX_VALIDATOR_FALLBACK_MODELS = FALLBACK_MODELS_MAX;

function canonicalFindingPayload(finding: ReviewFinding): string {
	return JSON.stringify({
		title: finding.title.trim(),
		body: finding.body.trim(),
		severity: finding.severity,
		confidence: finding.confidence,
		file: finding.file.replaceAll('\\', '/'),
		line_start: finding.line_start,
		line_end: finding.line_end,
	});
}

export function canonicalizeValidationCandidates(
	findings: Array<ReviewFinding | ValidationCandidate>,
): ValidationCandidate[] {
	const candidates = new Map<string, ValidationCandidate>();
	for (const finding of findings) {
		const normalized: ReviewFinding = {
			title: finding.title.trim(),
			body: finding.body.trim(),
			severity: finding.severity,
			confidence: finding.confidence,
			file: finding.file.replaceAll('\\', '/'),
			line_start: finding.line_start,
			line_end: finding.line_end,
		};
		const findingId = createHash('sha256')
			.update(canonicalFindingPayload(normalized), 'utf8')
			.digest('hex');
		const existing = candidates.get(findingId);
		if (existing) {
			existing.duplicate_count +=
				'duplicate_count' in finding && finding.duplicate_count > 1
					? finding.duplicate_count
					: 1;
			continue;
		}
		candidates.set(findingId, {
			...normalized,
			finding_id: findingId,
			duplicate_count:
				'duplicate_count' in finding && finding.duplicate_count > 0
					? finding.duplicate_count
					: 1,
		});
	}
	return [...candidates.values()].sort((a, b) =>
		a.finding_id.localeCompare(b.finding_id),
	);
}

interface ValidatorPromptRequest {
	prompt: string;
	requestBytes: number;
	promptByteLimit: number;
	fits: boolean;
}

function renderScopeContext(context: FindingValidationScopeContext): string[] {
	const exactRange = context.selector.kind === 'range';
	return [
		`REVIEW_SELECTOR: ${JSON.stringify(context.selector)}`,
		`SCOPE_HASH: ${context.scopeHash}`,
		`HEAD_SHA: ${context.headSha}`,
		`BASE_REF: ${context.baseRef ?? 'none'}`,
		`RESOLVED_BASE_SHA: ${context.baseSha ?? 'none'}`,
		`RESOLVED_FROM_SHA: ${exactRange ? (context.baseSha ?? 'none') : 'none'}`,
		`RESOLVED_TO_SHA: ${exactRange ? (context.rangeToSha ?? 'none') : 'none'}`,
		`MERGE_BASE: ${context.mergeBase ?? 'none'}`,
		`SCOPE_COMPLETE: ${context.completeness.complete}`,
		`SCOPE_TRUNCATED: ${context.completeness.truncated}`,
		`SCOPE_SKIP_REASONS: ${JSON.stringify(context.completeness.skipReasons)}`,
		`SCOPE_DESCRIPTION: ${context.scopeDescription ?? 'canonical-review-diff'}`,
		...(context.files ? [`SCOPE_FILES: ${JSON.stringify(context.files)}`] : []),
		context.scopeDescription ? 'EXACT_REVIEWED_SCOPE:' : 'EXACT_REVIEWED_DIFF:',
		context.scopeDescription ? '```text' : '```diff',
		context.canonicalText,
		'```',
	];
}

function buildValidatorPromptRequest(
	candidates: ValidationCandidate[],
	context?: FindingValidationScopeContext,
): ValidatorPromptRequest {
	const prompt = [
		'TASK: Independently validate every supplied review finding.',
		'Return the strict JSON validation wrapper mandated by your system prompt.',
		'The finding_id set must be echoed exactly once with no additions or omissions.',
		context
			? 'Validate only against the exact reviewed scope below. Repository files may represent a different checkout; the supplied selector, resolved SHAs, scope hash, and canonical diff are authoritative.'
			: 'No canonical diff context was supplied by this caller. Use repository evidence and return UNVERIFIED when the candidate cannot be bound to exact reviewed content.',
		...(context ? renderScopeContext(context) : []),
		'CANDIDATES:',
		'',
		JSON.stringify({ candidates }, null, 2),
	].join('\n');
	const requestBytes =
		Buffer.byteLength(VALIDATOR_SYSTEM_PROMPT, 'utf8') +
		Buffer.byteLength(prompt, 'utf8');
	return {
		prompt,
		requestBytes,
		promptByteLimit: Math.min(requestBytes, MAX_EPHEMERAL_PROMPT_BYTE_LIMIT),
		fits: requestBytes <= MAX_EPHEMERAL_PROMPT_BYTE_LIMIT,
	};
}

const VALIDATOR_SYSTEM_PROMPT = [
	'You are an independent code-review finding validator.',
	'You never approve code and never invent new findings.',
	'Verify only the supplied candidate IDs against repository and diff evidence.',
	'Default to DISPROVED; use CONFIRMED only with direct evidence and UNVERIFIED only when diligent verification cannot decide.',
	'Return exactly one fenced ```json ... ``` wrapper and no prose outside it. Do not emit any other JSON.',
	'The strict root object has exactly one key, "validations"; each item has exactly "finding_id", "disposition", "confidence", and "evidence".',
	'Schema: {"validations":[{"finding_id":"...","disposition":"CONFIRMED|DISPROVED|UNVERIFIED","confidence":0.0,"evidence":"..."}]}.',
].join('\n');

function modelIdentifier(model: ModelOverride | undefined): string | undefined {
	return model ? `${model.providerID}/${model.modelID}` : undefined;
}

function rejectedDispatchAttempt(
	input: RunFindingValidationInput,
	model: ModelOverride | undefined,
	prompt: string,
	startedAt: number,
	error: unknown,
): ReviewDispatchResult {
	return {
		status: 'error',
		agentName: input.agentName,
		modelId: modelIdentifier(model),
		text: '',
		error: error instanceof Error ? error.message : String(error),
		durationMs: Date.now() - startedAt,
		promptBytes:
			Buffer.byteLength(VALIDATOR_SYSTEM_PROMPT, 'utf8') +
			Buffer.byteLength(prompt, 'utf8'),
		responseBytes: 0,
	};
}

function isTransientDispatchFailure(dispatch: ReviewDispatchResult): boolean {
	if (dispatch.status === 'timeout') return true;
	if (dispatch.status !== 'error') return false;
	return isTransientProviderError(dispatch.error ?? '');
}

export async function runFindingValidation(
	input: RunFindingValidationInput,
): Promise<FindingValidationResult> {
	const candidates = canonicalizeValidationCandidates(input.findings);
	if (candidates.length === 0) {
		return { complete: true, candidates, validations: [], attempts: [] };
	}

	const promptRequest = buildValidatorPromptRequest(
		candidates,
		input.scopeContext,
	);
	if (!promptRequest.fits) {
		return {
			complete: false,
			candidates,
			validations: [],
			attempts: [],
			error:
				`finding validation requires ${promptRequest.requestBytes} prompt bytes, ` +
				`exceeding the ${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT}-byte isolated-session ceiling; exact diff evidence was not truncated`,
		};
	}
	const { prompt } = promptRequest;
	const models = [
		input.model,
		...(input.fallbackModels ?? []).slice(0, MAX_VALIDATOR_FALLBACK_MODELS),
	];
	const attempts: ReviewDispatchResult[] = [];
	let dispatch: ReviewDispatchResult | undefined;
	for (let index = 0; index < models.length; index += 1) {
		const model = models[index];
		const startedAt = Date.now();
		try {
			// The dispatcher owns the bounded child session. This loop owns only
			// bounded model failover, with one observable attempt per model.
			// eslint-disable-next-line no-await-in-loop
			dispatch = await input.dispatcher.dispatch({
				directory: input.directory,
				parentSessionId: input.parentSessionId,
				agentName: input.agentName,
				model,
				system: VALIDATOR_SYSTEM_PROMPT,
				prompt,
				title: `finding validation (${candidates.length})`,
				timeoutMs: input.timeoutMs,
				promptByteLimit: promptRequest.promptByteLimit,
				abortSignal: input.abortSignal,
			});
		} catch (error) {
			dispatch = rejectedDispatchAttempt(
				input,
				model,
				prompt,
				startedAt,
				error,
			);
		}
		attempts.push(dispatch);
		if (dispatch.status === 'completed') break;
		if (!isTransientDispatchFailure(dispatch) || index === models.length - 1) {
			break;
		}
	}

	if (!dispatch) {
		return {
			complete: false,
			candidates,
			validations: [],
			attempts,
			error: 'finding validation made no model dispatch attempt',
		};
	}
	if (dispatch.status !== 'completed') {
		return {
			complete: false,
			candidates,
			validations: [],
			attempts,
			error:
				dispatch.error ??
				`finding validation dispatch ended with status ${dispatch.status}`,
			dispatch,
		};
	}

	const extracted = extractFindingValidationsFromAgentOutput(dispatch.text);
	const validations = extracted.validations;
	if (extracted.error) {
		return {
			complete: false,
			candidates,
			validations,
			attempts,
			error: `finding validation output was malformed: ${extracted.error}`,
			dispatch,
		};
	}

	const expectedIds = new Set(
		candidates.map((candidate) => candidate.finding_id),
	);
	const seenIds = new Set<string>();
	for (const validation of validations) {
		if (!expectedIds.has(validation.finding_id)) {
			return {
				complete: false,
				candidates,
				validations,
				attempts,
				error: `finding validation returned unknown ID ${validation.finding_id}`,
				dispatch,
			};
		}
		if (seenIds.has(validation.finding_id)) {
			return {
				complete: false,
				candidates,
				validations,
				attempts,
				error: `finding validation duplicated ID ${validation.finding_id}`,
				dispatch,
			};
		}
		seenIds.add(validation.finding_id);
	}
	const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));
	if (missingIds.length > 0) {
		return {
			complete: false,
			candidates,
			validations,
			attempts,
			error: `finding validation omitted ${missingIds.length} required ID(s)`,
			dispatch,
		};
	}

	return { complete: true, candidates, validations, attempts, dispatch };
}

export const MAX_TRACKED_VALIDATION_SESSIONS = 256;

export interface FindingValidationScheduler {
	schedule: (
		validationIdentity: string,
		run: () => Promise<FindingValidationResult>,
		onComplete: (result: FindingValidationResult) => void | Promise<void>,
		onError?: (error: unknown) => void | Promise<void>,
	) => boolean;
	/** Instance-local test/lifecycle seam. */
	reset: () => void;
	readonly pendingCount: number;
}

/**
 * Creates one bounded finding-validation scheduler for one plugin instance.
 *
 * Keeping the pending map in this closure is load-bearing: a saturated plugin
 * instance must not consume another instance's 256 live validation slots.
 */
export function createFindingValidationScheduler(): FindingValidationScheduler {
	const validationByIdentity = new Map<
		string,
		Promise<FindingValidationResult>
	>();
	return {
		get pendingCount() {
			return validationByIdentity.size;
		},
		reset: () => validationByIdentity.clear(),
		schedule: (validationIdentity, run, onComplete, onError): boolean => {
			if (
				!validationIdentity ||
				validationIdentity.length > 2_048 ||
				Array.from(validationIdentity).some((char) => {
					const code = char.charCodeAt(0);
					return code <= 0x1f && code !== 0;
				}) ||
				validationByIdentity.has(validationIdentity)
			) {
				return false;
			}
			if (validationByIdentity.size >= MAX_TRACKED_VALIDATION_SESSIONS) {
				return false;
			}

			const reportError = (error: unknown): Promise<void> => {
				try {
					return Promise.resolve(onError?.(error)).then(
						() => undefined,
						() => undefined,
					);
				} catch {
					// Fire-and-forget validation must never create an unhandled
					// rejection, including when the error reporter itself fails.
					return Promise.resolve();
				}
			};
			let runPromise: Promise<FindingValidationResult>;
			try {
				// Preserve eager start while containing a synchronous throw.
				runPromise = run();
			} catch (error) {
				runPromise = Promise.reject(error);
			}
			const pending = runPromise
				.then(
					(result) => {
						try {
							const completion = onComplete(result);
							return completion &&
								typeof (completion as Promise<void>).then === 'function'
								? (completion as Promise<void>).then(
										() => result,
										(error) => reportError(error).then(() => result),
									)
								: result;
						} catch (error) {
							return reportError(error).then(() => result);
						}
					},
					(error) =>
						reportError(error).then(
							(): FindingValidationResult => ({
								complete: false,
								candidates: [],
								validations: [],
								attempts: [],
								error:
									error instanceof Error
										? error.message
										: `finding validation failed: ${String(error)}`,
							}),
						),
				)
				.finally(() => {
					if (validationByIdentity.get(validationIdentity) === pending) {
						validationByIdentity.delete(validationIdentity);
					}
				});
			validationByIdentity.set(validationIdentity, pending);
			return true;
		},
	};
}
