/**
 * Full-Auto Intercept Hook
 *
 * Intercepts architect messages in full-auto mode and triggers autonomous oversight
 * when the architect outputs escalation patterns (questions, phase completion prompts).
 *
 * This hook runs as a chat.message transform — it inspects the architect's output
 * and injects the critic's autonomous oversight response when escalation is detected.
 */

import * as fs from 'node:fs';

import { createCriticAutonomousOversightAgent } from '../agents/critic';
import type { PluginConfig } from '../config';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	type ParsedCriticResponse,
	parseCriticResponseFields,
} from '../full-auto/critic-response-parser';
import {
	type FullAutoOversightEvent as V2FullAutoOversightEvent,
	writeFullAutoOversightEvent as v2WriteOversightEvent,
	writeFullAutoOversightEvidence as v2WriteOversightEvidence,
} from '../full-auto/oversight';
import {
	loadFullAutoRunState,
	pauseFullAutoRun,
	recordFullAutoOversight,
	terminateFullAutoRun,
} from '../full-auto/state';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { _internals as stateInternals } from '../state.js';
import { telemetry } from '../telemetry';
import * as logger from '../utils/logger';
import { validateSwarmPath } from './utils';

// Pattern for detecting end-of-sentence question marks (not mid-sentence like "v1?")
// Matches "?" at end of text or followed by whitespace/newline
const END_OF_SENTENCE_QUESTION_PATTERN = /\?\s*$/;

// Patterns that indicate phase completion (architect wants to finish a phase)
const PHASE_COMPLETION_PATTERNS = [
	/Ready for Phase (?:\d+|\[?N\+1\]?)\??/i,
	/phase.{0,20}(?:complete|finish|done|wrap)/i,
	/move(?:d?)?\s+(?:on\s+)?to\s+(?:the\s+)?(?:next\s+)?phase/i,
	/(?:proceed|move)\s+to\s+the\s+next\s+phase/i,
	/what would you like.{0,20}(?:next|do next)/i,
];

// Patterns that indicate the architect is asking a question / awaiting direction
// These are NOT phase completion — they are question-type escalations
const QUESTION_ESCALATION_PATTERNS = [
	/escalat/i,
	/What would you like/i,
	/Should I proceed/i,
	/Do you want/i,
	/Shall I/i,
	/Would you like/i,
	/Can I proceed/i,
	/May I proceed/i,
	/Awaiting (?:your |)(?:approval|confirmation|input|decision|direction)/i,
	/Please (?:confirm|approve|advise|let me know)/i,
	/How (?:would you like|should I)/i,
];

// Patterns that indicate mid-sentence question marks (code, version numbers, etc.)
// These should NOT trigger escalation
const MID_SENTENCE_QUESTION_PATTERNS = [
	/\b(v\d+\?)/i, // version numbers like "v1?"
	/\b(v\d+\.\d+\?)/i, // version numbers like "v1.2?"
	/\bAPI\?/i, // short acronyms
	/\bOK\?/i, // short confirmations
	/\b\d+\?\d+/, // numbers with question marks between them
];

interface MessageWithParts {
	info: {
		role: string;
		agent?: string;
		sessionID?: string;
		[key: string]: unknown;
	};
	parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Computes a simple hash of a string for deadlock detection.
 * Uses a basic DJB2-style hash for determinism across sessions.
 */
function hashString(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) + hash + str.charCodeAt(i);
		hash = hash & hash; // Convert to 32bit integer
	}
	return Math.abs(hash).toString(36);
}

/**
 * Checks if a question mark is mid-sentence (code, version number, etc.)
 * Returns true if the question mark should NOT trigger escalation.
 */
