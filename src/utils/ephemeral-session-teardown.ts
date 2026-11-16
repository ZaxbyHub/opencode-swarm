/**
 * Ephemeral opencode session teardown — abort-then-delete ordering that closes
 * the FOREIGN KEY constraint race described in issue #2123.
 *
 * ## Why this exists
 *
 * opencode writes the final assistant `part`/`message` **asynchronously**, in
 * `SessionProcessor.cleanup`, which runs as a stream-drain finalizer that can
 * settle AFTER `session.prompt()` resolves. The `part.message_id` foreign key
 * is `ON DELETE CASCADE`, so a `session.delete()` that lands before that flush
 * cascade-removes the parent `message` row; opencode's late `updatePart`/
 * `updateMessage` then fails with `SQLiteError: FOREIGN KEY constraint failed`
 * (in opencode's own log — the plugin's `session.delete()` promise resolves
 * fine, which is why a `.catch(() => {})` on the delete cannot prevent it).
 *
 * ## Why awaiting `session.abort()` fixes it
 *
 * `POST /session/{id}/abort` resolves only after `SessionRunState.cancel` →
 * `Runner.cancel` → `Fiber.interrupt(runFiber)`. Effect's `Fiber.interrupt` runs
 * every finalizer on the target fiber before resolving, and the run-loop fiber
 * carries `Effect.ensuring(cleanup())`. Therefore, once `await session.abort()`
 * resolves, opencode has already flushed the final part/message (or the session
 * was already idle, in which case `cleanup` ran during natural completion).
 * Source: opencode v1.18.16 — `packages/opencode/src/session/{run-state,runner,
 * processor}.ts`.
 *
 * Because `cleanup` awaits each pending tool-call deferred with a 250 ms
 * timeout, the abort step can block up to ~250 ms+ under interruption. Its
 * bounded timeout must stay well above that (default 5 s) or it would give up
 * before the flush lands and re-introduce the race.
 */
import { log } from './logger.js';
import { withTimeout } from './timeout.js';

/** Minimum lifecycle surface for tearing an ephemeral session down. */
export interface EphemeralSessionLifecycle {
	/** Server-side abort; optional because some session shims (tests, older hosts) lack it. */
	abort?: (args: { path: { id: string } }) => Promise<unknown>;
	/** Hard delete the session and cascade its rows. */
	delete: (args: { path: { id: string } }) => Promise<unknown>;
	/**
	 * Read the session back (issue #2599). Used by `teardownEphemeralSessionVerified`
	 * as the bounded existence check; optional because some shims lack it —
	 * absence degrades verification to a typed unverified result.
	 */
	get?: (args: { path: { id: string } }) => Promise<unknown>;
}

export const DEFAULT_EPHEMERAL_ABORT_TIMEOUT_MS = 5_000;
export const DEFAULT_EPHEMERAL_TEARDOWN_DELETE_TIMEOUT_MS = 2_000;

export interface TeardownEphemeralSessionOptions {
	/** Bounded timeout for the graceful abort step. Must stay > ~500 ms. */
	abortTimeoutMs?: number;
	/** Bounded timeout for the hard delete step. */
	deleteTimeoutMs?: number;
	/**
	 * Skip the abort step. Use only for sessions that were never prompted (no
	 * final part flush pending) — e.g. a session that timed out during
	 * `session.create` before `session.prompt` was ever called.
	 */
	skipAbort?: boolean;
}

/**
 * Race a session HTTP call against a bounded timer. The structural lifecycle
 * type carries no `signal` (it must also fit the `SessionOps` shim), so the
 * timer bounds the AWAIT only — it cannot pre-empt the in-flight SDK request,
 * which is allowed to settle in the background. Mirrors `boundedDeleteEphemeralSession`
 * in `src/evaluation/ephemeral-agent-dispatcher.ts`. Best-effort: never throws.
 */
