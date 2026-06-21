import { z } from 'zod';
import {
	paginateLaneOutput,
	readLaneOutput,
} from '../background/lane-output-store';
import { createSwarmTool } from './create-tool';

const RetrieveLaneOutputArgsSchema = z.object({
	ref: z
		.string()
		.min(1)
		.describe(
			'Opaque lane output ref returned as output_ref by dispatch tools.',
		),
	offset: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe('Line offset to start from.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.default(100)
		.describe('Number of lines to return, max 500.'),
});

export const retrieve_lane_output: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Retrieve paged full output for a dispatch_lanes or collect_lane_results lane by output_ref. Use when a lane preview is truncated, degraded, or needs candidate routing from full text.',
		args: {
			ref: RetrieveLaneOutputArgsSchema.shape.ref,
			offset: RetrieveLaneOutputArgsSchema.shape.offset,
			limit: RetrieveLaneOutputArgsSchema.shape.limit,
		},
		async execute(args: unknown, directory: string): Promise<string> {
			const parsed = RetrieveLaneOutputArgsSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify(
					{
						success: false,
						failure_class: 'invalid_args',
						message: 'Invalid retrieve_lane_output arguments',
						errors: parsed.error.issues.map(
							(issue) => `${issue.path.join('.')}: ${issue.message}`,
						),
					},
					null,
					2,
				);
			}

			let loaded: ReturnType<typeof readLaneOutput>;
			try {
				loaded = readLaneOutput(directory, parsed.data.ref);
			} catch {
				loaded = null;
			}
			if (!loaded) {
				return JSON.stringify(
					{
						success: false,
						failure_class: 'not_found',
						message: `No lane output artifact found for ${parsed.data.ref}`,
					},
					null,
					2,
				);
			}

			const page = paginateLaneOutput(
				loaded.artifact.text,
				parsed.data.offset,
				Math.min(parsed.data.limit, 500),
			);
			if (page.exhausted) {
				return (
					`--- Lane output ${loaded.artifact.ref} offset beyond range ---\n` +
					`Lane: ${loaded.artifact.laneId} (${loaded.artifact.agent})\n` +
					`Digest: ${loaded.artifact.digest}\n` +
					`Content has ${page.totalLines} line${page.totalLines === 1 ? '' : 's'}.`
				);
			}

			const header =
				`--- Lane output ${loaded.artifact.ref} lines ${page.startLine + 1}-${page.endLine} of ${page.totalLines} ---\n` +
				`Batch: ${loaded.artifact.batchId}\n` +
				`Lane: ${loaded.artifact.laneId}\n` +
				`Agent: ${loaded.artifact.agent}\n` +
				`Source: ${loaded.artifact.source}\n` +
				`Digest: ${loaded.artifact.digest}\n` +
				`Chars: ${loaded.artifact.chars}\n` +
				(loaded.artifact.transcriptIncomplete
					? 'Warning: transcript may be incomplete because the session message fetch hit its limit.\n'
					: '');
			let response = `${header}\n${page.content}`;
			if (page.endLine < page.totalLines) {
				const remaining = page.totalLines - page.endLine;
				response += `\n\n... ${remaining} more line${remaining === 1 ? '' : 's'}. Use offset=${page.endLine} to retrieve more.`;
			}
			return response;
		},
	});
