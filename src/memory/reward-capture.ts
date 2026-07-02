/**
 * A.4/B.2 — Council reward capture (positive terminal reward only).
 *
 * Closes the memory learning loop: when an APPROVE council verdict advances a
 * task to `complete`, every DISTINCT memory recalled and attributable to that
 * task earns a single EMA reward step toward the terminal reward (1.0 for
 * APPROVE).
 *
 * Design constraints (resolved decision C-6, Phase A; unitId narrowing B.2):
 *   - POSITIVE reward only. No negative/REJECT/CONCERNS/max-rounds trigger here;
 *     that is the finalize-time sweep (B.6).
 *   - unitId-narrowed with run_id fallback: bundles are listed by `runId`
 *     (session), then narrowed to the verdict's `opts.unitId` so sibling
 *     tasks' recalls in the same session are NOT rewarded for this verdict.
 *     A bundle is kept when it is untagged (`bundle.unitId == null`, the
 *     legacy/unattributable case), when the verdict itself has no `unitId`
 *     (cannot narrow — degrades to full session-scoped reward, today's
 *     behavior), or when `bundle.unitId === opts.unitId` (precise match). A
 *     bundle is excluded only when both ids are present and differ (a
 *     different task's tagged bundle). `unitId` is also recorded on each
 *     reward event for audit/attribution.
 *   - DISTINCT dedup: a memory recalled in several KEPT bundles this session
 *     gets exactly ONE EMA step.
 *
 * This module owns NO error isolation beyond the optional-method (`?.`) guards
 * on capabilities the provider may not implement. The calling HOOK owns
 * try/catch isolation so a reward-capture failure can never affect task
 * completion. (Exception: the B.5 soft-propagation pass below is wrapped in its
 * OWN best-effort try/catch so that a propagation failure can never discard the
 * direct reward that already succeeded — the direct EMA steps are persisted and
 * counted BEFORE propagation runs at all, so they are unaffected by any
 * propagation-time error. Propagation itself is NOT guaranteed all-or-nothing:
 * if a mid-loop `upsert` throws (e.g. after some propagated targets already
 * received their step), the targets updated before the throw keep their
 * propagated step and the remaining scheduled targets are simply never
 * reached — partial propagation is an accepted outcome, per FR-004's "better
 * to under-propagate than over-propagate".)
 *
 * B.5 — soft Q-propagation (FR-004 / SC-005). After each DIRECT reward, a
 * FRACTION of that reward is propagated ONE HOP to closely-related memories so
 * learning generalizes to similar memories, strictly bounded to avoid runaway
 * updates. Relatedness = same scope + same kind + high Jaccard token overlap;
 * only memories retrieved within `propagationWindowDays` (from recall-usage
 * timestamps) are eligible; at most `propagationFanoutCap` per source (top-by-
 * overlap, deterministic); each related memory gets at most ONE propagated
 * step regardless of how many sources reach it; directly-rewarded ids and the
 * source itself are excluded; propagated updates never re-enter propagation.
 * See the constant/helper docs below for the exact formula and thresholds.
 */

import { log as debugLog } from '../utils/logger';
import type { QLearningConfig } from './config';
import { DEFAULT_QLEARNING_CONFIG } from './config';
import type { MemoryProvider } from './provider';
import {
	applyEmaUpdate,
	applyPropagatedEmaUpdate,
	getQValue,
	setQValue,
} from './q-learning';
import { stableScopeKey } from './schema';
import { jaccard, tokenize } from './scoring';
import type { MemoryRecord } from './types';

/**
 * Reward-event verdict marker suffix for a PROPAGATED (indirect) reward,
 * distinct from the direct verdict label. Encoded in the free-form `verdict`
 * string (schema-free — avoids a provider column/migration) so value-log/audit
 * can tell direct from propagated events and so a consumer filtering
 * `verdict === 'APPROVE'` counts only direct approvals. Both providers persist
 * `verdict` as an opaque string. The full propagated label is
 * `` `${directLabel}${PROPAGATED_VERDICT_SUFFIX}` `` — see `verdictLabel` below.
 */
