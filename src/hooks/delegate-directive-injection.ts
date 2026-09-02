/**
 * Architect-side delegate directive injection (Swarm Learning System, Change 1 /
 * Task 1.4).
 *
 * When the architect delegates via the `Task` tool, this `tool.execute.before`
 * hook prepends the role-scoped `<delegate_knowledge_directives>` block to the
 * subagent's prompt so the delegate sees the directives (and the ack contract)
 * from its very first message. It mirrors the existing skill-injection pattern
 * in src/index.ts, which already mutates `input.args.prompt`.
 *
 * This is ADVISORY (prompt enrichment): it must never throw or block a
 * delegation. A retrieval failure simply leaves the prompt unchanged.
 *
 * NOTE on plan deviation: the implementation plan listed `src/agents/architect.ts`
 * as the "delegation prompt builder". The architect is prompt-driven — real
 * delegations are constructed by the model at runtime via the Task tool, so the
 * code-accurate interception point is this hook, not the architect prompt
 * template. The architect's own `<swarm_knowledge_directives>` injection is
 * untouched.
 */

import {
	buildDirectiveComplianceBlock,
	parseDirectivesToVerifyBlock,
} from '../agents/reviewer-directive-compliance.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { loadPlan } from '../plan/manager.js';
import { log, warn } from '../utils/logger.js';
import { extractCurrentPhaseFromPlan } from './extractors.js';
import { recordKnowledgeEvent } from './knowledge-events.js';
import {
	buildDelegateDirectiveBlock,
	DELEGATE_INJECT_HARD_CHAR_CAP,
	defaultExpectedToolsForAgent,
	injectForDelegate,
	isDelegatedAgent,
	parseDelegateDirectiveBlock,
} from './knowledge-injector.js';
import type { KnowledgeConfig } from './knowledge-types.js';
import { readPhaseDirectivesToVerify } from './phase-directives.js';
import {
	collectPlanTaskIdContextFromPhases,
	toTaskIdPlanContextOptions,
} from './plan-task-id-context.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { resolveTaskId } from './task-id-resolver.js';

/**
 * Emits a structured `injection_skip` diagnostic event so the reason a
 * per-delegation skip fired is recoverable from `.swarm/knowledge-events.jsonl`
 * (mirrors `recordInjectionSkip` in knowledge-injector.ts, issue #1768). Only
 * called for skip branches that fire per-delegation (i.e. after the
 * `isTaskTool` gate passes) — `knowledge_disabled` and `not_task_tool` fire on
 * every non-Task tool call and stay log-only to avoid an event flood.
 * Fire-and-forget + fail-open: telemetry must never break delegation.
 */
function recordDelegateInjectionSkip(
	directory: string,
	reason: string,
	options?: {
		agent?: string;
		sessionId?: string;
		detail?: Record<string, unknown>;
	},
): void {
	recordKnowledgeEvent(directory, {
		type: 'injection_skip',
		reason,
		agent: options?.agent,
		session_id: options?.sessionId,
		detail: options?.detail,
	}).catch(() => {
		// swallow — diagnostic telemetry must never propagate
	});
}

export interface DelegateInjectionInput {
	tool: unknown;
	agent?: unknown;
	sessionID?: unknown;
	args?: unknown;
}

/** True for the Task delegation tool (case-insensitive variants). */
function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

function hasDelegateDirectiveBlock(text: string): boolean {
	return parseDelegateDirectiveBlock(text).length > 0;
}

function hasDirectiveComplianceBlock(text: string): boolean {
	return parseDirectivesToVerifyBlock(text).length > 0;
}

/**
 * Prepend the per-delegate directive block to a Task delegation's prompt.
 * Returns the number of directives injected (0 when nothing was injected),
 * primarily for test assertions. Never throws.
 */
