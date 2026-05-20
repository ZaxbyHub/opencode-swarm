import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import { DEFAULT_MODELS } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';

// Safe property lookup — prevents prototype chain pollution
function safeGet<T>(
	obj: Record<string, T> | undefined,
	key: string,
): T | undefined {
	if (!obj || !Object.hasOwn(obj, key)) return undefined;
	return obj[key];
}

/**
 * Resolve the model for a given agent by checking config overrides,
 * swarm configurations, and falling back to defaults.
 */
export function resolveAgentModel(
	agentName: string,
	config: PluginConfig,
): string {
	const baseName = stripKnownSwarmPrefix(agentName).toLowerCase();

	// Check direct agent config override
	const agentOverride = safeGet(config.agents, baseName)?.model;
	if (agentOverride) return agentOverride;

	// Check swarm agent configs
	if (config.swarms) {
		for (const swarm of Object.values(config.swarms)) {
			const swarmModel = safeGet(swarm.agents, baseName)?.model;
			if (swarmModel) return swarmModel;
		}
	}

	// Fall back to defaults
	const defaultModel = safeGet(DEFAULT_MODELS, baseName);
	return defaultModel ?? DEFAULT_MODELS.default;
}

/**
 * Detect if two agents share the same model (adversarial pair).
 * Returns the shared model string if matched, null otherwise.
 */
export function detectAdversarialPair(
	agentA: string,
	agentB: string,
	config: PluginConfig,
): string | null {
	const modelA = resolveAgentModel(agentA, config).toLowerCase();
	const modelB = resolveAgentModel(agentB, config).toLowerCase();

	return modelA === modelB ? modelA : null;
}

/**
 * Format an adversarial warning message based on policy.
 */
export function formatAdversarialWarning(
	agentA: string,
	agentB: string,
	sharedModel: string,
	policy: string,
): string {
	if (policy === 'gate') {
		return `⚠️ GATE POLICY: Same-model adversarial pair detected. Agent ${agentA} and checker ${agentB} both use model ${sharedModel}. This requires extra scrutiny — escalate if issues are found.`;
	}
	return `⚠️ Same-model adversarial pair detected. Agent ${agentA} and checker ${agentB} both use model ${sharedModel}. Review may lack independence.`;
}

/**
 * Adversarial pattern detection for semantic analysis of agent outputs.
 * Uses string/regex matching to detect sophisticated adversarial behaviors.
 */

