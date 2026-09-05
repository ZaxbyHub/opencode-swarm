import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { resolveRetentionCap } from '../retention/caps';
import { appendCappedJsonl, readTailJsonl } from '../retention/jsonl-cap';
import type { VettedMemoryRoot } from './storage-root';

/**
 * Durable, append-only record of a completed consolidation pass. Persisted to
 * `.swarm/memory/consolidation-log.jsonl` (invariant #4: runtime state stays
 * under `.swarm/`). Serves two purposes:
 *  - idempotency: a pass for a `phaseNumber` already present here is a no-op;
 *  - observability: the `/swarm memory consolidation-log` CLI reads it.
 *
 * #1850 (critic GAP-3): when cohort sharing is active, the log follows the
 * cohort root (acceptance #4 — consolidation state is part of the vetted-root
 * surface). Callers may pass a `VettedMemoryRoot` to redirect; a raw directory
 * string preserves today's local behavior.
 */
export interface ConsolidationLogRecord {
	phaseNumber: number;
	/** Session/run that produced this pass, for multi-session observability.
	 * Idempotency remains keyed on phaseNumber (the memory store is per
	 * directory), so this is informational only. */
	runId?: string;
	startedAt: string;
	completedAt: string;
	clusterCount: number;
	clustersDeferred: number;
	decisionsEmitted: number;
	added: number;
	superseded: number;
	contradictionsDetected: number;
	deduped: number;
	proposed: number;
	memoriesDecayed: number;
	errored: number;
	processedProposalIds: string[];
}

const LOG_RELATIVE_PATH = path.join('memory', 'consolidation-log.jsonl');
const LOG_BASENAME = 'consolidation-log.jsonl';

/**
 * Global FIFO cap on the consolidation log (issue #2483 §2). Enforcement and
 * the bounded read both resolve the effective value through
 * `resolveRetentionCap` so the #2483 acceptance checks can shrink the cap
 * below this default and prove the writer clamps. The cap keeps last-N
 * semantics: records are returned oldest-to-newest, so callers that
 * `slice(-limit)` for the CLI's last-N view keep working.
 */
export const MAX_CONSOLIDATION_LOG_ENTRIES = 500;

/** #1850: resolve the log path under either a local directory or a vetted root. */
function resolveLogPath(target: string | VettedMemoryRoot): string {
	if (typeof target === 'string') {
		return validateSwarmPath(target, LOG_RELATIVE_PATH);
	}
	if (target.kind === 'cohort') {
		return path.join(target.cohortRoot, LOG_BASENAME);
	}
	return validateSwarmPath(target.directory, LOG_RELATIVE_PATH);
}

export async function readConsolidationLog(
	target: string | VettedMemoryRoot,
): Promise<ConsolidationLogRecord[]> {
	return readTailJsonl<ConsolidationLogRecord>(resolveLogPath(target), {
		maxEntries: resolveRetentionCap(
			'MAX_CONSOLIDATION_LOG_ENTRIES',
			MAX_CONSOLIDATION_LOG_ENTRIES,
		),
	});
}

export async function appendConsolidationLog(
	target: string | VettedMemoryRoot,
	record: ConsolidationLogRecord,
): Promise<void> {
	await appendCappedJsonl(resolveLogPath(target), JSON.stringify(record), {
		maxEntries: resolveRetentionCap(
			'MAX_CONSOLIDATION_LOG_ENTRIES',
			MAX_CONSOLIDATION_LOG_ENTRIES,
		),
	});
}
