import type { AgentSessionState } from '../state';

/**
 * Shared advisory-queue push helper (issue #1976).
 *
 * Problem it fixes: `session.pendingAdvisoryMessages` is a bare `string[]`
 * that ~70 producer sites pushed onto directly via `.push()`, with no shared
 * gate. Re-firing triggers (per-tool-call, per-Task-call, per-poll, on retry)
 * stacked near-identical or byte-identical advisories that the drain rendered
 * verbatim with no dedupe or size bound — which produced the PR_REVIEW banner
 * flood (55.3% of non-blank lines in a real transcript).
 *
 * This helper gives every producer a gate by construction:
 *   1. empty/whitespace messages are skipped (drain hygiene),
 *   2. near-identical messages already queued are suppressed (dedupe),
 *   3. the queue is length-bounded (keep-latest) so volume is capped.
 *
 * IMPORTANT — dedupe scope. The advisory drain (`messagesTransform`) clears
 * `pendingAdvisoryMessages = []` on every turn, so this helper's dedupe only
 * suppresses duplicates that accumulate WITHIN a single turn (between pushes
 * and the next drain). CROSS-turn re-injection (the dominant failure mode for
 * per-tool/per-Task repeaters) is NOT handled here — those producers carry
 * their own session-scoped "already said" state keyed on a stable identity.
 * The drain-level byte budget (`messagesTransform`) bounds rendered output
 * across all producers, including any not yet migrated to this helper.
 */

/**
 * Maximum number of pending advisories retained in the queue at once
 * (defense-in-depth, in addition to the drain byte budget). Keep-latest: when
 * the cap is exceeded the OLDEST entry is dropped. The issue explicitly flags
 * "keep earliest" as a priority inversion because high-value advisories tend
 * to arrive LATE in a turn while low-value ones arrive early.
 */
export const MAX_PENDING_ADVISORIES = 25;

/**
 * Normalize a message for dedupe comparison. Collapses internal whitespace,
 * trims, and lowercases so trivial formatting differences (indentation, line
 * breaks, case) do not defeat dedup, while genuinely different content still
 * produces different fingerprints.
 *
 * The FULL normalized message is the default fingerprint. Producers whose
 * message embeds volatile fields (timestamps, step ranges, counts) that
 * should NOT defeat dedup pass an explicit `dedupeKey` instead — e.g. PRM
 * passes `prm:${pattern}:${escalationLevel}` so within-level repeats dedupe
 * while genuine escalation (level 1→2→3) survives. When a key is supplied it
 * is the AUTHORITATIVE dedupe identity: the helper records pushed keys and
 * matches on them, NOT on message text, so distinct content that shares a key
 * is still deduped and identical content with distinct keys is still enqueued.
 */
function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Options for {@link pushAdvisory}.
 */
export interface PushAdvisoryOptions {
	/**
	 * Stable semantic identity for dedupe. Use this when the rendered message
	 * embeds volatile fields (counts, step ranges, ids) that vary across
	 * logically-equivalent re-fires. When omitted, the full normalized message
	 * text is used as the fingerprint.
	 */
	dedupeKey?: string;
	/**
	 * Override the default queue length cap ({@link MAX_PENDING_ADVISORIES}).
	 */
	maxPending?: number;
}

/**
 * Push an advisory onto the session's pending queue with dedupe + length cap.
 *
 * @returns `true` if the message was enqueued, `false` if it was suppressed
 *   (empty, or a near-identical/duplicate message was already queued). Callers
 *   that maintain cross-turn "already said" state should record that state ONLY
 *   when this returns `true` — and must NEVER early-return out of other
 *   mandatory work (escalation counting, telemetry, replay) based on this
 *   result. Suppression applies to the ADVISORY INJECTION only.
 */
export function pushAdvisory(
	session: Pick<AgentSessionState, 'pendingAdvisoryMessages'>,
	message: string,
	opts?: PushAdvisoryOptions,
): boolean {
	// 1. Skip empty/whitespace-only messages (drain hygiene).
	const trimmed = message?.trim();
	if (!trimmed) return false;

	session.pendingAdvisoryMessages ??= [];

	// 2. Dedupe: skip if a matching advisory is already queued.
	//    - When a dedupeKey is supplied, it is the AUTHORITATIVE identity: the
	//      helper matches on key-presence in the queue only (the producer embeds
	//      the key in the message by convention, e.g. `[pr-monitor:...]`,
	//      `[council:...]`, `[prm:...]`). Identical text with distinct keys is
	//      still enqueued (escalation survives); distinct text sharing a key is
	//      still deduped (re-detections collapse).
	//    - When no dedupeKey is supplied, match on the full normalized message
	//      text so near-identical re-fires collapse.
	if (opts?.dedupeKey) {
		const key = opts.dedupeKey;
		if (session.pendingAdvisoryMessages.some((m) => m.includes(key))) {
			return false;
		}
	} else if (
		session.pendingAdvisoryMessages.some(
			(m) => normalizeMessage(m) === normalizeMessage(message),
		)
	) {
		return false;
	}

	// 3. Length cap: keep-latest (drop oldest from the front). High-value
	//    advisories tend to arrive late in a turn, so evicting the oldest
	//    preserves the most recent signal. Clamp to >= 1 so a caller passing
	//    maxPending: 0 (or negative) cannot cause an infinite loop (shift() on
	//    an empty array leaves length at 0, and `0 >= 0` never exits).
	const cap = Math.max(1, opts?.maxPending ?? MAX_PENDING_ADVISORIES);
	while (session.pendingAdvisoryMessages.length >= cap) {
		session.pendingAdvisoryMessages.shift();
	}

	session.pendingAdvisoryMessages.push(message);
	return true;
}
