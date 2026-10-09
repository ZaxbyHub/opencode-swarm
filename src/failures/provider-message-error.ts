/**
 * Provider errors recorded on an assistant message (`info.error`).
 *
 * `session.prompt` answers HTTP 200 even when the provider refused or failed
 * the request (an HTTP 403 refusal, a 429 rate limit, an exhausted quota):
 * the failure is the assistant message's `info.error` and the message has no
 * text. A consumer that reads only the text parts therefore sees an empty —
 * apparently successful — response, and its retry / model-fallback path
 * never runs. The consumers that import this module (full-auto oversight and
 * intercept, the curator / skill-improver LLM factories, the ephemeral agent
 * dispatcher, the mutation generator and the Lean integration) read
 * `info.error` through it and turn it into an error on their existing error
 * path. Not every `session.prompt` consumer does yet: the Lean lane runner
 * (`src/turbo/lean/runner.ts`, #3162) still checks only `promptResult.data`,
 * the PR wake-prompt senders (`pr-workflow-response-gate.ts`,
 * `pr-event-delivery.ts`) do not read the reply, and `dispatch-lanes.ts`
 * reads `info.error` with its own lane-error mapping.
 */
import { classifyProviderFailure } from './invocation-failure';

export type ProviderMessageError = {
	name: string;
	statusCode?: number;
	/** Bounded display text from {@link classifyProviderFailure}. */
	message: string;
	/** Provider failure category, e.g. `provider.rate_limit`. */
	category: string;
};

/**
 * Read the provider error OpenCode records on an assistant message, or
 * `null` when the message carries none.
 */
export function readProviderMessageError(
	info: unknown,
): ProviderMessageError | null {
	if (!info || typeof info !== 'object') return null;
	const error = (info as { error?: unknown }).error;
	if (!error || typeof error !== 'object') return null;
	const { name, data } = error as { name?: unknown; data?: unknown };
	const details = (data && typeof data === 'object' ? data : {}) as {
		message?: unknown;
		statusCode?: unknown;
	};
	const statusCode =
		typeof details.statusCode === 'number' &&
		Number.isFinite(details.statusCode)
			? details.statusCode
			: undefined;
	const rawMessage =
		typeof details.message === 'string' && details.message.trim().length > 0
			? details.message
			: 'no message';
	// AGENTS.md invariant 9: classify through the canonical provider classifier
	// (as dispatch-lanes does for the same `info.error`) so the category is
	// structured and the message is bounded display evidence, never raw text.
	const classified = classifyProviderFailure(
		statusCode === undefined
			? rawMessage
			: { message: rawMessage, status: statusCode },
	);
	return {
		name:
			typeof name === 'string' && name.length > 0
				? name.slice(0, 64)
				: 'UnknownError',
		...(statusCode === undefined ? {} : { statusCode }),
		// The sanitized display can be empty (e.g. a message of only control
		// characters); fall back to a constant, never to the raw text.
		message: classified.evidence.display || 'no message',
		category: classified.category,
	};
}

/** `<prefix>: <name> (HTTP <status>): <message>`. */
export function formatProviderMessageError(
	prefix: string,
	error: ProviderMessageError,
): string {
	const status =
		error.statusCode === undefined ? '' : ` (HTTP ${error.statusCode})`;
	return `${prefix}: ${error.name}${status}: ${error.message}`;
}

/**
 * An `Error` for a provider message error. Its message carries the status
 * and provider text (what the message-based transient/quota classifiers
 * read), and it carries `status` / `category` so `classifyProviderFailure`
 * recovers the same structured category.
 */
export type ProviderMessageErrorObject = Error & {
	status?: number;
	category: string;
	providerError: ProviderMessageError;
};

export function providerMessageErrorToError(
	prefix: string,
	error: ProviderMessageError,
): ProviderMessageErrorObject {
	const err = new Error(
		formatProviderMessageError(prefix, error),
	) as ProviderMessageErrorObject;
	if (error.statusCode !== undefined) err.status = error.statusCode;
	err.category = error.category;
	err.providerError = error;
	return err;
}

/**
 * Throw when the assistant message carries a provider error; for consumers
 * whose error path is a thrown error.
 */
export function throwIfProviderMessageError(
	prefix: string,
	info: unknown,
): void {
	const error = readProviderMessageError(info);
	if (error) throw providerMessageErrorToError(prefix, error);
}
