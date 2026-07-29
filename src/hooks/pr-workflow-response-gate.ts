import {
	cancelPrWorkflowPluginWake,
	clearPrWorkflowAutoWakeState,
	isPrWorkflowAutoWakeSuppressed,
	markPrWorkflowPluginWake,
	observePrWorkflowAutoWakeEvent,
} from './pr-workflow-auto-wake.js';
import { readPrWorkflowGateState } from './pr-workflow-gate.js';

const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

export const _internals: {
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
} = {
	readPrWorkflowGateState,
};

/**
 * Maximum number of consecutive unproductive auto-resumes per gated session
 * before the response gate suspends further wakes. "Unproductive" means the
 * durable gate's `revision` did not advance between wakes — i.e. no
 * state-mutating controller tool (dispatch_lanes_async,
 * write_pr_review_trigger_eval, complete_pr_workflow, recordPrReview*,
 * bindPrReviewBase, …) made durable progress. A healthy review bumps
 * `revision` on every successful state-mutating controller call, so the
 * consecutive counter resets on progress and never exhausts the budget.
 * Read-only tools (collect_lane_results polling, grep, read) intentionally do
 * NOT bump `revision` — an architect that only polls without ever dispatching
 * new lanes or recording trigger evaluations IS making progress on the
 * runtime's bookkeeping but is not advancing the durable gate, so the budget
 * treats long polling-only stretches conservatively. Only a genuinely stuck
 * session holds `revision` constant across many idle cycles.
 */
export const DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_WAKES = 5;

/**
 * Cooldown applied ONLY between consecutive unproductive wakes. The first
 * wake after progress is never throttled, so a review that is actively
 * bumping `revision` never waits.
 */
export const DEFAULT_WAKE_COOLDOWN_MS = 30_000;

/**
 * Minimum time between FULL workflow banners for a single session. The banner
 * is injected at most once per assistant MESSAGE (see the `banneredMessages`
 * map in {@link createPrWorkflowResponseGate}); this cooldown only chooses
 * whether that one injection is the full multi-line banner or the short
 * one-line marker.
 *
 * Suspended and user-interrupted states BYPASS the cooldown: those are
 * invariant-10 operational notices that must not be downgraded to the short
 * marker. They are still subject to the per-message dedupe — "always visible"
 * means visible on every user-facing turn, not repeated on every part of it.
 * Overridable via `createPrWorkflowResponseGate({ bannerCooldownMs })`.
 */
export const DEFAULT_BANNER_COOLDOWN_MS = 20_000;

/**
 * Absolute per-session injection ceiling used ONLY when the host does not
 * supply `messageID`. The pinned host contract
 * (`@opencode-ai/plugin` `index.d.ts`: `experimental.text.complete` receives
 * `{ sessionID, messageID, partID }`, all required) always supplies it, so this
 * path is defensive. Without a ceiling, a host that omitted `messageID` would
 * fall back to the wall-clock window alone — which is exactly the behavior that
 * produced the measured flood (968 marker-only lines, 55.3% of a real review
 * transcript), because a cooldown only downgrades an injection, it never
 * suppresses one.
 */
export const MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION = 20;

/**
 * Structural prefix of every banner this module emits, in either mode and in
 * both the full and short forms. Used to make injection idempotent: if a text
 * part already opens with a banner (host write-back of a previously mutated
 * buffer, or a model that opened its turn by quoting one) a second banner is
 * never stacked on top. Anchored at `^` on purpose — a reviewer lane quoting
 * this file's banner literal MID-part is legitimate content and must not be
 * mistaken for an injection.
 */
