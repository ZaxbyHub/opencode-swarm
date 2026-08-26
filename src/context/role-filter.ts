/**
 * Role-Scoped Context Injection Filter
 * Filters context entries based on [FOR: ...] tags for role-based context delivery.
 */

import { stripKnownSwarmPrefix } from '../config/schema.js';
import { appendCoreEventSync } from '../events/core-events.js';
import { parseDelegationEnvelope } from '../hooks/delegation-gate.js';
import { log } from '../utils';

/**
 * Context entry with role metadata
 */
export interface ContextEntry {
	role: 'user' | 'assistant' | 'system';
	content: string;
	name?: string;
}

export interface FilterByRoleOptions {
	/** Allow valid leading [FOR: ...] tags to route otherwise-protected system entries. */
	filterTaggedSystem?: boolean;
}

/**
 * Regex pattern for extracting [FOR: ...] tags from content
 * Matches patterns like: [FOR: ALL], [FOR: reviewer, test_engineer]
 */
const FOR_TAG_PATTERN = /^\[FOR:\s*([^\]]+)\]/i;

/**
 * Check if content contains plan references (should never be filtered)
 */
function containsPlanContent(text: string): boolean {
	if (!text) return false;

	const lowerText = text.toLowerCase();
	return (
		lowerText.includes('.swarm/plan') ||
		lowerText.includes('.swarm/context') ||
		lowerText.includes('swarm/plan.md') ||
		lowerText.includes('swarm/context.md')
	);
}

/**
 * Check if content contains knowledge references (should never be filtered)
 * Detects knowledge entries, lessons, or swarm knowledge references
 */
function containsKnowledgeContent(text: string): boolean {
	if (!text) return false;

	const lowerText = text.toLowerCase();
	return (
		lowerText.includes('knowledge') ||
		lowerText.includes('lesson') ||
		lowerText.includes('.swarm/knowledge') ||
		lowerText.includes('swarm knowledge')
	);
}

/**
 * Parse the [FOR: ...] tag from content and return the agent list.
 * Returns null if no valid tag found.
 */
