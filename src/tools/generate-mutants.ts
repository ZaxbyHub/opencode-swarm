/**
 * Generate mutation patches tool.
 * Calls generateMutants() from src/mutation/generator.ts with the ToolContext
 * and returns the patch list for piping into the mutation_test tool.
 * On LLM failure, emits a SKIP verdict with a diagnostic message.
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { MutationPatch } from '../mutation/engine.js';
import { generateMutants } from '../mutation/generator.js';
import { createSwarmTool } from './create-tool';

export interface GenerateMutantsResult {
	verdict: 'ready' | 'SKIP';
	patches: MutationPatch[];
	count: number;
	message?: string;
}

export const generate_mutants: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Generate LLM-based mutation testing patches for the specified source files. Returns MutationPatch[] for direct consumption by the mutation_test tool. On LLM failure or when no patches can be generated, returns a SKIP verdict with a diagnostic message rather than throwing.',
		args: {
			files: z
				.array(z.string())
				.describe(
					'Array of source file paths to generate mutation patches for',
				),
		},
		async execute(
			args: unknown,
			_directory: string,
			ctx?: ToolContext,
		): Promise<string> {
			const typedArgs = args as { files: string[] };

			if (
				!typedArgs.files ||
				!Array.isArray(typedArgs.files) ||
				typedArgs.files.length === 0
			) {
				const result: GenerateMutantsResult = {
					verdict: 'SKIP',
					patches: [],
					count: 0,
					message: 'generate_mutants: files must be a non-empty array',
				};
				return JSON.stringify(result, null, 2);
			}

			try {
				const patches = await generateMutants(typedArgs.files, ctx);

				if (patches.length === 0) {
					const result: GenerateMutantsResult = {
						verdict: 'SKIP',
						patches: [],
						count: 0,
						message:
							'generate_mutants: LLM returned no patches — skipping mutation gate',
					};
					return JSON.stringify(result, null, 2);
				}

				const result: GenerateMutantsResult = {
					verdict: 'ready',
					patches,
					count: patches.length,
				};
				return JSON.stringify(result, null, 2);
			} catch (error) {
				const result: GenerateMutantsResult = {
					verdict: 'SKIP',
					patches: [],
					count: 0,
					message: `generate_mutants: unexpected error — ${error instanceof Error ? error.message : String(error)}`,
				};
				return JSON.stringify(result, null, 2);
			}
		},
	});
