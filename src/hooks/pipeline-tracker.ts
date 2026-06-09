/**
 * Pipeline Tracker Hook
 *
 * Injects phase reminders into messages to keep the Architect on track.
 * Uses experimental.chat.messages.transform so it doesn't show in UI.
 *
 * Research: "LLMs Get Lost In Multi-Turn Conversation" shows ~40% compliance
 * drop after 2-3 turns without reminders.
 */

import type { PluginConfig } from '../config';
import { loadPlan } from '../plan/manager';
import { extractCurrentPhaseFromPlan } from './extractors';
import { safeHook } from './utils';

/**
 * Parse phase number from phase string like "Phase 4: Documentation & Release [IN PROGRESS]"
 * Returns null if parsing fails.
 */
function parsePhaseNumber(phaseString: string | null): number | null {
	if (!phaseString) return null;

	const match = phaseString.match(/^Phase (\d+):/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return null;
}

/**
 * Build dynamic phase reminder with compliance escalation based on phase number.
 * Counteracts temporal compliance decay discovered during field testing.
 */
export function buildPhaseReminder(phaseNumber: number | null): string {
	const phaseHeader = phaseNumber !== null ? ` (Phase ${phaseNumber})` : '';
	const complianceHeader =
		phaseNumber !== null
			? `COMPLIANCE CHECK (Phase ${phaseNumber}):`
			: 'COMPLIANCE CHECK:';

	return `<swarm_reminder>
⚠️ ARCHITECT WORKFLOW REMINDER${phaseHeader}:
1. ANALYZE → Identify domains, create initial spec
2. SME_CONSULTATION → Delegate to @sme (one domain per call, max 3 calls)
3. COLLATE → Synthesize SME outputs into unified spec
4. CODE → Delegate to @coder
5. QA_REVIEW → Delegate to @reviewer (specify CHECK dimensions)
6. TRIAGE → Review feedback: APPROVED | REVISION_NEEDED | BLOCKED
7. TEST → If approved, delegate to @test_engineer

DELEGATION RULES:
- SME: ONE domain per call (serial), max 3 per phase
- Reviewer: Specify CHECK dimensions relevant to the change
- Always wait for response before next delegation

${complianceHeader}
- Reviewer delegation is MANDATORY for every coder task.
- pre_check_batch is NOT a substitute for reviewer.
- Stage A (automated tools) + Stage B/Council (agent review) = BOTH required.
${
	phaseNumber !== null && phaseNumber >= 4
		? `\n⚠️ You are in Phase ${phaseNumber}. Compliance degrades with time. Do not skip reviewer or test_engineer.`
		: ''
}
</swarm_reminder>`;
}

interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
}

interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

/**
 * Creates the experimental.chat.messages.transform hook for pipeline tracking.
 * Only injects for the architect agent.
 */
export function createPipelineTrackerHook(
	config: PluginConfig,
	directory?: string,
) {
	const enabled = config.inject_phase_reminders !== false;

	if (!enabled) {
		return {};
	}

	return {
		'experimental.chat.messages.transform': safeHook(
			async (
				_input: Record<string, never>,
				output: { messages?: MessageWithParts[] },
			): Promise<void> => {
				const messages = output?.messages;
				if (!messages || messages.length === 0) return;

				// Find the last user message
				let lastUserMessageIndex = -1;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i]?.info?.role === 'user') {
						lastUserMessageIndex = i;
						break;
					}
				}

				if (lastUserMessageIndex === -1) return;

				const lastUserMessage = messages[lastUserMessageIndex];
				if (!lastUserMessage?.parts) return;

				// Only inject for architect (or if no agent specified = main session)
				const agent = lastUserMessage.info?.agent;
				if (agent && agent !== 'architect') return;

				// Find the first text part
				const textPartIndex = lastUserMessage.parts.findIndex(
					(p) => p?.type === 'text' && p.text !== undefined,
				);

				if (textPartIndex === -1) return;

				// Load plan and extract current phase for compliance escalation
				let phaseNumber: number | null = null;
				try {
					const plan = await loadPlan(directory!);
					if (plan) {
						const phaseString = extractCurrentPhaseFromPlan(plan);
						phaseNumber = parsePhaseNumber(phaseString);
					}
				} catch {
					// Fall back to base compliance text if plan loading fails
					phaseNumber = null;
				}

				// Generate dynamic reminder based on phase number
				const phaseReminder = buildPhaseReminder(phaseNumber);

				// Prepend the reminder to the existing text
				const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
				lastUserMessage.parts[textPartIndex].text =
					`${phaseReminder}\n\n---\n\n${originalText}`;
			},
		),
	};
}