function isMidSentenceQuestion(text: string): boolean {
	return MID_SENTENCE_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Resolves the oversight agent name for the current swarm.
 *
 * Derives the oversight agent name directly from the original architect agent string
 * and the canonical stripped base role. Preserves original separator/prefix bytes.
 *
 * - undefined/empty architect agent -> 'critic_oversight'
 * - 'architect' -> 'critic_oversight'
 * - '<prefix><sep>architect' -> '<prefix><sep>critic_oversight'
 * - Arbitrary/custom prefixes work: 'teamalpha_architect' -> 'teamalpha_critic_oversight'
 */
function resolveOversightAgentName(
	architectAgentName: string | undefined,
): string {
	// Handle undefined or empty input
	if (!architectAgentName) {
		return 'critic_oversight';
	}

	const stripped = stripKnownSwarmPrefix(architectAgentName);

	// If stripped base role is not 'architect', fall back to default
	if (stripped !== 'architect') {
		return 'critic_oversight';
	}

	// The base role is 'architect' — remove the trailing 'architect' (case-insensitive)
	// from the original and append 'critic_oversight'. This preserves the original
	// separator/prefix bytes.
	// e.g., 'teamalpha_architect' -> 'teamalpha_critic_oversight'
	// e.g., 'team-alpha_architect' -> 'team-alpha_critic_oversight'
	const baseRole = 'architect';
	const lastIndex = architectAgentName.toLowerCase().lastIndexOf(baseRole);
	if (lastIndex <= 0) {
		// Shouldn't happen if stripped === 'architect', but guard defensively
		return 'critic_oversight';
	}

	// Take everything before 'architect' and append 'critic_oversight'
	const prefix = architectAgentName.slice(0, lastIndex);
	return `${prefix}critic_oversight`;
}

/**
 * Checks if the architect's message contains an escalation pattern.
 * Returns the detected pattern type or null if no escalation detected.
 */
function detectEscalation(
	text: string,
): 'phase_completion' | 'question' | null {
	// Check for phase completion patterns first (highest priority)
	for (const pattern of PHASE_COMPLETION_PATTERNS) {
		if (pattern.test(text)) {
			return 'phase_completion';
		}
	}

	// Check for question-type escalation patterns (architect asking for direction)
	for (const pattern of QUESTION_ESCALATION_PATTERNS) {
		if (pattern.test(text)) {
			return 'question';
		}
	}

	// Check for end-of-sentence question mark
	if (END_OF_SENTENCE_QUESTION_PATTERN.test(text)) {
		// Make sure it's not a mid-sentence question
		if (!isMidSentenceQuestion(text)) {
			return 'question';
		}
	}

	return null;
}

/**
 * Extracts the full text content from a message's parts.
 */
function extractMessageText(message: MessageWithParts): string {
	if (!message?.parts) return '';
	const textParts = message.parts.filter((p) => p?.type === 'text' && p.text);
	return textParts.map((p) => p.text ?? '').join('\n');
}

/**
 * Event type for auto_oversight entries in events.jsonl.
 */
interface AutoOversightEvent {
	type: 'auto_oversight';
	timestamp: string;
	interaction_mode:
		| 'question_resolution'
		| 'plan_review'
		| 'task_completion'
		| 'phase_completion';
	architect_output: string;
	critic_verdict: string;
	critic_reasoning: string;
	evidence_checked: string[];
	interaction_count: number;
	deadlock_count: number;
}

/**
 * Result from critic dispatch — used to inject verdict into message stream.
 */
interface CriticDispatchResult extends ParsedCriticResponse {}

/**
 * Parses the critic's structured text response into a CriticDispatchResult.
 * The critic response format is:
 *   VERDICT: APPROVED | NEEDS_REVISION | ...
 *   REASONING: [text with possible multi-line content]
 *   EVIDENCE_CHECKED: [list]
 *   ANTI_PATTERNS_DETECTED: [list or "none"]
 *   ESCALATION_NEEDED: YES | NO
 */
export function parseCriticResponse(rawResponse: string): CriticDispatchResult {
	return parseCriticResponseFields(rawResponse, {
		onUnknownVerdict: (value) => {
			logger.warn(
				`[full-auto-intercept] Unknown verdict '${value}' — defaulting to NEEDS_REVISION`,
			);
		},
	});
}

/**
 * Maps escalation type to interaction mode.
 */
function escalationTypeToInteractionMode(
	escalationType: 'phase_completion' | 'question',
): AutoOversightEvent['interaction_mode'] {
	return escalationType === 'phase_completion'
		? 'phase_completion'
		: 'question_resolution';
}

/**
 * Writes an auto_oversight event to .swarm/events.jsonl.
 * Follows the same pattern as phase-complete.ts: lock acquisition + validateSwarmPath + appendFileSync.
 */
async function writeAutoOversightEvent(
	directory: string,
	architectOutput: string,
	criticVerdict: string,
	criticReasoning: string,
	evidenceChecked: string[],
	interactionCount: number,
	deadlockCount: number,
	escalationType: 'phase_completion' | 'question',
): Promise<void> {
	const event: AutoOversightEvent = {
		type: 'auto_oversight',
		timestamp: new Date().toISOString(),
		interaction_mode: escalationTypeToInteractionMode(escalationType),
		architect_output: architectOutput,
		critic_verdict: criticVerdict,
		critic_reasoning: criticReasoning,
		evidence_checked: evidenceChecked,
		interaction_count: interactionCount,
		deadlock_count: deadlockCount,
	};

	const lockTaskId = `auto-oversight-${Date.now()}`;
	const eventsFilePath = 'events.jsonl';
	const dir = directory;

	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>> | undefined;
	try {
		lockResult = await tryAcquireLock(
			dir,
			eventsFilePath,
			'auto-oversight',
			lockTaskId,
		);
	} catch (error) {
		logger.warn(
			`[full-auto-intercept] Warning: failed to acquire lock for auto_oversight event: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!lockResult?.acquired) {
		logger.warn(
			`[full-auto-intercept] Warning: could not acquire lock for events.jsonl write — proceeding without lock`,
		);
	}
	try {
		const eventsPath = validateSwarmPath(dir, 'events.jsonl');
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
	} catch (writeError) {
		logger.error(
			`[full-auto-intercept] Failed to write auto_oversight event: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
		);
		throw writeError;
	} finally {
		if (lockResult?.acquired && lockResult.lock._release) {
			try {
				await lockResult.lock._release();
			} catch (releaseError) {
				logger.error(
					`[full-auto-intercept] Lock release failed:`,
					releaseError,
				);
			}
		}
	}
}

/**
 * Injects the critic's verdict as an assistant message after the architect's message.
 * This makes the verdict visible in the chat without modifying the architect's output.
 *
 * Verdict handling:
 * - ANSWER: injects critic's reasoning as the assistant's answer
 * - ESCALATE_TO_HUMAN: triggers escalation (handled separately)
 * - APPROVED / NEEDS_REVISION / REJECTED / BLOCKED / REPHRASE: injects verdict message
 */
export function injectVerdictIntoMessages(
	messages: MessageWithParts[],
	architectIndex: number,
	criticResult: CriticDispatchResult,
	escalationType: 'phase_completion' | 'question',
	oversightAgentName: string,
): void {
	// Handle ESCALATE_TO_HUMAN — trigger escalation but still inject the verdict
	if (
		criticResult.escalationNeeded ||
		criticResult.verdict === 'ESCALATE_TO_HUMAN'
	) {
		const verdictMessage: MessageWithParts = {
			info: {
				role: 'assistant',
				agent: oversightAgentName,
			},
			parts: [
				{
					type: 'text',
					text: `[FULL-AUTO OVERSIGHT — ESCALATE_TO_HUMAN]\n\nCritic reasoning: ${criticResult.reasoning}\n\nThis question requires human judgment. The swarm has been paused for human review.`,
				},
			],
		};
		messages.splice(architectIndex + 1, 0, verdictMessage);
		return;
	}

	// Handle ANSWER verdict — inject critic's answer with continuation instruction
	if (criticResult.verdict === 'ANSWER') {
		const verdictMessage: MessageWithParts = {
			info: {
				role: 'assistant',
				agent: oversightAgentName,
			},
			parts: [
				{
					type: 'text',
					text: `[FULL-AUTO OVERSIGHT — ANSWER]\n\n${criticResult.reasoning}`,
				},
			],
		};
		messages.splice(architectIndex + 1, 0, verdictMessage);

		// Inject continuation instruction so the architect proceeds without stalling
		const continuationMessage: MessageWithParts = {
			info: {
				role: 'user',
				agent: oversightAgentName,
			},
			parts: [
				{
					type: 'text',
					text: '[FULL-AUTO CONTINUATION] The critic has answered your question. Incorporate the answer above and continue executing the current plan. Do not ask follow-up questions about this answer — proceed with implementation.',
				},
			],
		};
		messages.splice(architectIndex + 2, 0, continuationMessage);
		return;
	}

	// Handle APPROVED / NEEDS_REVISION / REJECTED / BLOCKED / REPHRASE
	const verdictEmoji =
		criticResult.verdict === 'APPROVED'
			? '✅'
			: criticResult.verdict === 'NEEDS_REVISION'
				? '🔄'
				: criticResult.verdict === 'REJECTED'
					? '❌'
					: criticResult.verdict === 'BLOCKED'
						? '🚫'
						: '💬';

	const verdictMessage: MessageWithParts = {
		info: {
			role: 'assistant',
			agent: oversightAgentName,
		},
		parts: [
			{
				type: 'text',
				text: `[FULL-AUTO OVERSIGHT] ${verdictEmoji} **${criticResult.verdict}**\n\nCritic reasoning: ${criticResult.reasoning}`,
			},
		],
	};
	messages.splice(architectIndex + 1, 0, verdictMessage);

	// For APPROVED and phase_completion: inject continuation to advance to next phase
	if (
		criticResult.verdict === 'APPROVED' &&
		escalationType === 'phase_completion'
	) {
		const continuationMessage: MessageWithParts = {
			info: {
				role: 'user',
				agent: oversightAgentName,
			},
			parts: [
				{
					type: 'text',
					text: '[FULL-AUTO CONTINUATION] Phase approved by autonomous oversight. Call `phase_complete` now to finalize this phase, then proceed to the next phase in the plan. Do not wait for further human input.',
				},
			],
		};
		messages.splice(architectIndex + 2, 0, continuationMessage);
	} else if (criticResult.verdict === 'APPROVED') {
		const continuationMessage: MessageWithParts = {
			info: {
				role: 'user',
				agent: oversightAgentName,
			},
			parts: [
				{
					type: 'text',
					text: '[FULL-AUTO CONTINUATION] Approved by autonomous oversight. Continue executing the current task and plan. Do not wait for further human input.',
				},
			],
		};
		messages.splice(architectIndex + 2, 0, continuationMessage);
	}
}

/**
 * Handles critic dispatch and writes the auto_oversight event after the critic responds.
 *
 * This function encapsulates the critic invocation and event writing flow.
 * The critic response is awaited before writing the event to events.jsonl.
 */
export async function dispatchCriticAndWriteEvent(
	directory: string,
	architectOutput: string,
	criticContext: string,
	criticModel: string,
	escalationType: 'phase_completion' | 'question',
	interactionCount: number,
	deadlockCount: number,
	oversightAgentName: string,
	// H4 fix: optional sessionID so the v2 mirror binds the verdict to the
	// correct architect session in multi-architect / multi-swarm setups.
	sessionID?: string,
): Promise<CriticDispatchResult> {
	const client = stateInternals.swarmState.opencodeClient;

	// If no client (e.g., in tests), fall back to PENDING
	if (!client) {
		logger.warn(
			'[full-auto-intercept] No opencodeClient — critic dispatch skipped (fallback to PENDING)',
		);
		const result: CriticDispatchResult = {
			verdict: 'PENDING',
			reasoning: 'No opencodeClient available — critic dispatch not possible',
			evidenceChecked: [],
			antiPatternsDetected: [],
			escalationNeeded: false,
			rawResponse: '',
		};
		await writeAutoOversightEvent(
			directory,
			architectOutput,
			result.verdict,
			result.reasoning,
			result.evidenceChecked,
			interactionCount,
			deadlockCount,
			escalationType,
		);
		return result;
	}

	const oversightAgent = createCriticAutonomousOversightAgent(
		criticModel,
		criticContext,
	);
	logger.log(
		`[full-auto-intercept] Dispatching critic: ${oversightAgent.name} using model ${criticModel}`,
	);

	let ephemeralSessionId: string | undefined;
	const promptController = new AbortController();

	// Best-effort cleanup — never throws.
	// Aborts any in-flight prompt before deleting the session so OpenCode
	// stops writing message rows before the session row is removed (prevents
	// FK constraint crashes).
	const cleanup = () => {
		promptController.abort();
		if (ephemeralSessionId) {
			const id = ephemeralSessionId;
			ephemeralSessionId = undefined;
			client.session.delete({ path: { id } }).catch(() => {});
		}
	};

	let criticResponse = '';
	try {
		// 1. Create ephemeral session scoped to project directory.
		// Bind to the calling session as parent so OpenCode treats this as
		// a child session and does not persist it as a new root in the TUI.
		const createResult = await client.session.create({
			...(sessionID
				? {
						body: { parentID: sessionID, title: 'full_auto_critic background' },
					}
				: {}),
			query: { directory },
		});
		if (!createResult.data) {
			throw new Error(
				`Failed to create critic session: ${JSON.stringify(createResult.error)}`,
			);
		}
		ephemeralSessionId = createResult.data.id;
		logger.log(
			`[full-auto-intercept] Created ephemeral session: ${ephemeralSessionId}`,
		);

		// 2. Prompt using the registered oversight agent (read-only tools)
		const promptResult = await client.session.prompt({
			path: { id: ephemeralSessionId },
			body: {
				agent: oversightAgentName,
				tools: { write: false, edit: false, patch: false },
				parts: [{ type: 'text', text: criticContext }],
			},
			signal: promptController.signal,
		});

		if (!promptResult.data) {
			throw new Error(
				`Critic LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
			);
		}

		// 3. Extract text parts from response
		const textParts = promptResult.data.parts.filter(
			(p): p is typeof p & { text: string } => p.type === 'text',
		);
		criticResponse = textParts.map((p) => p.text).join('\n');
		logger.log(
			`[full-auto-intercept] Critic response received (${criticResponse.length} chars)`,
		);

		// 3b. Handle empty response
		if (!criticResponse.trim()) {
			logger.warn(
				'[full-auto-intercept] Critic returned empty response — using fallback verdict',
			);
			criticResponse =
				'VERDICT: NEEDS_REVISION\nREASONING: Critic returned empty response\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: empty_response\nESCALATION_NEEDED: NO';
		}
	} finally {
		cleanup();
	}

	// 4. Parse the critic response
	let parsed: CriticDispatchResult;
	try {
		parsed = parseCriticResponse(criticResponse);
		logger.log(
			`[full-auto-intercept] Critic verdict: ${parsed.verdict} | escalation: ${parsed.escalationNeeded}`,
		);
	} catch (parseError) {
		logger.error(
			`[full-auto-intercept] Failed to parse critic response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
		);
		parsed = {
			verdict: 'NEEDS_REVISION',
			reasoning:
				'Critic response parsing failed — defaulting to NEEDS_REVISION',
			evidenceChecked: [],
			antiPatternsDetected: [],
			escalationNeeded: false,
			rawResponse: criticResponse,
		};
	}

	// 5. Write the auto_oversight event AFTER the critic responds.
	// Note: if this throws (e.g. disk error), the v2 mirror step below is skipped,
	// meaning phase-approval evidence coherence depends on the write succeeding.
	await writeAutoOversightEvent(
		directory,
		architectOutput,
		parsed.verdict,
		parsed.reasoning,
		parsed.evidenceChecked,
		interactionCount,
		deadlockCount,
		escalationType,
	);

	// v2: Mirror the verdict into the shared oversight pipeline so that phase
	// approval evidence and durable run-state stay coherent with reactive
	// intercept verdicts. Best-effort — never throw.
	try {
		await mirrorReactiveVerdictToV2({
			directory,
			parsed,
			architectOutput,
			escalationType,
			oversightAgentName,
			criticModel,
			sessionID,
		});
	} catch (mirrorError) {
		logger.error(
			`[full-auto-intercept] v2 mirror failed: ${mirrorError instanceof Error ? mirrorError.message : String(mirrorError)}`,
		);
	}

	return parsed;
}

/**
 * Creates the full-auto intercept hook factory.
 *
 * This hook intercepts architect messages in full-auto mode and triggers
 * autonomous oversight when escalation patterns are detected.
 *
 * @param config - Plugin configuration containing full_auto settings
 * @param directory - Working directory from plugin init context
 * @returns Hook object with messagesTransform function
 */
export function createFullAutoInterceptHook(
	config: PluginConfig,
	directory: string,
): {
	messagesTransform: (
		input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	) => Promise<void>;
} {
	// Get full-auto config (with defaults)
	const fullAutoConfig = config.full_auto ?? {
		enabled: false,
		max_interactions_per_phase: 50,
		deadlock_threshold: 3,
		escalation_mode: 'pause',
	};

	// First-class toggle: always armed. The per-invocation
	// `hasActiveFullAuto(sessionID)` check below is the runtime gate. Note:
	// for messages without a sessionID, hasActiveFullAuto falls back to
	// "any session has full-auto on" (deliberate v1 single-session behavior,
	// covered by the regression suite) — so this gate is the in-memory
	// session flag, not the durable run state used by the v2 hooks.

	const deadlockThreshold = fullAutoConfig.deadlock_threshold ?? 3;
	const maxInteractions = fullAutoConfig.max_interactions_per_phase ?? 50;
	const escalationMode = fullAutoConfig.escalation_mode ?? 'pause';

	/**
	 * Main messages transform hook.
	 * Inspects architect output and triggers autonomous oversight when escalation detected.
	 */
	const messagesTransform = async (
		_input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	): Promise<void> => {
		const messages = output.messages;
		if (!messages || messages.length === 0) return;

		// Find the last architect message (user role = architect is the active agent)
		// In the chat.message transform, architect outputs appear as user role messages
		let lastArchitectMessageIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.info?.role === 'user') {
				// Check if this is the architect (agent could be undefined for main session)
				const agent = msg.info?.agent;
				const strippedAgent = agent ? stripKnownSwarmPrefix(agent) : undefined;
				// Only process if this is the architect (explicit 'architect' or undefined/main session)
				if (!agent || strippedAgent === 'architect') {
					lastArchitectMessageIndex = i;
					break;
				}
			}
		}

		if (lastArchitectMessageIndex === -1) return;

		const architectMessage = messages[lastArchitectMessageIndex];
		const architectText = extractMessageText(architectMessage);

		if (!architectText) return;

		// Get session ID for state tracking
		const sessionID = architectMessage.info?.sessionID;

		// Check if full-auto is active for this session
		if (!stateInternals.hasActiveFullAuto(sessionID)) return;

		// Get or create session state for tracking
		let session: ReturnType<typeof stateInternals.ensureAgentSession> | null =
			null;
		if (sessionID) {
			// Only import and use ensureAgentSession if we have a sessionID
			session = stateInternals.ensureAgentSession(sessionID);
		}

		// Check interaction limit — escalate if threshold reached
		if (session) {
			const interactionCount = session.fullAutoInteractionCount ?? 0;
			if (interactionCount >= maxInteractions) {
				const escalated = await handleEscalation(
					directory,
					'interaction_limit',
					sessionID,
					architectText,
					interactionCount,
					session.fullAutoDeadlockCount ?? 0,
					escalationMode,
				);
				if (escalated) return;
			}
		}

		// Detect escalation
		const escalationType = detectEscalation(architectText);
		if (!escalationType) return;

		// Track interaction
		if (session) {
			session.fullAutoInteractionCount =
				(session.fullAutoInteractionCount ?? 0) + 1;
		}

		// Deadlock detection: hash the question and compare
		if (escalationType === 'question') {
			const questionHash = hashString(architectText.trim());

			if (session) {
				const lastQuestionHash = session.fullAutoLastQuestionHash;
				if (lastQuestionHash === questionHash) {
					// Same question detected — increment deadlock count
					session.fullAutoDeadlockCount =
						(session.fullAutoDeadlockCount ?? 0) + 1;
					logger.warn(
						`[full-auto-intercept] Potential deadlock detected (count: ${session.fullAutoDeadlockCount}/${deadlockThreshold}) — identical question repeated`,
					);

					if (session.fullAutoDeadlockCount >= deadlockThreshold) {
						const escalated = await handleEscalation(
							directory,
							'deadlock',
							sessionID,
							architectText,
							session.fullAutoInteractionCount ?? 0,
							session.fullAutoDeadlockCount,
							escalationMode,
						);
						if (escalated) return;
					}
				} else {
					// Different question — reset deadlock count
					session.fullAutoDeadlockCount = 0;
				}
				session.fullAutoLastQuestionHash = questionHash;
			}
		}

		// Trigger autonomous oversight
		logger.log(
			`[full-auto-intercept] Escalation detected (${escalationType}) — triggering autonomous oversight`,
		);

		// Build the critic agent context
		const criticContext = buildCriticContext(architectText, escalationType);

		// Get the critic model (from config or default)
		const criticModel =
			fullAutoConfig.critic_model ?? 'claude-sonnet-4-20250514';

		// Create the oversight agent
		const oversightAgent = createCriticAutonomousOversightAgent(
			criticModel,
			criticContext,
		);

		// Resolve the oversight agent name for the current swarm
		const architectAgent = architectMessage.info?.agent;
		const resolvedOversightAgentName =
			resolveOversightAgentName(architectAgent);

		// Defensive validation: ensure the resolved name is non-empty and sensible
		// before using it for dispatch. If somehow it's empty (shouldn't happen with
		// current logic, but guard in case), fall back to 'critic_oversight'.
		const dispatchAgentName =
			resolvedOversightAgentName && resolvedOversightAgentName.length > 0
				? resolvedOversightAgentName
				: 'critic_oversight';

		// Log the oversight agent that was created (for debugging)
		logger.log(
			`[full-auto-intercept] Created autonomous oversight agent: ${oversightAgent.name} using model ${criticModel} (dispatch as: ${dispatchAgentName})`,
		);

		// Dispatch the critic and write event after response
		const criticResult = await dispatchCriticAndWriteEvent(
			directory,
			architectText,
			criticContext,
			criticModel,
			escalationType,
			session?.fullAutoInteractionCount ?? 0,
			session?.fullAutoDeadlockCount ?? 0,
			dispatchAgentName,
			sessionID,
		);

		// Inject verdict into message stream
		injectVerdictIntoMessages(
			messages,
			lastArchitectMessageIndex,
			criticResult,
			escalationType,
			dispatchAgentName,
		);
	};

	return {
		messagesTransform,
	};
}

