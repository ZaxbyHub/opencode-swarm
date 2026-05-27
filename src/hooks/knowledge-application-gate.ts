/**
 * Runtime wiring for the knowledge application contract.
 *
 * Two integration points:
 *
 *   1. `experimental.chat.messages.transform` — scans the latest
 *      architect-authored message for `KNOWLEDGE_APPLIED|IGNORED|VIOLATED`
 *      markers and records them via `recordAcknowledgmentDeduped`. This
 *      runs BEFORE the architect's next tool call so the toolBefore gate
 *      sees the ack.
 *
 *   2. `tool.execute.before` (FAIL-CLOSED chain at src/index.ts) — when a
 *      high-risk tool fires and the calling agent is the architect,
 *      consults `swarmState.currentCriticalShownIds` and the audit log to
 *      assemble the set of critical directives that have been shown but
 *      not acknowledged. In `mode: 'enforce'` it THROWS to block the
 *      action (per the FAIL-CLOSED contract — `output.error` is NOT a
 *      write API at toolBefore time). In `mode: 'warn'` it appends to
 *      `events.jsonl` and lets the action proceed.
 *
 * Tools considered high-risk:
 *   - save_plan
 *   - update_task_status
 *   - phase_complete
 *   - Task (delegations to coder/reviewer/test_engineer/sme/docs/designer)
 *
 * Non-architect agents are never gated.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { addKnowledgeAckDedup, swarmState } from '../state.js';
import { warn } from '../utils/logger.js';
import {
	buildAckDedupKey,
	type KnowledgeApplicationConfig,
	parseAcknowledgments,
	type RecordContext,
	recordAcknowledgment,
} from './knowledge-application.js';
import type { MessageWithParts } from './knowledge-types.js';

/** Tools that require knowledge-directive acknowledgment before execution. */
export const HIGH_RISK_TOOLS = new Set([
	'save_plan',
	'update_task_status',
	'phase_complete',
	'task',
	'Task',
]);

export interface GateInput {
	tool: unknown;
	agent?: unknown;
	sessionID?: unknown;
}

/**
 * Pre-tool gate. Throws when the architect attempts a high-risk action with
 * an unacknowledged critical directive in `enforce` mode. Always returns in
 * `warn` mode (with a side-effect events.jsonl write).
 */
