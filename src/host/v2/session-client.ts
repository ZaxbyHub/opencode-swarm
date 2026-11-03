/**
 * v2 session client shim — issue #3169 Phase 2 (+ Phase 3 lane sessions).
 *
 * A narrow `OpencodeClient` subset implementing exactly the v1 session surface
 * Epic's dispatch paths use (`session.create/prompt/abort/delete` plus `get`,
 * which verified teardown requires), backed by the v2 host's `ctx.session`
 * domain. Installed as the synthetic v1 PluginInput's `client` field by
 * `setup.ts`, it flows through the shared init core's single client write site
 * into `swarmState.opencodeClient` and every init-path `ctx.client` consumer —
 * the tracking issue's Decision 2 (a client subset instead of v2 branches
 * spread through consumers).
 *
 * Translation contract (per the issue §4 gap table and the Phase 0 live
 * findings on @opencode/cli 2.0.26):
 *
 *   - `create({body:{parentID,title}, query:{directory}})` validates placement
 *     BEFORE creating anything. Phase 3: a CONFIRMED parent-directory divergence
 *     (the worktree-isolation lane shape — a lane worktree directory always
 *     differs from the parent's project root) now takes the EAGER path: a REAL
 *     PARENTED host session created immediately, then relocated into the
 *     requested directory with `session.move` when the host placed it in the
 *     parent's directory (Phase 0 C1: parented children inherit the parent's
 *     directory and ignore the requested one). Phase 3 originally created the
 *     lane session parentless, because a parentless create honoured
 *     `location.directory` on 2.0.x; OpenCode 2.1's native `subagent` tool
 *     refuses to resume a session whose host-side `parentID` is not the calling
 *     session, so a parentless lane could never be resumed. Placement is
 *     verified (echo, `get` fallback, bounded re-read after the move) with a
 *     remove-and-fail-closed guard; a host whose parented create already
 *     honours the location is never moved. The requested `parentID` is also
 *     REMEMBERED plugin-side and written onto every `get` result for the
 *     eager record, unconditionally (whatever the host reported). It restates
 *     the parent the create sent, so it is redundant with the host-recorded
 *     parent; it is kept so `prWorkflowSessionResolver`'s first-hop
 *     controller resolution (`pr-workflow-session-resolver.ts`) and
 *     `lookupParentSessionIDForTaskRoute` stay v1-faithful. A real id is returned — the native `subagent` tool
 *     resumes it by id (Phase 0 C7). Unverifiable parent placement still fails
 *     closed with the Phase 2 typed error (live-verification item), and
 *     same-directory/parentless creates keep the deferred placeholder (the real
 *     create there must carry prompt-time options — permissions are
 *     create-time-only on v2).
 *   - `prompt({path:{id}, body:{agent,model?,system?,tools,parts}, signal?})`
 *     emulates the v1 BLOCKING call over three arms keyed on the registry:
 *     (1) an EAGER record → full treatment on the real session — `switchAgent` +
 *     `switchModel`, a sessionID-scoped `context` hook (fence-aware system
 *     replacement preserving `<swarm_system_directive` parts, denied-tool
 *     deletion from `event.tools`), epoch-scoped error clear, `prompt` →
 *     bounded `wait` → `context()`; (2) a deferred/already-prompted PLACEHOLDER
 *     → real create carrying agent/model + the read-only denial map as
 *     `effect:'deny'` permissions, then the same hook/prompt/wait/context
 *     sequence, with the #3186 PRR-002 retire-and-recreate on re-prompts;
 *     (3) a foreign real id → the direct path (agent switch only). All three
 *     translate into the v1 `{data:{info,parts}}` envelope so
 *     `dispatchEphemeralAgent` and `readProviderMessageError` work unchanged.
 *   - Provider failures are EVENT-SOURCED on v2 (Phase 0 C4: no error text in
 *     `context()`), so the event pump records `session.error` /
 *     `session.execution.failed` payloads here (`recordV2SessionErrorFromEnvelope`,
 *     called pump-side beside `seedSessionIdentityFromEnvelope`) and the
 *     translation surfaces them as the v1 `info.error` shape. A failed outcome
 *     without recorded detail yields a bounded `provider.unknown` error
 *     instead of a silent empty success.
 *   - `abort` maps to `interrupt`, `delete` to `remove` (eager records are
 *     pruned after the removal resolves — the id is real, so a later `get`
 *     still resolves through to a host that reports the session gone), and
 *     `get` maps `{path:{id}}` onto `ctx.session.get({sessionID})` returning
 *     `{data: info}` — verified teardown through the shim resolves.
 *
 * Registry (invariant 8): placeholder and eager records share ONE bounded map
 * (cap 64, FIFO). Placeholder residue is intentionally not pruned (keep-for-get);
 * that residue shares the cap, so a live eager record can be evicted after 64
 * later insertions of any kind — a disclosed, bounded degradation (its next
 * prompt takes the direct path and the parentID overlay stops applying), pinned
 * in tests/unit/host/v2/session-client-lane-3169.test.ts.
 *
 * Deferred-work marker: NONE. The unverified live-host behaviors this design
 * rests on are recorded as deferrals in the trace (context-hook firing for
 * plugin-created sessions, permission vocabulary honor, `context()` entry
 * shapes, `wait` on failed prompts, `get(parent).location` availability,
 * lane subagent resume + parentID overlay — LVD-1..LVD-4) with the owning
 * follow-up on #3169. The create-then-move semantics (parent's directory on a
 * parented create, `move` relocating while preserving `parentID`) were
 * verified by a live probe against OpenCode 2.1.4.
 *
 * C6 await convention: every `await` lives inside a `deferredV2Session*`
 * function declaration or `const deferredV2SessionX = async (` binding — the
 * dual-shape-parity scan's function tracker does not recognize object-literal
 * method properties, so the client object's methods never await directly.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { canonicalRootKeyLexical } from '../../utils/canonical-root';
import { log } from '../../utils/logger';
import { withTimeout } from '../../utils/timeout';
import type {
	V2EventEnvelope,
	V2PluginContext,
	V2Registration,
	V2SessionContextEvent,
	V2SessionPermission,
} from './types';

/** The #2526 provenance fence opener — fenced system parts survive replacement. */
const SYSTEM_DIRECTIVE_FENCE_OPEN = '<swarm_system_directive';

/** Bounded placeholder registry (invariant 8): one live placeholder per dispatch. */
const MAX_PLACEHOLDER_SESSIONS = 64;
/** Bounded event-sourced error store (invariant 8). */
const MAX_RECORDED_SESSION_ERRORS = 128;
/** Bounded recheck for pump lag before synthesizing a no-detail failure. */
const ERROR_RECHECK_ATTEMPTS = 3;
const ERROR_RECHECK_DELAY_MS = 50;
/**
 * Default wait cap for callers that pass no AbortSignal. v1 `session.prompt`
 * blocks until completion; signal-carrying callers (the dispatcher, lean
 * turbo) keep that exact semantics through their own signal, so the cap only
 * backstops the signal-less wake-prompt callers.
 */
