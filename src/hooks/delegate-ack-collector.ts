/**
 * Delegate ack collection (Swarm Learning System, Change 1 / Task 1.5).
 *
 * A `tool.execute.after` hook on the `Task` tool. After a delegated subagent
 * returns, this reconciles the directives that were shown to it (recovered by
 * parsing the `<delegate_knowledge_directives>` block out of the delegation
 * prompt) against the ack markers in the subagent's transcript:
 *
 *   - For every ack whose ID was actually shown, emit a receipt event of the
 *     matching type (applied / ignored / violated / n_a). Acks for IDs that were
 *     never shown are DROPPED (anti-spoofing).
 *   - For every CRITICAL directive that was shown but never acknowledged, emit a
 *     `violated` event with reason `unacknowledged` and append an audit line to
 *     `.swarm/unacknowledged-criticals.jsonl`.
 *
 * Stateless by design: it re-parses the prompt rather than relying on
 * cross-hook mutable state, so it is safe under parallel delegations. Fail-open:
 * never throws, never blocks.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { parseAcknowledgments } from './knowledge-application.js';
import { escalateViolatedEntries } from './knowledge-escalator.js';
import { newTraceId, recordKnowledgeEvent } from './knowledge-events.js';
import { parseDelegateDirectiveBlock } from './knowledge-injector.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { validateSwarmPath } from './utils.js';

export interface DelegateAckInput {
	tool: unknown;
	agent?: unknown;
	sessionID?: unknown;
	args?: unknown;
}

export interface DelegateAckOutput {
	output?: unknown;
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

/** Best-effort extraction of a task id from a delegation prompt envelope. */
function extractTaskId(prompt: string): string | undefined {
	const m = /\btask[_-]?id\s*[:=]\s*([A-Za-z0-9._-]{1,80})/i.exec(prompt);
	return m ? m[1] : undefined;
}

/**
 * Append an unacknowledged-critical audit line. Path is validated to stay inside
 * `.swarm/`. Best-effort: errors are swallowed by the caller.
 */
async function appendUnacknowledgedCritical(
	directory: string,
	record: Record<string, unknown>,
): Promise<void> {
	const filePath = validateSwarmPath(
		directory,
		'unacknowledged-criticals.jsonl',
	);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

export interface CollectDelegateAcksResult {
	emitted: Array<{ id: string; type: string }>;
	unacknowledgedCriticals: string[];
}

/**
 * Core reconciliation used by both the runtime hook and tests. Returns a summary
 * of what was emitted. Never throws.
 */
export async function collectDelegateAcks(params: {
	directory: string;
	prompt: string;
	transcript: string;
	agent: string;
	sessionId?: string;
	taskId?: string;
}): Promise<CollectDelegateAcksResult> {
	const result: CollectDelegateAcksResult = {
		emitted: [],
		unacknowledgedCriticals: [],
	};
	try {
		const shown = parseDelegateDirectiveBlock(params.prompt);
		if (shown.length === 0) return result;

		const shownById = new Map(shown.map((d) => [d.id, d]));
		const criticalIds = shown
			.filter((d) => d.priority === 'critical')
			.map((d) => d.id);

		const acks = parseAcknowledgments(params.transcript);
		const ackedIds = new Set<string>();
		const violatedIds = new Set<string>();
		const sessionId = params.sessionId ?? 'unknown';
		const taskId = params.taskId ?? extractTaskId(params.prompt);
		const traceId = newTraceId();

		for (const ack of acks) {
			// Anti-spoofing: only honor acks for directives that were actually shown.
			if (!shownById.has(ack.id)) continue;
			ackedIds.add(ack.id);
			await recordKnowledgeEvent(params.directory, {
				type: ack.result,
				trace_id: traceId,
				knowledge_id: ack.id,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				reason: ack.reason,
			});
			if (ack.result === 'violated') violatedIds.add(ack.id);
			result.emitted.push({ id: ack.id, type: ack.result });
		}

		// Any critical that was shown but never acknowledged is a contract
		// violation: record it as violated/unacknowledged and audit it.
		for (const id of criticalIds) {
			if (ackedIds.has(id)) continue;
			result.unacknowledgedCriticals.push(id);
			await recordKnowledgeEvent(params.directory, {
				type: 'violated',
				trace_id: traceId,
				knowledge_id: id,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				reason: 'unacknowledged',
			});
			violatedIds.add(id);
			result.emitted.push({ id, type: 'violated' });
			try {
				await appendUnacknowledgedCritical(params.directory, {
					timestamp: new Date().toISOString(),
					knowledge_id: id,
					agent: params.agent,
					session_id: sessionId,
					task_id: taskId,
					reason: 'unacknowledged',
				});
			} catch {
				// audit log is best-effort
			}
		}

		// Repeat-mistake escalation (Change 3): after all violated events are
		// persisted, escalate any directive that crossed the repeat threshold.
		if (violatedIds.size > 0) {
			await escalateViolatedEntries(params.directory, [...violatedIds]);
		}
	} catch {
		// fail-open
	}
	return result;
}

/**
 * `tool.execute.after` adapter. Reconciles delegate acks for a completed Task.
 */
export async function collectDelegateAcksAfter(
	directory: string,
	input: DelegateAckInput,
	output: DelegateAckOutput,
): Promise<void> {
	if (!isTaskTool(input.tool)) return;
	const argsRecord =
		input.args && typeof input.args === 'object'
			? (input.args as Record<string, unknown>)
			: null;
	const prompt =
		argsRecord && typeof argsRecord.prompt === 'string'
			? argsRecord.prompt
			: '';
	if (!prompt) return;
	const transcript = typeof output.output === 'string' ? output.output : '';
	if (!transcript) return;

	// Attribute receipts to the delegate (subagent_type), not the architect caller.
	const parsed = parseDelegationArgs(input.args);
	const agent = parsed?.targetAgent ?? 'unknown';
	const sessionId =
		typeof input.sessionID === 'string' ? input.sessionID : undefined;

	await collectDelegateAcks({
		directory,
		prompt,
		transcript,
		agent,
		sessionId,
	});
}
