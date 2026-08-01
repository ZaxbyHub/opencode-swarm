/**
 * Handle /swarm pr-feedback command.
 *
 * Triggers the architect to enter MODE: PR_FEEDBACK — the swarm workflow for
 * ingesting and closing KNOWN pull-request feedback (review comments, requested
 * changes, CI failures, merge conflicts, stale branches, pasted notes). This is
 * distinct from /swarm pr-review, which discovers NEW findings.
 *
 * Input contract (PR reference is optional):
 *   /swarm pr-feedback 155                         → feedback pass on PR 155
 *   /swarm pr-feedback 155 also fix the lint errors → PR 155 + extra instructions
 *   /swarm pr-feedback 155 continue from .swarm/pr-review/<run_id>/feedback-handoff.json
 *                                                   -> PR 155 + exact transition request
 *   /swarm pr-feedback owner/repo#155               → shorthand
 *   /swarm pr-feedback https://github.com/.../pull/155
 *   /swarm pr-feedback                              → bare signal; architect builds
 *                                                     the ledger from current PR/branch
 *   /swarm pr-feedback address the review notes about error handling
 *                                                   → no parseable PR ref ⇒ the whole
 *                                                     input is forwarded as instructions
 *
 * PR-reference parsing and injection-hardening are shared with /swarm pr-review
 * via ./pr-ref.ts.
 */

import {
	looksLikePrRef,
	resolvePrCommandInput,
	sanitizeInstructions,
} from './pr-ref.js';

const PR_REVIEW_HANDOFF_PATH_PATTERN =
	/^\.swarm\/pr-review\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/feedback-handoff\.json$/;

export interface PrFeedbackContinuationRequest {
	runId: string;
	handoffPath: string;
	instructions: string;
}

export interface PrFeedbackCommandInput {
	prUrl?: string;
	instructions: string;
	continuation?: PrFeedbackContinuationRequest;
	error?: string;
	errorKind?: 'pr-reference' | 'continuation';
}

function isPrFeedbackCommandError(
	value: PrFeedbackContinuationRequest | PrFeedbackCommandInput,
): value is PrFeedbackCommandInput {
	return 'error' in value;
}

function isPrFeedbackContinuationRequest(
	value: PrFeedbackContinuationRequest | PrFeedbackCommandInput,
): value is PrFeedbackContinuationRequest {
	return 'runId' in value && 'handoffPath' in value;
}

function parseContinuationClause(
	rest: string[],
): PrFeedbackContinuationRequest | PrFeedbackCommandInput | null {
	if (rest.length === 0) return null;
	if (rest[0].toLowerCase() !== 'continue') return null;
	if (rest[1]?.toLowerCase() !== 'from') return null;
	const rawPath = rest[2];
	if (!rawPath) {
		return {
			instructions: '',
			errorKind: 'continuation',
			error:
				'Malformed PR-feedback continuation: expected "continue from .swarm/pr-review/<run_id>/feedback-handoff.json"',
		};
	}
	const normalizedPath = rawPath.replace(/\\/g, '/');
	const matched = normalizedPath.match(PR_REVIEW_HANDOFF_PATH_PATTERN);
	if (!matched) {
		return {
			instructions: '',
			errorKind: 'continuation',
			error:
				'PR-feedback continuation must use .swarm/pr-review/<run_id>/feedback-handoff.json',
		};
	}
	if (rest.length !== 3) {
		return {
			instructions: '',
			errorKind: 'continuation',
			error:
				'PR-feedback continuation must use the exact form "continue from .swarm/pr-review/<run_id>/feedback-handoff.json"',
		};
	}
	return {
		runId: matched[1],
		handoffPath: normalizedPath,
		instructions: '',
	};
}

export function parsePrFeedbackCommandInput(
	directory: string,
	args: string[],
): PrFeedbackCommandInput {
	const rest = args.filter((t) => t.trim().length > 0);
	if (rest.length === 0) {
		return { instructions: '' };
	}

	let prUrl: string | undefined;
	let tail = rest;
	if (looksLikePrRef(rest[0])) {
		const resolved = resolvePrCommandInput([rest[0]], directory);
		if (resolved === null) {
			return {
				instructions: '',
				error: 'PR-feedback command requires a PR reference',
				errorKind: 'pr-reference',
			};
		}
		if ('error' in resolved) {
			return {
				instructions: '',
				error: resolved.error,
				errorKind: 'pr-reference',
			};
		}
		prUrl = resolved.prUrl;
		tail = rest.slice(1);
	}

	const continuation = parseContinuationClause(tail);
	if (continuation) {
		if (isPrFeedbackCommandError(continuation)) {
			return continuation;
		}
		if (!isPrFeedbackContinuationRequest(continuation)) {
			return {
				instructions: '',
				error: 'Malformed PR-feedback continuation request',
			};
		}
		return {
			prUrl,
			instructions: continuation.instructions,
			continuation,
		};
	}
	return {
		prUrl,
		instructions: sanitizeInstructions(tail.join(' ')),
	};
}

export function handlePrFeedbackCommand(
	directory: string,
	args: string[],
): string {
	const parsed = parsePrFeedbackCommandInput(directory, args);
	if (parsed.error) {
		if (parsed.errorKind === 'pr-reference') {
			return [
				`Error: ${parsed.error}`,
				'',
				'That looked like a PR reference but could not be resolved. Pass a full',
				'URL or `owner/repo#N`, or omit the reference to start a no-PR feedback',
				'session (e.g. `/swarm pr-feedback address the review notes`).',
			].join('\n');
		}
		return `Error: ${parsed.error}`;
	}

	// No args → bare signal. The architect/skill assembles the feedback ledger
	// from the current PR, branch state, and any pasted context.
	if (!parsed.prUrl && !parsed.instructions && !parsed.continuation) {
		return '[MODE: PR_FEEDBACK]';
	}

	if (parsed.prUrl) {
		const signal = `[MODE: PR_FEEDBACK pr="${parsed.prUrl}"]`;
		if (parsed.continuation) {
			const continuation = `continue from ${parsed.continuation.handoffPath}`;
			return parsed.continuation.instructions
				? `${signal} ${continuation} ${parsed.continuation.instructions}`
				: `${signal} ${continuation}`;
		}
		return parsed.instructions ? `${signal} ${parsed.instructions}` : signal;
	}

	if (parsed.continuation) {
		const continuation = `continue from ${parsed.continuation.handoffPath}`;
		return parsed.continuation.instructions
			? `[MODE: PR_FEEDBACK] ${continuation} ${parsed.continuation.instructions}`
			: `[MODE: PR_FEEDBACK] ${continuation}`;
	}

	// Otherwise the input is free-text pasted feedback (pr-feedback explicitly
	// supports no-PR sessions).
	return parsed.instructions
		? `[MODE: PR_FEEDBACK] ${parsed.instructions}`
		: '[MODE: PR_FEEDBACK]';
}