const SIGNAL_LESS_WAIT_CAP_MS = 10 * 60 * 1000;

/**
 * Lane placement bounds (DI seam, invariant 7: tests shrink these instead of
 * waiting on real time). `session.move` is applied host-side at a session
 * boundary, so the eager lane create re-reads the session until it reports
 * the lane directory. Live probe on OpenCode 2.1.4: an idle session reported
 * the new directory 0.04–0.34 s after `move`.
 *
 *  - every placement `get` is capped at `laneReadTimeoutMs` (and raced
 *    against the caller's signal);
 *  - the confirmation poll runs at most `laneMovePollAttempts` reads spaced
 *    `laneMovePollDelayMs` apart, inside a `laneConfirmBudgetMs` deadline;
 *  - `session.move` is capped at `laneMoveTimeoutMs` (and raced against the
 *    caller's signal); after a move timeout or abort, removal waits at most
 *    `laneMoveSettleMs` for the still-pending move to settle.
 *
 * Worst case before the (separately bounded) removal: one verification read
 * (1 s) + move (10 s) + settle wait (10 s) + confirmation (5 s).
 */
export const _internals = {
	laneMovePollAttempts: 40,
	laneMovePollDelayMs: 50,
	laneReadTimeoutMs: 1_000,
	laneConfirmBudgetMs: 5_000,
	laneMoveTimeoutMs: 10_000,
	laneMoveSettleMs: 10_000,
	/** Cleanup budget for the eager-create compensation removes (PRR-001). */
	eagerCleanupTimeoutMs: 10_000,
};

interface PlaceholderRecord {
	parentID?: string;
	title?: string;
	directory: string;
	realId?: string;
	/**
	 * #3169 Phase 3: this record represents an EAGERLY created REAL host session
	 * (parented, moved lane placement) rather than a deferred placeholder — prompt
	 * routing keys on this flag, never on `realId` presence (a prompted
	 * placeholder also has `realId` bound; the PRR-002 retire logic applies to
	 * non-eager records only).
	 */
	eager?: boolean;
	/** Set synchronously when a prompt on this placeholder starts. */
	promptStarted?: boolean;
	/**
	 * #3169 Phase 2 review round 1: the caller's teardown (abort/delete) can
	 * arrive while the prompt is still in flight — before `realId` is bound.
	 * Those calls park these flags and the prompt's finally honors them once
	 * the real id exists, so a timed-out dispatch still cleans up its host
	 * session.
	 */
	abortPending?: boolean;
	deletePending?: boolean;
}

const placeholderSessions = new Map<string, PlaceholderRecord>();
const sessionErrors = new Map<string, unknown>();
let placeholderCounter = 0;

function rememberPlaceholder(id: string, record: PlaceholderRecord): void {
	placeholderSessions.set(id, record);
	while (placeholderSessions.size > MAX_PLACEHOLDER_SESSIONS) {
		const oldest = placeholderSessions.keys().next().value;
		if (oldest === undefined) break;
		placeholderSessions.delete(oldest);
	}
}

function rememberSessionError(sessionId: string, error: unknown): void {
	sessionErrors.set(sessionId, error);
	while (sessionErrors.size > MAX_RECORDED_SESSION_ERRORS) {
		const oldest = sessionErrors.keys().next().value;
		if (oldest === undefined) break;
		sessionErrors.delete(oldest);
	}
}

/**
 * Record a `session.error` / `session.execution.failed` envelope's error
 * payload for the shim's result translation. SYNC by contract — the event pump
 * calls it inline in its iteration loop. Accepts the same dual payload dialect
 * `mapV2EventToV1` accepts (live `data`, SDK `properties`).
 */
export function recordV2SessionErrorFromEnvelope(
	envelope: V2EventEnvelope,
): void {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type !== 'session.error' && type !== 'session.execution.failed') return;
	const payload =
		(envelope as { data?: Record<string, unknown> }).data ??
		(envelope as { properties?: Record<string, unknown> }).properties ??
		{};
	const sessionID =
		typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
	const error = payload.error;
	if (sessionID !== undefined && error !== undefined) {
		rememberSessionError(sessionID, error);
	}
}

/** Drop all shim-held state (v2 cleanup path; bounded residue documented in the trace). */
export function clearV2SessionClientState(): void {
	placeholderSessions.clear();
	sessionErrors.clear();
}

/**
 * Map a v1 read-only denial map onto v2 create-time permission entries.
 * Fail-closed shape: only `effect: 'deny'` entries are ever produced.
 */
export function readOnlyToolsToV2Permissions(
	tools: Readonly<Record<string, false>> | undefined,
): V2SessionPermission[] {
	if (!tools || typeof tools !== 'object') return [];
	const permissions: V2SessionPermission[] = [];
	for (const resource of Object.keys(tools)) {
		if (resource.length === 0) continue;
		permissions.push({ action: 'tool', resource, effect: 'deny' });
	}
	return permissions;
}

/** Filesystem-free directory equality (win32 separator + case tolerant). */
function sameDirectoryLexical(a: string, b: string): boolean {
	return canonicalRootKeyLexical(a) === canonicalRootKeyLexical(b);
}

function isAssistantEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const record = entry as { role?: unknown; type?: unknown };
	if (record.role === 'assistant') return true;
	return typeof record.type === 'string' && record.type.includes('assistant');
}

function isUserEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const record = entry as { role?: unknown; type?: unknown };
	if (record.role === 'user') return true;
	return typeof record.type === 'string' && record.type.includes('user');
}

function entryText(entry: unknown): string | undefined {
	if (!entry || typeof entry !== 'object') return undefined;
	const record = entry as {
		text?: unknown;
		content?: unknown;
		parts?: unknown;
	};
	if (typeof record.text === 'string') return record.text;
	const blocks: unknown[] | undefined = Array.isArray(record.content)
		? record.content
		: Array.isArray(record.parts)
			? record.parts
			: undefined;
	if (!blocks) return undefined;
	const texts: string[] = [];
	for (const block of blocks) {
		if (
			block &&
			typeof block === 'object' &&
			(block as { type?: unknown }).type === 'text' &&
			typeof (block as { text?: unknown }).text === 'string'
		) {
			texts.push((block as { text: string }).text);
		}
	}
	return texts.length > 0 ? texts.join('\n') : undefined;
}

function entryModelIds(entry: unknown): {
	providerID?: string;
	modelID?: string;
} {
	if (!entry || typeof entry !== 'object') return {};
	const record = entry as {
		model?: { id?: unknown; providerID?: unknown };
		modelID?: unknown;
		providerID?: unknown;
	};
	const providerID =
		typeof record.model?.providerID === 'string'
			? record.model.providerID
			: typeof record.providerID === 'string'
				? record.providerID
				: undefined;
	const modelID =
		typeof record.model?.id === 'string'
			? record.model.id
			: typeof record.modelID === 'string'
				? record.modelID
				: undefined;
	return { providerID, modelID };
}

function idleOutcome(entries: unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as { type?: unknown; outcome?: unknown };
		if (record.type !== 'idle') continue;
		return typeof record.outcome === 'string' ? record.outcome : undefined;
	}
	return undefined;
}

