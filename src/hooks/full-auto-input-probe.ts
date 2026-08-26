/**
 * Full-Auto v2 input-probe hook (tool.execute.after).
 *
 * Inspects tool output for prompt-injection / credential-request /
 * exfiltration / guardrail-disable shapes and stores a warning on the
 * durable Full-Auto run state. The warning is consulted by the permission
 * hook on the next risky action — when both fire, the action escalates to
 * the critic instead of using the deterministic policy.
 *
 * The probe never blocks tool execution by itself.
 */
import type { PluginConfig } from '../config';
import { appendCoreEventSync } from '../events/core-events.js';
import {
	type FullAutoInputProbeResult,
	probeFullAutoInput,
} from '../full-auto/input-probe';
import { loadFullAutoRunState } from '../full-auto/state';
import * as logger from '../utils/logger';
import { normalizeToolName } from './normalize-tool-name';

const PROBED_TOOLS = new Set<string>([
	'web_search',
	'webfetch',
	'web_fetch',
	'fetch',
	'http',
	'request',
	'doc_extract',
	'doc_scan',
	'gitingest',
	'extract_code_blocks',
	'retrieve_summary',
	'retrieve_lane_output',
	'search',
	'read',
	'view',
]);

export interface FullAutoInputProbeHookOptions {
	config: PluginConfig;
	directory: string;
}

interface ToolAfterInput {
	tool: string;
	sessionID: string;
	callID?: string;
}

interface ToolAfterOutput {
	output?: unknown;
	error?: unknown;
}

async function writeWarningEvent(
	directory: string,
	sessionID: string,
	tool: string,
	probe: FullAutoInputProbeResult,
): Promise<void> {
	const event = {
		type: 'full_auto_input_warning' as const,
		timestamp: new Date().toISOString(),
		session_id: sessionID,
		tool,
		warnings: probe.warnings,
	};
	try {
		appendCoreEventSync(directory, event);
	} catch (error) {
		logger.error(
			`[full-auto/input-probe] failed to write event: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function extractText(out: unknown): string {
	if (typeof out === 'string') return out;
	if (out && typeof out === 'object') {
		const candidate = out as Record<string, unknown>;
		if (typeof candidate.output === 'string') return candidate.output;
		if (typeof candidate.text === 'string') return candidate.text;
		if (typeof candidate.body === 'string') return candidate.body;
		try {
			return JSON.stringify(candidate);
		} catch {
			return '';
		}
	}
	return '';
}

export interface PendingInputWarning {
	tool: string;
	at: string;
	categories: string[];
}

// H6 fix: bounded LRU map with TTL. Without this, the module-level stash
// grows unboundedly across sessions and a stale warning from yesterday
// could escalate today's first risky tool. AGENTS.md Invariant 8.
const MAX_TRACKED_SESSIONS = 256;
const WARNING_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const fullAutoInputWarningStash: Map<string, PendingInputWarning> =
	new Map();

function isExpired(w: PendingInputWarning, nowMs = Date.now()): boolean {
	const at = Date.parse(w.at);
	if (!Number.isFinite(at)) return true;
	return nowMs - at > WARNING_TTL_MS;
}

function evictExpired(): void {
	const now = Date.now();
	for (const [sid, w] of fullAutoInputWarningStash) {
		if (isExpired(w, now)) fullAutoInputWarningStash.delete(sid);
	}
	// FIFO eviction if still over cap.
	while (fullAutoInputWarningStash.size > MAX_TRACKED_SESSIONS) {
		const firstKey = fullAutoInputWarningStash.keys().next().value;
		if (firstKey === undefined) break;
		fullAutoInputWarningStash.delete(firstKey);
	}
}

export function setPendingInputWarning(
	sessionID: string,
	warning: PendingInputWarning,
): void {
	// Re-insert at the end so this entry is the most-recently-used (Map
	// iteration is insertion order in JS).
	fullAutoInputWarningStash.delete(sessionID);
	fullAutoInputWarningStash.set(sessionID, warning);
	evictExpired();
}

export function consumePendingInputWarning(
	sessionID: string,
): PendingInputWarning | undefined {
	const warning = fullAutoInputWarningStash.get(sessionID);
	if (warning) fullAutoInputWarningStash.delete(sessionID);
	if (warning && isExpired(warning)) return undefined;
	return warning;
}

export function peekPendingInputWarning(
	sessionID: string,
): PendingInputWarning | undefined {
	const w = fullAutoInputWarningStash.get(sessionID);
	if (!w) return undefined;
	if (isExpired(w)) {
		fullAutoInputWarningStash.delete(sessionID);
		return undefined;
	}
	return w;
}

export function createFullAutoInputProbeHook(
	options: FullAutoInputProbeHookOptions,
): {
	toolAfter: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
} {
	const { directory } = options;
	// First-class toggle: always armed; the run-state check below
	// (status !== 'running' → return) is the runtime gate.
	return {
		toolAfter: async (input, output) => {
			const tool = (
				normalizeToolName(input.tool) ??
				input.tool ??
				''
			).toLowerCase();
			if (!PROBED_TOOLS.has(tool)) return;
			const sessionID = input.sessionID;
			if (!sessionID) return;
			const runState = loadFullAutoRunState(directory, sessionID);
			if (!runState || runState.status !== 'running') return;
			const text = extractText(output.output);
			if (!text) return;
			const probe = probeFullAutoInput(text);
			if (!probe.hasWarning) return;
			setPendingInputWarning(sessionID, {
				tool,
				at: new Date().toISOString(),
				categories: probe.warnings.map((w) => w.category),
			});
			// M4 fix: a successful injection probe is NOT progress. Do not
			// reset consecutiveNoProgressTurns; a malicious tool stream that
			// keeps tripping the probe should still trip the cadence
			// no-progress trigger.
			await writeWarningEvent(directory, sessionID, tool, probe);
		},
	};
}
