import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	analyzeImpact,
	type TestImpactResult,
} from '../test-impact/analyzer.js';
import { createSwarmTool } from './create-tool';

export const test_impact: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Analyze which test files are impacted by changes to the given source files. Returns TestImpactResult with impactedTests, untestedFiles, and the full impact map.',
	args: {
		changedFiles: z
			.array(z.string())
			.describe('Array of source file paths to analyze for test impact'),
		working_directory: z
			.string()
			.optional()
			.describe(
				'Project root directory. Defaults to current working directory.',
			),
	},
	async execute(
		args: unknown,
		directory: string,
		_ctx?: ToolContext,
	): Promise<string> {
		const typedArgs = args as {
			changedFiles: string[];
			working_directory?: string;
		};

		try {
			if (
				!typedArgs.changedFiles ||
				!Array.isArray(typedArgs.changedFiles) ||
				typedArgs.changedFiles.length === 0
			) {
				return JSON.stringify(
					{
						error: 'changedFiles must be a non-empty array of file paths',
						success: false,
					},
					null,
					2,
				);
			}

			const cwd = typedArgs.working_directory || directory || process.cwd();
			const result: TestImpactResult = await analyzeImpact(
				typedArgs.changedFiles,
				cwd,
			);

			return JSON.stringify(result, null, 2);
		} catch (e) {
			return JSON.stringify(
				{
					error:
						e instanceof Error
							? `test_impact failed: ${e.message}`
							: 'test_impact failed: unknown error',
					success: false,
				},
				null,
				2,
			);
		}
	},
});
