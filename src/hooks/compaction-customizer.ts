/**
 * Compaction Customizer Hook
 *
 * Enhances session compaction by injecting swarm context from plan.md and context.md.
 * Adds current phase information and key decisions to the compaction context.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../config';
import { loadPlan } from '../plan/manager';
import { buildRehydrationCache } from '../state.js';
import {
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
	extractDecisions,
	extractIncompleteTasks,
	extractIncompleteTasksFromPlan,
	extractPatterns,
} from './extractors';
import { readSwarmFileAsync, safeHook } from './utils';

/**
 * Creates the experimental.session.compacting hook for compaction customization.
 */
export function createCompactionCustomizerHook(
	config: PluginConfig,
	directory: string,
): Record<string, unknown> {
	const enabled = config.hooks?.compaction !== false;

	if (!enabled) {
		return {};
	}

	return {
		'experimental.session.compacting': safeHook(
			async (
				_input: { sessionID: string },
				output: { context: string[]; prompt?: string },
			): Promise<void> => {
				const contextContent = await readSwarmFileAsync(
					directory,
					'context.md',
				);

				// Try structured plan first
				const plan = await loadPlan(directory);
				if (plan && plan.migration_status !== 'migration_failed') {
					const currentPhase = extractCurrentPhaseFromPlan(plan);
					if (currentPhase) {
						output.context.push(`[SWARM PLAN] ${currentPhase}`);
					}
					const incompleteTasks = extractIncompleteTasksFromPlan(plan);
					if (incompleteTasks) {
						output.context.push(`[SWARM TASKS] ${incompleteTasks}`);
					}
				} else {
					// Legacy fallback
					const planContent = await readSwarmFileAsync(directory, 'plan.md');
					if (planContent) {
						const currentPhase = extractCurrentPhase(planContent);
						if (currentPhase) {
							output.context.push(`[SWARM PLAN] ${currentPhase}`);
						}
						const incompleteTasks = extractIncompleteTasks(planContent);
						if (incompleteTasks) {
							output.context.push(`[SWARM TASKS] ${incompleteTasks}`);
						}
					}
				}

				// Add decisions summary from context.md
				if (contextContent) {
					const decisionsSummary = extractDecisions(contextContent);
					if (decisionsSummary) {
						output.context.push(`[SWARM DECISIONS] ${decisionsSummary}`);
					}
				}

				// Add patterns from context.md
				if (contextContent) {
					const patterns = extractPatterns(contextContent);
					if (patterns) {
						output.context.push(`[SWARM PATTERNS] ${patterns}`);
					}
				}

				// Add context optimization hint and summary count if summaries exist
				try {
					const summariesDir = join(directory, '.swarm', 'summaries');
					const files = await fs.promises.readdir(summariesDir);
					if (files.length > 0) {
						const count = files.length;
						output.context.push(
							`[CONTEXT OPTIMIZATION] Tool outputs from earlier in this session have been stored to disk. When compacting, replace any large tool output blocks (bash, test_runner, lint, diff results) with a one-line reference: "[Output stored — use /swarm retrieve to access full content]". Preserve the tool name, exit status, and any error messages. Discard raw output lines.`,
						);
						output.context.push(
							`[STORED OUTPUTS] ${count} tool output${count === 1 ? '' : 's'} stored in .swarm/summaries/. These are retrievable via /swarm retrieve <id>.`,
						);
					}
				} catch {
					// summaries directory doesn't exist or read error — skip hint and count
				}

				// Add knowledge tools reminder to survive context resets
				output.context.push(
					'[KNOWLEDGE TOOLS] You have persistent knowledge tools: knowledge_recall (search for relevant past decisions), knowledge_add (store a new lesson), knowledge_remove (delete outdated entries). Use knowledge_recall when past context would help.',
				);

				// Refresh rehydration cache so sessions created after compaction
				// start with current disk state, not stale startup snapshot.
				await buildRehydrationCache(directory);

				// Note: Do not modify output.prompt - let OpenCode use its default compaction prompt
			},
		),
	};
}
