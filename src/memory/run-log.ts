import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';

export type MemoryRunLogEventName =
	| 'recall_requested'
	| 'recall_returned'
	| 'prompt_injection_skipped'
	| 'prompt_injected'
	| 'proposal_created'
	| 'proposal_rejected_by_validation';

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
	metadata?: Record<string, unknown>;
}

export async function appendMemoryRunLog(
	directory: string,
	runId: string | undefined,
	event: MemoryRunLogEvent,
): Promise<void> {
	const safeRunId = sanitizeRunId(runId);
	const relativePath = path.join('runs', safeRunId, 'memory.jsonl');
	const filePath = validateSwarmPath(directory, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(
		filePath,
		`${JSON.stringify({
			...event,
			runId: safeRunId,
			timestamp: event.timestamp ?? new Date().toISOString(),
		})}\n`,
		'utf-8',
	);
}

export function sanitizeRunId(runId: string | undefined): string {
	const value = runId?.trim() || 'unknown';
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
	return sanitized || 'unknown';
}