function recordedErrorToInfoError(error: unknown): {
	name: string;
	data: { message: string; statusCode?: number };
} {
	if (error && typeof error === 'object') {
		const record = error as {
			name?: unknown;
			message?: unknown;
			status?: unknown;
			statusCode?: unknown;
			data?: { message?: unknown; statusCode?: unknown };
		};
		const message =
			typeof record.data?.message === 'string' && record.data.message.length > 0
				? record.data.message
				: typeof record.message === 'string' && record.message.length > 0
					? record.message
					: 'no message';
		const statusCodeValue =
			typeof record.data?.statusCode === 'number' &&
			Number.isFinite(record.data.statusCode)
				? record.data.statusCode
				: typeof record.statusCode === 'number' &&
						Number.isFinite(record.statusCode)
					? record.statusCode
					: typeof record.status === 'number' && Number.isFinite(record.status)
						? record.status
						: undefined;
		return {
			name:
				typeof record.name === 'string' && record.name.length > 0
					? record.name.slice(0, 64)
					: 'ProviderError',
			data: {
				message,
				...(statusCodeValue === undefined
					? {}
					: { statusCode: statusCodeValue }),
			},
		};
	}
	return {
		name: 'ProviderError',
		data: {
			message: 'v2 session failed without recorded error detail',
		},
	};
}

interface TranslatedPromptData {
	info: Record<string, unknown>;
	parts: Array<{ type: 'text'; text: string }>;
}

interface ContextClassification {
	outcome: string | undefined;
	texts: string[];
	model: Record<string, unknown>;
	/** Only the paths where a recorded event error decides the verdict. */
	needsErrorLookup: boolean;
}

/**
 * Classify a `context()` entry list per the pinned translation matrix (trace
 * 05 plan, F1/F1-R2/F5/F4-R2): an explicit non-failed idle outcome succeeds
 * EVEN WITH ZERO assistant text (empty parts keep the bash-retry
 * `providerRefused` arm-1 signal `completed`+empty-text); only `failed`, a
 * recorded event error, or a textless turn with no idle marker take the error
 * path; assistant entries require an explicit role marker and only the
 * entries AFTER the last user-role entry (the final turn) join.
 */
function classifyContextEntries(entries: unknown[]): ContextClassification {
	const lastUserIndex = entries.reduce<number>(
		(last, entry, index) => (isUserEntry(entry) ? index : last),
		-1,
	);
	const finalTurn = entries.slice(lastUserIndex + 1);
	const assistantEntries = finalTurn.filter(isAssistantEntry);
	const texts = assistantEntries
		.map(entryText)
		.filter((text): text is string => typeof text === 'string');
	// Final-turn idle only: a moved lane session carries a host `idle`
	// (outcome succeeded) right after its `location-switched` entry and before
	// the first user message (live 2.1.4 / 2.2.5 timelines). Reading the last
	// idle over the whole list would let that pre-prompt marker turn a turn
	// that produced no idle of its own into an empty success.
	const outcome = idleOutcome(finalTurn);
	return {
		outcome,
		texts,
		model: assistantEntries.reduce<Record<string, unknown>>((acc, entry) => {
			const ids = entryModelIds(entry);
			if (ids.providerID !== undefined && ids.modelID !== undefined) {
				return { providerID: ids.providerID, modelID: ids.modelID };
			}
			return acc;
		}, {}),
		needsErrorLookup:
			outcome === 'failed' || (outcome === undefined && texts.length === 0),
	};
}

function buildTranslatedPromptData(
	classification: ContextClassification,
	recordedError: unknown,
): TranslatedPromptData {
	if (classification.needsErrorLookup || recordedError !== undefined) {
		return {
			info: { error: recordedErrorToInfoError(recordedError) },
			parts: [],
		};
	}
	return {
		info: classification.model,
		parts: classification.texts.map((text) => ({
			type: 'text' as const,
			text,
		})),
	};
}

/** Bounded recheck of the error store for pump lag (deferred-named for the C6 scan). */
async function deferredV2SessionErrorRecheck(realId: string): Promise<unknown> {
	for (let attempt = 0; attempt < ERROR_RECHECK_ATTEMPTS; attempt += 1) {
		if (sessionErrors.has(realId)) return sessionErrors.get(realId);
		if (attempt < ERROR_RECHECK_ATTEMPTS - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, ERROR_RECHECK_DELAY_MS),
			);
		}
	}
	return undefined;
}

/**
 * Classify + translate a context() entry list, consulting the event-sourced
 * error store ONLY on the paths where a recorded error decides the verdict
 * (successful turns never pay the bounded recheck latency).
 */
async function deferredV2SessionTranslate(
	entries: unknown[],
	sessionId: string,
): Promise<TranslatedPromptData> {
	const classification = classifyContextEntries(entries);
	let recordedError: unknown = sessionErrors.get(sessionId);
	if (classification.needsErrorLookup && recordedError === undefined) {
		recordedError = await deferredV2SessionErrorRecheck(sessionId);
	}
	return buildTranslatedPromptData(classification, recordedError);
}

/** Read the parent session's directory for the placement precheck. */
async function deferredV2SessionGetParentDirectory(
	ctx: V2PluginContext,
	parentID: string,
): Promise<string | undefined> {
	const info = await ctx.session.get({ sessionID: parentID });
	if (!info || typeof info !== 'object') return undefined;
	const location = (info as { location?: { directory?: unknown } }).location;
	return typeof location?.directory === 'string'
		? location.directory
		: undefined;
}

/**
 * Bounded wait: raced against the caller's signal when present (v1 blocking
 * parity — the dispatcher's own timeout owns the bound); a 10-minute cap
 * backstops signal-less callers. Abort/expiry interrupts the v2 session, then
 * rejects with a typed error.
 */
async function deferredV2SessionWait(
	ctx: V2PluginContext,
	realId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) {
		await ctx.session.interrupt({ sessionID: realId }).catch(() => undefined);
		throw new Error('v2 session-client: prompt wait aborted');
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer =
			signal === undefined
				? setTimeout(() => {
						if (settled) return;
						settled = true;
						ctx.session
							.interrupt({ sessionID: realId })
							.catch(() => undefined)
							.finally(() => {
								reject(
									new Error(
										'v2 session-client: signal-less prompt wait exceeded cap',
									),
								);
							});
					}, SIGNAL_LESS_WAIT_CAP_MS)
				: undefined;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			ctx.session
				.interrupt({ sessionID: realId })
				.catch(() => undefined)
				.finally(() => {
					reject(new Error('v2 session-client: prompt wait aborted'));
				});
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(ctx.session.wait({ sessionID: realId }))
			.then(() => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				resolve();
			})
			.catch((error: unknown) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : String(error));
			});
	});
}

