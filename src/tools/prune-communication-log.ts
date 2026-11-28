/**
 * `prune_communication_log` — the AI-release surface of the communication
 * debug log's programmatic lifecycle (see src/maintenance/communication-log.ts).
 *
 * The automatic maintenance pass prunes closed incidents whose closure is
 * durably provable (every named task's evidence at `complete`). Everything
 * else is this tool's worklist: closed entries whose task is not provably
 * complete, entries without a Status line, and the read-only worklist report.
 * Every removal here is an explicit AI decision with a justification, audited
 * to the core events log (`communication_log_pruned`, cause `ai_released`).
 * Open incidents are refused — they are the log's live worklist.
 */
import { z } from 'zod';
import {
	releaseCommunicationLogEntry,
	reportCommunicationLogWorklist,
} from '../maintenance/communication-log.js';
import { createSwarmTool } from './create-tool.js';

const PruneCommunicationLogArgsSchema = z
	.object({
		entry_headline: z
			.string()
			.trim()
			.min(3)
			.max(200)
			.optional()
			.describe(
				'Prefix of the incident headline to AI-release (must match exactly one `## Vorfall …` entry). Omit for the read-only worklist report.',
			),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.optional()
			.describe(
				'Why this entry may be removed although its closure is not durably provable (audited). Required with entry_headline.',
			),
	})
	.strict();

export async function executePruneCommunicationLog(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = PruneCommunicationLogArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid prune_communication_log call: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const { entry_headline, reason } = parsed.data;
	if (entry_headline !== undefined && (reason === undefined || reason === '')) {
		return JSON.stringify({
			success: false,
			message:
				'prune_communication_log requires a reason when removing an entry — the AI-release decision is audited to the core events log.',
		});
	}
	// Read-only worklist mode: no entry, no reason — report the state.
	if (entry_headline === undefined) {
		const report = await reportCommunicationLogWorklist(directory);
		return JSON.stringify(
			{
				success: true,
				mode: 'worklist',
				open_entries: report.openCount,
				ai_release_worklist: report.unclearClosed,
				hint: 'Closed incidents whose every named task is durably complete are pruned automatically by the session-close maintenance pass — they do not appear here. Everything in ai_release_worklist needs an explicit, audited AI decision: prune_communication_log({ entry_headline, reason }).',
			},
			null,
			2,
		);
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'prune_communication_log requires an active sessionID',
		});
	}
	const result = await releaseCommunicationLogEntry({
		directory,
		headlinePrefix: entry_headline,
		reason: reason ?? '',
		actorSessionID: context.sessionID,
	});
	if (result.outcome === 'released') {
		return JSON.stringify({
			success: true,
			removed_headline: result.headline,
			task_ids: result.taskIds,
			audited:
				'communication_log_pruned (cause: ai_released) → core event store',
		});
	}
	if (result.outcome === 'refused_open') {
		return JSON.stringify({
			success: false,
			message: `Refusing to remove "${result.headline}": its Status line says the incident is OPEN. Open entries are the log's live worklist — resolve the incident first, then let the automatic pass (or a justified release once closed) remove it.`,
		});
	}
	if (result.outcome === 'ambiguous') {
		return JSON.stringify({
			success: false,
			message: `Headline prefix matches ${result.candidates.length} entries — provide a longer prefix. Candidates: ${result.candidates
				.map((h) => `"${h}"`)
				.join(', ')}`,
		});
	}
	return JSON.stringify({
		success: false,
		message:
			result.candidates.length > 0
				? `No incident headline starts with the given prefix. Incidents in the log: ${result.candidates
						.map((h) => `"${h}"`)
						.join(', ')}`
				: 'The communication debug log has no incident entries (nothing to release).',
	});
}

export const prune_communication_log: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Maintain the swarm communication debug log lifecycle: report the AI-release worklist (no arguments), or remove one specific closed-but-unproven `## Vorfall` entry with an audited reason. Closed incidents whose every named task is durably complete (evidence state complete) are pruned automatically by the session-close maintenance pass; this tool is the explicit AI decision surface for everything else — closed entries whose task is not provably complete, entries without a Status line. Open incidents are always refused. Every removal is audited to the core event store (communication_log_pruned).',
		args: {
			entry_headline: PruneCommunicationLogArgsSchema.shape.entry_headline,
			reason: PruneCommunicationLogArgsSchema.shape.reason,
		},
		execute: executePruneCommunicationLog,
	});