/**
 * Builds additional context to append to the autonomous oversight prompt.
 * This provides the architect's question/output for the critic to evaluate.
 */
function buildCriticContext(
	architectOutput: string,
	escalationType: 'phase_completion' | 'question',
): string {
	const contextHeader =
		escalationType === 'phase_completion'
			? '## ARCHITECT PHASE COMPLETION REQUEST\n\nThe architect has signaled phase completion and is awaiting oversight approval to proceed.'
			: '## ARCHITECT QUESTION\n\nThe architect has asked a question and is awaiting an autonomous answer or escalation.';

	const truncatedOutput =
		architectOutput.length > 2000
			? `${architectOutput.slice(0, 2000)}\n... [truncated]`
			: architectOutput;

	return `${contextHeader}

### ARCHITECT OUTPUT:
${truncatedOutput}

### YOUR TASK:
Evaluate the architect's output and provide a response. If this is a question, answer it directly if you have sufficient information. If this is a phase completion, verify all tasks are complete and provide APPROVED or NEEDS_REVISION.

Remember: You are the sole quality gate. Default posture is REJECT unless you have positive evidence of correctness.`;
}

/**
 * Escalation reasons for telemetry and reporting.
 */
type EscalationReason = 'interaction_limit' | 'deadlock' | 'ESCALATE_TO_HUMAN';