function makeV2SessionContextHandler(
	realId: string,
	system: string | undefined,
	tools: Readonly<Record<string, false>> | undefined,
): (event: unknown) => Promise<void> {
	return (event: unknown) => {
		const typed = event as V2SessionContextEvent;
		if (!typed || typed.sessionID !== realId) return Promise.resolve();
		if (system !== undefined && Array.isArray(typed.system)) {
			// Fence-aware replacement: provenance-fenced parts (#2526 carriers)
			// survive; everything else yields to the replacement prompt.
			const fenced = typed.system.filter(
				(part) =>
					part &&
					typeof part.text === 'string' &&
					part.text.includes(SYSTEM_DIRECTIVE_FENCE_OPEN),
			);
			typed.system.length = 0;
			typed.system.push(
				...fenced.map((part) => ({ type: 'text' as const, text: part.text })),
				{ type: 'text' as const, text: system },
			);
		}
		if (tools && typed.tools && typeof typed.tools === 'object') {
			let deleted = 0;
			for (const name of Object.keys(tools)) {
				if (Object.hasOwn(typed.tools, name)) {
					delete typed.tools[name as keyof typeof typed.tools];
					deleted += 1;
				}
			}
			if (deleted > 0) {
				log('v2 session-client: denied tools via context hook', {
					count: deleted,
				});
			}
		}
		return Promise.resolve();
	};
}

function promptBodyText(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	const texts: string[] = [];
	for (const part of parts) {
		if (
			part &&
			typeof part === 'object' &&
			(part as { type?: unknown }).type === 'text' &&
			typeof (part as { text?: unknown }).text === 'string'
		) {
			texts.push((part as { text: string }).text);
		}
	}
	return texts.join('\n');
}

/** The placeholder-path blocking prompt: real create + hook + prompt + wait + context. */
async function deferredV2SessionPromptPlaceholder(
	ctx: V2PluginContext,
	_placeholderId: string,
	stash: PlaceholderRecord,
	body: {
		agent?: unknown;
		model?: { providerID?: unknown; modelID?: unknown };
		system?: unknown;
		tools?: Readonly<Record<string, false>>;
	},
	text: string,
	signal: AbortSignal | undefined,
): Promise<{ data: TranslatedPromptData }> {
	// Mark in-flight SYNCHRONOUSLY (before the first await): the caller's
	// abort/delete teardown can arrive while realId is still unbound, and the
	// pending flags only help when promptStarted is already set.
	stash.promptStarted = true;
	// If the caller's signal is already aborted, do not create anything — the
	// dispatcher's awaitWithAbort would reject this call without cleanup.
	if (signal?.aborted) {
		throw new Error('v2 session-client: prompt wait aborted');
	}
	// #3186 review PRR-002: a placeholder id is legitimately re-prompted across
	// a caller's retry/fallback chain (curator, skill-improver, mutation
	// generator re-prompt the SAME session id per model attempt). Minting a
	// second host session would orphan the first — teardown can only ever
	// reach the newest realId. Retire the superseded session before minting
	// (its result was already consumed, so v1-accumulated context from a
	// failed attempt is not preserved), and reset the previous dispatch's
	// parked flags so they cannot fire against the fresh session.
	const previousRealId = stash.realId;
	if (previousRealId !== undefined) {
		stash.realId = undefined;
		stash.abortPending = false;
		stash.deletePending = false;
		await ctx.session
			.remove({ sessionID: previousRealId })
			.catch(() => undefined);
	}
	const agent = typeof body.agent === 'string' ? body.agent : undefined;
	const model =
		body.model &&
		typeof body.model.providerID === 'string' &&
		typeof body.model.modelID === 'string'
			? { id: body.model.modelID, providerID: body.model.providerID }
			: undefined;
	const system = typeof body.system === 'string' ? body.system : undefined;
	// Inline (not a prebuilt object) so the session.create directory-expression
	// guardrail (tests/unit/config/session-create-directory-guardrail.test.ts)
	// can trace `stash.directory` to its origin — the v1 caller's
	// `query.directory`.
	const created = await ctx.session.create({
		...(stash.parentID !== undefined ? { parentID: stash.parentID } : {}),
		...(stash.title !== undefined ? { title: stash.title } : {}),
		...(agent !== undefined ? { agent } : {}),
		...(model !== undefined ? { model } : {}),
		location: { directory: stash.directory },
		permissions: readOnlyToolsToV2Permissions(body.tools),
	});
	const createdRecord = created as {
		id?: unknown;
		location?: { directory?: unknown };
	};
	const realId =
		typeof createdRecord?.id === 'string' ? createdRecord.id : undefined;
	if (realId === undefined) {
		throw new Error('v2 session-client: session create returned no id');
	}
	const echoedDirectory =
		typeof createdRecord.location?.directory === 'string'
			? createdRecord.location.directory
			: undefined;
	if (
		echoedDirectory !== undefined &&
		!sameDirectoryLexical(echoedDirectory, stash.directory)
	) {
		await ctx.session.remove({ sessionID: realId }).catch(() => undefined);
		throw new Error(
			`v2 session-client: created session landed in ${echoedDirectory}, not the requested ${stash.directory} (#3169 Phase 0 C1)`,
		);
	}
	// Epoch-scope: a stale recorded error for a recycled host session id must
	// not poison this dispatch.
	sessionErrors.delete(realId);
	let registration: V2Registration | undefined;
	try {
		if (system !== undefined || body.tools !== undefined) {
			registration = await ctx.session.hook(
				'context',
				makeV2SessionContextHandler(realId, system, body.tools) as never,
			);
		}
		await ctx.session.prompt({ sessionID: realId, text });
		await deferredV2SessionWait(ctx, realId, signal);
		const entries = await ctx.session.context({ sessionID: realId });
		return {
			data: await deferredV2SessionTranslate(
				Array.isArray(entries) ? entries : [],
				realId,
			),
		};
	} finally {
		stash.realId = realId;
		if (registration?.dispose) {
			await registration.dispose().catch(() => undefined);
		}
		// #3169 Phase 2 review round 1 (host-session-leak race): the dispatcher's
		// teardown can arrive while the wait above is still pending (its
		// awaitWithAbort rejects on timeout/abort without awaiting this
		// promise), so abort/delete hit the PLACEHOLDER before realId is bound
		// and no-op. Those calls set the pending flags instead; now that the
		// real id exists, honor them — best-effort, never throwing.
		if (stash.abortPending) {
			await ctx.session.interrupt({ sessionID: realId }).catch(() => undefined);
		}
		if (stash.deletePending) {
			sessionErrors.delete(realId);
			await ctx.session.remove({ sessionID: realId }).catch(() => undefined);
		}
	}
}

/** The real-session direct prompt path (wake prompts; no create, no system hook). */
async function deferredV2SessionPromptReal(
	ctx: V2PluginContext,
	sessionId: string,
	body: { agent?: unknown },
	text: string,
	signal: AbortSignal | undefined,
): Promise<{ data: TranslatedPromptData }> {
	if (typeof body.agent === 'string') {
		const switchAgent = ctx.session.switchAgent;
		if (typeof switchAgent === 'function') {
			await switchAgent({ sessionID: sessionId, agent: body.agent });
		}
	}
	sessionErrors.delete(sessionId);
	await ctx.session.prompt({ sessionID: sessionId, text });
	await deferredV2SessionWait(ctx, sessionId, signal);
	const entries = await ctx.session.context({ sessionID: sessionId });
	return {
		data: await deferredV2SessionTranslate(
			Array.isArray(entries) ? entries : [],
			sessionId,
		),
	};
}