function parseForTag(content: string): string[] | null {
	const match = content.trim().match(FOR_TAG_PATTERN);
	if (!match) {
		return null;
	}

	const tagContent = match[1].trim();
	// [FOR: ALL] means include for all agents
	if (tagContent.toLowerCase() === 'all') {
		return ['all'];
	}

	// Parse comma-separated agent names
	return tagContent
		.split(',')
		.map((agent) => agent.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Check if targetRole matches any of the allowed agents in the tag.
 * Uses stripKnownSwarmPrefix for normalization and case-insensitive matching.
 */
function isTargetRoleAllowed(
	targetRole: string,
	allowedAgents: string[],
): boolean {
	if (allowedAgents.includes('all')) {
		return true;
	}

	const normalizedTarget = stripKnownSwarmPrefix(targetRole).toLowerCase();

	return allowedAgents.some((agent) => {
		const normalizedAgent = stripKnownSwarmPrefix(agent).toLowerCase();
		return normalizedTarget === normalizedAgent;
	});
}

/**
 * Check if entry should never be filtered based on role and content.
 * - System prompts: never filter
 * - User entries with delegation envelopes: never filter
 * - Assistant entries with plan content: never filter
 * - Assistant entries with knowledge content: never filter
 */
function shouldNeverFilter(entry: ContextEntry): boolean {
	// System prompts are never filtered
	if (entry.role === 'system') {
		return true;
	}

	// User entries with delegation envelopes are never filtered
	if (entry.role === 'user') {
		const envelope = parseDelegationEnvelope(entry.content);
		if (envelope) {
			return true;
		}
	}

	// Assistant entries with plan or knowledge content are never filtered
	if (entry.role === 'assistant') {
		if (
			containsPlanContent(entry.content) ||
			containsKnowledgeContent(entry.content)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Log context filtering metrics to .swarm/events.jsonl
 */
function logFilteringMetrics(
	directory: string,
	targetRole: string,
	totalEntries: number,
	includedEntries: number,
): void {
	try {
		appendCoreEventSync(directory, {
			event: 'context_filtered',
			timestamp: new Date().toISOString(),
			agentName: targetRole,
			totalEntries,
			includedEntries,
			filteredEntries: totalEntries - includedEntries,
			estimatedTokensSaved: (totalEntries - includedEntries) * 100,
		});
	} catch (error) {
		log('[RoleFilter] event append failed', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Filter context entries based on target role and [FOR: ...] tags.
 *
 * Filtering rules:
 * - Entries with [FOR: ALL] are included for all agents
 * - Entries with [FOR: specific_agents] are included only for named agents
 * - Entries without [FOR: ...] tag are included for all agents (backward compatibility)
 * - System prompts, delegation envelopes, plan content, and knowledge entries are never filtered
 *
 * @param entries - Array of context entries to filter
 * @param targetRole - The target agent role to filter for
 * @param directory - Optional project directory for metrics logging
 * @param options - Optional routing behavior; defaults preserve historical semantics
 * @returns Filtered array of context entries
 */
export function filterByRole(
	entries: ContextEntry[],
	targetRole: string,
	directory?: string,
	options: FilterByRoleOptions = {},
): ContextEntry[] {
	// If no entries, return empty array
	if (!entries || entries.length === 0) {
		return [];
	}

	// Filter entries based on role and tags
	const filtered: ContextEntry[] = [];

	for (const entry of entries) {
		// Parse before the exemption check so the production system-hook adapter
		// can opt valid tagged system fragments into routing. Empty/malformed tags
		// remain protected system context, and all default callers keep the
		// historical unconditional system exemption.
		const allowedAgents = parseForTag(entry.content);
		const canFilterTaggedSystem =
			entry.role === 'system' &&
			options.filterTaggedSystem === true &&
			allowedAgents !== null &&
			allowedAgents.length > 0;

		// Check if entry should never be filtered
		if (shouldNeverFilter(entry) && !canFilterTaggedSystem) {
			filtered.push(entry);
			continue;
		}

		// If no tag present, include for all (backward compatibility)
		if (allowedAgents === null) {
			filtered.push(entry);
			continue;
		}

		// Check if target role is allowed
		if (isTargetRoleAllowed(targetRole, allowedAgents)) {
			filtered.push(entry);
		}
	}

	// Log metrics only when directory is provided — never fall back to cwd
	if (directory) {
		logFilteringMetrics(directory, targetRole, entries.length, filtered.length);
	}

	return filtered;
}

/**
 * Create the production adapter for role-scoped system fragments.
 *
 * The adapter intentionally has no directory parameter: chat-system filtering
 * must stay free of synchronous metrics I/O. Missing session or agent identity
 * fails open so critical system context is never dropped speculatively.
 */
export function createRoleFilterSystemHook(
	getActiveAgentName: (sessionID: string) => string | undefined,
): {
	'experimental.chat.system.transform': (
		input: { sessionID?: string },
		output: { system?: string[] },
	) => Promise<void>;
} {
	return {
		'experimental.chat.system.transform': async (input, output) => {
			if (!input.sessionID || !Array.isArray(output.system)) return;

			const targetRole = getActiveAgentName(input.sessionID);
			if (!targetRole) return;

			const entries: ContextEntry[] = output.system.map((content) => ({
				role: 'system',
				content,
			}));
			const filtered = filterByRole(entries, targetRole, undefined, {
				filterTaggedSystem: true,
			});
			// MUST mutate in place (issue #1619). The OpenCode host invokes each
			// hook as `M(input, output)`, discards the return value, and afterwards
			// reads its OWN local array (`LLMRequestPrep.prepare`), so
			// `output.system = …` is a rebind the host never observes and the
			// filtering would silently never happen. Enforced by
			// tests/unit/hooks/chat-transform-rebind-guard.test.ts.
			const kept = filtered.map(({ content }) => content);
			output.system.length = 0;
			// Loop rather than `push(...kept)`: the injected-fragment count is
			// unbounded and spreading it can exceed the engine's argument limit.
			for (const content of kept) {
				output.system.push(content);
			}
		},
	};
}
