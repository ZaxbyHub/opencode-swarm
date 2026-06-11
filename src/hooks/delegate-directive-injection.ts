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
	DIRECTIVES_TO_VERIFY_TAG,
} from '../agents/reviewer-directive-compliance.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { loadPlan } from '../plan/manager.js';
import { warn } from '../utils/logger.js';
import { extractCurrentPhaseFromPlan } from './extractors.js';
import {
	buildDelegateDirectiveBlock,
	DELEGATE_DIRECTIVE_BLOCK_TAG,
	defaultExpectedToolsForAgent,
	injectForDelegate,
	isDelegatedAgent,
} from './knowledge-injector.js';
import type { KnowledgeConfig } from './knowledge-types.js';
import { readPhaseDirectivesToVerify } from './phase-directives.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';

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
	try {
		if (config.enabled === false) return 0;
		if (!isTaskTool(input.tool)) return 0;

		// Only the architect delegates. Restricting to architect callers prevents a
		// subagent from triggering nested delegate injection.
		const callerAgent = typeof input.agent === 'string' ? input.agent : '';
		if (!callerAgent || stripKnownSwarmPrefix(callerAgent) !== 'architect') {
			return 0;
		}

		const argsRecord =
			input.args && typeof input.args === 'object'
				? (input.args as Record<string, unknown>)
				: null;
		if (!argsRecord) return 0;
		const promptRaw = argsRecord.prompt;
		if (typeof promptRaw !== 'string') return 0;

		const parsed = parseDelegationArgs(input.args);
		if (!parsed) return 0;
		const targetAgent = parsed.targetAgent;
		if (!isDelegatedAgent(targetAgent)) return 0;

		// Idempotency: never inject a second directive or compliance block.
		if (
			promptRaw.includes(DELEGATE_DIRECTIVE_BLOCK_TAG) ||
			promptRaw.includes(DIRECTIVES_TO_VERIFY_TAG)
		) {
			return 0;
		}

		const sessionId =
			typeof input.sessionID === 'string' ? input.sessionID : undefined;

		// Resolve the plan phase label so the emitted delegate_inject event (and
		// thus the reviewer verdict loop + phase-complete gate) windows by phase.
		const plan = await loadPlan(directory).catch(() => null);
		const phaseLabel = plan
			? (extractCurrentPhaseFromPlan(plan) ??
				`Phase ${plan.current_phase ?? 1}`)
			: undefined;

		const { entries } = await injectForDelegate({
			directory,
			agent: targetAgent,
			expectedTools: defaultExpectedToolsForAgent(targetAgent),
			taskTitle: promptRaw.slice(0, 800),
			sessionId,
			phase: phaseLabel,
			config,
		});

		const prefixParts: string[] = [];
		const delegateBlock = buildDelegateDirectiveBlock(entries, config);
		if (delegateBlock) prefixParts.push(delegateBlock);

		// Reviewer delegations also receive the per-phase "directives to verify"
		// block so the reviewer can emit a DIRECTIVE_COMPLIANCE verdict per ID
		// (Change 2, Task 2.1). Sourced from this phase's retrieved events.
		if (stripKnownSwarmPrefix(targetAgent).toLowerCase() === 'reviewer') {
			const toVerify = await readPhaseDirectivesToVerify(directory, phaseLabel);
			const complianceBlock = buildDirectiveComplianceBlock(toVerify);
			if (complianceBlock) prefixParts.push(complianceBlock);
		}

		if (prefixParts.length === 0) return 0;
		argsRecord.prompt = `${prefixParts.join('\n\n')}\n\n${promptRaw}`;
		return entries.length;
	} catch (err) {
		warn(
			`[delegate-directive-injection] non-fatal: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return 0;
	}
}
