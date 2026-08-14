import * as fsp from 'node:fs/promises';
import {
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
} from '../background/pr-feedback-event-queue.js';
import {
	cancelPrWorkflowPluginWake,
	clearPrWorkflowAutoWakeState,
	isPrWorkflowAutoWakeSuppressed,
	markPrWorkflowPluginWake,
	observePrWorkflowAutoWakeEvent,
} from './pr-workflow-auto-wake.js';
import {
	type PrReviewDepthTier,
	readPrWorkflowGateState,
} from './pr-workflow-gate.js';
import { validateSwarmPath } from './utils.js';

const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

export const _internals: {
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
	claimPrFeedbackMonitorEvents: typeof claimPrFeedbackMonitorEvents;
	readPrFeedbackMonitorQueue: typeof readPrFeedbackMonitorQueue;
} = {
	readPrWorkflowGateState,
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
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
const BANNER_PREFIX_PATTERN =
	/^--- \[(?:PR_REVIEW|PR_FEEDBACK) WORKFLOW ACTIVE/;

/**
 * Per-tier default total-wake ceilings, derived proportionally from each
 * depth tier's consolidation-floor workload (base lanes + micro lanes).
 *
 * DERIVATION:
 *   Tier workloads (base + micro):  S = 1+1 = 2,  M = 3+6 = 9,  L = 6+11 = 17
 *   Headroom multiplier: 6 (chosen so that L >= 100 and scales uniformly)
 *   Ceilings:  S = 2×6 = 12,  M = 9×6 = 54,  L = 17×6 = 102
 *
 * The tier-L ceiling (102) is comfortably above the observed ~40–55 healthy
 * tier-L wake count, providing generous headroom for real reviews while still
 * bounding pathological loops. Tier-S is tightest because small PRs have the
 * least lane work; tier-M is proportionally in between.
 *
 * When `totalWakeCeiling` is provided to `createPrWorkflowResponseGate`,
 * it overrides these defaults.
 */
export const DEFAULT_TOTAL_WAKE_CEILINGS: Record<PrReviewDepthTier, number> = {
	S: 12,
	M: 54,
	L: 102,
};

/**
 * Bound on the tracked wake budgets. Invariant 8 (session/global state):
 * module-level state must have an explicit eviction strategy. `wakeBudgets`
 * evicts LEAST RECENTLY WOKEN — see {@link evictIfOverBound}, which also
 * refuses to drop suspended or in-flight entries and therefore treats this
 * bound as best-effort. Three further per-session maps share the same numeric
 * bound but keep the simpler insertion-order FIFO discipline, because they
 * hold no enforcement state that is unsafe to lose: `bannerStamps` (instant of
 * the last full banner), `banneredMessages` (the assistant message already
 * carrying a banner), and `fallbackInjections` (the injection count on the
 * messageID-less path).
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
	/** Total number of wake attempts recorded for this budget. NEVER reset by
	 * revision progress — only the consecutive counter resets on progress; that
	 * is the guarantee this counter exists to provide. Its SCOPE is the scope of
	 * the enclosing map (see `wakeBudgets` in
	 * {@link createPrWorkflowResponseGate}): one PROCESS lifetime, running until
	 * the durable gate CLEARS. `resetBudget` drops the entry on a gate clear
	 * (complete/abort) and a plugin reload starts fresh totals — so this is not
	 * a total across the whole conversation/session lifetime.
	 *
	 * Deliberately NOT "one workflow activation": `transitionPrReviewToFeedback`
	 * (`pr-workflow-gate.ts`) mints a new `workflowInstanceId` WITHOUT clearing
	 * the gate, so a budget survives the PR_REVIEW -> PR_FEEDBACK handoff and
	 * keeps accumulating across both activations. See the ceiling note at the
	 * `totalWakes` increment for why that matters. */
	totalWakes: number;
	/** Discriminator for WHY the session was suspended: 'consecutive' means
	 * the consecutive-unproductive budget was exhausted; 'total' means the
	 * total-wake ceiling in force for this process, at the tier the gate
	 * currently reports, was reached (same scope caveat as
	 * {@link WakeBudget.totalWakes}). */
	suspendedReason: 'consecutive' | 'total';
}

/**
 * A total-wake ceiling is only meaningful as a finite positive integer. Every
 * other shape silently DISABLES or INVERTS the brake rather than tuning it:
 * `Infinity` and `NaN` make `totalWakes >= ceiling` never true (so the total
 * brake never fires), and `0` or a negative value makes it true on the very
 * first wake (so the session suspends before it can do any work). Fractional
 * values are accepted by the comparison but describe a ceiling that can never
 * be hit exactly, which is a configuration mistake rather than an intent.
 *
 * Invalid values fall back to {@link DEFAULT_TOTAL_WAKE_CEILINGS} at RESOLVE
 * time rather than throwing at construction. The sibling options
 * (`maxConsecutiveUnproductiveWakes`, `wakeCooldownMs`, `bannerCooldownMs`) are
 * all plain `?? default` reads, so a throw here would be the only option in
 * this factory able to crash plugin initialization — a strictly worse failure
 * mode than clamping to a safe default.
 */
function isValidTotalWakeCeiling(value: number | undefined): value is number {
	// Number.isInteger is false for NaN and both Infinities, so this single
	// predicate covers finiteness, integrality, and positivity.
	return value !== undefined && Number.isInteger(value) && value > 0;
}

function canonicalGitHubPrUrl(value: string): string | null {
	try {
		const url = new URL(value);
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
		if (
			url.protocol !== 'https:' ||
			url.hostname.toLowerCase() !== 'github.com' ||
			!match
		) {
			return null;
		}
		const number = Number(match[3]);
		if (!Number.isSafeInteger(number) || number <= 0) return null;
		return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${number}`;
	} catch {
		return null;
	}
}

function sameGitHubPr(left: string, right: string): boolean {
	const leftCanonical = canonicalGitHubPrUrl(left);
	return (
		leftCanonical !== null && leftCanonical === canonicalGitHubPrUrl(right)
	);
}

function formatQueuedMonitorEventsText(
	events: Awaited<ReturnType<typeof claimPrFeedbackMonitorEvents>>,
): string {
	if (events.length === 0) return '';
	const lines = [
		'Queued PR monitor events are now authorized for this PR_FEEDBACK workflow and must be treated as feedback inputs for the current round:',
		...events.map(
			(event) =>
				`- ${event.type} on ${event.repoFullName}#${event.prNumber}: ${event.message.split('\n')[0]}`,
		),
		'Do not expand or replace an already-declared immutable feedback inventory; if these events require a later round, finish or abort the current round first.',
	];
	return lines.join('\n');
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
		suspendedReason?: 'consecutive' | 'total';
		userInterrupted?: boolean;
		maxConsecutive?: number;
		recovery?: { code: string; requiredAction: string };
	} = {},
): string {
	const lines: string[] = [
		`[${mode} WORKFLOW ACTIVE]`,
		`The ${mode} workflow gate is still active. Continue with the required structured lanes, evidence, and controller tools until \`complete_pr_workflow\` succeeds.`,
		`If the bind/checkout path is unreachable — for example a compound \`git fetch && git checkout\` was rejected as read-only shell syntax, the PR head cannot be fetched, or the working tree is on the wrong branch — call \`abort_pr_workflow\` (mode: "${mode}", kind: "recovery", reason: "<one-line cause>") to clear the gate, or ask the user to run \`/swarm abort-pr-workflow\` (a force abort that may clear a bound gate).`,
	];
	if (options.suspended) {
		if (options.suspendedReason === 'total') {
			lines.push(
				'Auto-resume is suspended because the total wake budget for this workflow has been exhausted. The session will not be re-awoken automatically. Run `/swarm abort-pr-workflow`, call `abort_pr_workflow`, or complete the workflow with `complete_pr_workflow` to publish normally.',
			);
		} else {
			const max = options.maxConsecutive;
			lines.push(
				`Auto-resume is suspended after ${max ?? 'the configured number of'} consecutive unproductive retries (the durable gate \`revision\` did not advance). The session will not be re-awoken automatically. Run \`/swarm abort-pr-workflow\` or call \`abort_pr_workflow\` to clear the gate, or complete the workflow with \`complete_pr_workflow\` to publish normally.`,
			);
		}
	}
	if (options.userInterrupted) {
		lines.push(
			'Auto-resume is paused after a user interruption. The durable workflow gate is preserved, but the plugin will not re-awaken this session. Send a new message to continue, or run `/swarm abort-pr-workflow` to clear the workflow.',
		);
	}
	if (options.recovery) {
		lines.push(
			`Auto-resume is disabled because manual Git recovery is required. code=${options.recovery.code} retryable=false required_action=${options.recovery.requiredAction}`,
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
		suspendedReason?: 'consecutive' | 'total';
		userInterrupted?: boolean;
		maxConsecutive?: number;
		recovery?: { code: string; requiredAction: string };
	} = {},
): string {
	const lines: string[] = [
		`--- [${mode} WORKFLOW ACTIVE — output below is not a terminal verdict; \`complete_pr_workflow\` clears the gate on success; if the bind/checkout path is unreachable call \`abort_pr_workflow\` or run \`/swarm abort-pr-workflow\`] ---`,
	];
	if (options.suspended) {
		if (options.suspendedReason === 'total') {
			lines.push(
				'[Auto-resume is suspended because the total wake budget for this workflow has been exhausted. Run `/swarm abort-pr-workflow`, call `abort_pr_workflow`, or complete the workflow with `complete_pr_workflow`.]',
			);
		} else {
			const max = options.maxConsecutive;
			lines.push(
				`[Auto-resume is suspended after ${max ?? 'the configured number of'} consecutive unproductive retries. Run \`/swarm abort-pr-workflow\` or call \`abort_pr_workflow\` to clear the gate, or complete the workflow with \`complete_pr_workflow\`.]`,
			);
		}
	}
	if (options.userInterrupted) {
		lines.push(
			'[Auto-resume paused after a user interruption. Send a new message to continue, or run `/swarm abort-pr-workflow` to clear the workflow.]',
		);
	}
	if (options.recovery) {
		lines.push(
			`[Manual Git recovery required; auto-resume disabled. code=${options.recovery.code} retryable=false required_action=${options.recovery.requiredAction}]`,
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
	/** Override the per-tier default total-wake ceilings. A single number
	 * applies uniformly to all tiers; a partial Record allows per-tier
	 * overrides with unspecified tiers falling back to the defaults.
	 * When omitted, the context-aware defaults (DEFAULT_TOTAL_WAKE_CEILINGS)
	 * apply. */
	totalWakeCeiling?: number | Partial<Record<PrReviewDepthTier, number>>;
}) {
	const wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
	const maxConsecutive =
		options.maxConsecutiveUnproductiveWakes ??
		DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_WAKES;
	const wakeCooldownMs = options.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;
	const bannerCooldownMs =
		options.bannerCooldownMs ?? DEFAULT_BANNER_COOLDOWN_MS;
	/**
	 * Resolve the total-wake ceiling for a tier, validating the caller-supplied
	 * override (see {@link isValidTotalWakeCeiling}). The check is applied to
	 * BOTH shapes of the option — the uniform scalar and each looked-up per-tier
	 * record value — so one bad tier entry degrades to that tier's default
	 * instead of disabling the brake for it. An absent value (option omitted, or
	 * a partial record without this tier) takes the same default path.
	 */
	const resolveTotalWakeCeiling = (tier: PrReviewDepthTier): number => {
		const configured =
			typeof options.totalWakeCeiling === 'number'
				? options.totalWakeCeiling
				: options.totalWakeCeiling?.[tier];
		return isValidTotalWakeCeiling(configured)
			? configured
			: DEFAULT_TOTAL_WAKE_CEILINGS[tier];
	};
	/**
	 * Per-session wake budgets (consecutive counter, suspension flag, and
	 * total-wake counter). This is an IN-MEMORY map scoped to ONE PROCESS
	 * LIFETIME — it resets on plugin reload / process restart. The total-wake
	 * bound holds within a single process invocation; a plugin reload starts
	 * fresh totals.
	 */
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

	/**
	 * Enforce the {@link MAX_TRACKED_WAKE_SESSIONS} bound on `wakeBudgets`
	 * (invariant 8) by evicting the LEAST RECENTLY WOKEN entry — LRU by
	 * `lastWakeAt`, not insertion order. Selection rules, in priority order:
	 *
	 *  1. Never evict a SUSPENDED budget. A suspended entry records a session
	 *     whose consecutive or total cap already fired; recreating it on the
	 *     next idle would reset `totalWakes` to 0 and re-arm auto-resume,
	 *     defeating the cap this module exists to enforce.
	 *  2. Never evict the CURRENT session (`currentSessionID`) or any session
	 *     whose idle handler is mid-flight (`activeWakeSessions`). Those
	 *     handlers hold a live reference to their budget object: deleting the
	 *     map entry detaches it, so their later `totalWakes += 1` / `suspended =
	 *     true` writes land on an object nothing can read, and the next idle
	 *     rebuilds a zeroed budget. A rebuilt budget has `lastSeenRevision ===
	 *     undefined`, which makes `madeProgress` unconditionally true — so the
	 *     consecutive brake, the cooldown, and the total ceiling all become
	 *     unreachable for that session.
	 *  3. Among the survivors, evict the SMALLEST `lastWakeAt`.
	 *  4. `lastWakeAt === 0` means "created, never woken", which is the NEWEST
	 *     possible state, not the oldest — a naive minimum would invert the
	 *     intent and evict the freshest entry first. Never-woken entries are
	 *     therefore held back as a LAST RESORT, used only when no already-woken
	 *     candidate exists at all (in insertion order, preserving the previous
	 *     FIFO tie-break).
	 *     This branch is defence-in-depth, not the common path: the ordinary
	 *     create-then-wake window is already covered by rule 2, because
	 *     `activeWakeSessions` holds the session for exactly as long as its
	 *     entry sits at `lastWakeAt === 0`, and `lastWakeAt` is assigned
	 *     unconditionally once the handler reaches its bookkeeping. What
	 *     remains is the narrow case of a handler that threw between creating
	 *     the budget and that assignment, which strands a never-woken entry
	 *     permanently. Do not "simplify" this away by assuming rule 2 covers
	 *     every zero — it covers every zero that is still in flight.
	 *
	 * The bound is best-effort by construction: when suspended entries plus the
	 * in-flight/current sessions exhaust the candidate set, the map is allowed
	 * to EXCEED MAX_TRACKED_WAKE_SESSIONS rather than drop state that is unsafe
	 * to lose. `if (evicted === undefined) break` is the termination guard for
	 * that case — it also makes an all-suspended map impossible to spin on.
	 */
	function evictIfOverBound(currentSessionID: string): void {
		while (wakeBudgets.size > MAX_TRACKED_WAKE_SESSIONS) {
			let lruKey: string | undefined;
			let lruWakeAt = Number.POSITIVE_INFINITY;
			let neverWokenKey: string | undefined;
			for (const [key, budget] of wakeBudgets) {
				if (
					budget.suspended ||
					key === currentSessionID ||
					activeWakeSessions.has(key)
				) {
					continue;
				}
				if (budget.lastWakeAt <= 0) {
					if (neverWokenKey === undefined) neverWokenKey = key;
					continue;
				}
				if (budget.lastWakeAt < lruWakeAt) {
					lruWakeAt = budget.lastWakeAt;
					lruKey = key;
				}
			}
			const evicted = lruKey ?? neverWokenKey;
			if (evicted === undefined) break;
			wakeBudgets.delete(evicted);
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

	/**
	 * Append a machine-readable suspension record to `.swarm/events.jsonl`.
	 * Auto-resume suspension is otherwise observable only as prose inside a
	 * chat banner, which no operator tooling can aggregate; this is the audit
	 * surface for "why did this review stop resuming".
	 *
	 * Shape and failure policy mirror the abort-path append in
	 * `pr-workflow-gate.ts` (`pr_workflow_aborted`): a `type`-tagged JSON line,
	 * a path resolved through {@link validateSwarmPath}, and a non-fatal
	 * try/catch. `validateSwarmPath` itself throws synchronously (null bytes,
	 * traversal, symlinked `.swarm`), so it stays INSIDE the try. A missing
	 * `.swarm` directory yields ENOENT and is likewise swallowed — the audit
	 * trail is best-effort and must never break the gate or the wake
	 * bookkeeping that surrounds this call.
	 *
	 * Awaited, never fire-and-forget: this runs inside the async `event`
	 * handler, and a `queueMicrotask`-style detachment would let the process
	 * tear down with the record unwritten (a recorded durability lesson in this
	 * repo).
	 */
	async function appendWakeSuspendedEvent(fields: {
		sessionID: string;
		mode: string;
		suspendedReason: 'consecutive' | 'total';
		consecutiveUnproductive: number;
		totalWakes: number;
		tier: PrReviewDepthTier;
	}): Promise<void> {
		try {
			const eventsPath = validateSwarmPath(options.directory, 'events.jsonl');
			const suspendedEvent = {
				type: 'pr_workflow_wake_suspended',
				timestamp: new Date().toISOString(),
				sessionID: fields.sessionID,
				mode: fields.mode,
				suspendedReason: fields.suspendedReason,
				consecutiveUnproductive: fields.consecutiveUnproductive,
				totalWakes: fields.totalWakes,
				tier: fields.tier,
				maxConsecutiveUnproductiveWakes: maxConsecutive,
				totalWakeCeiling: resolveTotalWakeCeiling(fields.tier),
			};
			await fsp.appendFile(
				eventsPath,
				`${JSON.stringify(suspendedEvent)}\n`,
				'utf-8',
			);
		} catch {
			// Non-fatal: the audit trail is best-effort. A failed write must
			// never break the gate or abort the suspension bookkeeping.
		}
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
		const suspendedReason = budget?.suspendedReason;
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
		const recovery = state.checkoutRecovery
			? {
					code: state.checkoutRecovery.code,
					requiredAction: state.checkoutRecovery.requiredAction,
				}
			: undefined;
		const forceFullBanner = suspended || userInterrupted || Boolean(recovery);
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
			suspendedReason,
			userInterrupted,
			maxConsecutive: maxConsecutive,
			recovery,
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
			if (state.checkoutRecovery) {
				// Manual Git recovery is a terminal startup condition, not a model
				// retry condition. Keep the durable banner but never re-wake the model.
				return;
			}
			// The idle decision above can race a later abort because OpenCode does
			// not await event hooks in dispatch order. Recheck after durable I/O so
			// an abort published while this read was pending still prevents the wake.
			if (isPrWorkflowAutoWakeSuppressed(options.directory, sessionID)) return;
			if (!session) return;

			// Pass the live session id so eviction can never drop the budget this
			// handler is about to create or mutate (see evictIfOverBound rule 2).
			evictIfOverBound(sessionID);
			let budget = wakeBudgets.get(sessionID);
			if (!budget) {
				budget = {
					consecutiveUnproductive: 0,
					lastWakeAt: 0,
					suspended: false,
					totalWakes: 0,
					suspendedReason: 'consecutive',
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
			const feedbackTarget =
				state.prFeedbackTargetUrl ?? state.prFeedbackReviewHandoff?.prUrl;
			const queuedMonitorRecord =
				state.mode === 'PR_FEEDBACK' &&
				!state.prFeedbackInventory &&
				feedbackTarget
					? await _internals
							.readPrFeedbackMonitorQueue(options.directory, sessionID)
							.catch(() => null)
					: null;
			const queuedMonitorEvents =
				queuedMonitorRecord?.events.filter(
					(event) =>
						!event.claimedWorkflowInstanceId &&
						Boolean(feedbackTarget) &&
						sameGitHubPr(event.prUrl, feedbackTarget ?? ''),
				) ?? [];
			const queuedMonitorText =
				queuedMonitorEvents.length > 0
					? `\n${formatQueuedMonitorEventsText(queuedMonitorEvents)}`
					: '';
			let promptRejected = false;
			let promptAccepted = false;
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
									suspendedReason: undefined,
									maxConsecutive: maxConsecutive,
								})}\nDo not stop or summarize. Inspect the durable gate, dispatch or collect the next missing required lane, and continue until complete_pr_workflow succeeds. If the bind/checkout path is genuinely unreachable, call abort_pr_workflow instead of looping.${queuedMonitorText}`,
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
				promptAccepted = true;
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
				let postWakeState: Awaited<
					ReturnType<typeof _internals.readPrWorkflowGateState>
				>;
				try {
					postWakeState = await _internals.readPrWorkflowGateState(
						options.directory,
						sessionID,
					);
				} catch {
					// Two distinct causes reach this catch, and neither is a
					// gate-clear. (a) A transient fs error (EBUSY/EMFILE, or a
					// concurrent writer). (b) A DURABLE validation failure:
					// readPrWorkflowGateStateFromDisk deliberately throws
					// `BLOCKED: ... is not valid JSON` / `... is invalid` for a
					// corrupt or schema-invalid state file
					// (pr-workflow-gate.ts:6357-6368), and
					// `_internals.readPrWorkflowGateState` propagates it
					// unmodified — so a throw here is NOT necessarily transient
					// and may recur on every subsequent wake.
					//
					// Falling back to the pre-wake snapshot is nonetheless the
					// correct handling for BOTH causes. This catch is nested
					// inside the `finally` that owns all wake bookkeeping
					// (lastWakeAt, the consecutive counter, totalWakes, and the
					// suspension checks below); rethrowing would skip every one
					// of them and recreate the unbounded-wake hazard this module
					// exists to prevent — worst under cause (b), where the error
					// recurs and the loop would never be braked at all.
					// Continuing with the last-known-good revision instead makes
					// the wake count as unproductive (a revision that cannot be
					// re-read cannot advance), so a corrupt gate file suspends
					// the session through the normal budget path. Reserving null
					// exclusively for a confirmed gate-clear also prevents
					// resetBudget from wiping the just-incremented totalWakes.
					postWakeState = state;
				}
				if (
					promptAccepted &&
					queuedMonitorEvents.length > 0 &&
					feedbackTarget &&
					state.workflowInstanceId &&
					postWakeState?.mode === 'PR_FEEDBACK' &&
					postWakeState.workflowInstanceId === state.workflowInstanceId &&
					!postWakeState.prFeedbackInventory &&
					sameGitHubPr(
						postWakeState.prFeedbackTargetUrl ??
							postWakeState.prFeedbackReviewHandoff?.prUrl ??
							'',
						feedbackTarget,
					)
				) {
					await _internals
						.claimPrFeedbackMonitorEvents(
							options.directory,
							sessionID,
							state.workflowInstanceId,
							feedbackTarget,
							queuedMonitorEvents.map((event) => event.dedupToken),
						)
						.catch(() => []);
				}
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
					// Set by EITHER suspension branch below; the single audit
					// append after both branches then reports the FINAL state.
					// Emitting inside each branch instead would write two
					// contradicting records for a wake that trips both budgets
					// (reachable whenever maxConsecutive === totalCeiling), and
					// the second one would disagree with the `suspendedReason`
					// the user-facing banner renders.
					let suspensionTripped = false;
					if (!effectiveMadeProgress) {
						budget.consecutiveUnproductive += 1;
						if (budget.consecutiveUnproductive >= maxConsecutive) {
							budget.suspended = true;
							budget.suspendedReason = 'consecutive';
							suspensionTripped = true;
						}
					} else {
						budget.consecutiveUnproductive = 0;
					}

					// TOTAL-wake budget: increment on EVERY attempted wake
					// (success, failure, timeout) and NEVER reset by progress.
					// Read the depth tier from durable gate state; default to 'L'
					// when absent (e.g. PR_FEEDBACK mode has no diff-stats tier).
					//
					// KNOWN, INTENTIONALLY UNFIXED: the tier is read per-wake
					// while `totalWakes` is tier-agnostic, so the ceiling a
					// budget is measured against can CHANGE mid-budget. Two
					// directions, and they are not symmetric:
					//
					//  - TIGHTENING (the common case): wakes accrued before the
					//    depth tier is bound default to 'L' (102) and are later
					//    compared against the bound tier. If that turns out to
					//    be S (12) or M (54), the pre-bind wakes count against
					//    the smaller ceiling and the brake fires EARLIER. Bind
					//    happens early and the consecutive brake (5) caps any
					//    unproductive run, so this is a 0-3 wake skew.
					//  - LOOSENING (real, do not claim otherwise):
					//    `transitionPrReviewToFeedback` mints a new
					//    `workflowInstanceId` WITHOUT clearing the durable gate,
					//    so `resetBudget` never runs and this budget survives
					//    into PR_FEEDBACK — where the replacement state carries
					//    no `prReviewDepthTier` and the `?? 'L'` below therefore
					//    raises the ceiling to 102. A tier-S review that hands
					//    off to feedback keeps its accumulated count but gains
					//    headroom.
					//
					// Left as-is deliberately: the loosening is bounded by the
					// same 102 that a tier-L review gets, the consecutive brake
					// stays active throughout, and both candidate "fixes"
					// (per-tier counters, or rebasing the count when the tier
					// binds) would loosen the FIRST case further while adding
					// state. Do not "correct" this without re-deriving that
					// tradeoff — and do not restore the earlier claim that the
					// skew can only ever tighten, which is false.
					budget.totalWakes += 1;
					const tier: PrReviewDepthTier =
						postWakeState.prReviewDepthTier ?? 'L';
					const totalCeiling = resolveTotalWakeCeiling(tier);
					if (budget.totalWakes >= totalCeiling) {
						budget.suspended = true;
						budget.suspendedReason = 'total';
						suspensionTripped = true;
					}
					if (suspensionTripped) {
						// Machine-readable audit record for the suspension. Both
						// branches above route here, so exactly one line is
						// written per suspension transition and its
						// `suspendedReason` is by construction the value the
						// banner will render. Awaited (never fire-and-forget) and
						// internally non-fatal.
						await appendWakeSuspendedEvent({
							sessionID,
							mode: postWakeState.mode,
							suspendedReason: budget.suspendedReason,
							consecutiveUnproductive: budget.consecutiveUnproductive,
							totalWakes: budget.totalWakes,
							tier,
						});
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
