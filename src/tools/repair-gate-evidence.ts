import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	type RepairGateEvidenceArgs,
	repairTaskGateEvidence,
} from '../evidence/task-gate-repair.js';
import { createSwarmTool } from './create-tool.js';
import { resolveWorkingDirectory } from './resolve-working-directory.js';

export async function executeRepairGateEvidence(
	args: RepairGateEvidenceArgs & { working_directory?: string },
	directory: string,
	_ctx?: ToolContext,
) {
	try {
		const resolved = resolveWorkingDirectory(args.working_directory, directory);
		if (!resolved.success) {
			return {
				success: false,
				message: resolved.message,
				errors: [resolved.message],
			};
		}
		return await repairTaskGateEvidence(args, resolved.directory, {
			sessionID: _ctx?.sessionID,
			messageID: _ctx?.messageID,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: 'repair_gate_evidence failed',
			errors: [message],
		};
	}
}

export const repair_gate_evidence: ToolDefinition = createSwarmTool({
	description:
		'Architect-only evidence repair for exact-task gate files. Rebuilds corrupt or legacy task gate evidence from the latest durable requirements receipt or a fail-closed reconstruction sentinel.',
	args: {
		task_id: z
			.string()
			.min(1)
			.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format'),
		reason: z.string().min(1).max(2000),
		expected_sha256: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		expected_generation: z.number().int().min(0).optional(),
		working_directory: z.string().optional(),
	},
	execute: async (args: unknown, directory: string, ctx?: ToolContext) =>
		JSON.stringify(
			await executeRepairGateEvidence(
				args as RepairGateEvidenceArgs & { working_directory?: string },
				directory,
				ctx,
			),
			null,
			2,
		),
});
