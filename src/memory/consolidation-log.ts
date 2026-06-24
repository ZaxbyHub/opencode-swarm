import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';

/**
 * Durable, append-only record of a completed consolidation pass. Persisted to
 * `.swarm/memory/consolidation-log.jsonl` (invariant #4: runtime state stays
 * under `.swarm/`). Serves two purposes:
 *  - idempotency: a pass for a `phaseNumber` already present here is a no-op;
 *  - observability: the `/swarm memory consolidation-log` CLI reads it.
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

export async function readConsolidationLog(
	directory: string,
): Promise<ConsolidationLogRecord[]> {
	const filePath = validateSwarmPath(directory, LOG_RELATIVE_PATH);
	let raw: string;
	try {
		raw = await readFile(filePath, 'utf-8');
	} catch {
		return [];
	}
	const records: ConsolidationLogRecord[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as ConsolidationLogRecord);
		} catch {
			// Skip corrupt lines rather than failing the whole read.
		}
	}
	return records;
}

export async function appendConsolidationLog(
	directory: string,
	record: ConsolidationLogRecord,
): Promise<void> {
	const filePath = validateSwarmPath(directory, LOG_RELATIVE_PATH);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}
