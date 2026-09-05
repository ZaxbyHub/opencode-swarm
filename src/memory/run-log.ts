import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { resolveRetentionCap } from '../retention/caps';
import { appendCappedJsonl } from '../retention/jsonl-cap';

export type MemoryRunLogEventName =
	| 'recall_requested'
	| 'recall_returned'
	| 'prompt_injection_skipped'
	| 'prompt_injected'
	| 'proposal_created'
	| 'proposal_rejected_by_validation'
	| 'curator_decision_applied'
	| 'curator_decision_rejected_by_validation'
	| 'consolidation_started'
	| 'cluster_count'
	| 'decisions_emitted'
	| 'contradictions_detected'
	| 'memories_decayed'
	| 'consolidation_completed';

export interface MemoryRunLogEvent {
	event: MemoryRunLogEventName;
	runId: string;
	agentRole?: string;
	agentId?: string;
	bundleId?: string;
	memoryIds?: string[];
	scores?: number[];
	tokenEstimate?: number;
	proposalId?: string;
	rejectionReason?: string;
	timestamp?: string;
	/** Consolidation pass identifier (phase boundary that triggered the pass). */
	phaseNumber?: number;
	/** Consolidation metrics (issue #1464). */
	clusterCount?: number;
	decisionsEmitted?: number;
	contradictionsDetected?: number;
	memoriesDecayed?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Global FIFO cap on each run's `memory.jsonl` run log (issue #2483 §2).
 * Enforcement resolves the effective value through `resolveRetentionCap` so
 * the #2483 acceptance checks can shrink the cap below this default and
 * prove the writer clamps. Keyspace (run directories) is handled by the
 * retention sweep and close lifecycle.
 */
export const MAX_RUN_LOG_ENTRIES = 2000;

export async function appendMemoryRunLog(
	directory: string,
	runId: string | undefined,
	event: MemoryRunLogEvent,
): Promise<void> {
	const safeRunId = sanitizeRunId(runId);
	const relativePath = path.join('runs', safeRunId, 'memory.jsonl');
	const filePath = validateSwarmPath(directory, relativePath);
	await appendCappedJsonl(
		filePath,
		JSON.stringify({
			...event,
			runId: safeRunId,
			timestamp: event.timestamp ?? new Date().toISOString(),
		}),
		{
			maxEntries: resolveRetentionCap(
				'MAX_RUN_LOG_ENTRIES',
				MAX_RUN_LOG_ENTRIES,
			),
		},
	);
}

export function sanitizeRunId(runId: string | undefined): string {
	const value = runId?.trim() || 'unknown';
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
	return sanitized || 'unknown';
}
