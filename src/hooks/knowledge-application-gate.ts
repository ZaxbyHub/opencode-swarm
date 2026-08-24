/**
 * Runtime wiring for the knowledge application contract.
 *
 * Two integration points:
 *
 *   1. `experimental.chat.messages.transform` — scans the latest
 *      architect-authored message for
 *      `KNOWLEDGE_APPLIED|IGNORED|N_A|CONTRADICTED|VIOLATED`
 *      markers and records them via `recordAcknowledgmentDeduped`. This
 *      runs BEFORE the architect's next tool call so the toolBefore gate
 *      sees the ack.
 *
 *   2. `tool.execute.before` (FAIL-CLOSED chain at src/index.ts) — when a
 *      high-risk tool fires and the calling agent is the architect,
 *      consults the authoritative receipt ledger for critical architect
 *      directives in the current active phase/task that have been shown but
 *      not acknowledged. In `mode: 'enforce'` it THROWS to block the
 *      action (per the FAIL-CLOSED contract — `output.error` is NOT a
 *      write API at toolBefore time) — UNLESS one of two bounded escape
 *      hatches has fired first (a per-directive denial-count limit, or a
 *      per-exact-pair staleness TTL since the directive was shown; see
 *      `incrementGateDenialCount`/`buildGateDenialDirectiveKey` in
 *      `../state.js`), in which case the pending directives are
 *      auto-acknowledged and an audit event is durably written before the
 *      action is allowed to proceed. In `mode: 'warn'` it appends to
 *      `events.jsonl` and always lets the action proceed.
 *
 * Tools considered high-risk:
 *   - save_plan
 *   - update_task_status
 *   - phase_complete
 *   - Task (delegations to coder/reviewer/test_engineer/sme/docs/designer)
 *
 * Non-architect agents are never gated.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	addKnowledgeAckDedup,
	buildGateDenialDirectiveKey,
	clearCriticalShownIds,
	clearGateDenialCount,
	incrementGateDenialCount,
	swarmState,
} from '../state.js';
import { warn } from '../utils/logger.js';
import {
	buildAckDedupKey,
	type KnowledgeApplicationConfig,
	parseAcknowledgments,
	type RecordContext,
	recordAcknowledgment,
} from './knowledge-application.js';
import {
	commitApplicationOutcomeBatch,
	commitGateReleaseBatch,
	queryLiveMemberships,
	type ReceiptMembership,
} from './knowledge-receipt-ledger.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from './knowledge-store.js';
import type {
	MessageWithParts,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';

/** Tools that require knowledge-directive acknowledgment before execution. */
export const HIGH_RISK_TOOLS = new Set([
	'save_plan',
	'update_task_status',
	'phase_complete',
	'task',
	'Task',
	'skill_regenerate',
	'skill_retire',
]);

const DEFAULT_MAX_GATE_DENIALS = 5;
const DEFAULT_GATE_STALENESS_MS = 600_000; // 10 minutes

export interface GateInput {
	tool: unknown;
	agent?: unknown;
	sessionID?: unknown;
}

function selectCurrentArchitectDirectiveMemberships(
	memberships: ReceiptMembership[],
): ReceiptMembership[] {
	const activeArchitect = memberships.filter(
		(membership) =>
			membership.exposure_kind === 'architect_directive' &&
			!membership.phase_closed_at,
	);
	let latest: ReceiptMembership | undefined;
	let latestAt = Number.NEGATIVE_INFINITY;
	for (const membership of activeArchitect) {
		const committedAt = Date.parse(membership.committed_at);
		const comparableAt = Number.isFinite(committedAt)
			? committedAt
			: Number.NEGATIVE_INFINITY;
		// Map/journal iteration order is authoritative when two commits share a
		// millisecond, so the later encountered scope wins the tie.
		if (!latest || comparableAt >= latestAt) {
			latest = membership;
			latestAt = comparableAt;
		}
	}
	if (!latest) return [];
	return activeArchitect.filter(
		(membership) =>
			membership.phase === latest.phase &&
			membership.task_id === latest.task_id,
	);
}

function selectStaleUnmarkedMemberships(
	memberships: ReceiptMembership[],
	now: number,
	stalenessMs: number,
): ReceiptMembership[] {
	return memberships.filter((membership) => {
		if (membership.application_marker || hasEffectiveGateRelease(membership))
			return false;
		const committedAt = Date.parse(membership.committed_at);
		return Number.isFinite(committedAt) && now - committedAt > stalenessMs;
	});
}

