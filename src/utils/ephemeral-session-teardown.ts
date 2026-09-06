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
 * Bounded existence check via `session.get`. `get` throwing (session-gone
 * errors surface as rejections on the SDK surface) or returning an empty body
 * both mean the session is gone (mirrors the reason-forwarding resolver
 * precedent in `src/hooks/pr-workflow-session-resolver.ts`).
 */
async function sessionExists(
	session: EphemeralSessionLifecycle,
	sessionId: string,
	verifyTimeoutMs: number,
): Promise<boolean> {
	if (typeof session.get !== 'function') return true; // cannot disprove → treat as alive
	try {
		const result = await withTimeout(
			session.get({ path: { id: sessionId } }),
			verifyTimeoutMs,
			new Error(
				`ephemeral session verify timed out after ${verifyTimeoutMs}ms`,
			),
		);
		const body = (result as { data?: unknown } | undefined)?.data;
		if (body === undefined || body === null) return false;
		return true;
	} catch {
		// A rejected get is how the host reports "no such session".
		return false;
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
		const alive = await _internals.sessionExists(
			session,
			sessionId,
			verifyTimeoutMs,
		);
		if (!alive) return { ok: true, sessionId, attempts: deleteAttempts };
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
	log: typeof log;
} = {
	boundedSessionCall,
	boundedAbort: boundedAbortEphemeralSession,
	boundedDelete: boundedDeleteEphemeralSession,
	sessionExists,
	log,
};