const PROPAGATED_VERDICT_SUFFIX = '_PROPAGATED';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CouncilRewardOptions {
	/** Session id — bundles are listed by this `runId`. */
	runId: string;
	/**
	 * taskId — narrows bundle attribution (see module header for the exact
	 * predicate) and is recorded on reward events for audit/attribution.
	 */
	unitId?: string;
	/** Terminal reward on the [0,1] utility scale (1.0 for APPROVE). */
	reward: number;
	/** EMA learning rate η (config.memory.qLearning.learningRate). */
	eta: number;
	/** Neutral fallback q-value for records without a stored qValue. */
	initialQValue: number;
	/**
	 * Full q-learning config. B.5 reads the propagation parameters
	 * (`propagationFraction`, `propagationFanoutCap`, `propagationWindowDays`)
	 * from here. Optional for back-compat with A.4 call sites; defaults to
	 * `DEFAULT_QLEARNING_CONFIG` when omitted. `eta`/`initialQValue` above are
	 * kept as explicit fields (the direct-reward contract predates this) and are
	 * NOT overridden by this config.
	 */
	qLearning?: QLearningConfig;
	/** Already-truncated council-synthesis payload (FR-010). */
	verdictSynthesisJson?: string;
	/** ISO 8601 timestamp, caller-supplied. */
	timestamp: string;
	/**
	 * True label persisted on the DIRECT reward event's `verdict` field (and,
	 * with the `_PROPAGATED` suffix, on any B.5 propagated event it produces).
	 * Defaults to `'APPROVE'` when omitted — byte-identical to this module's
	 * pre-existing behavior, so A.4 (delegation-gate.ts, which never passes this)
	 * is unaffected. Callers with a graded or negative-terminal reward (B.3's
	 * phase verdict, B.6's finalize sweep) should pass the reason so the
	 * value-log audit is not mislabeled `'APPROVE'` for a REJECT/CONCERNS/
	 * session-terminated reward.
	 */
	verdictLabel?: string;
}

export interface CouncilRewardResult {
	/** Count of distinct memories that received an EMA step. */
	memoriesRewarded: number;
}

/**
 * Apply the positive council reward to every distinct memory recalled during
 * the session identified by `opts.runId` that is attributable to
 * `opts.unitId` (with the run_id fallback described in the module header for
 * untagged bundles and unitId-less verdicts).
 *
 * Uses the provider's DIRECT `upsert` (a SYSTEM-level utility update that
 * bypasses the propose/curator flow, like maintenance/compaction). `setQValue`
 * changes only `metadata.qValue`, leaving scope/kind/text (and therefore the
 * record id) unchanged, so `upsert` replaces the record in place.
 */