export async function injectDelegateDirectivesBefore(
	directory: string,
	input: DelegateInjectionInput,
	config: KnowledgeConfig,
): Promise<number> {
	// Declared outside the try so the catch block can still attribute a
	// diagnostic event to the session even if something later throws; the
	// derivation itself is a plain typeof check and cannot throw.
	let sessionId: string | undefined;
	try {
		sessionId =
			typeof input.sessionID === 'string' ? input.sessionID : undefined;
		const debugSkip = (reason: string, data?: Record<string, unknown>) => {
			log('[delegate-directive-injection] skipped', {
				reason,
				caller_agent: typeof input.agent === 'string' ? input.agent : undefined,
				tool: input.tool,
				...data,
			});
			return 0;
		};

		if (config.enabled === false) return debugSkip('knowledge_disabled');
		if (!isTaskTool(input.tool)) return debugSkip('not_task_tool');

		const callerAgent = typeof input.agent === 'string' ? input.agent : '';
		const callerRole = stripKnownSwarmPrefix(callerAgent).toLowerCase();
		if (!callerAgent || callerRole !== 'architect') {
			recordDelegateInjectionSkip(directory, 'delegate_caller_not_allowed', {
				agent: callerAgent || undefined,
				sessionId,
				detail: { caller_role: callerRole },
			});
			return debugSkip('caller_not_allowed', { caller_role: callerRole });
		}

		const argsRecord =
			input.args && typeof input.args === 'object'
				? (input.args as Record<string, unknown>)
				: null;
		if (!argsRecord) {
			recordDelegateInjectionSkip(directory, 'delegate_missing_args', {
				agent: callerAgent,
				sessionId,
			});
			return debugSkip('missing_args');
		}
		const promptRaw = argsRecord.prompt;
		if (typeof promptRaw !== 'string') {
			recordDelegateInjectionSkip(directory, 'delegate_missing_prompt', {
				agent: callerAgent,
				sessionId,
			});
			return debugSkip('missing_prompt');
		}

		const parsed = parseDelegationArgs(input.args);
		if (!parsed) {
			recordDelegateInjectionSkip(
				directory,
				'delegate_unparseable_delegation_args',
				{ agent: callerAgent, sessionId },
			);
			return debugSkip('unparseable_delegation_args');
		}
		const targetAgent = parsed.targetAgent;
		if (!isDelegatedAgent(targetAgent)) {
			recordDelegateInjectionSkip(
				directory,
				'delegate_target_not_delegated_agent',
				{
					agent: targetAgent,
					sessionId,
					detail: { target_agent: targetAgent },
				},
			);
			return debugSkip('target_not_delegated_agent', {
				target_agent: targetAgent,
			});
		}

		// Idempotency: never inject a second directive or compliance block.
		if (
			hasDelegateDirectiveBlock(promptRaw) ||
			hasDirectiveComplianceBlock(promptRaw)
		) {
			recordDelegateInjectionSkip(directory, 'delegate_already_injected', {
				agent: targetAgent,
				sessionId,
			});
			return debugSkip('already_injected', { target_agent: targetAgent });
		}

		// Resolve the plan phase label so the emitted delegate_inject event (and
		// thus the reviewer verdict loop + phase-complete gate) windows by phase.
		const plan = await loadPlan(directory).catch(() => null);
		const phaseLabel = plan
			? (extractCurrentPhaseFromPlan(plan) ??
				`Phase ${plan.current_phase ?? 1}`)
			: undefined;
		const planTaskIdOptions = plan
			? toTaskIdPlanContextOptions(
					collectPlanTaskIdContextFromPhases(plan.phases),
				)
			: {};
		const taskIdResolution = resolveTaskId(argsRecord, {
			policy: 'attribution',
			...planTaskIdOptions,
		});
		const taskId =
			taskIdResolution.status === 'resolved'
				? taskIdResolution.taskId
				: undefined;

		const { entries, trace_id } = await injectForDelegate({
			directory,
			agent: targetAgent,
			expectedTools: defaultExpectedToolsForAgent(targetAgent),
			taskTitle: promptRaw.slice(0, 800),
			taskId,
			sessionId,
			phase: phaseLabel,
			config,
		});

		const prefixParts: string[] = [];
		// (#1849 RC-4) Thread the retrieval trace_id into the rendered block so the
		// delegate can cite it and the ack-collector recovers the original trace.
		// Issue #2045: the block obeys the configured injection ceiling with the
		// same hard cap the transform path applies (Task/lane parity).
		const delegateBlock = buildDelegateDirectiveBlock(
			entries,
			config,
			trace_id,
			Math.min(
				config.inject_char_budget ?? 2_000,
				DELEGATE_INJECT_HARD_CHAR_CAP,
			),
		);
		if (delegateBlock) prefixParts.push(delegateBlock);

		// Reviewer delegations also receive the per-phase "directives to verify"
		// block so the reviewer can emit a DIRECTIVE_COMPLIANCE verdict per ID
		// (Change 2, Task 2.1). Sourced from this phase's retrieved events.
		if (stripKnownSwarmPrefix(targetAgent).toLowerCase() === 'reviewer') {
			const toVerify = await readPhaseDirectivesToVerify(directory, phaseLabel);
			const complianceBlock = buildDirectiveComplianceBlock(toVerify);
			if (complianceBlock) prefixParts.push(complianceBlock);
		}

		if (prefixParts.length === 0) {
			recordDelegateInjectionSkip(
				directory,
				'delegate_no_directives_to_inject',
				{ agent: targetAgent, sessionId },
			);
			return debugSkip('no_directives_to_inject', {
				target_agent: targetAgent,
			});
		}
		argsRecord.prompt = `${prefixParts.join('\n\n')}\n\n${promptRaw}`;
		log('[delegate-directive-injection] injected', {
			caller_agent: callerAgent,
			caller_role: callerRole,
			target_agent: targetAgent,
			count: entries.length,
			session_id: sessionId,
		});
		return entries.length;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		recordDelegateInjectionSkip(directory, 'delegate_injection_error', {
			sessionId,
			detail: { message },
		});
		warn(`[delegate-directive-injection] non-fatal: ${message}`);
		return 0;
	}
}