async function boundedSessionCall(
	call: () => Promise<unknown>,
	timeoutMs: number,
	timeoutLabel: string,
	failureLabel: string,
	sessionId: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			call(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${timeoutLabel} after ${timeoutMs}ms`)),
					Math.max(1, timeoutMs),
				);
			}),
		]);
	} catch (error) {
		_internals.log(`${failureLabel} for ephemeral session`, {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Bounded graceful abort. Guarantees opencode has flushed the session's final
 * part/message before resolving (or that the session was already idle). Never
 * throws; logs timeouts/failures via the debug-gated logger.
 */
export async function boundedAbortEphemeralSession(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	timeoutMs: number = DEFAULT_EPHEMERAL_ABORT_TIMEOUT_MS,
): Promise<void> {
	if (typeof session.abort !== 'function') return;
	await _internals.boundedSessionCall(
		() => session.abort!({ path: { id: sessionId } }),
		timeoutMs,
		'ephemeral session abort timed out',
		'ephemeral session abort failed',
		sessionId,
	);
}

/**
 * Bounded hard delete. Never throws; logs timeouts/failures.
 */
export async function boundedDeleteEphemeralSession(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	timeoutMs: number = DEFAULT_EPHEMERAL_TEARDOWN_DELETE_TIMEOUT_MS,
): Promise<void> {
	await _internals.boundedSessionCall(
		() => session.delete({ path: { id: sessionId } }),
		timeoutMs,
		'ephemeral session delete timed out',
		'ephemeral session delete failed',
		sessionId,
	);
}

/**
 * Tear an ephemeral session down without racing opencode's final part/message
 * flush (#2123): a bounded, awaited `session.abort()` (flush) FOLLOWED BY a
 * bounded `session.delete()`. Best-effort: never throws.
 *
 * Callers that need cleanup guaranteed before they return should `await` this.
 * Fire-and-forget callers may `void` it — the abort→delete ordering still holds
 * inside the unit, so the FK race is closed regardless; only the caller's own
 * completion timing is detached. A caller that exits before completion leaks
 * the session. For a lane-directory child session that leak is NOT harmless:
 * the leaked session's plugin activity keeps the lane's `swarm.db` WAL handle
 * open, which locks the lane directory against deletion on Windows (issue
 * #2599) — those callers must use `teardownEphemeralSessionVerified`, which
 * confirms the session actually died and returns a typed failure when it
 * survives.
 */
export async function teardownEphemeralSession(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	options: TeardownEphemeralSessionOptions = {},
): Promise<void> {
	const abortTimeoutMs =
		options.abortTimeoutMs ?? DEFAULT_EPHEMERAL_ABORT_TIMEOUT_MS;
	const deleteTimeoutMs =
		options.deleteTimeoutMs ?? DEFAULT_EPHEMERAL_TEARDOWN_DELETE_TIMEOUT_MS;
	const skipAbort = options.skipAbort ?? false;

	if (!skipAbort) {
		await _internals.boundedAbort(session, sessionId, abortTimeoutMs);
	}
	await _internals.boundedDelete(session, sessionId, deleteTimeoutMs);
}

export const DEFAULT_EPHEMERAL_VERIFY_TIMEOUT_MS = 2_000;
export const DEFAULT_EPHEMERAL_MAX_DELETE_ATTEMPTS = 3;

export interface TeardownEphemeralSessionVerifiedOptions
	extends TeardownEphemeralSessionOptions {
	/** Bounded timeout for the post-delete existence check (`session.get`). */
	verifyTimeoutMs?: number;
	/**
	 * Total bounded delete attempts (initial + retries) when the session
	 * survives the first delete. Bounded to [2, 6].
	 */
	maxDeleteAttempts?: number;
}

export type EphemeralTeardownVerification =
	| { ok: true; sessionId: string; attempts: number }
	| {
			ok: false;
			sessionId: string;
			attempts: number;
			/** Stable marker for telemetry/routing; see issue #2599 AC3. */
			kind: 'ephemeral-session-teardown-unverified';
			reason: string;
	  };

/**
 * Existence verdict for the post-delete verify (`session.get`).
 *
 * - `'gone'` — confirmed-gone signal only: an empty body (`data` undefined or
 *   null with no transport-class error envelope), or — for hosts configured
 *   `throwOnError: true` — a rejection that is neither the verify deadline
 *   error (compared by identity) nor transport-class.
 * - `'unreadable'` — the verify timed out (the locally constructed deadline
 *   error, distinguished by identity) or the call failed with a transport-class
 *   error (whatwg fetch `TypeError`, connection-reset family). Never a death
 *   claim: under the installed SDK's `throwOnError` default-off, session-gone
 *   surfaces through the body check, so nearly every rejection/envelope-error
 *   reaching these paths is an unproven-death signal (issue #2964).
 * - `'alive'` — non-empty body, or `get` unavailable (cannot disprove).
 */
type SessionExistence = 'alive' | 'gone' | 'unreadable';

/**
 * Transport-class failure codes for `isTransientTransportError`. Closed set —
 * do not broaden speculatively; an unrecognized error keeps today's semantics
 * (conservative in both directions: no new death claims, no new unverified
 * results).
 */
const TRANSIENT_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EPIPE',
	'UND_ERR_SOCKET',
]);

/**
 * Whether an error looks like a transient transport failure rather than a
 * host-level answer: a whatwg fetch network `TypeError`, a Node/Deno
 * connection error code, or an SDK abort. Used both for rejections of
 * `session.get` and for transport errors normalized into `{data: null, error}`
 * envelopes by the v2 session shim (`src/host/v2/session-client.ts`).
 */
function isTransientTransportError(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	if (err instanceof TypeError) return true;
	const coded = err as { code?: unknown; name?: unknown };
	if (
		typeof coded.code === 'string' &&
		TRANSIENT_TRANSPORT_ERROR_CODES.has(coded.code)
	) {
		return true;
	}
	return coded.name === 'AbortError';
}

async function sessionExists(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	verifyTimeoutMs: number,
): Promise<SessionExistence> {
	if (typeof session.get !== 'function') return 'alive'; // cannot disprove → treat as alive
	// #2964: hoisted so the deadline rejection is distinguishable BY IDENTITY
	// from any host-thrown error (withTimeout rejects with this exact object).
	const verifyTimeoutError = new Error(
		`ephemeral session verify timed out after ${verifyTimeoutMs}ms`,
	);
	try {
		const result = await withTimeout(
			session.get({ path: { id: sessionId } }),
			verifyTimeoutMs,
			verifyTimeoutError,
		);
		const body = (result as { data?: unknown } | undefined)?.data;
		if (body === undefined || body === null) {
			// v2-host arm (#2964): the v2 session shim normalizes host
			// rejections to `{data: null, error}` envelopes, so a transport
			// failure reaches this body check without ever throwing. Only a
			// transport-class envelope error is unproven; an absent error (or a
			// host not-found error object) is the gone signal, exactly as the
			// raw v1 SDK resolves 404s to `{error}` with no `data` key.
			const envelopeError = (result as { error?: unknown } | undefined)?.error;
			if (
				envelopeError !== undefined &&
				envelopeError !== null &&
				isTransientTransportError(envelopeError)
			) {
				return 'unreadable';
			}
			return 'gone';
		}
		return 'alive';
	} catch (err) {
		// The verify deadline fired (identity match) or the transport died —
		// neither proves the session is gone. Everything else keeps today's
		// 'gone' reading for hosts that throw on 404 (`throwOnError: true`).
		if (err === verifyTimeoutError) return 'unreadable';
		if (isTransientTransportError(err)) return 'unreadable';
		return 'gone';
	}
}

/**
 * Verified teardown (issue #2599): bounded abort → bounded delete → bounded
 * existence check, retrying the delete a bounded number of times when the
 * session survives, and returning a typed `ephemeral-session-teardown-unverified`
 * failure when it still does. Never throws; the caller decides how to escalate.
 */
export async function teardownEphemeralSessionVerified(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	options: TeardownEphemeralSessionVerifiedOptions = {},
): Promise<EphemeralTeardownVerification> {
	const verifyTimeoutMs =
		options.verifyTimeoutMs ?? DEFAULT_EPHEMERAL_VERIFY_TIMEOUT_MS;
	const attempts = Math.min(
		6,
		Math.max(
			2,
			options.maxDeleteAttempts ?? DEFAULT_EPHEMERAL_MAX_DELETE_ATTEMPTS,
		),
	);
	if (typeof session.get !== 'function') {
		// Best-effort pass (identical to teardownEphemeralSession), then report
		// that verification was impossible — never claim an unproven death.
		await teardownEphemeralSession(session, sessionId, options);
		return {
			ok: false,
			sessionId,
			attempts: 1,
			kind: 'ephemeral-session-teardown-unverified',
			reason: 'get-unavailable',
		};
	}
	let deleteAttempts = 0;
	for (;;) {
		await teardownEphemeralSession(session, sessionId, {
			...options,
			skipAbort: deleteAttempts > 0 ? true : options.skipAbort,
		});
		deleteAttempts += 1;
		// #2964: only a confirmed-gone signal verifies teardown; an unreadable
		// verify (deadline or transport) is a typed failure, never ok:true.
		const existence = await _internals.sessionExists(
			session,
			sessionId,
			verifyTimeoutMs,
		);
		if (existence === 'gone') {
			return { ok: true, sessionId, attempts: deleteAttempts };
		}
		if (existence === 'unreadable') {
			return {
				ok: false,
				sessionId,
				attempts: deleteAttempts,
				kind: 'ephemeral-session-teardown-unverified',
				reason: 'verify-unreadable',
			};
		}
		if (deleteAttempts >= attempts) {
			return {
				ok: false,
				sessionId,
				attempts: deleteAttempts,
				kind: 'ephemeral-session-teardown-unverified',
				reason: 'session-survived-bounded-retries',
			};
		}
	}
}

export const _internals: {
	boundedSessionCall: typeof boundedSessionCall;
	boundedAbort: typeof boundedAbortEphemeralSession;
	boundedDelete: typeof boundedDeleteEphemeralSession;
	sessionExists: typeof sessionExists;
	isTransientTransportError: typeof isTransientTransportError;
	log: typeof log;
} = {
	boundedSessionCall,
	boundedAbort: boundedAbortEphemeralSession,
	boundedDelete: boundedDeleteEphemeralSession,
	sessionExists,
	isTransientTransportError,
	log,
};
