import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	executeMutationSuite,
	type MutationReport,
	validateTestCommand,
} from '../mutation/engine.js';
import {
	evaluateMutationGate,
	type MutationGateResult,
} from '../mutation/gate.js';
import { analyzeImpact } from '../test-impact/analyzer.js';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';
import { MAX_SAFE_TEST_FILES } from './test-runner.js';

export const mutation_test: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Execute mutation testing with pre-generated patches — applies each mutant patch, runs tests, and evaluates kill rate against quality gate thresholds. Test selection: pass files (explicit override) or source_files (impacted tests derived via the impact analyzer, bounded by the safe test-file cap; analyzer failure or empty derivation returns a typed bounded fallback instead of running a broad suite). Returns verdict (pass/warn/fail) with per-function kill rates, survived mutant details, test_selection, and evaluability reporting.',
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
				.optional()
				.describe(
					'Array of test file paths to run against mutants. Explicit override: when provided, this set wins over analyzer derivation.',
				),
			source_files: z
				.array(z.string())
				.optional()
				.describe(
					'Source files whose impacted tests are derived via the impact analyzer when files is omitted (bounded by the safe test-file cap).',
				),
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
				files?: string[];
				source_files?: string[];
				test_command: string[];
				pass_threshold?: number;
				warn_threshold?: number;
				working_directory?: string;
			};

			try {
				if (!typedArgs.files && !typedArgs.source_files) {
					return JSON.stringify(
						{
							error:
								'provide either files (explicit test file paths) or source_files (derive impacted tests via the impact analyzer)',
							success: false,
						},
						null,
						2,
					);
				}
				if (
					typedArgs.files &&
					(!Array.isArray(typedArgs.files) || typedArgs.files.length === 0)
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
					typedArgs.source_files &&
					(!Array.isArray(typedArgs.source_files) ||
						typedArgs.source_files.length === 0)
				) {
					return JSON.stringify(
						{
							error: 'source_files must be a non-empty array of file paths',
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

				const cmdValidationError = validateTestCommand(typedArgs.test_command);
				if (cmdValidationError) {
					return JSON.stringify(
						{
							error: cmdValidationError,
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

				const resolved = resolveWorkingDirectory(
					typedArgs.working_directory,
					directory,
				);
				if (!resolved.success) {
					return JSON.stringify(
						{ success: false, error: resolved.message },
						null,
						2,
					);
				}
				const cwd = resolved.directory;
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

				// Test selection (issue #2492): explicit files override; otherwise derive
				// impacted tests from the impact analyzer (bounded by the safe test-file
				// cap); analyzer failure, empty derivation, or cap overflow takes a typed
				// bounded fallback — never a silent broad run.
				type TestSelection = {
					source: 'impact_analysis' | 'explicit_override' | 'fallback';
					resolved_test_files: string[];
					fallback_reason?: string;
				};
				let selection: TestSelection;
				if (typedArgs.files && typedArgs.files.length > 0) {
					selection = {
						source: 'explicit_override',
						resolved_test_files: typedArgs.files,
					};
				} else {
					const sourceFilesForImpact = typedArgs.source_files ?? [];
					try {
						const impactResult =
							await _internals.mutationInternals.analyzeImpact(
								sourceFilesForImpact,
								cwd,
								MAX_SAFE_TEST_FILES,
							);
						if (impactResult.impactedTests.length === 0) {
							selection = {
								source: 'fallback',
								resolved_test_files: [],
								fallback_reason:
									'impact analysis found no impacted tests for the given source files; pass explicit files to override',
							};
						} else if (
							impactResult.impactedTests.length > MAX_SAFE_TEST_FILES
						) {
							selection = {
								source: 'fallback',
								resolved_test_files: [],
								fallback_reason: `derived test set (${impactResult.impactedTests.length}) exceeds the safe cap of ${MAX_SAFE_TEST_FILES}; narrow the source files or pass explicit files to override`,
							};
						} else {
							selection = {
								source: 'impact_analysis',
								resolved_test_files: impactResult.impactedTests.map(
									(absPath) => {
										const relativePath = path.relative(cwd, absPath);
										return path.isAbsolute(relativePath)
											? absPath
											: relativePath;
									},
								),
							};
						}
					} catch (err) {
						selection = {
							source: 'fallback',
							resolved_test_files: [],
							fallback_reason: `impact analysis failed (${err instanceof Error ? err.message : String(err)}); pass explicit files to override`,
						};
					}
				}

				if (selection.source === 'fallback') {
					// Bounded typed refusal: nothing runs, everything is reported.
					return JSON.stringify(
						{
							success: false,
							error:
								'mutation_test could not resolve a bounded test set for the requested sources',
							test_selection: selection,
							evaluability: {
								evaluable: false,
								reason: selection.fallback_reason ?? 'no test selection',
							},
						},
						null,
						2,
					);
				}

				const report: MutationReport = await executeMutationSuite(
					typedArgs.patches,
					typedArgs.test_command,
					selection.resolved_test_files,
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

				// Evaluability (issue #2492): report whether the batch could be evaluated
				// at all, plus the per-outcome counts behind the verdict.
				// A completed batch against a resolved test set is evaluable: a
				// verdict was computed. Killability proportions ride the reason and
				// mutation_outcome_counts; the fallback refusal is the not-evaluable
				// case (reported before any run).
				const killableCount =
					report.totalMutants - report.equivalent - report.skipped;
				const evaluability = {
					evaluable: true,
					reason: `${killableCount} of ${report.totalMutants} mutants were killable (${report.equivalent} equivalent, ${report.skipped} skipped)`,
				};

				// Cache refresh (issue #2492): every completed gate verdict
				// invalidates the cached impact-map selection so the next load
				// rebuilds from current test imports. Invalidation is O(1) — no
				// whole-tree rescan on the response path; a failure here never
				// fails the batch.
				let cache_refreshed = false;
				try {
					const cachePath = path.join(
						cwd,
						'.swarm',
						'cache',
						'impact-map.json',
					);
					await fs.promises.unlink(cachePath);
					cache_refreshed = true;
				} catch (err) {
					// ENOENT: no cache existed — nothing stale to invalidate; the
					// next load rebuilds from disk either way.
					cache_refreshed =
						err instanceof Error &&
						(err as NodeJS.ErrnoException).code === 'ENOENT';
				}

				return JSON.stringify(
					{
						...result,
						test_selection: selection,
						evaluability,
						mutation_outcome_counts: {
							killed: report.killed,
							survived: report.survived,
							equivalent: report.equivalent,
							skipped: report.skipped,
							total: report.totalMutants,
						},
						cache_refreshed,
					},
					null,
					2,
				);
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

export const _internals: {
	mutationInternals: {
		analyzeImpact: typeof analyzeImpact;
	};
} = {
	mutationInternals: { analyzeImpact },
};