/**
 * Writes the escalation report to .swarm/escalation-report.md.
 * Only writes under the validated workspace directory.
 */
async function writeEscalationReport(
	directory: string,
	reason: EscalationReason,
	architectOutput: string,
	interactionCount: number,
	deadlockCount: number,
	phase?: number,
): Promise<void> {
	try {
		const reportPath = validateSwarmPath(directory, 'escalation-report.md');

		// Load current phase from plan.json if not provided
		let currentPhase = phase;
		if (currentPhase === undefined) {
			try {
				const planPath = validateSwarmPath(directory, 'plan.json');
				const planContent = fs.readFileSync(planPath, 'utf-8');
				const plan = JSON.parse(planContent);
				// Find the highest-numbered phase that is not complete
				const incompletePhases = plan.phases
					.filter((p: { status?: string }) => p.status !== 'complete')
					.sort((a: { id: number }, b: { id: number }) => b.id - a.id);
				currentPhase = incompletePhases[0]?.id;
			} catch {
				// plan.json not available - leave phase undefined
			}
		}

		const timestamp = new Date().toISOString();
		const reasonLabels: Record<EscalationReason, string> = {
			interaction_limit: 'Interaction Limit Exceeded',
			deadlock: 'Deadlock Threshold Exceeded',
			ESCALATE_TO_HUMAN: 'Critic Response: ESCALATE_TO_HUMAN',
		};

		const reportContent = `# Full-Auto Escalation Report

## Timestamp
${timestamp}

## Reason for Escalation
${reasonLabels[reason]}

## Architect Output That Triggered Escalation
\`\`\`
${architectOutput.slice(0, 4000)}
${architectOutput.length > 4000 ? '\n... [output truncated]' : ''}
\`\`\`

## FullAuto State at Time of Escalation
- **Interaction Count**: ${interactionCount}
- **Deadlock Count**: ${deadlockCount}

## Current Phase and Plan Context
- **Current Phase**: ${currentPhase !== undefined ? `Phase ${currentPhase}` : 'Unknown'}
${currentPhase !== undefined ? `- **Phase Status**: Pending completion` : ''}

## Resolution
This escalation requires human intervention. The swarm has been paused.
Please review the architect's output above and provide guidance.
`;

		fs.writeFileSync(reportPath, reportContent, 'utf-8');
		logger.log(
			`[full-auto-intercept] Escalation report written to: ${reportPath}`,
		);
	} catch (error) {
		logger.error(
			`[full-auto-intercept] Failed to write escalation report:`,
			error instanceof Error ? error.message : String(error),
		);
	}
}

