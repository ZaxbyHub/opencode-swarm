/**
 * Promotion-evidence store (issue #1849 §B2).
 *
 * Append-only, FIFO-bounded JSONL store for {@link PromotionEvidenceRecord}s
 * produced when a validated terminal receipt (applied/violated/contradicted) is
 * filed. This is the wiring that finally feeds #1847's
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
import type { PromotionEvidenceRecord } from './knowledge-types.js';
import { validateSwarmPath } from './utils.js';

/**
 * Soft cap on the promotion-evidence log. FIFO-trimmed after each append.
 * Sized generously — one record per validated applied/violated/contradicted
 * receipt item.
 */
const MAX_PROMOTION_EVIDENCE_ENTRIES = 2000;

/** Resolve the promotion-evidence log path under the project-root `.swarm/`. */
export function resolvePromotionEvidencePath(directory: string): string {
	return validateSwarmPath(directory, 'knowledge-promotion-evidence.jsonl');
}

function parseRecord(line: string): PromotionEvidenceRecord | null {
	try {
		const o = JSON.parse(line) as Partial<PromotionEvidenceRecord>;
		if (
			typeof o.cohort_id === 'string' &&
			typeof o.entry_id === 'string' &&
			typeof o.retrieval_trace_id === 'string' &&
			(o.receipt_outcome === 'applied' ||
				o.receipt_outcome === 'violated' ||
				o.receipt_outcome === 'contradicted') &&
			typeof o.receipt_event_id === 'string' &&
			typeof o.timestamp === 'string'
		) {
			return o as PromotionEvidenceRecord;
		}
	} catch {
		/* skip malformed line */
	}
	return null;
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
 * Load all promotion-evidence records, grouped by entry_id. This is the loader
 * that replaces the inert stub at `hive-promoter.ts:loadPromotionEvidence`.
 * Returns an empty object when the file is absent (no evidence yet — the
 * conservative default). Never throws.
 */
export async function loadPromotionEvidenceByEntry(
	directory: string,
): Promise<Record<string, PromotionEvidenceRecord[]>> {
	const filePath = resolvePromotionEvidencePath(directory);
	let content: string;
	try {
		content = await readFile(filePath, 'utf-8');
	} catch {
		return {};
	}
	const out: Record<string, PromotionEvidenceRecord[]> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const rec = parseRecord(trimmed);
		if (!rec) continue;
		const bucket = out[rec.entry_id];
		if (bucket) {
			bucket.push(rec);
		} else {
			out[rec.entry_id] = [rec];
		}
	}
	return out;
}