function resolveSessionId(id: string): string | undefined {
	const stash = placeholderSessions.get(id);
	if (stash === undefined) return id;
	return stash.realId;
}

/** Feature-detect the full surface the shim requires (types.ts host-tolerance contract). */
export function createV2SessionClient(
	ctx: V2PluginContext,
): OpencodeClient | undefined {
	const session = ctx?.session;
	if (!session || typeof session !== 'object') return undefined;
	for (const member of [
		'create',
		'get',
		'remove',
		'prompt',
		'wait',
		'context',
		'interrupt',
		'hook',
	] as const) {
		if (typeof session[member] !== 'function') return undefined;
	}
	const client = {
		session: {
			create: (args: {
				body?: { parentID?: string; title?: string };
				query: { directory: string };
				signal?: AbortSignal;
			}): Promise<{ data: { id: string } | null; error?: unknown }> =>
				deferredV2SessionCreate(ctx, args),
			prompt: (args: {
				path: { id: string };
				body: Record<string, unknown>;
				signal?: AbortSignal;
			}): Promise<{ data: TranslatedPromptData | null; error?: unknown }> =>
				deferredV2SessionPrompt(ctx, args),
			abort: (args: { path: { id: string } }): Promise<unknown> => {
				const id = args?.path?.id;
				const resolved = resolveSessionId(id);
				if (resolved !== undefined) {
					return ctx.session
						.interrupt({ sessionID: resolved })
						.catch(() => undefined);
				}
				// Prompt in flight but realId not yet bound: park the intent —
				// the prompt's finally performs the interrupt once the id exists
				// (review round 1 leak race). A never-prompted placeholder has
				// no host session, so it stays a no-op.
				const stash = placeholderSessions.get(id);
				if (stash?.promptStarted) stash.abortPending = true;
				return Promise.resolve(undefined);
			},
			delete: (args: { path: { id: string } }): Promise<unknown> => {
				const id = args?.path?.id;
				// Resolve BEFORE anything else — the dispatcher's teardown arrives
				// with the PLACEHOLDER id, and the placeholder must map to the
				// real host session (#3169 Phase 2 F2). The stash is KEPT (not
				// consumed) for non-eager records: the verified-teardown existence
				// check `get` arrives AFTER this delete and must still resolve to
				// the real id, where the host reports the removed session as gone.
				const stash = placeholderSessions.get(id);
				const resolved = resolveSessionId(id);
				if (resolved !== undefined) {
					sessionErrors.delete(resolved);
					// PRR-010: prune only on a CONFIRMED removal. A failed remove
					// leaves the host session ALIVE, so dropping its record would
					// orphan an untracked session and silently lose the parentID
					// overlay the enforcement consumers rely on. The non-eager arm
					// keeps its stash for exactly this keep-for-get reason.
					return deferredV2SessionRemoveEager(ctx, resolved).then((outcome) => {
						if (stash?.eager === true && outcome.ok) {
							placeholderSessions.delete(id);
						} else if (stash?.eager === true) {
							log('v2 session-client: eager delete cleanup failed', {
								reason: outcome.reason,
							});
						}
					});
				}
				// Same leak race as abort: park the delete for the prompt's
				// finally; a never-prompted placeholder deletes nothing.
				if (stash?.promptStarted) stash.deletePending = true;
				return Promise.resolve(undefined);
			},
			get: (args: {
				path: { id: string };
			}): Promise<{ data: unknown; error?: unknown }> => {
				const id = args?.path?.id;
				const stash = placeholderSessions.get(id);
				// #3169 Phase 3: overlay the REMEMBERED parentID for eager records.
				// The overlay is unconditional: it replaces whatever `parentID` the
				// host reported (or supplies it when absent). Eager lane sessions
				// are created WITH that parentID, so it restates the host-recorded
				// parent and is redundant with it; it is kept so
				// `prWorkflowSessionResolver`'s first-hop controller resolution and
				// `lookupParentSessionIDForTaskRoute` stay v1-faithful even when a
				// host projection omits `parentID`. Non-eager records and foreign
				// ids pass through.
				const overlayParentID =
					stash?.eager === true && typeof stash.parentID === 'string'
						? stash.parentID
						: undefined;
				const resolved = resolveSessionId(id);
				if (resolved === undefined) return Promise.resolve({ data: null });
				return (
					ctx.session
						.get({ sessionID: resolved })
						.then((info) => ({
							data:
								overlayParentID !== undefined &&
								info &&
								typeof info === 'object'
									? {
											...(info as Record<string, unknown>),
											parentID: overlayParentID,
										}
									: info,
						}))
						// #3186 review PRR-006: v1 SDK clients resolve error responses
						// to `{error}` envelopes instead of rejecting, so consumers
						// branch on `result.error` or wrap their own try/catch
						// (pr-workflow-session-resolver is awaited bare in the
						// fail-closed tool-before chain). Forwarding the rejection
						// verbatim would surface it there and block every tool call.
						.catch((error: unknown) => ({ data: null, error }))
				);
			},
		},
	};
	return client as unknown as OpencodeClient;
}

/** Bound for a host-reported/caller-supplied path inside a typed error message. */
const MAX_PATH_IN_MESSAGE_CHARS = 200;

/**
 * PRR-011: bound interpolated paths. The placement-guard message is not just
 * display text — dispatch-lanes' retry classifier regex-tests the error object's
 * `message` scalar (src/tools/dispatch-lanes.ts isRetryableSessionCreateFailure),
 * so an unbounded, HOST-reported path is an unbounded influence on control flow
 * and on the advisory queue's message size.
 */
function boundPathForMessage(path: string | undefined): string {
	if (path === undefined) return 'an unverifiable location';
	if (path.length <= MAX_PATH_IN_MESSAGE_CHARS) return path;
	return `${path.slice(0, MAX_PATH_IN_MESSAGE_CHARS)}… (truncated)`;
}

/**
 * PRR-001/PRR-007/PRR-010: one bounded, outcome-reporting removal helper for the
 * eager arm. The placement-compensation removes used to be bare
 * `await ctx.session.remove(...).catch(() => undefined)` — unbounded (which is
 * what the dual-shape C6 gate flags once the scanner's function tracker is
 * reset by a neighbouring cast-assignment) and outcome-blind (a failed
 * cleanup of a mis-placed session was indistinguishable from a successful
 * one). This bounds the call and reports what happened.
 */