export async function knowledgeApplicationGateBefore(
	directory: string,
	input: GateInput,
	config: KnowledgeApplicationConfig,
): Promise<void> {
	if (!config.enabled) return;

	const toolName = typeof input.tool === 'string' ? input.tool : '';
	// Use config-provided tools, falling back to the hardcoded default set
	const riskTools = config.high_risk_tools
		? new Set(config.high_risk_tools)
		: HIGH_RISK_TOOLS;
	if (!riskTools.has(toolName)) return;

	const agentRaw = typeof input.agent === 'string' ? input.agent : '';
	if (!agentRaw) return;
	const baseAgent = stripKnownSwarmPrefix(agentRaw);
	if (baseAgent !== 'architect') return;

	const sessionID =
		typeof input.sessionID === 'string' ? input.sessionID : undefined;
	if (!sessionID) {
		// OpenCode's tool.execute.before contract guarantees a sessionID for
		// every tool invocation. Reaching this branch means the contract has
		// been violated (test stub, runtime bug, or hostile caller). Fail
		// closed in enforce mode — silently allowing the call would defeat
		// the gate. Warn mode proceeds after logging a warning event to
		// events.jsonl for diagnostics.
		if (config.mode === 'enforce') {
			throw new Error(
				'KNOWLEDGE_ENFORCE_GATE_DENY: missing sessionID on tool.execute.before; refusing to evaluate critical-directive ack state',
			);
		}
		// Log warning event for missing sessionID (warn mode only)
		void _internals
			.writeWarnEvent(directory, {
				timestamp: new Date().toISOString(),
				event: 'knowledge_application_gate_warn',
				tool: toolName,
				agent: agentRaw,
				reason: 'missing_sessionID',
				mode: config.mode,
			})
			.catch(() => {
				/* never block tool path */
			});
		return;
	}

	const cached = swarmState.currentCriticalShownIds.get(sessionID);
	if (!cached || cached.ids.length === 0) return;

	// Has an architect ack landed in this session for any of the critical ids?
	const dayKey = new Date().toISOString().slice(0, 10);
	const ackedIds = new Set<string>();
	for (const id of cached.ids) {
		// Either explicit-applied OR explicit-ignored counts as "acknowledged"
		// for the purpose of the gate (the architect chose; we audit elsewhere).
		for (const result of ['applied', 'ignored', 'violated'] as const) {
			const key = buildAckDedupKey(sessionID, id, result);
			if (swarmState.knowledgeAckDedup.has(key)) {
				ackedIds.add(id);
				break;
			}
		}
	}

	const unacked = cached.ids.filter((id) => !ackedIds.has(id));
	if (unacked.length === 0) return;

	// Synthesise the gate result format expected by gateKnowledgeApplication
	// (the helper itself takes recentArchitectText, but here we pre-decided
	// who is acked via the dedup set; do not re-parse text).
	if (config.mode === 'enforce' && config.critical_requires_ack) {
		const ids = unacked.join(', ');
		throw new Error(
			`KNOWLEDGE_ENFORCE_GATE_DENY: ${toolName} blocked — critical knowledge directive(s) ${ids} require KNOWLEDGE_APPLIED:<id> or KNOWLEDGE_IGNORED:<id> reason=... before this action.`,
		);
	}

	// warn mode → events.jsonl audit
	void writeWarnEvent(directory, {
		timestamp: new Date().toISOString(),
		event: 'knowledge_application_gate_warn',
		tool: toolName,
		agent: agentRaw,
		sessionID,
		dayKey,
		unacknowledged_critical_ids: unacked,
	}).catch(() => {
		/* never block tool path */
	});
}

async function writeWarnEvent(
	directory: string,
	record: Record<string, unknown>,
): Promise<void> {
	const filePath = path.join(directory, '.swarm', 'events.jsonl');
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * Compose into `experimental.chat.messages.transform`. Scans the most recent
 * `role: 'user'`-shaped architect message for ack markers (per
 * `full-auto-intercept.ts` pattern: architect outputs appear as user role)
 * and records each via `recordAcknowledgmentDeduped`. Best-effort: never
 * throws; never mutates the messages array.
 */
export async function knowledgeApplicationTransformScan(
	directory: string,
	output: { messages?: MessageWithParts[] },
	sessionID?: string,
): Promise<void> {
	if (!output?.messages) return;
	if (!sessionID) return;
	// Find the latest message authored by an architect-prefixed agent.
	let target: MessageWithParts | undefined;
	for (let i = output.messages.length - 1; i >= 0; i--) {
		const m = output.messages[i];
		const agent = m.info?.agent;
		if (
			typeof agent === 'string' &&
			stripKnownSwarmPrefix(agent) === 'architect'
		) {
			target = m;
			break;
		}
	}
	if (!target) return;
	const text = (target.parts ?? [])
		.map((p) => (typeof p.text === 'string' ? p.text : ''))
		.join('\n');
	if (!text) return;

	const acks = parseAcknowledgments(text);
	if (acks.length === 0) return;

	const ctx: RecordContext = { sessionId: sessionID };
	for (const ack of acks) {
		const key = buildAckDedupKey(sessionID, ack.id, ack.result);
		if (swarmState.knowledgeAckDedup.has(key)) continue;
		addKnowledgeAckDedup(key);
		try {
			await recordAcknowledgment(directory, ack, ctx);
		} catch (err) {
			warn(
				`[knowledge-application-gate] transform-scan record failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}

export const _internals = {
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
	HIGH_RISK_TOOLS,
	writeWarnEvent,
};