export async function applyCouncilReward(
	provider: MemoryProvider,
	opts: CouncilRewardOptions,
): Promise<CouncilRewardResult> {
	const bundles =
		(await provider.listRecallUsage?.({ runId: opts.runId })) ?? [];
	if (bundles.length === 0) {
		return { memoriesRewarded: 0 };
	}

	// B.2: narrow to bundles attributable to this verdict's unit, with a
	// run_id fallback so untagged bundles and unitId-less verdicts keep the
	// prior session-scoped signal. Exclude a bundle ONLY when both ids are
	// present and differ (a different task's tagged bundle).
	const attributedBundles = bundles.filter(
		(bundle) =>
			bundle.unitId == null ||
			opts.unitId == null ||
			bundle.unitId === opts.unitId,
	);

	// Collect DISTINCT memory ids across all attributed bundles this session.
	// A memory recalled in several bundles earns exactly ONE EMA step.
	const distinctIds = new Set<string>();
	for (const bundle of attributedBundles) {
		for (const id of bundle.memoryIds) {
			distinctIds.add(id);
		}
	}

	let memoriesRewarded = 0;
	// Source records that actually received a DIRECT reward — reused as the
	// propagation origins (their scope/kind/text drive candidate discovery).
	const rewardedRecords: MemoryRecord[] = [];
	for (const id of distinctIds) {
		const rec = await provider.get(id);
		if (!rec) continue;
		const qBefore = getQValue(rec, opts.initialQValue);
		const qAfter = applyEmaUpdate(qBefore, opts.reward, opts.eta);
		await provider.upsert(setQValue(rec, qAfter));
		await provider.appendRewardEvent?.({
			memoryId: id,
			runId: opts.runId,
			unitId: opts.unitId,
			verdict: opts.verdictLabel ?? 'APPROVE',
			reward: opts.reward,
			qBefore,
			qAfter,
			verdictSynthesisJson: opts.verdictSynthesisJson,
			timestamp: opts.timestamp,
		});
		rewardedRecords.push(rec);
		memoriesRewarded++;
	}

	// B.5 — soft Q-propagation. Runs AFTER the direct rewards above are
	// persisted and counted, and is wrapped in its own best-effort guard so a
	// propagation failure can never discard the direct result or the caller's
	// dedup bookkeeping. `distinctIds` is the self/no-double-update exclusion
	// set (every id that was part of this direct batch, resolved or not).
	try {
		await propagateReward(provider, opts, rewardedRecords, distinctIds);
	} catch (err) {
		debugLog(
			`[memory:propagation] skipped after error: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	return { memoriesRewarded };
}

/**
 * B.5 — propagate a FRACTION of the direct reward, one hop, to closely-related
 * memories. Strictly bounded (see the module header); degrades to a no-op
 * (returns without updating anything) whenever a bound cannot be safely
 * evaluated. Never recurses: propagated updates append propagation-tagged
 * reward events but are not themselves treated as sources.
 */
async function propagateReward(
	provider: MemoryProvider,
	opts: CouncilRewardOptions,
	sources: MemoryRecord[],
	directlyRewardedIds: ReadonlySet<string>,
): Promise<void> {
	if (sources.length === 0) return;

	const qConfig = opts.qLearning ?? DEFAULT_QLEARNING_CONFIG;
	const fraction = qConfig.propagationFraction;
	const fanoutCap = qConfig.propagationFanoutCap;
	const windowDays = qConfig.propagationWindowDays;
	const relatednessThreshold = qConfig.propagationRelatednessThreshold;

	// Bound guards — any invalid/disabling value degrades to no propagation.
	if (!Number.isFinite(fraction) || fraction <= 0) return;
	if (!Number.isFinite(fanoutCap) || fanoutCap <= 0) return;
	if (!Number.isFinite(windowDays) || windowDays <= 0) return;
	if (!Number.isFinite(relatednessThreshold)) return;
	if (typeof provider.list !== 'function') return;

	// Recency reference "now" is the caller-supplied reward timestamp
	// (deterministic; no wall-clock read). If it cannot be parsed we cannot
	// bound the window, so we conservatively skip.
	const nowMs = Date.parse(opts.timestamp);
	if (!Number.isFinite(nowMs)) return;
	const windowMs = windowDays * MS_PER_DAY;

	// Retrieval-recency signal: most-recent recall-usage timestamp per memory
	// id, across ALL sessions. `lastAccessedAt` on the record is defined-but-
	// never-written in this codebase (untrustworthy); recall usage is the real
	// signal. A candidate absent from this map was never retrieved → excluded.
	const recencyById = await buildRetrievalRecency(provider);
	if (!recencyById) return; // provider lacks listRecallUsage → skip

	// Deterministic source order so cap/drop decisions are stable in tests.
	const orderedSources = [...sources].sort((a, b) => a.id.localeCompare(b.id));

	// Each related memory receives at most ONE propagated step regardless of
	// how many sources reach it (dedup across sources by id).
	const scheduled = new Map<string, MemoryRecord>();
	// Cache list() results per scope+kind so many same-scope sources don't
	// re-query, and so candidate sets are identical across sources.
	const listCache = new Map<string, MemoryRecord[]>();

	for (const source of orderedSources) {
		const scopeKey = stableScopeKey(source.scope);
		const cacheKey = `${scopeKey}::${source.kind}`;
		let candidates = listCache.get(cacheKey);
		if (!candidates) {
			candidates = await provider.list({
				scopes: [source.scope],
				kinds: [source.kind],
			});
			listCache.set(cacheKey, candidates);
		}

		const sourceTokens = tokenize(source.text);
		const qualified: { record: MemoryRecord; overlap: number }[] = [];
		for (const cand of candidates) {
			if (cand.id === source.id) continue; // never propagate to self
			if (directlyRewardedIds.has(cand.id)) continue; // no double-update
			// scope is guaranteed same by the list filter; re-check defensively
			// so an over-broad provider list() can never break the scope bound.
			if (stableScopeKey(cand.scope) !== scopeKey) continue;
			if (cand.kind !== source.kind) continue;
			const retrievedAt = recencyById.get(cand.id);
			if (retrievedAt === undefined) continue; // never retrieved
			if (nowMs - retrievedAt > windowMs) continue; // outside window
			const overlap = jaccard(sourceTokens, tokenize(cand.text));
			if (overlap < relatednessThreshold) continue;
			qualified.push({ record: cand, overlap });
		}

		// Deterministic top-N by overlap desc, id asc tiebreak.
		qualified.sort(
			(a, b) => b.overlap - a.overlap || a.record.id.localeCompare(b.record.id),
		);
		const cap = Math.trunc(fanoutCap);
		const selected = qualified.slice(0, cap);
		const dropped = qualified.length - selected.length;
		if (dropped > 0) {
			// No silent truncation — surface cap-limited drops on the debug path.
			debugLog(
				`[memory:propagation] fan-out cap reached for source ${source.id}: ` +
					`${qualified.length} qualified, ${selected.length} propagated, ` +
					`${dropped} dropped by cap ${cap}`,
			);
		}
		for (const { record } of selected) {
			if (!scheduled.has(record.id)) scheduled.set(record.id, record);
		}
	}

	// Apply exactly one propagated EMA step per unique target.
	for (const record of scheduled.values()) {
		const qBefore = getQValue(record, opts.initialQValue);
		const qAfter = applyPropagatedEmaUpdate(
			qBefore,
			opts.reward,
			opts.eta,
			fraction,
		);
		await provider.upsert(setQValue(record, qAfter));
		await provider.appendRewardEvent?.({
			memoryId: record.id,
			runId: opts.runId,
			unitId: opts.unitId,
			verdict: `${opts.verdictLabel ?? 'APPROVE'}${PROPAGATED_VERDICT_SUFFIX}`,
			reward: opts.reward,
			qBefore,
			qAfter,
			verdictSynthesisJson: opts.verdictSynthesisJson,
			timestamp: opts.timestamp,
		});
	}
}

/**
 * Build `memoryId → most-recent recall-usage timestamp (ms)` across ALL
 * sessions. Returns null when the provider cannot report recall usage (then
 * B.5 skips propagation entirely, since it has no trustworthy recency signal).
 */
async function buildRetrievalRecency(
	provider: MemoryProvider,
): Promise<Map<string, number> | null> {
	if (typeof provider.listRecallUsage !== 'function') return null;
	// Unfiltered: recency is a cross-session signal — a related memory may have
	// been retrieved in an earlier session than the one being rewarded now.
	const usage = (await provider.listRecallUsage()) ?? [];
	const recency = new Map<string, number>();
	for (const event of usage) {
		const ts = Date.parse(event.timestamp);
		if (!Number.isFinite(ts)) continue;
		for (const id of event.memoryIds) {
			const prev = recency.get(id);
			if (prev === undefined || ts > prev) recency.set(id, ts);
		}
	}
	return recency;
}