async function deferredV2SessionRemoveEager(
	ctx: V2PluginContext,
	sessionID: string,
): Promise<{ ok: boolean; reason?: string }> {
	const cleanupTimeoutMs = _internals.eagerCleanupTimeoutMs;
	try {
		await withTimeout(
			ctx.session.remove({ sessionID }),
			cleanupTimeoutMs,
			new Error(
				`v2 session-client: eager cleanup of session ${sessionID} exceeded ${cleanupTimeoutMs}ms`,
			),
		);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Outcome of a host call raced against a deadline and the caller's signal. */
type BoundedCall<T> =
	| { kind: 'settled'; value: T }
	| { kind: 'rejected'; error: unknown }
	| { kind: 'timeout' }
	| { kind: 'aborted' };

/**
 * Race a host call against `ms` (via `withTimeout`) and, when given, the
 * caller's signal. Host session calls take no AbortSignal (the vendored
 * `V2SessionDomain` inputs carry none), so this only stops WAITING: the
 * underlying call may still complete. Settlement handlers are attached to
 * `promise` up front, so a late rejection is never unhandled.
 */
async function deferredV2SessionBoundedCall<T>(
	promise: Promise<T>,
	ms: number,
	signal?: AbortSignal,
): Promise<BoundedCall<T>> {
	const settled: Promise<BoundedCall<T>> = promise.then(
		(value) => ({ kind: 'settled', value }),
		(error: unknown) => ({ kind: 'rejected', error }),
	);
	if (signal?.aborted) return { kind: 'aborted' };
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<BoundedCall<T>>((resolve) => {
		onAbort = () => resolve({ kind: 'aborted' });
		signal?.addEventListener('abort', onAbort, { once: true });
	});
	const timedOut = new Error('v2 session-client: bounded host call timed out');
	try {
		return await withTimeout(Promise.race([settled, aborted]), ms, timedOut);
	} catch (error) {
		if (error === timedOut) return { kind: 'timeout' };
		throw error;
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * A session's reported `location.directory` (undefined when the host reports
 * none or rejects). The read is bounded: a `get` that outlives `ms` or the
 * caller's signal is a terminal placement failure (`timeout` / `aborted`).
 */
async function deferredV2SessionReadDirectory(
	ctx: V2PluginContext,
	sessionID: string,
	signal: AbortSignal | undefined,
	ms: number = _internals.laneReadTimeoutMs,
): Promise<{ directory?: string; terminal?: 'timeout' | 'aborted' }> {
	const read = await deferredV2SessionBoundedCall(
		ctx.session.get({ sessionID }),
		ms,
		signal,
	);
	if (read.kind === 'timeout' || read.kind === 'aborted') {
		return { terminal: read.kind };
	}
	if (read.kind === 'rejected') return {};
	// Non-parenthesized on purpose: a `const x = (` cast-assignment matches
	// the C6 scanner's function-binding regex and resets its function tracker
	// mid-function, mis-attributing later awaits (dual-shape-parity.test.ts
	// C6 gate). Keep cast bindings off a leading `(` in this file.
	const reported = read.value as
		| { location?: { directory?: unknown } }
		| undefined;
	return typeof reported?.location?.directory === 'string'
		? { directory: reported.location.directory }
		: {};
}

type LaneMoveOutcome =
	| { ok: true; landed: string }
	| {
			ok: false;
			aborted: boolean;
			reason?: string;
			landed?: string;
			/** The move was still pending when the bounded settle wait ended. */
			moveUnsettled?: boolean;
	  };

/**
 * Relocate a freshly created, parented lane session into its worktree and
 * confirm the host applied it. OpenCode 2.1.x derives a parented child's
 * location from its parent (a `location` passed to create is ignored), and
 * `session.move` is the host's supported way to change a session's
 * directory: live probe on 2.1.4 — the moved session keeps its `parentID` and
 * `projectID`, reports the lane directory within 0.04–0.34 s, and its shell
 * commands then run with the lane as cwd. The move is applied asynchronously,
 * so the session is re-read (bounded by `_internals`) until it reports the
 * lane directory; the last observed directory is returned on timeout so the
 * caller's typed error names where the session actually is.
 */
async function deferredV2SessionMoveIntoLane(
	ctx: V2PluginContext,
	sessionID: string,
	directory: string,
	signal: AbortSignal | undefined,
): Promise<LaneMoveOutcome> {
	if (typeof ctx.session.move !== 'function') {
		return {
			ok: false,
			aborted: false,
			reason: 'the host session domain has no session.move',
		};
	}
	// `delivery` is deliberately omitted: it only sequences a move against
	// an in-flight run (`steer` interrupts it, `queue` waits for it), and
	// this session was created by the caller a moment ago and has never
	// been prompted, so there is nothing to sequence against. The live 2.1.4
	// probe relocated an idle session identically with `delivery` omitted,
	// `steer` and `queue`, and the vendored `move` input type
	// (src/host/v2/types.ts) pins no delivery value — nor an abort signal, so
	// a timed-out or aborted move cannot be cancelled host-side.
	const pendingMove = ctx.session.move({ sessionID, directory });
	const moveTimeoutMs = _internals.laneMoveTimeoutMs;
	const moved = await deferredV2SessionBoundedCall(
		pendingMove,
		moveTimeoutMs,
		signal,
	);
	if (moved.kind === 'rejected') {
		return {
			ok: false,
			aborted: false,
			reason: `session.move failed: ${
				moved.error instanceof Error ? moved.error.message : String(moved.error)
			}`,
		};
	}
	if (moved.kind === 'timeout' || moved.kind === 'aborted') {
		// Serialise compensation with the uncancellable move: the caller removes
		// the session next, and a removal racing a still-pending relocation
		// could leave the host to apply the move afterwards. Wait (bounded) for
		// the move to settle; if it does not, report the removal as unconfirmed.
		const late = await deferredV2SessionBoundedCall(
			pendingMove,
			_internals.laneMoveSettleMs,
		);
		return {
			ok: false,
			aborted: moved.kind === 'aborted',
			...(moved.kind === 'timeout'
				? { reason: `session.move exceeded ${moveTimeoutMs}ms` }
				: {}),
			...(late.kind === 'timeout' ? { moveUnsettled: true } : {}),
		};
	}
	let observed: string | undefined;
	const attempts = _internals.laneMovePollAttempts;
	const deadline = Date.now() + _internals.laneConfirmBudgetMs;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const read = await deferredV2SessionReadDirectory(
			ctx,
			sessionID,
			signal,
			Math.min(_internals.laneReadTimeoutMs, remaining),
		);
		// Re-check AFTER the read: an abort that lands while the final read is
		// pending must not be reported as a successful placement.
		if (read.terminal === 'aborted' || signal?.aborted) {
			return { ok: false, aborted: true, landed: observed };
		}
		if (read.terminal === 'timeout') {
			return {
				ok: false,
				aborted: false,
				reason: 'a placement read timed out',
				landed: observed,
			};
		}
		observed = read.directory;
		if (
			read.directory !== undefined &&
			sameDirectoryLexical(read.directory, directory)
		) {
			return { ok: true, landed: read.directory };
		}
		if (attempt < attempts - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, _internals.laneMovePollDelayMs),
			);
		}
	}
	return { ok: false, aborted: false, landed: observed };
}

/**
 * PRR-007: the caller's abort/timeout can land while the eager create is
 * still in flight (its cleanup keys on the RESOLVED id, so an abandoned
 * create would otherwise leave a live session nobody holds the id for).
 * Remove what was created and refuse.
 */
