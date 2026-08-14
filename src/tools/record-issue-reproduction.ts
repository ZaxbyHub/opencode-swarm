/**
 * record_issue_reproduction — persist an issue-bound reproduction receipt for
 * the issue-trace workflow (issue #2131 finding 2.6).
 *
 * The issue-trace reducer requires reproduction evidence (OR a typed waiver)
 * before the localization → PLAN transition can fire. The noRepro flag/waiver
 * path is set by `/swarm issue --no-repro`; this tool is the writer for the
 * case where reproduction was actually performed. The reader
 * (`reproductionReceiptExists` in issue-trace-state.ts) accepts the receipt only
 * when `performed === true` and `issueNumber` matches the traced issue.
 *
 * Note: this is an agent self-attestation, not an independently verified
 * reproduction — it records the commands the agent ran and the output summary it
 * observed. It raises the bar from unchecked prose to a structured, issue-bound
 * artifact with a session provenance stamp, but does not itself prove the
 * reproduction exercises the defect.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

const RecordIssueReproductionArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		performed: z.boolean(),
		commands: z.array(z.string().min(1)).min(1).optional(),
		output_summary: z.string().min(1).optional(),
	})
	.strict();

export async function executeRecordIssueReproduction(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordIssueReproductionArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid reproduction receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const { issueNumber, performed, commands, output_summary } = parsed.data;

	// A performed=true receipt MUST carry the actual evidence (commands + an
	// output summary) — otherwise {performed:true} alone would satisfy the gate
	// with zero evidence. A performed=false receipt is bookkeeping only and need
	// not carry evidence.
	if (performed && (!commands || commands.length === 0 || !output_summary)) {
		return JSON.stringify({
			success: false,
			message:
				'A performed=true reproduction receipt requires non-empty commands and output_summary.',
		});
	}

	const receipt: Record<string, unknown> = {
		performed,
		issueNumber,
		timestamp: new Date().toISOString(),
	};
	if (commands) receipt.commands = commands;
	if (output_summary) receipt.output_summary = output_summary;
	if (context.sessionID?.trim()) receipt.sessionId = context.sessionID.trim();

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'reproduction.json');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message:
				error instanceof Error ? error.message : 'Failed to validate path',
		});
	}

	try {
		const dir = path.dirname(validatedPath);
		await fs.promises.mkdir(dir, { recursive: true });
		const tmpPath = path.join(dir, '.reproduction.json.tmp');
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(receipt, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tmpPath, validatedPath);
		return JSON.stringify({
			success: true,
			issueNumber,
			performed,
			path: '.swarm/reproduction.json',
			message: performed
				? `Reproduction receipt recorded for issue #${issueNumber}; the trace may now transition to PLAN.`
				: `Reproduction receipt recorded (performed=false) for issue #${issueNumber}; it does NOT satisfy the reproduction gate.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_issue_reproduction: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record the reproduction outcome for the current traced issue. The /swarm issue --trace workflow requires reproduction evidence (or a typed --no-repro waiver) before it can leave localization and transition to PLAN. Call this with performed=true, the exact commands run, and a concrete output_summary after attempting a minimal reproduction; the receipt binds to issueNumber (and records the calling session) and is read by the issue-trace engine. A performed=true receipt MUST include commands and output_summary. A performed=false receipt is recorded but does NOT satisfy the gate.',
		args: {
			issueNumber: RecordIssueReproductionArgsSchema.shape.issueNumber,
			performed: RecordIssueReproductionArgsSchema.shape.performed,
			commands: RecordIssueReproductionArgsSchema.shape.commands,
			output_summary: RecordIssueReproductionArgsSchema.shape.output_summary,
		},
		execute: executeRecordIssueReproduction,
	});