function hasEffectiveGateRelease(membership: ReceiptMembership): boolean {
	return (
		membership.gate_release?.membership_event_id ===
		membership.membership_event_id
	);
}

function groupMembershipsByTrace(
	memberships: ReceiptMembership[],
): Map<string, ReceiptMembership[]> {
	const byTrace = new Map<string, ReceiptMembership[]>();
	for (const membership of memberships) {
		const group = byTrace.get(membership.trace_id) ?? [];
		group.push(membership);
		byTrace.set(membership.trace_id, group);
	}
	return byTrace;
}

/**
 * Best-effort lookup of directive lesson text by knowledge entry id, for
 * surfacing the acknowledged content inside a gate denial (issue #2299).
 *
 * Reads the project-local swarm store always (cached by `readKnowledge` and
 * bounded in size by the store's own knowledge cap) and the cross-project hive
 * store only when the hive file exists. A hive entry can only be an
 * unacknowledged architect-directive membership if it was displayed, which
 * requires hive to have been enabled at display time, so reading it back here
 * is not a fresh disclosure. Fail-open: any read error simply omits the
 * content echo and never alters the denial outcome.
 */
export async function loadDirectiveContents(
	directory: string,
	entryIds: string[],
): Promise<Map<string, string>> {
	const contents = new Map<string, string>();
	if (entryIds.length === 0) return contents;
	const want = new Set(entryIds);
	const sources: string[] = [resolveSwarmKnowledgePath(directory)];
	try {
		const hivePath = resolveHiveKnowledgePath();
		if (existsSync(hivePath)) sources.push(hivePath);
	} catch {
		/* hive resolution unavailable — content echo is best-effort */
	}
	for (const filePath of sources) {
		try {
			const entries = await readKnowledge<SwarmKnowledgeEntry>(filePath);
			for (const entry of entries) {
				if (
					want.has(entry.id) &&
					!contents.has(entry.id) &&
					typeof entry.lesson === 'string'
				) {
					contents.set(entry.id, entry.lesson);
				}
			}
		} catch {
			/* fail-open: never let content echo break the denial */
		}
	}
	return contents;
}

/**
 * Build the KNOWLEDGE_ENFORCE_GATE_DENY message (issue #2299). Renders
 * unacknowledged memberships in the single canonical colon pair form
 * `<trace_id>:<entry_id>`, lists every valid verb with its token grammar,
 * and emits one fully-instantiated, copy-pasteable `KNOWLEDGE_N_A` example per
 * membership plus the directive content being acknowledged.
 */
