import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	type RepairKnowledgeReceiptLedgerInput,
	repairKnowledgeReceiptLedger,
} from '../hooks/knowledge-receipt-ledger.js';
import { createSwarmTool } from './create-tool.js';
import { resolveWorkingDirectory } from './resolve-working-directory.js';

export async function executeRepairKnowledgeReceiptLedger(
	args: RepairKnowledgeReceiptLedgerInput & { working_directory?: string },
	directory: string,
	_ctx?: ToolContext,
) {
	try {
		if (_ctx?.sessionID && args.session_id !== _ctx.sessionID) {
			return {
				success: false,
				message:
					'repair_knowledge_receipt_ledger session_id must match the invoking tool context.',
				errors: ['RECEIPT_REPAIR_SESSION_MISMATCH'],
			};
		}
		const resolved = resolveWorkingDirectory(args.working_directory, directory);
		if (!resolved.success) {
			return {
				success: false,
				message: resolved.message,
				errors: [resolved.message],
			};
		}
		const result = await repairKnowledgeReceiptLedger(resolved.directory, args);
		if (!result.ok) {
			return {
				success: false,
				message: 'repair_knowledge_receipt_ledger failed',
				errors: [result.detail],
				code: result.code,
			};
		}
		const reEvaluationArgs = JSON.stringify({
			repair_id: result.repair_id,
			phase: args.phase,
			...(args.task_id ? { task_id: args.task_id } : {}),
			scope_complete: true,
		});
		return {
			success: true,
			message:
				result.status === 'validated_projection'
					? 'knowledge receipt projection validated'
					: result.status === 'pending_re_evaluation'
						? `knowledge receipt ledger still pending re-evaluation; as architect, run knowledge_recall with a comprehensive query and repair_re_evaluation ${reEvaluationArgs}`
						: `knowledge receipt ledger repaired and blocked pending re-evaluation; as architect, run knowledge_recall with a comprehensive query and repair_re_evaluation ${reEvaluationArgs}`,
			...result,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: 'repair_knowledge_receipt_ledger failed',
			errors: [message],
		};
	}
}

export const repair_knowledge_receipt_ledger: ToolDefinition = createSwarmTool({
	description:
		'Architect-only repair and validation for the authoritative knowledge receipt ledger. Rebuilds the derived projection when authority is readable, or quarantines a bounded corrupt authority, salvages only the validated prefix, and blocks the exact phase/session until a fresh re-evaluation is committed.',
	args: {
		phase: z.string().min(1),
		session_id: z.string().min(1),
		task_id: z.string().min(1).optional(),
		reason: z.string().min(1).max(2000),
		grace_days: z.number().int().min(0).optional(),
		working_directory: z.string().optional(),
	},
	execute: async (args: unknown, directory: string, ctx?: ToolContext) =>
		JSON.stringify(
			await executeRepairKnowledgeReceiptLedger(
				args as RepairKnowledgeReceiptLedgerInput & {
					working_directory?: string;
				},
				directory,
				ctx,
			),
			null,
			2,
		),
});
