import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { checkpoint } from '../tools/checkpoint.js';
import type { ToolResult } from '../tools/create-tool';

const CheckpointResultSchema = z
	.object({
		action: z.string().optional(),
		success: z.boolean(),
		error: z.string().optional(),
		checkpoints: z.array(z.unknown()).optional(),
	})
	.passthrough();

function safeParseResult(
	result: ToolResult,
): z.infer<typeof CheckpointResultSchema> {
	const jsonStr = typeof result === 'string' ? result : result.output;
	const parsed = CheckpointResultSchema.safeParse(JSON.parse(jsonStr));
	if (!parsed.success) {
		return {
			success: false,
			error: `Invalid response: ${parsed.error.message}`,
		};
	}
	return parsed.data;
}

/**
 * Handle /swarm checkpoint command
 * Creates, lists, restores, or deletes checkpoints with optional label
 */
export async function handleCheckpointCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const subcommand = args[0] || 'list';
	const label = args[1];

	switch (subcommand) {
		case 'save':
			return handleSave(directory, label);
		case 'restore':
			return handleRestore(directory, label);
		case 'delete':
			return handleDelete(directory, label);
		default:
			return handleList(directory);
	}
}

async function handleSave(directory: string, label?: string): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint save <label>`';
	}

	try {
		const result = await checkpoint.execute({ action: 'save', label }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (parsed.success) {
			return `✓ Checkpoint saved: "${label}"`;
		} else {
			return `Error: ${parsed.error || 'Failed to save checkpoint'}`;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleRestore(
	directory: string,
	label?: string,
): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint restore <label>`';
	}

	try {
		const result = await checkpoint.execute({ action: 'restore', label }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (parsed.success) {
			return `✓ Restored to checkpoint: "${label}"`;
		} else {
			return `Error: ${parsed.error || 'Failed to restore checkpoint'}`;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleDelete(
	directory: string,
	label?: string,
): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint delete <label>`';
	}

	try {
		const result = await checkpoint.execute({ action: 'delete', label }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (parsed.success) {
			return `✓ Checkpoint deleted: "${label}"`;
		} else {
			return `Error: ${parsed.error || 'Failed to delete checkpoint'}`;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleList(directory: string): Promise<string> {
	try {
		const result = await checkpoint.execute({ action: 'list' }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (!parsed.success) {
			return `Error: ${parsed.error || 'Failed to list checkpoints'}`;
		}

		const checkpoints = parsed.checkpoints || [];

		if (checkpoints.length === 0) {
			return 'No checkpoints found. Create one with `/swarm checkpoint save <label>`';
		}

		const lines = [
			'## Checkpoints',
			'',
			...checkpoints.map(
				// biome-ignore lint/suspicious/noExplicitAny: checkpoint shape from JSON.parse is untyped
				(c: any) =>
					`- "${c.label}" — ${new Date(c.timestamp).toLocaleString()}`,
			),
			'',
			'Commands:',
			'- `/swarm checkpoint save <label>` — Create checkpoint',
			'- `/swarm checkpoint restore <label>` — Restore checkpoint',
			'- `/swarm checkpoint delete <label>` — Delete checkpoint',
		];

		return lines.join('\n');
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}