export function buildGateDenialMessage(
	toolName: string,
	memberships: ReceiptMembership[],
	contents: Map<string, string>,
): string {
	const pairs = memberships.map((m) => `${m.trace_id}:${m.entry_id}`);
	const examples = memberships.map(
		(m) => `  KNOWLEDGE_N_A:${m.trace_id}:${m.entry_id} reason=<reason>`,
	);
	const contentLines = memberships.map((m) => {
		const lesson = contents.get(m.entry_id);
		return `  [${m.trace_id}:${m.entry_id}] ${
			lesson ??
			'content not found in knowledge store — see the most recent <swarm_knowledge_directives> block or run knowledge_recall'
		}`;
	});
	return [
		`KNOWLEDGE_ENFORCE_GATE_DENY: ${toolName} blocked — unacknowledged critical knowledge directive(s): ${pairs.join(', ')}.`,
		'',
		'Acknowledge each directive using its exact, colon-separated tokens (<trace_id>:<entry_id>) with one of these verb markers:',
		'  KNOWLEDGE_APPLIED:<trace_id>:<entry_id>',
		'  KNOWLEDGE_IGNORED:<trace_id>:<entry_id> reason=<short reason>',
		'  KNOWLEDGE_CONTRADICTED:<trace_id>:<entry_id> reason=<observable conflict>',
		'  KNOWLEDGE_N_A:<trace_id>:<entry_id> reason=<short reason>',
		'  KNOWLEDGE_VIOLATED:<trace_id>:<entry_id> reason=<short reason>',
		'KNOWLEDGE_N_A (does not apply; neutral) is a valid, penalty-free acknowledgment when the directive does not pertain to the current step.',
		'',
		'Copy-paste to acknowledge each directive now (replace <reason> with a short reason):',
		...examples,
		'',
		'Directive content being acknowledged:',
		...contentLines,
	].join('\n');
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

	const receiptState = await queryLiveMemberships(directory, {
		session_id: sessionID,
		include_terminal: true,
		include_phase_closed: false,
		exposure_kind: 'architect_directive',
	});
	if (!receiptState.ok) {
		if (config.mode === 'enforce') {
			throw new Error(
				`KNOWLEDGE_ENFORCE_GATE_DENY: receipt authority unavailable (${receiptState.code}); refusing to infer acknowledgment from diagnostics`,
			);
		}
		void writeWarnEvent(directory, {
			timestamp: new Date().toISOString(),
			event: 'knowledge_application_gate_warn',
			tool: toolName,
			agent: agentRaw,
			sessionID,
			reason: receiptState.code,
		});
		return;
	}
	const currentMemberships = selectCurrentArchitectDirectiveMemberships(
		receiptState.memberships,
	);
	const criticalMemberships = currentMemberships.filter(
		(membership) => membership.critical,
	);
	if (criticalMemberships.length === 0) {
		clearGateDenialCount(sessionID);
		return;
	}
	let unackedMemberships = criticalMemberships.filter(
		(membership) =>
			!membership.application_marker && !hasEffectiveGateRelease(membership),
	);
	if (unackedMemberships.length === 0) {
		clearGateDenialCount(sessionID);
		return;
	}

	// The receipt ledger is the gate authority. Diagnostic logs and the
	// compatibility dedup cache never widen this pending exact-pair set.
	if (config.mode === 'enforce' && config.critical_requires_ack) {
		const maxDenials = config.max_gate_denials ?? DEFAULT_MAX_GATE_DENIALS;
		const stalenessMs = config.gate_staleness_ms ?? DEFAULT_GATE_STALENESS_MS;

		// Escape hatch 1: clear only exact pairs older than the configured TTL.
		// Fresh pairs remain pending and continue through the denial path below.
		const now = Date.now();
		const staleMemberships = selectStaleUnmarkedMemberships(
			unackedMemberships,
			now,
			stalenessMs,
		);
		if (staleMemberships.length > 0) {
			for (const [traceId, memberships] of groupMembershipsByTrace(
				staleMemberships,
			)) {
				const committed = await commitGateReleaseBatch(directory, {
					trace_id: traceId,
					session_id: sessionID,
					items: memberships.map((membership) => ({
						entry_id: membership.entry_id,
						source: 'application_gate_staleness_release',
						reason: 'configured staleness escape hatch',
					})),
				});
				if (!committed.ok || committed.rejected.length > 0) {
					throw new Error(
						'KNOWLEDGE_ENFORCE_GATE_DENY: could not durably record staleness release',
					);
				}
			}
			const stalePairs = new Set(
				staleMemberships.map(
					(membership) => `${membership.trace_id}/${membership.entry_id}`,
				),
			);
			unackedMemberships = unackedMemberships.filter(
				(membership) =>
					!stalePairs.has(`${membership.trace_id}/${membership.entry_id}`),
			);
			const staleIds = [
				...new Set(staleMemberships.map((membership) => membership.entry_id)),
			];
			clearGateDenialCount(sessionID);
			// Awaited (not fire-and-forget): the bypass state above is already
			// committed, so the audit write is the only remaining evidence of
			// this security-relevant auto-clear. Awaiting it before returning
			// keeps the "never silent" guarantee true even under a write
			// failure window, not just in the common case.
			await writeWarnEvent(directory, {
				timestamp: new Date().toISOString(),
				event: 'knowledge_application_gate_staleness_clear',
				tool: toolName,
				agent: agentRaw,
				sessionID,
				cleared_ids: staleIds,
				cleared_pairs: [...stalePairs],
				age_ms: Math.max(
					...staleMemberships.map(
						(membership) => now - Date.parse(membership.committed_at),
					),
				),
				staleness_threshold_ms: stalenessMs,
			}).catch((err: unknown) => {
				warn(
					`[knowledge-application-gate] staleness-clear audit write failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			});
			if (unackedMemberships.length === 0) {
				clearCriticalShownIds(sessionID);
				return;
			}
		}

		// Escape hatch 2: denial count — if this session has been denied more
		// than the configured max, auto-clear and allow the action. The
		// counter is keyed to the current directive-id-set identity, so a
		// session whose critical directives were swapped out from under it
		// (an ordinary phase/task-transition occurrence via
		// setCriticalShownIds) starts a fresh count instead of inheriting a
		// stale one accrued against an unrelated, earlier directive.
		const unackedPairs = unackedMemberships.map(
			(membership) => `${membership.trace_id}/${membership.entry_id}`,
		);
		const unacked = [
			...new Set(unackedMemberships.map((membership) => membership.entry_id)),
		];
		const directiveKey = buildGateDenialDirectiveKey(unackedPairs);
		const denials = incrementGateDenialCount(sessionID, directiveKey);
		if (denials > maxDenials) {
			for (const [traceId, memberships] of groupMembershipsByTrace(
				unackedMemberships,
			)) {
				const committed = await commitGateReleaseBatch(directory, {
					trace_id: traceId,
					session_id: sessionID,
					items: memberships.map((membership) => ({
						entry_id: membership.entry_id,
						source: 'application_gate_denial_limit_release',
						reason: 'configured denial-count escape hatch',
					})),
				});
				if (!committed.ok || committed.rejected.length > 0) {
					throw new Error(
						'KNOWLEDGE_ENFORCE_GATE_DENY: could not durably record denial-limit release',
					);
				}
			}
			clearCriticalShownIds(sessionID);
			clearGateDenialCount(sessionID);
			await writeWarnEvent(directory, {
				timestamp: new Date().toISOString(),
				event: 'knowledge_application_gate_denial_limit_clear',
				tool: toolName,
				agent: agentRaw,
				sessionID,
				cleared_ids: unacked,
				denial_count: denials,
				max_gate_denials: maxDenials,
			}).catch((err: unknown) => {
				warn(
					`[knowledge-application-gate] denial-limit-clear audit write failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			});
			return;
		}

		const contents = await loadDirectiveContents(directory, unacked);
		throw new Error(
			buildGateDenialMessage(toolName, unackedMemberships, contents),
		);
	}
	const unacked = [
		...new Set(unackedMemberships.map((membership) => membership.entry_id)),
	];
	const unackedPairs = unackedMemberships.map(
		(membership) => `${membership.trace_id}/${membership.entry_id}`,
	);

	// warn mode → events.jsonl audit
	void writeWarnEvent(directory, {
		timestamp: new Date().toISOString(),
		event: 'knowledge_application_gate_warn',
		tool: toolName,
		agent: agentRaw,
		sessionID,
		unacknowledged_critical_ids: unacked,
		unacknowledged_critical_pairs: unackedPairs,
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
	const live = await queryLiveMemberships(directory, {
		session_id: sessionID,
		include_terminal: true,
		include_phase_closed: false,
		exposure_kind: 'architect_directive',
	});
	if (!live.ok) {
		warn(
			`[knowledge-application-gate] receipt authority unavailable: ${live.code}`,
		);
		return;
	}
	for (const ack of acks) {
		// Architect markers must bind to one exact retrieval membership. Legacy
		// entry-only markers remain parseable for delegates but cannot satisfy this
		// application gate or affect a sibling trace.
		if (!ack.trace_id) continue;
		const key = buildAckDedupKey(
			sessionID,
			JSON.stringify([ack.trace_id, ack.id]),
			ack.result,
		);
		if (swarmState.knowledgeAckDedup.has(key)) continue;
		const memberships = live.memberships.filter(
			(membership) =>
				membership.trace_id === ack.trace_id &&
				membership.entry_id === ack.id &&
				!membership.application_marker &&
				!hasEffectiveGateRelease(membership),
		);
		if (memberships.length === 0) continue;
		const byTrace = new Map<string, typeof memberships>();
		for (const membership of memberships) {
			const group = byTrace.get(membership.trace_id) ?? [];
			group.push(membership);
			byTrace.set(membership.trace_id, group);
		}
		let committedAll = true;
		let newlyCommitted = false;
		for (const [traceId, group] of byTrace) {
			const committed = await commitApplicationOutcomeBatch(directory, {
				trace_id: traceId,
				session_id: sessionID,
				items: group.map((membership) => ({
					entry_id: membership.entry_id,
					outcome: ack.result,
					source: 'architect_marker',
					reason: ack.reason,
				})),
			});
			if (!committed.ok || committed.rejected.length > 0) {
				committedAll = false;
				break;
			}
			if (committed.committed.length > 0) newlyCommitted = true;
		}
		if (!committedAll) continue;
		addKnowledgeAckDedup(key);
		if (!newlyCommitted) continue;
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
	selectCurrentArchitectDirectiveMemberships,
	selectStaleUnmarkedMemberships,
	loadDirectiveContents,
	buildGateDenialMessage,
};
