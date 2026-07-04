/**
 * Pure q-learning-style utility math for memory reward propagation.
 *
 * No I/O, no provider imports — safe to import from any layer (hooks, scoring,
 * tools) without pulling in sqlite/jsonl or council-verdict types. Callers
 * (A.4 reward capture, A.5 scoring) own the wiring; this module only owns
 * the math.
 *
 * `getQValue`/`setQValue` operate on any `MemoryRecord`-shaped object (a
 * structural `{ metadata?: Record<string, unknown> }`), so no runtime or
 * type import of `MemoryRecord` is required here.
 */

/** Clamp a number to the closed [0, 1] interval. */
function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * EMA update: q ← (1-η)·q + η·reward.
 *
 * A convex combination of two [0,1] inputs stays in [0,1]; the clamp guards
 * against float drift and out-of-range callers (e.g. reward slightly outside
 * [0,1]) rather than relying on that invariant alone.
 *
 * Non-finite guards (a malformed reward, learning rate, or prior must not
 * corrupt the stored q-value): a non-finite `reward` or `eta` falls back to
 * the clamped `qOld`; a non-finite `qOld` (for which `clamp01` would itself
 * yield NaN) falls back to `0`. This branch is unreachable under the intended
 * `getQValue`-first contract (which always yields a finite value in [0,1]).
 */
export function applyEmaUpdate(
	qOld: number,
	reward: number,
	eta: number,
): number {
	if (!Number.isFinite(qOld)) return 0;
	if (!Number.isFinite(reward) || !Number.isFinite(eta)) {
		return clamp01(qOld);
	}
	const next = (1 - eta) * qOld + eta * reward;
	return clamp01(next);
}

/**
 * B.5 — Propagation EMA step (soft Q-propagation). Applies a fractionally
 * REDUCED reward step to a RELATED memory, reusing the SAME EMA mechanism as a
 * direct reward but scaling the effective learning rate by `fraction`:
 *
 *   applyPropagatedEmaUpdate(q, r, η, f) = applyEmaUpdate(q, r, η·f)
 *                                        = q + η·f·(r − q)
 *
 * so a related memory shifts by EXACTLY `fraction` times the shift a direct
 * reward would produce from the same `qOld` (whose shift is η·(r − q)). This is
 * the precise, testable meaning of "the related memory shifts by the fraction"
 * (SC-005). It is algebraically identical to the alternative framing — pulling
 * the reward `fraction` of the way from `qOld` toward `r` and then applying η —
 * because η·(qOld + f·(r − qOld) − qOld) = η·f·(r − qOld).
 *
 * `fraction` is clamped to (0, 1]: a non-finite or ≤0 fraction yields NO shift
 * (returns the clamped `qOld`) — propagation degrades to a no-op rather than
 * corrupting the stored value; a fraction >1 is capped at 1 so a propagated
 * step can never exceed the direct step it derives from (blast-radius guard).
 */
export function applyPropagatedEmaUpdate(
	qOld: number,
	reward: number,
	eta: number,
	fraction: number,
): number {
	if (!Number.isFinite(fraction) || fraction <= 0) {
		// η·0 = 0 → applyEmaUpdate returns clamp01(qOld): no shift.
		return applyEmaUpdate(qOld, reward, 0);
	}
	const cappedFraction = fraction > 1 ? 1 : fraction;
	return applyEmaUpdate(qOld, reward, eta * cappedFraction);
}

/**
 * Read a memory record's stored q-value from `metadata.qValue`, falling back
 * to `fallback` when absent, non-numeric, non-finite, or out of [0,1].
 */
export function getQValue(
	record: { metadata?: Record<string, unknown> },
	fallback = 0.5,
): number {
	const raw = record.metadata?.qValue;
	if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
		return raw;
	}
	return fallback;
}

/**
 * Return a NEW record-shaped object with `metadata.qValue` set to the
 * clamped value, preserving all other metadata (immutable — does not
 * mutate `record`).
 */
export function setQValue<T extends { metadata?: Record<string, unknown> }>(
	record: T,
	value: number,
): T {
	return {
		...record,
		metadata: {
			...record.metadata,
			qValue: clamp01(Number.isFinite(value) ? value : 0),
		},
	};
}