/**
 * Handles escalation based on the configured escalation mode.
 * Returns true if escalation was triggered (and execution should stop).
 */
async function handleEscalation(
	directory: string,
	reason: EscalationReason,
	sessionID: string | undefined,
	architectOutput: string,
	interactionCount: number,
	deadlockCount: number,
	escalationMode: 'pause' | 'terminate',
	phase?: number,
): Promise<boolean> {
	// Emit telemetry event
	telemetry.autoOversightEscalation(
		sessionID ?? 'unknown',
		reason,
		interactionCount,
		deadlockCount,
		phase,
	);

	// Write escalation report
	await writeEscalationReport(
		directory,
		reason,
		architectOutput,
		interactionCount,
		deadlockCount,
		phase,
	);

	if (escalationMode === 'terminate') {
		logger.error(
			`[full-auto-intercept] ESCALATION (terminate mode) — reason: ${reason}, session: ${sessionID}`,
		);
		// State-based termination (v2 pattern): mark the run as terminated in
		// durable state so subsequent tool calls are blocked by the permission
		// hook.  Do NOT use process.exit(1) — that kills the entire OpenCode
		// host process, violating Invariant #1 (fast, bounded, fail-open).
		if (sessionID) {
			terminateFullAutoRun(directory, sessionID, reason);
		}
		return true;
	}

	// In pause mode, return true to signal that escalation was triggered
	// The message will still go through to the user, but critic dispatch should be skipped
	logger.warn(
		`[full-auto-intercept] ESCALATION (pause mode) — reason: ${reason}, session: ${sessionID}`,
	);
	return true;
}