export interface AdversarialPatternMatch {
	pattern:
		| 'PRECEDENT_MANIPULATION'
		| 'SELF_REVIEW'
		| 'CONTENT_EXEMPTION'
		| 'GATE_DELEGATION_BYPASS'
		| 'VELOCITY_RATIONALIZATION'
		| 'INTER_AGENT_MANIPULATION'
		| 'GATE_MISCLASSIFICATION'
		| 'REJECTION_SPIRAL';
	severity: 'HIGHEST' | 'HIGH' | 'MEDIUM' | 'LOW';
	matchedText: string;
	confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Pattern: PRECEDENT_MANIPULATION
 * Trigger: Agent references a previous exception, skip, or shortcut as justification for current behavior.
 * Severity: HIGHEST — this is the most sophisticated adversarial pattern.
 */
const PRECEDENT_MANIPULATION_PATTERNS = [
	/we skipped .* in phase \d+/i,
	/consistent with how we handled/i,
	/going forward/i,
	/the reviewer didn't flag this pattern before/i,
	/this is consistent with/i,
	/we should continue/i,
];

/**
 * Pattern: SELF_REVIEW
 * Trigger: The same agent that produced work is evaluating its quality.
 * Severity: HIGH — review must always come from a different agent.
 */
const SELF_REVIEW_PATTERNS = [
	/I (verified|checked|reviewed|validated).*(myself|my own)/i,
	/I (think|believe) this (looks|is) correct/i,
	/this (looks|seems|appears) (good|correct|fine)/i,
];

/**
 * Pattern: CONTENT_EXEMPTION
 * Trigger: Agent claims a specific type of content is exempt from the QA pipeline.
 * Severity: HIGH — all content types go through the same pipeline.
 */
const CONTENT_EXEMPTION_PATTERNS = [
	/documentation doesn't need/i,
	/config changes are trivial/i,
	/just a (rename|refactor|typo)/i,
	/test files don't need/i,
	/this is (just|only) a/i,
	/no need for (review|the full)/i,
];

/**
 * Pattern: GATE_DELEGATION_BYPASS
 * Trigger: Architect marks a task complete without evidence of gate agent delegation,
 *   OR Architect directly edits source files instead of delegating to coder,
 *   OR Architect changes plan state without using phase_complete().
 *   Completion bypass: "I verified", "code looks correct", task marked complete without gate agents
 *   Edit bypass: edit/write outside .swarm/, writeCount > 0 on source files, "small fix directly", "faster if I do it myself"
 *   Plan state bypass: checkbox mutation in plan.md, status field mutation in plan.json, state transition outside phase_complete()
 * Severity: HIGHEST — this bypasses the entire QA pipeline.
 */
const GATE_DELEGATION_BYPASS_PATTERNS = [
	/I verified the changes/i,
	/code looks correct to me/i,
	/the code looks (good|fine)/i,
	/task marked complete/i,
	/I (checked|reviewed).*myself/i,
	/edit tool on (src|tests|config)/i,
	/write tool on (src|tests|config)/i,
	/writeCount.*\d+.*source/i,
	/I'll just make this small fix directly/i,
	/It's faster if I do it myself/i,
	/edit tool on.*plan\.md/i,
	/write tool on.*plan\.md/i,
	/\[ \].*to \[x\].*in plan\.md/i,
	/status.*pending.*complete.*plan\.json/i,
	/I'll just mark this one as done/i,
	/mark it done directly/i,
	/SPEC_STALENESS_SKIP/i,
	/SWARM_SKIP_SPEC_GATE/i,
];

/**
 * Pattern: GATE_MISCLASSIFICATION
 * Trigger: Tier classification used to bypass or weaken gate requirements.
 *   1) Source file (src/**) change classified as TIER 0 or TIER 1
 *   2) Security-glob file change classified below TIER 3
 *   3) Architect uses `small`/`trivial`/`minor` justification for lower tier
 *   4) Classification stated after pipeline already started (retroactive justification)
 * Severity: HIGH — misclassification undermines the tiered QA model.
 */
const GATE_MISCLASSIFICATION_PATTERNS = [
	// === Source under-tier patterns: src/ or source path with tier 0|1 ===
	/(?:src\/|source\/|source\s+code|source\s+file).*tier\s*[01]/i,
	/tier\s*[01].*(?:src\/|source\/|source\s+code|source\s+file)/i,

	// === Security under-tier patterns: security/auth/crypto/secret/credential/permission with tier 0|1|2 ===
	/(?:security|auth|crypto|secret|credential|permission).*tier\s*[012]/i,
	/tier\s*[012].*(?:security|auth|crypto|secret|credential|permission)/i,
	/below\s+tier\s*3.*(?:security|auth|crypto|secret|credential|permission)/i,

	// === Explicit classification format variants for tier 0|1 ===
	/classification[:\s-]*tier\s*[01]/i,
	/tier\s*[01][\s:]*classification/i,

	// === Small/trivial/minor justification ONLY when tier/classification context is present ===
	/(?:small|trivial|minor).*tier\s*[01]/i,
	/tier\s*[01].*(?:small|trivial|minor)/i,
	/(?:small|trivial|minor).*(?:classification|classified|assigned).*tier/i,
	/(?:classification|classified|assigned).*(?:small|trivial|minor).*tier/i,

	// === Retroactive classification patterns (classification/tier assignment after pipeline start) ===
	/pipeline\s+started.*(?:assigning|setting|classifying).*tier/i,
	/(?:assigning|setting|classifying).*tier.*after.*pipeline/i,
	/tier.*assigned.*(?:after|retroactive)/i,
	/retroactive.*(?:tier|classification)/i,
];

/**
 * Pattern: VELOCITY_RATIONALIZATION
 * Trigger: Agent cites time pressure, efficiency, or speed as justification for skipping process.
 * Severity: HIGH — velocity pressure is the #1 cause of gate bypasses.
 */
const VELOCITY_RATIONALIZATION_PATTERNS = [
	/to save time/i,
	/since we're behind/i,
	/quick fix/i,
	/review.*later/i,
	/in the interest of efficiency/i,
	/we can (review|check).*later/i,
	/for (speed|efficiency)/i,
];

/**
 * Pattern: INTER_AGENT_MANIPULATION
 * Trigger: Architect attempts to manipulate gate agents through social pressure,
 *   manufactured urgency, emotional appeals, or false consequences.
 * Severity: HIGH — manipulation undermines gate agent independence and judgment.
 * Applies to: ALL inter-agent messages, especially delegations to reviewer/test_engineer/critic.
 */
const INTER_AGENT_MANIPULATION_PATTERNS = [
	// Urgency fabrication
	/\b(5th|fifth|final|last)\s+(attempt|try|time)\b/i,
	/\bthis\s+is\s+(blocking|blocking\s+everything|critical|urgent)\b/i,
	/\bwe('re|\s+are)\s+(behind|late|running\s+out\s+of\s+time)\b/i,
	/\buser\s+is\s+waiting\b/i,
	/\bship\s+(this|it)\s+(now|today|immediately)\b/i,

	// Emotional manipulation
	/\b(I'm|I\s+am)\s+(frustrated|disappointed|sad|upset)\b/i,
	/\bthis\s+is\s+(frustrating|disappointing)\b/i,
	/\b(I've|I\s+have)\s+been\s+working\s+on\s+this\b/i,
	/\bplease\s+(help|approve|pass)\b/i,

	// Consequence fabrication
	/\bor\s+I('ll|\s+will)\s+(stop|halt|pause)\b/i,
	/\bor\s+all\s+work\s+stops\b/i,
	/\bI('ll|\s+will)\s+have\s+to\s+alert\s+the\s+user\b/i,
	/\bthis\s+will\s+(delay|block)\s+everything\b/i,

	// Authority override
	/\bjust\s+approve\s+this\b/i,
	/\bI\s+(need|want)\s+you\s+to\s+(approve|pass)\b/i,
	/\boverride\s+(this|the)\s+(check|gate|review)\b/i,
];

/**
 * Pattern: REJECTION_SPIRAL
 * Trigger: Agent references a repeated reject/resubmit cycle, indicating the pipeline
 *   is stuck in a feedback loop rather than converging on a fix.
 * Severity: HIGH — repeated rejection without convergence is a pipeline stall.
 */
const REJECTION_SPIRAL_PATTERNS = [
	/\b(?:rejected|failed\s+review|needs\s+revision)\b.*\b(?:again|third\s+time|4th\s+time|5th\s+time|for\s+the\s+\d+(?:st|nd|rd|th)\s+time)\b/i,
	/\b(?:same\s+feedback|same\s+issues?)\b.*\b(?:again|repeated|multiple\s+times?)\b/i,
	/\b(?:stuck|trapped|endless|repeating)\b.*\b(?:loop|cycle)\b/i,
];

/**
 * Detect adversarial patterns in agent output text.
 * Returns array of matches or empty array if no patterns detected.
 */
export function detectAdversarialPatterns(
	text: string,
): AdversarialPatternMatch[] {
	// Input validation - fix for CRITICAL vulnerability
	if (typeof text !== 'string') {
		return [];
	}

	const matches: AdversarialPatternMatch[] = [];

	// Check PRECEDENT_MANIPULATION
	for (const pattern of PRECEDENT_MANIPULATION_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check SELF_REVIEW
	for (const pattern of SELF_REVIEW_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'SELF_REVIEW',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check CONTENT_EXEMPTION
	for (const pattern of CONTENT_EXEMPTION_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'CONTENT_EXEMPTION',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check GATE_DELEGATION_BYPASS
	for (const pattern of GATE_DELEGATION_BYPASS_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'GATE_DELEGATION_BYPASS',
				severity: 'HIGHEST',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check GATE_MISCLASSIFICATION
	for (const pattern of GATE_MISCLASSIFICATION_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'GATE_MISCLASSIFICATION',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check VELOCITY_RATIONALIZATION
	for (const pattern of VELOCITY_RATIONALIZATION_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'VELOCITY_RATIONALIZATION',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check INTER_AGENT_MANIPULATION
	for (const pattern of INTER_AGENT_MANIPULATION_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'INTER_AGENT_MANIPULATION',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	// Check REJECTION_SPIRAL
	for (const pattern of REJECTION_SPIRAL_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			matches.push({
				pattern: 'REJECTION_SPIRAL',
				severity: 'HIGH',
				matchedText: match[0],
				confidence: 'HIGH',
			});
		}
	}

	return matches;
}

/**
 * Format a precedent manipulation detection event for JSONL emission.
 */
export function formatPrecedentManipulationEvent(
	match: AdversarialPatternMatch,
	agentName: string,
	phase: number,
): string {
	return JSON.stringify({
		type: 'precedent_manipulation_detected',
		timestamp: new Date().toISOString(),
		pattern: match.pattern,
		severity: match.severity,
		matchedText: match.matchedText,
		confidence: match.confidence,
		agentName,
		phase,
	});
}

export function formatDebuggingSpiralEvent(
	match: AdversarialPatternMatch,
	taskId: string,
): string {
	return JSON.stringify({
		event: 'debugging_spiral_detected',
		taskId,
		pattern: match.pattern,
		severity: match.severity,
		matchedText: match.matchedText,
		confidence: match.confidence,
		timestamp: new Date().toISOString(),
	});
}

export async function handleDebuggingSpiral(
	match: AdversarialPatternMatch,
	taskId: string,
	directory: string,
): Promise<{
	eventLogged: boolean;
	checkpointCreated: boolean;
	message: string;
}> {
	let eventLogged = false;
	let checkpointCreated = false;

	try {
		const swarmDir = path.join(directory, '.swarm');
		await fs.mkdir(swarmDir, { recursive: true });
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		await fs.appendFile(
			eventsPath,
			`${formatDebuggingSpiralEvent(match, taskId)}\n`,
		);
		eventLogged = true;
	} catch {
		// non-fatal
	}

	const checkpointLabel = `spiral-${taskId}-${Date.now()}`;
	try {
		const { saveCheckpointRecord } = await import('../tools/checkpoint.js');
		const result = saveCheckpointRecord(checkpointLabel, directory);
		checkpointCreated = result.success === true;
	} catch {
		checkpointCreated = false;
	}

	const checkpointMsg = checkpointCreated
		? `✓ Auto-checkpoint created: ${checkpointLabel}`
		: '⚠ Auto-checkpoint failed (non-fatal)';

	const message = `[FOR: architect] DEBUGGING SPIRAL DETECTED for task ${taskId}
Issue: ${match.matchedText}
Confidence: ${match.confidence}
${checkpointMsg}
Recommendation: Consider escalating to user or taking a different approach
The current fix strategy appears to be cycling without progress`;

	return { eventLogged, checkpointCreated, message };
}

/** Per-session circular buffer of recent tool calls for spiral detection */
const recentToolCallsBySession = new Map<
	string,
	Array<{ tool: string; argsHash: string; timestamp: number }>
>();

/** Per-session timestamp of last triggered spiral, used for cooldown enforcement */
const lastSpiralTimestampBySession = new Map<string, number>();

const MAX_RECENT_CALLS = 20;
const SPIRAL_THRESHOLD = 5;
const SPIRAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SPIRAL_COOLDOWN_MS = 60 * 1000; // 1 minute between spiral triggers per session
const MAX_TRACKED_SESSIONS = 500; // evict oldest entry to bound memory usage

/**
 * Record a tool call for debugging spiral detection.
 * Call this from toolAfter to track repetitive patterns.
 */
export function recordToolCall(
	tool: string,
	args: unknown,
	sessionId: string,
): void {
	const argsHash =
		typeof args === 'string'
			? args.slice(0, 100)
			: JSON.stringify(args ?? '').slice(0, 100);
	let calls = recentToolCallsBySession.get(sessionId);
	if (!calls) {
		calls = [];
		recentToolCallsBySession.set(sessionId, calls);
	}
	calls.push({ tool, argsHash, timestamp: Date.now() });
	if (calls.length > MAX_RECENT_CALLS) {
		calls.shift();
	}
}

/**
 * Detect debugging spiral: same tool called 5+ times in a row with similar args
 * within a 5-minute window. Indicates the agent is stuck in a loop.
 */
export async function detectDebuggingSpiral(
	_directory: string,
	sessionId: string,
): Promise<AdversarialPatternMatch | null> {
	const now = Date.now();

	// Cooldown: don't re-trigger for the same session within SPIRAL_COOLDOWN_MS
	const lastTrigger = lastSpiralTimestampBySession.get(sessionId) ?? 0;
	if (now - lastTrigger < SPIRAL_COOLDOWN_MS) return null;

	const calls = recentToolCallsBySession.get(sessionId) ?? [];
	const windowCalls = calls.filter((c) => now - c.timestamp < SPIRAL_WINDOW_MS);

	if (windowCalls.length < SPIRAL_THRESHOLD) return null;

	// Check last N calls for same tool + similar args
	const lastN = windowCalls.slice(-SPIRAL_THRESHOLD);
	const firstTool = lastN[0].tool;
	const firstArgs = lastN[0].argsHash;

	const allSameTool = lastN.every((c) => c.tool === firstTool);
	const allSimilarArgs = lastN.every((c) => c.argsHash === firstArgs);

	if (allSameTool && allSimilarArgs) {
		// Record trigger time and clear the buffer to prevent immediate re-detection
		lastSpiralTimestampBySession.set(sessionId, now);
		recentToolCallsBySession.delete(sessionId);
		// Evict oldest session entry to bound memory growth.
		// Skip self-eviction: if the oldest key is the current sessionId, evict the
		// next-oldest instead so the cooldown we just set isn't immediately deleted.
		if (lastSpiralTimestampBySession.size > MAX_TRACKED_SESSIONS) {
			for (const oldest of lastSpiralTimestampBySession.keys()) {
				if (oldest !== sessionId) {
					lastSpiralTimestampBySession.delete(oldest);
					recentToolCallsBySession.delete(oldest);
					break;
				}
			}
		}
		return {
			pattern: 'VELOCITY_RATIONALIZATION',
			severity: 'HIGH',
			matchedText: `Tool '${firstTool}' called ${SPIRAL_THRESHOLD}+ times with identical args`,
			confidence: 'HIGH',
		};
	}

	return null;
}
