import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	executeMutationSuite,
	type MutationReport,
} from '../mutation/engine.js';
import {
	evaluateMutationGate,
	type MutationGateResult,
} from '../mutation/gate.js';
import { createSwarmTool } from './create-tool';

export const mutation_test: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Execute mutation testing with pre-generated patches — applies each mutant patch, runs tests, and evaluates kill rate against quality gate thresholds. Returns verdict (pass/warn/fail) with per-function kill rates and survived mutant details.',
		args: {
			patches: z
				.array(
					z.object({
						id: z.string().describe('Unique identifier for the mutation patch'),
						filePath: z.string().describe('File path to apply the patch to'),
						functionName: z.string().describe('Function being mutated'),
						mutationType: z
							.string()
							.describe(
								'Type of mutation (e.g., off_by_one, null_substitution)',
							),
						patch: z.string().describe('Unified diff patch content'),
						lineNumber: z
							.number()
							.optional()
							.describe('Line number of the mutation'),
					}),
				)
				.describe(
					'Array of MutationPatch objects — pre-generated mutation patches to execute',
				),
			files: z
				.array(z.string())
				.describe('Array of test file paths to run against mutants'),
			test_command: z
				.array(z.string())
				.describe(
					'Test command as array of strings (e.g., ["npx", "vitest", "--run"])',
				),
			pass_threshold: z
				.number()
				.optional()
				.describe('Kill rate threshold for pass verdict (default: 0.80)'),
			warn_threshold: z
				.number()
				.optional()
				.describe('Kill rate threshold for warn verdict (default: 0.60)'),
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
				patches: Array<{
					id: string;
					filePath: string;
					functionName: string;
					mutationType: string;
					patch: string;
					lineNumber?: number;
				}>;
				files: string[];
				test_command: string[];
				pass_threshold?: number;
				warn_threshold?: number;
				working_directory?: string;
			};

			try {
				if (
					!typedArgs.files ||
					!Array.isArray(typedArgs.files) ||
					typedArgs.files.length === 0
				) {
					return JSON.stringify(
						{
							error: 'files must be a non-empty array of file paths',
							success: false,
						},
						null,
						2,
					);
				}

				if (
					!typedArgs.test_command ||
					!Array.isArray(typedArgs.test_command) ||
					typedArgs.test_command.length === 0
				) {
					return JSON.stringify(
						{
							error: 'test_command must be a non-empty array of strings',
							success: false,
						},
						null,
						2,
					);
				}

				if (!typedArgs.test_command.every((c) => typeof c === 'string')) {
					return JSON.stringify(
						{
							error: 'test_command must contain only strings',
							success: false,
						},
						null,
						2,
					);
				}

				if (
					!typedArgs.patches ||
					!Array.isArray(typedArgs.patches) ||
					typedArgs.patches.length === 0
				) {
					return JSON.stringify(
						{
							error:
								'patches must be a non-empty array of MutationPatch objects',
							success: false,
						},
						null,
						2,
					);
				}

				const cwd = typedArgs.working_directory || directory || process.cwd();
				const passThreshold = typedArgs.pass_threshold ?? 0.8;
				const warnThreshold = typedArgs.warn_threshold ?? 0.6;

				// Build source files map for equivalence detection
				const sourceFiles = new Map<string, string>();
				const uniquePaths = [
					...new Set(typedArgs.patches.map((p) => p.filePath)),
				];
				for (const filePath of uniquePaths) {
					try {
						const resolvedPath = path.resolve(cwd, filePath);
						sourceFiles.set(filePath, fs.readFileSync(resolvedPath, 'utf-8'));
					} catch {
						// Skip files that can't be read
					}
				}

				const report: MutationReport = await executeMutationSuite(
					typedArgs.patches,
					typedArgs.test_command,
					typedArgs.files,
					cwd,
					undefined, // budgetMs
					undefined, // onProgress
					sourceFiles.size > 0 ? sourceFiles : undefined,
				);

				const result: MutationGateResult = evaluateMutationGate(
					report,
					passThreshold,
					warnThreshold,
				);

				return JSON.stringify(result, null, 2);
			} catch (e) {
				return JSON.stringify(
					{
						error:
							e instanceof Error
								? `mutation_test failed: ${e.message}`
								: 'mutation_test failed: unknown error',
						success: false,
					},
					null,
					2,
				);
			}
		},
	});
