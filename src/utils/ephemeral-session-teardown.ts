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

/** Minimum lifecycle surface for tearing an ephemeral session down. */
export interface EphemeralSessionLifecycle {
	/** Server-side abort; optional because some session shims (tests, older hosts) lack it. */
	abort?: (args: { path: { id: string } }) => Promise<unknown>;
	/** Hard delete the session and cascade its rows. */
	delete: (args: { path: { id: string } }) => Promise<unknown>;
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
 * completion timing is detached (process exit before completion leaks a
 * session, same as the prior fire-and-forget delete, and is harmless).
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

export const _internals: {
	boundedSessionCall: typeof boundedSessionCall;
	boundedAbort: typeof boundedAbortEphemeralSession;
	boundedDelete: typeof boundedDeleteEphemeralSession;
	log: typeof log;
} = {
	boundedSessionCall,
	boundedAbort: boundedAbortEphemeralSession,
	boundedDelete: boundedDeleteEphemeralSession,
	log,
};
