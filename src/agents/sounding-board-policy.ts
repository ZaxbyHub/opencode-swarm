/**
 * Sounding-board response policy (issue #2491) — extracted from src/index.ts
 * (r12, async lifecycle F3) so BOTH Task transports apply the EXACT same
 * policy:
 *
 *  - the synchronous Task handoff in src/index.ts, and
 *  - the native-async completion path in the background completion observer.
 *
 * The policy composes the response-contract parser and the always-surface
 * guard from src/agents/critic.ts. There is no second parsing semantics: both
 * callers feed the critic_sounding_board child's verified result text through
 * this one function.
 */

import {
	applyAlwaysSurfacePolicy,
	isSoundingBoardCategory,
	parseSoundingBoardResponse,
	type SoundingBoardCategory,
	type SoundingBoardResponse,
} from './critic.js';

/**
 * Resolve a category from the architect-owned sounding-board dispatch packet.
 * Only the explicit `category` field is caller metadata.  Prompt, description,
 * task, and context are model-controlled/free-text surfaces and must never be
 * scanned for a protocol category (issue #2491 F-004).
 */
export function resolveSoundingBoardCallerCategory(args: unknown): {
	supplied: boolean;
	value?: unknown;
} {
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return { supplied: false };
	}
	const record = args as Record<string, unknown>;
	if (Object.hasOwn(record, 'category')) {
		return { supplied: true, value: record.category };
	}
	return { supplied: false };
}

/**
 * The VALIDATED caller-owned category for persistence (r13 audit P1-3): the
 * explicit `category` field of the dispatch packet, normalized, and only when
 * it is a real protocol category. Missing, malformed, or free-text values
 * return null — the async transport then applies the conservative fallback
 * (identical to a sync dispatch that carried no category metadata).
 */
export function validSoundingBoardCallerCategory(
	args: unknown,
): SoundingBoardCategory | null {
	const caller = resolveSoundingBoardCallerCategory(args);
	if (!caller.supplied || !isSoundingBoardCategory(caller.value)) {
		return null;
	}
	return (caller.value as string).trim().toLowerCase() as SoundingBoardCategory;
}

/**
 * Apply the sounding-board response contract at a completion boundary.
 * Missing/malformed category metadata may never preserve UNNECESSARY: the
 * response is surfaced as APPROVED with an observable warning. A caller-owned
 * category is passed separately so a model cannot relabel a sticky decision.
 *
 * Returns null when no structured verdict can be parsed — callers must treat
 * that conservatively (the sync handoff surfaces a treat-as-REPHRASE warning;
 * the async closeout does the same), never as silent approval.
 */
export function applySoundingBoardResponsePolicy(
	rawResponse: string,
	args?: unknown,
): SoundingBoardResponse | null {
	const callerCategory = resolveSoundingBoardCallerCategory(args);
	const parsed = parseSoundingBoardResponse(
		rawResponse,
		callerCategory.supplied ? { category: callerCategory.value } : undefined,
	);
	if (!parsed) return null;
	const guarded = applyAlwaysSurfacePolicy(parsed);
	if (guarded.protocolError && guarded.verdict === 'UNNECESSARY') {
		return {
			...guarded,
			verdict: 'APPROVED',
			warning:
				guarded.warning ??
				'Invalid or missing Category metadata; verdict was surfaced as APPROVED.',
		};
	}
	return guarded;
}
