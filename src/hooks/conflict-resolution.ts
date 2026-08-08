/**
 * Centralized conflict resolution policy.
 * Encapsulates advisory injection and telemetry emission for agent-vs-agent conflicts.
 * Call this whenever: Reviewer rejects coder output repeatedly, Critic returns
 * REPHRASE/RESOLVE and Architect loops, or Test Engineer blocks previously reviewed work.
 */
import { swarmState } from '../state.js';
import { emit } from '../telemetry.js';
import type { AgentConflictDetectedEvent } from '../types/events.js';
import { pushAdvisory } from '../utils/advisory-queue';

export interface ResolveAgentConflictInput {
	sessionID: string;
	phase: number;
	taskId?: string;
	sourceAgent: AgentConflictDetectedEvent['sourceAgent'];
	targetAgent: AgentConflictDetectedEvent['targetAgent'];
	conflictType: AgentConflictDetectedEvent['conflictType'];
	rejectionCount?: number;
	summary: string;
}

export function resolveAgentConflict(input: ResolveAgentConflictInput): void {
	const session = swarmState.agentSessions.get(input.sessionID);
	if (!session) return;

	const rejections = input.rejectionCount ?? 0;
	let resolutionPath: AgentConflictDetectedEvent['resolutionPath'];
	// Stable per-(task, rejection-level) identity for advisory dedupe. Lets
	// genuine escalation (level 1→2→3) survive while suppressing byte-identical
	// re-fires of the SAME level within a turn. The key tag is embedded at the
	// front of the message (same convention as council-advisory `[council:...]`,
	// pr-event `[pr-monitor:...]`, prm `[prm:...]`) so pushAdvisory's
	// key-presence dedupe (m.includes(key)) can match it.
	const taskId = input.taskId ?? 'unknown';
	const conflictDedupeKey = `conflict:${taskId}:${rejections}`;

	if (rejections >= 3) {
		resolutionPath = 'soundingboard';
		pushAdvisory(
			session,
			`[${conflictDedupeKey}] CONFLICT ESCALATION (rejections=${rejections}): ${input.sourceAgent} vs ${input.targetAgent} on task ${taskId}. Three or more failed cycles detected. Route to Critic in SOUNDING_BOARD mode, then simplify before any user escalation.`,
			{ dedupeKey: conflictDedupeKey },
		);
	} else {
		resolutionPath = 'self_resolve';
		pushAdvisory(
			session,
			`[${conflictDedupeKey}] CONFLICT DETECTED (rejections=${rejections}): ${input.sourceAgent} disagrees with ${input.targetAgent} on task ${taskId}. Attempt self-resolution using .swarm/plan.md, .swarm/spec.md, and .swarm/context.md before escalation.`,
			{ dedupeKey: conflictDedupeKey },
		);
	}

	// Emit telemetry — fire and forget, never throws
	const event: AgentConflictDetectedEvent = {
		type: 'agent_conflict_detected',
		timestamp: new Date().toISOString(),
		sessionId: input.sessionID,
		phase: input.phase,
		taskId: input.taskId,
		sourceAgent: input.sourceAgent,
		targetAgent: input.targetAgent,
		conflictType: input.conflictType,
		resolutionPath,
		summary: input.summary,
	};
	// `agent_conflict_detected` is a real member of `TelemetryEvent` as of issue
	// #2029 and has a catalog entry in `src/observability/catalog.ts`, so this no
	// longer needs to be cast past the type system. The previous
	// `'agent_conflict_detected' as Parameters<typeof emit>[0]` cast meant a live
	// production event kind existed in `.swarm/telemetry.jsonl` that no type and no
	// consumer knew about — the defect class #2029 exists to close.
	emit('agent_conflict_detected', event as unknown as Record<string, unknown>);
}