async function deferredV2SessionEagerAbortCompensation(
	ctx: V2PluginContext,
	realId: string,
	moveUnsettled = false,
): Promise<{ data: null; error: unknown }> {
	const compensated = await deferredV2SessionRemoveEager(ctx, realId);
	if (!compensated.ok) {
		// Report the truth: the compensation itself failed, so the session may
		// still be alive and the caller needs the id to clean it up.
		log('v2 session-client: aborted eager create compensation failed', {
			reason: compensated.reason,
		});
	}
	return {
		data: null,
		error: {
			message: `v2 session-client: eager lane create aborted by the caller; ${
				compensated.ok
					? 'the created session was removed'
					: `removing session ${realId} also failed (${compensated.reason ?? 'unknown error'}) — remove it manually`
			}${moveUnsettledNote(realId, moveUnsettled && compensated.ok)}`,
			...(compensated.ok ? {} : { sessionID: realId, cleanupFailed: true }),
			...(moveUnsettled && compensated.ok
				? { sessionID: realId, cleanupUnconfirmed: true }
				: {}),
		},
	};
}

/**
 * #3558 review F2: a removal issued while the uncancellable `session.move` was
 * still pending is not proven final — the host might still apply the move.
 */
function moveUnsettledNote(realId: string, unsettled: boolean): string {
	return unsettled
		? `; session.move had not settled within ${_internals.laneMoveSettleMs}ms, so the removal of session ${realId} is unconfirmed — verify it is gone before retrying`
		: '';
}

/**
 * #3169 Phase 3 — the EAGER lane create (confirmed divergence only).
 *
 * Creates a REAL host session immediately WITH `parentID` — the host records
 * the true parent, which OpenCode 2.1.x's native `subagent` tool requires
 * before it resumes the session ("Session X is not a child of the current
 * session") — and WITHOUT permissions (lane coders need full tools; the
 * read-only map is a dispatcher-only concept). Placement is the entire point,
 * so it is REQUIRED: when the created session does not already report the
 * lane directory (echo, else `get`), it is relocated with `session.move` and
 * re-read until it does. A host whose parented create already honours the
 * requested `location` therefore never sees a move. Any failure (move
 * rejected or unavailable, relocation never observed, caller abort) removes
 * the session and fails closed (the consumer's existing
 * `STANDARD_WORKTREE_SESSION_CREATE_FAILED` degradation runs unchanged). The
 * requested `parentID` is also remembered plugin-side for the `get` overlay
 * (see the client's `get`).
 */
async function deferredV2SessionCreateEager(
	ctx: V2PluginContext,
	parentID: string,
	title: string | undefined,
	directory: string,
	signal: AbortSignal | undefined,
): Promise<{ data: { id: string } | null; error?: unknown }> {
	// PRR-006: keep the v1 envelope contract — a host rejection resolves to
	// `{data:null,error}`, never a throw (the shim's contract note at the
	// `get` arm says the same).
	let created: unknown;
	try {
		// `location` is still sent: OpenCode 2.1.x ignores it for a parented
		// create (the child lands in the parent's directory and is moved
		// below), while a host that honours it places the child directly and
		// the move is skipped.
		created = await ctx.session.create({
			parentID,
			...(title !== undefined ? { title } : {}),
			location: { directory },
		});
	} catch (error) {
		return {
			data: null,
			error: {
				message: `v2 session-client: eager lane create failed (${
					error instanceof Error ? error.message : String(error)
				})`,
			},
		};
	}
	const createdRecord = created as {
		id?: unknown;
		location?: { directory?: unknown };
	};
	const realId =
		typeof createdRecord?.id === 'string' ? createdRecord.id : undefined;
	if (realId === undefined) {
		return {
			data: null,
			error: {
				message:
					'v2 session-client: eager lane create returned no id (#3169 Phase 3)',
			},
		};
	}
	if (signal?.aborted) {
		return deferredV2SessionEagerAbortCompensation(ctx, realId);
	}
	let landed: string | undefined;
	let placementFailure: string | undefined;
	let moveUnsettled = false;
	if (typeof createdRecord.location?.directory === 'string') {
		landed = createdRecord.location.directory;
	} else {
		// #3558 review F1: the verification read is bounded like every other
		// placement read; a timeout is terminal (no move is attempted).
		const read = await deferredV2SessionReadDirectory(ctx, realId, signal);
		if (read.terminal === 'aborted') {
			return deferredV2SessionEagerAbortCompensation(ctx, realId);
		}
		if (read.terminal === 'timeout') {
			placementFailure = 'the placement read timed out';
		}
		landed = read.directory;
	}
	if (
		placementFailure === undefined &&
		(landed === undefined || !sameDirectoryLexical(landed, directory))
	) {
		const moved = await deferredV2SessionMoveIntoLane(
			ctx,
			realId,
			directory,
			signal,
		);
		if (moved.ok) {
			landed = moved.landed;
		} else if (moved.aborted) {
			return deferredV2SessionEagerAbortCompensation(
				ctx,
				realId,
				moved.moveUnsettled === true,
			);
		} else {
			landed = moved.landed ?? landed;
			moveUnsettled = moved.moveUnsettled === true;
			placementFailure =
				moved.reason === undefined
					? undefined
					: `moving it into the lane failed (${boundPathForMessage(moved.reason)})`;
		}
	}
	if (
		placementFailure !== undefined ||
		landed === undefined ||
		!sameDirectoryLexical(landed, directory)
	) {
		// PRR-010: surface a FAILED removal in the typed envelope rather than
		// swallowing it — a mis-placed live session holding the lane's swarm.db
		// WAL is the #2599 hazard, and the caller needs the id to retry teardown.
		const removed = await deferredV2SessionRemoveEager(ctx, realId);
		return {
			data: null,
			error: {
				message: `v2 session-client: eager lane create landed in ${boundPathForMessage(
					landed,
				)}, not the requested ${boundPathForMessage(directory)}${
					placementFailure !== undefined ? `; ${placementFailure}` : ''
				} (#3169 Phase 3 placement guard; Phase 0 C1)${
					removed.ok
						? ''
						: `; cleanup of session ${realId} also failed (${removed.reason ?? 'unknown error'}) — remove it before retrying`
				}${moveUnsettledNote(realId, moveUnsettled && removed.ok)}`,
				...(removed.ok ? {} : { sessionID: realId, cleanupFailed: true }),
				...(moveUnsettled && removed.ok
					? { sessionID: realId, cleanupUnconfirmed: true }
					: {}),
			},
		};
	}
	rememberPlaceholder(realId, {
		parentID,
		...(title !== undefined ? { title } : {}),
		directory,
		realId,
		eager: true,
	});
	return { data: { id: realId } };
}

