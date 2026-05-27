/**
 * summarize_work — agents call this at task completion to emit a short structured
 * summary of what they did (issue #893). Stored as a `note` evidence entry; rolled up
 * per-phase and reviewed by the architecture-supervisor critic. Advisory: never blocks.
 */

import type { ToolContext, tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	MAX_AGENT_SUMMARY_WORDS,
	MAX_LIST_ITEMS,
	normalizeAgentWorkSummary,
} from '../summaries/schema';
import { writeAgentSummary } from '../summaries/store';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}

const ArgsSchema = z.object({
	phase: z.number().int().min(0).max(999),
	summary: z.string().min(1),
	task_id: z.string().min(1).optional(),
	parent_agent: z.string().min(1).optional(),
	key_decisions: z.array(z.string().min(1)).optional(),
	constraints_observed: z.array(z.string().min(1)).optional(),
	constraints_violated: z.array(z.string().min(1)).optional(),
	assumptions: z.array(z.string().min(1)).optional(),
	risks: z.array(z.string().min(1)).optional(),
	files_touched: z.array(z.string().min(1)).optional(),
	evidence_refs: z.array(z.string().min(1)).optional(),
	working_directory: z.string().optional(),
});

export const summarize_work: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Emit a short structured summary of the work you just completed (key decisions, ' +
		'assumptions, risks, constraints observed/violated). Call this once at task ' +
		`completion. Keep the summary under ${MAX_AGENT_SUMMARY_WORDS} words and each list ` +
		`to ${MAX_LIST_ITEMS} items — longer content is truncated, not rejected. These ` +
		'summaries roll up per phase and are reviewed by the architecture supervisor to ' +
		'catch cross-task contradictions, drift, and repeated failure loops. Advisory only.',
	args: {
		phase: z
			.number()
			.int()
			.min(0)
			.max(999)
			.describe('Phase number this work belongs to.'),
		summary: z
			.string()
			.min(1)
			.describe(
				`One-paragraph summary of what you did (<= ${MAX_AGENT_SUMMARY_WORDS} words).`,
			),
		task_id: z
			.string()
			.min(1)
			.optional()
			.describe('Task ID this summary covers (e.g. "1.2").'),
		parent_agent: z
			.string()
			.min(1)
			.optional()
			.describe('The agent that delegated this task, if any.'),
		key_decisions: z.array(z.string().min(1)).optional(),
		constraints_observed: z.array(z.string().min(1)).optional(),
		constraints_violated: z.array(z.string().min(1)).optional(),
		assumptions: z.array(z.string().min(1)).optional(),
		risks: z.array(z.string().min(1)).optional(),
		files_touched: z.array(z.string().min(1)).optional(),
		evidence_refs: z.array(z.string().min(1)).optional(),
		working_directory: z.string().optional(),
	},
	execute: async (
		rawArgs: unknown,
		directory: string,
		ctx?: ToolContext,
	): Promise<string> => {
		const parsed = ArgsSchema.safeParse(rawArgs);
		if (!parsed.success) {
			return JSON.stringify(
				{
					success: false,
					reason: 'invalid arguments',
					errors: parsed.error.issues.map((i) => ({
						path: i.path.join('.'),
						message: i.message,
					})),
				},
				null,
				2,
			);
		}
		const args = parsed.data;
		const dirResult = resolveWorkingDirectory(
			args.working_directory,
			directory,
		);
		if (!dirResult.success) {
			return JSON.stringify(
				{ success: false, reason: dirResult.message },
				null,
				2,
			);
		}
		const workingDir = dirResult.directory;
		const sessionId = ctx?.sessionID ?? 'unknown-session';
		const agent = getContextAgent(ctx) ?? 'unknown-agent';

		// Honor a configured per-agent word cap; falls back to the schema default.
		let maxWords = MAX_AGENT_SUMMARY_WORDS;
		try {
			const config = loadPluginConfig(workingDir);
			maxWords =
				config.architectural_supervision?.max_agent_summary_words ?? maxWords;
		} catch {
			// config load failures fall back to the default cap
		}

		const summary = normalizeAgentWorkSummary(
			{
				phase: args.phase,
				task_id: args.task_id,
				session_id: sessionId,
				agent,
				parent_agent: args.parent_agent,
				summary: args.summary,
				key_decisions: args.key_decisions,
				constraints_observed: args.constraints_observed,
				constraints_violated: args.constraints_violated,
				assumptions: args.assumptions,
				risks: args.risks,
				files_touched: args.files_touched,
				evidence_refs: args.evidence_refs,
			},
			maxWords,
		);

		const storedTaskId = await writeAgentSummary(workingDir, summary);

		return JSON.stringify(
			{
				success: true,
				stored_task_id: storedTaskId,
				phase: summary.phase,
				agent: summary.agent,
				truncated: summary.truncated ?? false,
			},
			null,
			2,
		);
	},
});