const BANNER_PREFIX_PATTERN = /^--- \[(?:PR_REVIEW|PR_FEEDBACK) WORKFLOW ACTIVE/;

/**
 * Bounded FIFO map of tracked wake budgets. Invariant 8 (session/global
 * state): module-level state must have an explicit eviction strategy. Three
 * further per-session maps share this same bound and the same FIFO discipline:
 * `bannerStamps` (instant of the last full banner), `banneredMessages` (the
 * assistant message already carrying a banner), and `fallbackInjections` (the
 * injection count on the messageID-less path).
 */
export const MAX_TRACKED_WAKE_SESSIONS = 200;

interface PromptResult {
	error?: unknown;
}

interface SessionClient {
	prompt: (args: unknown) => Promise<PromptResult>;
	promptAsync?: (args: unknown) => Promise<PromptResult>;
}

interface PrWorkflowResponseGateClient {
	session?: unknown;
}

interface IdleEvent {
	type?: unknown;
	properties?: { sessionID?: unknown };
}

interface WakeBudget {
	consecutiveUnproductive: number;
	lastWakeAt: number;
	lastSeenRevision?: number;
	suspended: boolean;
}

/**
 * Compose the auto-wake continuation prompt text. This is sent to the model
 * as a user-role message on session.idle — NOT as a replacement of the
 * model's own text. It tells the model the gate is still active and names
 * the recovery paths. Naming the abort path is load-bearing: a trapped model
 * reads this every wake, and without an explicit exit it will keep retrying
 * the same blocked tools forever. When `suspended` is true, the operational
 * notice (invariant 10 — always visible, not debug-gated) tells the user
 * the session will not auto-resume and how to recover.
 */
function blockedText(
	mode: string,
	options: {
		suspended?: boolean;
		userInterrupted?: boolean;
		maxConsecutive?: number;
	} = {},
): string {
	const lines: string[] = [
		`[${mode} WORKFLOW ACTIVE]`,
		`The ${mode} workflow gate is still active. Continue with the required structured lanes, evidence, and controller tools until \`complete_pr_workflow\` succeeds.`,
		`If the bind/checkout path is unreachable — for example a compound \`git fetch && git checkout\` was rejected as read-only shell syntax, the PR head cannot be fetched, or the working tree is on the wrong branch — call \`abort_pr_workflow\` (mode: "${mode}", reason: "<one-line cause>") to clear the gate, or ask the user to run \`/swarm abort-pr-workflow\`.`,
	];
	if (options.suspended) {
		const max = options.maxConsecutive;
		lines.push(
			`Auto-resume is suspended after ${max ?? 'the configured number of'} consecutive unproductive retries (the durable gate \`revision\` did not advance). The session will not be re-awoken automatically. Run \`/swarm abort-pr-workflow\` or call \`abort_pr_workflow\` to clear the gate, or complete the workflow with \`complete_pr_workflow\` to publish normally.`,
		);
	}
	if (options.userInterrupted) {
		lines.push(
			'Auto-resume is paused after a user interruption. The durable workflow gate is preserved, but the plugin will not re-awaken this session. Send a new message to continue, or run `/swarm abort-pr-workflow` to clear the workflow.',
		);
	}
	return lines.join('\n');
}

/**
 * Compose a compact workflow-active banner prepended to architect text parts.
 * Unlike {@link blockedText} (used for auto-wake continuation prompts), this
 * banner does NOT replace the model's text — it is prepended so the user can
 * see the architect's reasoning and progress while being clearly informed
 * that the output is not a terminal verdict.
 *
 * Recovery instructions for suspended/interrupted states are always present in
 * the banner, so the one injection made for a message always names the recovery
 * path when the session is suspended or interrupted.
 */
function workflowBanner(
	mode: string,
	options: {
		suspended?: boolean;
		userInterrupted?: boolean;
		maxConsecutive?: number;
	} = {},
): string {
	const lines: string[] = [
		`--- [${mode} WORKFLOW ACTIVE — output below is not a terminal verdict; \`complete_pr_workflow\` clears the gate on success; if the bind/checkout path is unreachable call \`abort_pr_workflow\` or run \`/swarm abort-pr-workflow\`] ---`,
	];
	if (options.suspended) {
		const max = options.maxConsecutive;
		lines.push(
			`[Auto-resume is suspended after ${max ?? 'the configured number of'} consecutive unproductive retries. Run \`/swarm abort-pr-workflow\` or call \`abort_pr_workflow\` to clear the gate, or complete the workflow with \`complete_pr_workflow\`.]`,
		);
	}
	if (options.userInterrupted) {
		lines.push(
			'[Auto-resume paused after a user interruption. Send a new message to continue, or run `/swarm abort-pr-workflow` to clear the workflow.]',
		);
	}
	return lines.join(' ');
}

/**
 * Prevent an architect from masquerading a premature text output as a terminal
 * verdict. The text-complete hook prepends a workflow-active banner to the
 * FIRST substantive text part of each architect message while the durable gate
 * exists; the model's original text is preserved below the banner.
 *
 * Injection is bounded on three independent axes, because a banner that is
 * merely throttled is still injected on every part:
 *   1. blank parts are never decorated (a banner labelling no content is noise);
 *   2. a part that already opens with a banner is never re-decorated;
 *   3. at most ONE injection per assistant `messageID`.
 * The wall-clock cooldown (see DEFAULT_BANNER_COOLDOWN_MS) then only chooses
 * whether that single injection is the full banner or the short marker.
 *
 * session.idle mechanically resumes a gated session. The resume loop is bounded
 * (see DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_WAKES) so a session that cannot make
 * progress suspends instead of spinning forever. Suspended and user-interrupted
 * messages bypass the cooldown so their recovery notices are never downgraded to
 * the short marker.
 */
export function createPrWorkflowResponseGate(options: {
	directory: string;
	client?: PrWorkflowResponseGateClient;
	wakeTimeoutMs?: number;
	maxConsecutiveUnproductiveWakes?: number;
	wakeCooldownMs?: number;
	bannerCooldownMs?: number;
}) {
	const wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
	const maxConsecutive =
		options.maxConsecutiveUnproductiveWakes ??
		DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_WAKES;
	const wakeCooldownMs = options.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;
	const bannerCooldownMs =
		options.bannerCooldownMs ?? DEFAULT_BANNER_COOLDOWN_MS;
	const activeWakeSessions = new Set<string>();
	const wakeBudgets = new Map<string, WakeBudget>();
	/**
	 * Per-session instant of the last FULL banner emission (see
	 * {@link DEFAULT_BANNER_COOLDOWN_MS}). Bounded with the same FIFO discipline
	 * as {@link wakeBudgets} (invariant 8) and cleared alongside it in
	 * {@link resetBudget} when the gate clears.
	 */
	const bannerStamps = new Map<string, number>();
	/**
	 * Per-session `messageID` of the assistant message that already carries a
	 * banner. The host supplies `messageID` on every `experimental.text.complete`
	 * invocation, and one assistant message spans the whole multi-step agentic
	 * loop — so keying on it collapses a burst of text parts down to a single
	 * injection per user-facing turn. Bounded with the same FIFO discipline as
	 * {@link wakeBudgets} (invariant 8) and cleared in `resetBudget`.
	 */
	const banneredMessages = new Map<string, string>();
	/**
	 * Per-session injection count for the defensive path taken only when the host
	 * omits `messageID` (see
	 * {@link MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION}). Bounded and cleared
	 * alongside the maps above.
	 */
	const fallbackInjections = new Map<string, number>();
	const session = options.client?.session as SessionClient | undefined;

	/** FIFO-evict the oldest budget entry when the map exceeds the bound. */
	function evictIfOverBound(): void {
		while (wakeBudgets.size > MAX_TRACKED_WAKE_SESSIONS) {
			const oldestKey = wakeBudgets.keys().next().value;
			if (oldestKey === undefined) break;
			wakeBudgets.delete(oldestKey);
		}
	}

	/**
	 * FIFO-evict the oldest entry from each of the three banner-dedupe maps when
	 * it exceeds the bound. Mirrors {@link evictIfOverBound} (invariant 8).
	 * Call this at every site that INSERTS into any of them, so the bound is
	 * enforced by the code rather than by an argument about which branches
	 * happen to run together.
	 */
	function evictBannerDedupeMapsIfOverBound(): void {
		while (bannerStamps.size > MAX_TRACKED_WAKE_SESSIONS) {
			const oldestKey = bannerStamps.keys().next().value;
			if (oldestKey === undefined) break;
			bannerStamps.delete(oldestKey);
		}
		while (banneredMessages.size > MAX_TRACKED_WAKE_SESSIONS) {
			const oldestKey = banneredMessages.keys().next().value;
			if (oldestKey === undefined) break;
			banneredMessages.delete(oldestKey);
		}
		while (fallbackInjections.size > MAX_TRACKED_WAKE_SESSIONS) {
			const oldestKey = fallbackInjections.keys().next().value;
			if (oldestKey === undefined) break;
			fallbackInjections.delete(oldestKey);
		}
	}

	/**
	 * Reset helper exposed for production reset paths (state cleared) and for
	 * tests. Mirrors the eviction semantics — never leaves stale budget or
	 * banner-cooldown state behind after a gate clears, so a re-activation of
	 * the same sessionID starts with a fresh full banner.
	 */
	function resetBudget(sessionID: string): void {
		wakeBudgets.delete(sessionID);
		bannerStamps.delete(sessionID);
		banneredMessages.delete(sessionID);
		fallbackInjections.delete(sessionID);
	}

	const textComplete = async (
		input: { sessionID?: string; messageID?: string; partID?: string },
		output: { text: string },
	): Promise<void> => {
		if (!input.sessionID?.trim()) return;
		const state = await _internals.readPrWorkflowGateState(
			options.directory,
			input.sessionID,
		);
		if (!state) {
			// Gate cleared since the last event — drop any stale budget and
			// banner stamp so a future activation of the same sessionID starts
			// fresh (with a full banner).
			resetBudget(input.sessionID);
			clearPrWorkflowAutoWakeState(options.directory, input.sessionID);
			return;
		}
		// (1) Never decorate a blank part. OpenCode completes empty text parts
		// between tool calls and reasoning segments; a banner attached to no
		// content is pure noise, and it was the dominant term in the measured
		// flood — 968 of ~1015 injections in a real review transcript were
		// marker-only lines with no model prose, including one unbroken run of
		// 95. AGENTS.md invariant 10: "Do not emit diagnostic noise into
		// chat-visible streams."
		if (!output.text.trim()) return;
		// (2) Never stack a banner on text that already opens with one. Guards
		// against a host that hands back a previously mutated buffer, and against
		// a model that opens its turn by quoting the banner. Anchored at the
		// start of the part, so a reviewer lane quoting this file mid-part is
		// untouched.
		if (BANNER_PREFIX_PATTERN.test(output.text)) return;
		// (3) At most one injection per assistant message. The host supplies
		// `messageID` on every invocation (`@opencode-ai/plugin`
		// `index.d.ts`: `experimental.text.complete` receives
		// `{ sessionID, messageID, partID }`, all required), and one assistant
		// message spans the entire multi-step loop — so this is what actually
		// collapses a burst of parts to a single user-facing notice. Keying on
		// `partID` instead would suppress nothing: part IDs never repeat.
		const messageID = input.messageID?.trim();
		if (messageID) {
			if (banneredMessages.get(input.sessionID) === messageID) return;
		} else {
			// Defensive path: host omitted `messageID`. The wall-clock window
			// alone cannot bound injections, so apply an absolute ceiling.
			const injected = fallbackInjections.get(input.sessionID) ?? 0;
			if (injected >= MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION) return;
			fallbackInjections.set(input.sessionID, injected + 1);
			// Evict at the INSERT site. The bound was previously satisfied only
			// incidentally — a new key here was always followed by the eviction on
			// the full-banner path further down — but that argument runs three
			// branches deep and any early return added between here and there
			// would silently unbound the map. Invariant 8 wants a structural
			// guarantee, not a provable coincidence.
			evictBannerDedupeMapsIfOverBound();
		}

		const budget = wakeBudgets.get(input.sessionID);
		const suspended = budget?.suspended ?? false;
		const userInterrupted = isPrWorkflowAutoWakeSuppressed(
			options.directory,
			input.sessionID,
		);
		// Suspended and user-interrupted states carry invariant-10 operational
		// recovery notices that must never be DOWNGRADED to the short marker, so
		// they bypass the wall-clock cooldown. They remain subject to the
		// per-message dedupe above: "always visible" means visible on every
		// user-facing turn, not repeated on every part of one. Uses Date.now() to
		// match the wake-budget path's clock (see `now` in the idle handler
		// below); tests freeze the clock via the test-clock helper to exercise
		// cooldown boundaries.
		const forceFullBanner = suspended || userInterrupted;
		const now = Date.now();
		const lastBannerAt = bannerStamps.get(input.sessionID);
		const withinCooldown =
			lastBannerAt !== undefined && now - lastBannerAt < bannerCooldownMs;
		if (messageID) {
			banneredMessages.set(input.sessionID, messageID);
			evictBannerDedupeMapsIfOverBound();
		}
		if (!forceFullBanner && withinCooldown) {
			// A full banner was shown for this session within the cooldown
			// window — prepend only a short active marker so the user still
			// knows the output is gated without re-reading the full banner. The
			// stamp is NOT refreshed here, so the cooldown is measured from the
			// last FULL banner and the full form reliably returns once it
			// elapses. The model's original text is preserved below the marker.
			output.text = `--- [${state.mode} WORKFLOW ACTIVE] ---\n\n${output.text}`;
			return;
		}
		// Prepend the full workflow-active banner and stamp the instant so
		// subsequent parts within the cooldown get the short marker. The
		// original text is preserved so the user can see the architect's
		// reasoning and progress. The banner makes clear that this output is not
		// a terminal verdict — complete_pr_workflow clears the gate on success;
		// abort_pr_workflow can clear an unarmed workflow.
		const banner = workflowBanner(state.mode, {
			suspended,
			userInterrupted,
			maxConsecutive: maxConsecutive,
		});
		bannerStamps.set(input.sessionID, now);
		evictBannerDedupeMapsIfOverBound();
		output.text = `${banner}\n\n${output.text}`;
	};

	const event = async (input: { event: unknown }): Promise<void> => {
		const wakeDecision = await observePrWorkflowAutoWakeEvent(
			options.directory,
			input.event,
		);
		const event = input.event as
			| (IdleEvent & { data?: { sessionID?: unknown } })
			| undefined;
		const sessionID = event?.properties?.sessionID ?? event?.data?.sessionID;
		if (
			event?.type !== 'session.idle' ||
			typeof sessionID !== 'string' ||
			!sessionID.trim() ||
			wakeDecision.suppressWake ||
			activeWakeSessions.has(sessionID)
		) {
			return;
		}
		// Claim synchronously before the first durable read. OpenCode does not
		// await event hooks in dispatch order, so any ownership acquired after an
		// await leaves a window for duplicate idle handlers to start together.
		activeWakeSessions.add(sessionID);
		try {
			const state = await _internals.readPrWorkflowGateState(
				options.directory,
				sessionID,
			);
			if (!state) {
				// Gate already cleared (complete_pr_workflow, abort_pr_workflow, or
				// any future clear path). Drop the budget uniformly — no test-seam
				// coupling to a specific clear caller.
				resetBudget(sessionID);
				clearPrWorkflowAutoWakeState(options.directory, sessionID);
				return;
			}
			// The idle decision above can race a later abort because OpenCode does
			// not await event hooks in dispatch order. Recheck after durable I/O so
			// an abort published while this read was pending still prevents the wake.
			if (isPrWorkflowAutoWakeSuppressed(options.directory, sessionID)) return;
			if (!session) return;

			evictIfOverBound();
			let budget = wakeBudgets.get(sessionID);
			if (!budget) {
				budget = {
					consecutiveUnproductive: 0,
					lastWakeAt: 0,
					suspended: false,
				};
				wakeBudgets.set(sessionID, budget);
			}
			// Suspend check: once the consecutive-unproductive budget is
			// exhausted, never auto-resume again. textComplete still prepends the
			// full banner — carrying the suspension recovery notice, never
			// downgraded to the short marker — to the first substantive part of
			// the user's next turn.
			if (budget.suspended) return;

			const now = Date.now();
			// Progress reset: if the durable gate's revision advanced since the
			// last wake, the session is making healthy progress — zero the
			// consecutive counter so long-running reviews never exhaust it.
			if (
				budget.lastSeenRevision !== undefined &&
				state.revision > budget.lastSeenRevision
			) {
				budget.consecutiveUnproductive = 0;
			}
			// Cooldown: throttle only consecutive unproductive retries. The
			// first wake after progress (consecutiveUnproductive === 0) fires
			// immediately so active reviews are not delayed.
			if (
				budget.consecutiveUnproductive > 0 &&
				budget.lastWakeAt > 0 &&
				now - budget.lastWakeAt < wakeCooldownMs
			) {
				return;
			}

			const madeProgress =
				budget.lastSeenRevision === undefined
					? // First wake ever for this session: treat as a probe, not yet
						// unproductive — we do not know the prior revision.
						true
					: state.revision > budget.lastSeenRevision;

			const pluginWakeMessageID = markPrWorkflowPluginWake(
				options.directory,
				sessionID,
			);
			let promptRejected = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const args = {
					path: { id: sessionID },
					body: {
						messageID: pluginWakeMessageID,
						parts: [
							{
								type: 'text',
								text: `${blockedText(state.mode, {
									suspended: false,
									maxConsecutive: maxConsecutive,
								})}\nDo not stop or summarize. Inspect the durable gate, dispatch or collect the next missing required lane, and continue until complete_pr_workflow succeeds. If the bind/checkout path is genuinely unreachable, call abort_pr_workflow instead of looping.`,
							},
						],
					},
				};
				const call = session.promptAsync
					? session.promptAsync(args)
					: session.prompt(args);
				const result = await Promise.race([
					call,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error('PR workflow resume prompt timed out')),
							wakeTimeoutMs,
						);
					}),
				]);
				if (result?.error != null) {
					promptRejected = true;
					throw new Error(
						`PR workflow resume prompt failed: ${String(result.error)}`,
					);
				}
				// Note: budget bookkeeping runs in the finally block below so an
				// attempted wake counts against the budget even when the resume
				// prompt itself fails or times out. Otherwise a host that keeps
				// returning {error: ...} would never advance the consecutive
				// counter and the auto-resume loop would run unbounded — the
				// exact failure mode this module exists to prevent.
			} finally {
				if (timer) clearTimeout(timer);
				if (promptRejected) {
					cancelPrWorkflowPluginWake(
						options.directory,
						sessionID,
						pluginWakeMessageID,
					);
				}
				// Record the budget state for every attempted wake, including
				// failures. An attempted wake that did not produce progress must
				// count toward the consecutive-unproductive budget; otherwise a
				// failing host resume API would recreate the unbounded loop.
				//
				// Re-read the durable state AFTER the promptAsync await to detect
				// mid-wake progress. `madeProgress` was computed from a snapshot
				// read before the await (response-gate.ts:164); if a concurrent
				// controller tool bumped `state.revision` during the await, the
				// pre-await `madeProgress` would be stale `false`, the counter
				// would wrongly increment, and a healthy session could be
				// falsely suspended at MAX-1. The fresh read here corrects that
				// race: if the revision advanced during the wake, the wake IS
				// productive and the counter resets.
				const postWakeState = await _internals.readPrWorkflowGateState(
					options.directory,
					sessionID,
				);
				budget.lastWakeAt = now;
				if (postWakeState === null) {
					// Gate cleared during the wake (complete/abort). Drop the
					// budget so a future activation starts fresh; never suspend
					// a session whose gate just cleared. (No `return` here —
					// biome: returning inside finally would mask try/catch flow.)
					resetBudget(sessionID);
				} else {
					const currentRevision = postWakeState.revision;
					const effectiveMadeProgress =
						madeProgress ||
						(budget.lastSeenRevision !== undefined &&
							currentRevision > budget.lastSeenRevision);
					budget.lastSeenRevision = currentRevision;
					if (!effectiveMadeProgress) {
						budget.consecutiveUnproductive += 1;
						if (budget.consecutiveUnproductive >= maxConsecutive) {
							budget.suspended = true;
						}
					} else {
						budget.consecutiveUnproductive = 0;
					}
				}
			}
		} finally {
			// Retain ownership through the post-wake durable read and budget update.
			activeWakeSessions.delete(sessionID);
		}
	};

	return {
		event,
		textComplete,
		/**
		 * Test/inspection seam: returns a snapshot of the wake budget for the
		 * given session. Production code does not call this; it exists so
		 * tests can assert the consecutive counter and suspended flag
		 * without relying on `promptAsync` call counts alone.
		 */
		_inspectWakeBudget: (sessionID: string): WakeBudget | undefined =>
			wakeBudgets.get(sessionID),
	};
}