/** The shim's create: placement precheck, then placeholder mint (no host call). */
async function deferredV2SessionCreate(
	ctx: V2PluginContext,
	args: {
		body?: { parentID?: string; title?: string };
		query: { directory: string };
		signal?: AbortSignal;
	},
): Promise<{ data: { id: string } | null; error?: unknown }> {
	const directory = args?.query?.directory;
	if (typeof directory !== 'string' || directory.length === 0) {
		return {
			data: null,
			error: {
				message:
					'v2 session-client: create requires query.directory (v1 contract)',
			},
		};
	}
	const parentID = args?.body?.parentID;
	if (parentID !== undefined) {
		const parentDirectory = await deferredV2SessionGetParentDirectory(
			ctx,
			parentID,
		).catch(() => undefined);
		if (parentDirectory === undefined) {
			return {
				data: null,
				error: {
					message:
						'v2 session-client: parent session placement unverifiable (get returned no location.directory — live-verification item on #3169 Phase 2)',
				},
			};
		}
		if (!sameDirectoryLexical(parentDirectory, directory)) {
			// #3169 Phase 3: a CONFIRMED divergence is the worktree-isolation lane
			// shape (a lane worktree directory always differs from the parent's
			// project root). The Phase 2 refusal becomes an EAGER parented real
			// create moved into the requested directory — placement-verified,
			// with the requested parentID also remembered plugin-side for the
			// `get` overlay (the discriminator, its flip list, and the disclosed
			// deltas live in the trace's approved plan).
			//
			// PRR-008 (disclosed, not narrowed): the discriminator is DIVERGENCE
			// ONLY — any in-plugin caller whose parent session lives elsewhere
			// reaches this arm. That includes factory-from-lane callers (e.g. a
			// lane coder invoking the knowledge-curator delegate), whose session
			// is created as the lane's child and then moved into the project
			// root. The session is ephemeral and caller-deleted; narrowing
			// the arm to registered lanes would need a lane-registry lookup on the
			// create path (deferred to Phase 4 with the registry-residue work).
			return deferredV2SessionCreateEager(
				ctx,
				parentID,
				args?.body?.title,
				directory,
				args?.signal,
			);
		}
	}
	placeholderCounter += 1;
	const placeholderId = `v2shim-${placeholderCounter}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	rememberPlaceholder(placeholderId, {
		...(parentID !== undefined ? { parentID } : {}),
		...(args?.body?.title !== undefined ? { title: args.body.title } : {}),
		directory,
	});
	return { data: { id: placeholderId } };
}

/**
 * #3169 Phase 3 — the full-treatment prompt for an EAGER (real, parented
 * lane) session. No create (the session exists); agent/model arrive via
 * `switchAgent`/`switchModel` (feature-detected — a partial host degrades to
 * skipping the switch, disclosed in the header), the per-session `context`
 * hook carries the fence-aware system replacement and denied-tool deletion,
 * and the error store is epoch-scoped BEFORE the prompt: the eager id is
 * STABLE across a caller's retry chain (curator/skill-improver/mutation
 * generator re-prompt the same id per model attempt), so a stale
 * `session.error` from attempt 1 must not mask a succeeded attempt 2.
 */
async function deferredV2SessionPromptEager(
	ctx: V2PluginContext,
	realId: string,
	body: {
		agent?: unknown;
		model?: { providerID?: unknown; modelID?: unknown };
		system?: unknown;
		tools?: Readonly<Record<string, false>>;
	},
	text: string,
	signal: AbortSignal | undefined,
): Promise<{ data: TranslatedPromptData }> {
	// PRR-019/a: short-circuit an already-aborted caller BEFORE switching,
	// registering the hook, or submitting a prompt — the placeholder arm does
	// exactly this so a teardown-then-prompt race cannot burn a host turn (or
	// hit the caller's already-removed session).
	if (signal?.aborted) {
		throw new Error('v2 session-client: eager prompt aborted before dispatch');
	}
	const agent = typeof body.agent === 'string' ? body.agent : undefined;
	if (agent !== undefined) {
		const switchAgent = ctx.session.switchAgent;
		if (typeof switchAgent === 'function') {
			await switchAgent({ sessionID: realId, agent });
		} else {
			// PRR-009: the eager create carries no agent (permissions/agent are
			// create-time-only on v2), so a host without switchAgent runs the lane
			// under its DEFAULT agent. Make the degradation observable rather than
			// reporting a success the caller cannot distinguish.
			log(
				'v2 session-client: eager prompt skipped switchAgent (host lacks it)',
				{
					agent,
				},
			);
		}
	}
	const model =
		body.model &&
		typeof body.model.providerID === 'string' &&
		typeof body.model.modelID === 'string'
			? { id: body.model.modelID, providerID: body.model.providerID }
			: undefined;
	if (model !== undefined) {
		const switchModel = ctx.session.switchModel;
		if (typeof switchModel === 'function') {
			await switchModel({ sessionID: realId, model });
		} else {
			log(
				'v2 session-client: eager prompt skipped switchModel (host lacks it)',
				{ model },
			);
		}
	}
	const system = typeof body.system === 'string' ? body.system : undefined;
	sessionErrors.delete(realId);
	let registration: V2Registration | undefined;
	try {
		if (system !== undefined || body.tools !== undefined) {
			registration = await ctx.session.hook(
				'context',
				makeV2SessionContextHandler(realId, system, body.tools) as never,
			);
		}
		await ctx.session.prompt({ sessionID: realId, text });
		await deferredV2SessionWait(ctx, realId, signal);
		const entries = await ctx.session.context({ sessionID: realId });
		return {
			data: await deferredV2SessionTranslate(
				Array.isArray(entries) ? entries : [],
				realId,
			),
		};
	} finally {
		if (registration?.dispose) {
			await registration.dispose().catch(() => undefined);
		}
	}
}

/** The shim's prompt: three arms keyed on the registry (eager / placeholder / direct). */
async function deferredV2SessionPrompt(
	ctx: V2PluginContext,
	args: {
		path: { id: string };
		body: Record<string, unknown>;
		signal?: AbortSignal;
	},
): Promise<{ data: TranslatedPromptData | null; error?: unknown }> {
	const id = args?.path?.id;
	if (typeof id !== 'string' || id.length === 0) {
		return {
			data: null,
			error: { message: 'v2 session-client: prompt requires path.id' },
		};
	}
	const body = (args?.body ?? {}) as {
		agent?: unknown;
		model?: { providerID?: unknown; modelID?: unknown };
		system?: unknown;
		tools?: Readonly<Record<string, false>>;
		parts?: unknown;
	};
	const text = promptBodyText(body.parts);
	const stash = placeholderSessions.get(id);
	// Routing keys on the `eager` FLAG, never on `realId` presence: a prompted
	// placeholder also has `realId` bound (its finally keeps the stash) and must
	// keep the PRR-002 retire-and-recreate semantics.
	if (
		stash !== undefined &&
		stash.eager === true &&
		stash.realId !== undefined
	) {
		return deferredV2SessionPromptEager(
			ctx,
			stash.realId,
			body,
			text,
			args?.signal,
		);
	}
	if (stash !== undefined) {
		return deferredV2SessionPromptPlaceholder(
			ctx,
			id,
			stash,
			body,
			text,
			args?.signal,
		);
	}
	return deferredV2SessionPromptReal(ctx, id, body, text, args?.signal);
}
