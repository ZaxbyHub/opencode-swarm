/**
 * Promotion-evidence store (issue #1849 §B2).
 *
 * Append-only, FIFO-bounded, rebuildable projection of
 * {@link PromotionEvidenceRecord}s produced when an authoritative V2 terminal
 * receipt (applied/violated/contradicted) is filed. V2 receipt history remains
 * the authority if this projection write fails. This is the wiring that feeds #1847's
 * {@link evaluatePromotionPolicy} consumer (previously inert "until #1849
 * produces real receipts").
 *
 * Per-worktree by design: promotion evidence records THIS worktree's observed
 * applications. It is intentionally NOT a member of `KNOWLEDGE_FAMILY` (the
 * linked-cohort shared-artifact manifest), matching the precedent set by
 * `src/turbo/epic/promotion-evidence.ts`. It lives under the project-root
 * `.swarm/` (via {@link validateSwarmPath}), NOT the link-aware shared store
 * dir, so it stays per-worktree.
 */

import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../utils/logger.js';
import {
	queryHistoricalOutcomes,
	type ReceiptMembership,
	type ReceiptTerminal,
} from './knowledge-receipt-ledger.js';
import type { PromotionEvidenceRecord } from './knowledge-types.js';
import { validateSwarmPath } from './utils.js';

/**
 * Soft cap on the promotion-evidence log. FIFO-trimmed after each append.
 * Sized generously — one record per validated applied/violated/contradicted
 * receipt item.
 */
const MAX_PROMOTION_EVIDENCE_ENTRIES = 2000;

function terminalHistory(membership: ReceiptMembership): ReceiptTerminal[] {
	const compatible = membership as ReceiptMembership & {
		terminal_history?: ReceiptTerminal[];
		historical_terminals?: ReceiptTerminal[];
	};
	const candidates = [
		...(compatible.terminal_history ?? []),
		...(compatible.historical_terminals ?? []),
		...(membership.terminal ? [membership.terminal] : []),
	];
	const seen = new Set<string>();
	return candidates.filter((terminal) => {
		if (seen.has(terminal.event_id)) return false;
		seen.add(terminal.event_id);
		return true;
	});
}

/** Resolve the promotion-evidence log path under the project-root `.swarm/`. */
export function resolvePromotionEvidencePath(directory: string): string {
	return validateSwarmPath(directory, 'knowledge-promotion-evidence.jsonl');
}

/**
 * Append validated promotion-evidence records. Fail-open + bounded: a write
 * error logs and continues (the receipt event itself is the authoritative
 * record; promotion evidence is a derived consumer). FIFO-trims the log when it
 * exceeds {@link MAX_PROMOTION_EVIDENCE_ENTRIES}.
 */
export async function appendPromotionEvidence(
	directory: string,
	records: PromotionEvidenceRecord[],
): Promise<void> {
	if (records.length === 0) return;
	const filePath = resolvePromotionEvidencePath(directory);
	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		const block = records.map((r) => JSON.stringify(r)).join('\n');
		await appendFile(filePath, `${block}\n`, 'utf-8');
		await trimIfOversized(filePath).catch(() => {});
	} catch (err) {
		log('[promotion-evidence] append failed (fail-open)', {
			error: err instanceof Error ? err.message : String(err),
			count: records.length,
		});
	}
}

/** FIFO-trim the log when it exceeds the cap. Best-effort, never throws. */
async function trimIfOversized(filePath: string): Promise<void> {
	let content: string;
	try {
		content = await readFile(filePath, 'utf-8');
	} catch {
		return;
	}
	const lines = content.split('\n').filter((l) => l.trim().length > 0);
	if (lines.length <= MAX_PROMOTION_EVIDENCE_ENTRIES) return;
	const kept = lines.slice(lines.length - MAX_PROMOTION_EVIDENCE_ENTRIES);
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, `${kept.join('\n')}\n`, 'utf-8');
	await rename(tmp, filePath);
}

/**
 * Load authoritative receipt terminals as promotion evidence, grouped by
 * entry_id. The FIFO file above remains a derived projection and is never read.
 * Ledger uncertainty or missing truthful cohort lineage conservatively returns
 * no evidence. Never throws.
 */
export async function loadPromotionEvidenceByEntry(
	directory: string,
	canonicalCohortId?: string,
): Promise<Record<string, PromotionEvidenceRecord[]>> {
	try {
		const history = await _internals.queryHistoricalOutcomes(directory);
		if (!history.ok) return {};
		const out: Record<string, PromotionEvidenceRecord[]> = {};
		for (const membership of history.memberships) {
			// Promotion is cohort-scoped correctness state. Never assign historical
			// evidence to whichever cohort happens to be current at read time: the
			// cohort must have been truthfully captured with the displayed receipt.
			if (
				typeof membership.cohort_id !== 'string' ||
				membership.cohort_id.length === 0 ||
				(canonicalCohortId !== undefined &&
					membership.cohort_id !== canonicalCohortId)
			) {
				continue;
			}
			for (const terminal of terminalHistory(membership)) {
				if (
					terminal.outcome !== 'applied' &&
					terminal.outcome !== 'violated' &&
					terminal.outcome !== 'contradicted'
				) {
					continue;
				}
				const record: PromotionEvidenceRecord = {
					cohort_id: membership.cohort_id,
					source_link_id: membership.source_link_id,
					entry_id: membership.entry_id,
					retrieval_trace_id: membership.trace_id,
					receipt_outcome: terminal.outcome,
					receipt_event_id: terminal.event_id,
					phase: membership.phase,
					timestamp: terminal.committed_at,
				};
				const bucket = out[record.entry_id];
				if (bucket) bucket.push(record);
				else out[record.entry_id] = [record];
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Dependency seam for authoritative-reader failure and mapping tests. */
export const _internals = { queryHistoricalOutcomes };