// ---------------------------------------------------------------------------
// v2 mirror — write a full_auto_oversight event/evidence record alongside the
// legacy auto_oversight event when reactive intercept fires. The mirror is a
// best-effort augmentation: failures must not affect legacy behavior.
// ---------------------------------------------------------------------------

let reactiveOversightSequence = 0;

interface MirrorParams {
	directory: string;
	parsed: CriticDispatchResult;
	architectOutput: string;
	escalationType: 'phase_completion' | 'question';
	oversightAgentName: string;
	criticModel: string;
	sessionID?: string;
}

async function mirrorReactiveVerdictToV2(params: MirrorParams): Promise<void> {
	reactiveOversightSequence += 1;
	const triggerSource: V2FullAutoOversightEvent['trigger_source'] =
		params.escalationType === 'phase_completion'
			? 'phase_boundary'
			: 'text_pattern';

	// H4 fix: prefer the actual sessionID propagated from the message
	// transform. Fall back to walking the persisted state ONLY when the
	// caller did not supply one — which happens for legacy direct callers
	// of `dispatchCriticAndWriteEvent` that were written before sessionID
	// was threaded through. The mirror only fires when we end up with a
	// session that has a durable RUNNING record; otherwise it is a no-op
	// so the legacy `auto_oversight` event remains the canonical record.
	let sessionID = '';
	let phase: number | undefined;
	let planID: string | undefined;
	try {
		const filePath = validateSwarmPath(
			params.directory,
			'full-auto-state.json',
		);
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, 'utf-8');
			const persisted = JSON.parse(raw) as {
				sessions?: Record<
					string,
					{
						status?: string;
						sessionID?: string;
						currentPhase?: number;
						planID?: string;
					}
				>;
			};
			if (persisted.sessions) {
				const callerSid = params.sessionID;
				if (callerSid && persisted.sessions[callerSid]) {
					const rec = persisted.sessions[callerSid];
					if (rec.status === 'running') {
						sessionID = callerSid;
						phase = rec.currentPhase;
						planID = rec.planID;
					}
					// Caller's sessionID exists but is not running — drop the
					// binding so we don't write evidence to a paused/terminated
					// session. sessionID stays empty -> mirror skips below.
				} else if (!callerSid) {
					// Legacy callers that did not thread sessionID — fall back to
					// the first running record. Multi-architect runs are imperfect
					// here but documented as a known limitation.
					for (const sid of Object.keys(persisted.sessions)) {
						const rec = persisted.sessions[sid];
						if (rec?.status === 'running') {
							sessionID = sid;
							phase = rec.currentPhase;
							planID = rec.planID;
							break;
						}
					}
				}
			}
		}
	} catch {
		// No durable state — fall through; we'll skip the mirror below.
	}

	// Skip the mirror entirely when no durable v2 run is active. The legacy
	// auto_oversight event is the canonical record for v1 reactive intercept;
	// duplicating it as full_auto_oversight only adds value when there is a
	// durable run for phase_complete to consult.
	if (!sessionID) {
		return;
	}

	const decision: V2FullAutoOversightEvent['decision'] = (() => {
		if (
			params.parsed.escalationNeeded ||
			params.parsed.verdict === 'ESCALATE_TO_HUMAN'
		)
			return 'escalate_human';
		if (
			params.parsed.verdict === 'APPROVED' ||
			params.parsed.verdict === 'ANSWER'
		)
			return 'allow';
		if (params.parsed.verdict === 'BLOCKED') return 'pause';
		if (params.parsed.verdict === 'PENDING') return 'pending';
		return 'deny';
	})();

	const beforeStatus = sessionID
		? loadFullAutoRunState(params.directory, sessionID)?.status
		: undefined;

	const event: V2FullAutoOversightEvent = {
		type: 'full_auto_oversight',
		timestamp: new Date().toISOString(),
		session_id: sessionID,
		plan_id: planID,
		phase,
		trigger_source: triggerSource,
		trigger_reason: `reactive intercept (${params.escalationType})`,
		critic_agent: params.oversightAgentName,
		critic_model: params.criticModel,
		verdict: params.parsed.verdict,
		reasoning: params.parsed.reasoning,
		evidence_checked: params.parsed.evidenceChecked,
		anti_patterns_detected: params.parsed.antiPatternsDetected,
		escalation_needed: params.parsed.escalationNeeded,
		decision,
		full_auto_status_before: beforeStatus,
		full_auto_status_after: beforeStatus,
		oversight_sequence: reactiveOversightSequence,
	};

	// React to verdict on durable state.
	if (sessionID) {
		if (decision === 'pause') {
			pauseFullAutoRun(
				params.directory,
				sessionID,
				`reactive verdict ${params.parsed.verdict}`,
			);
			event.full_auto_status_after = 'paused';
		} else if (decision === 'escalate_human') {
			terminateFullAutoRun(
				params.directory,
				sessionID,
				'reactive ESCALATE_TO_HUMAN',
			);
			event.full_auto_status_after = 'terminated';
		}
		recordFullAutoOversight(
			params.directory,
			sessionID,
			params.parsed.verdict,
			`reactive ${params.escalationType}`,
		);
	}

	await v2WriteOversightEvent(params.directory, event);
	if (
		params.escalationType === 'phase_completion' &&
		params.parsed.verdict === 'APPROVED' &&
		typeof phase === 'number'
	) {
		await v2WriteOversightEvidence(params.directory, phase, event);
	}
}
