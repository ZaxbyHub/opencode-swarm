import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { type ASTDiffResult, computeASTDiff } from '../diff/ast-diff.js';
import {
	type ChangeCategory,
	classifyChanges,
	type RiskLevel,
} from '../diff/semantic-classifier.js';
import { generateSummary } from '../diff/summary-generator.js';
import { createSwarmTool } from './create-tool';

export interface DiffSummaryArgs {
	files: string[];
	classification?: ChangeCategory;
	riskLevel?: RiskLevel;
}

interface DiffSummaryError {
	error: string;
	success: false;
}

/**
 * Standalone tool that wraps the semantic classifier + summary generator
 * to produce a filtered SemanticDiffSummary.
 */
export const diff_summary: ReturnType<typeof createSwarmTool> = createSwarmTool(
	{
		description:
			'Generate a filtered semantic diff summary from AST analysis. Returns SemanticDiffSummary with optional filtering by classification or riskLevel.',
		args: {
			files: z.array(z.string()).describe('Array of file paths to analyze'),
			classification: z
				.string()
				.optional()
				.describe('Filter results to only this ChangeCategory'),
			riskLevel: z
				.string()
				.optional()
				.describe('Filter results to only this RiskLevel'),
		},
		async execute(
			args: unknown,
			directory: string,
			_ctx?: ToolContext,
		): Promise<string> {
			const typedArgs = args as DiffSummaryArgs;

			try {
				// Validate files array
				if (
					!typedArgs.files ||
					!Array.isArray(typedArgs.files) ||
					typedArgs.files.length === 0
				) {
					const errorResult: DiffSummaryError = {
						error: 'files must be a non-empty array of file paths',
						success: false,
					};
					return JSON.stringify(errorResult, null, 2);
				}

				const workingDir = directory || process.cwd();

				// Get old content from HEAD and new content from working tree for each file
				const astDiffs: ASTDiffResult[] = [];

				for (const filePath of typedArgs.files) {
					let astResult: ASTDiffResult | null = null;
					let gitBinaryMissing = false;
					let gitError: unknown = null;
					let fileExistsInHead = false;

					// Git cat-file check wrapped in its own try/catch to separate git ENOENT from file-read ENOENT
					try {
						child_process.execFileSync(
							'git',
							['cat-file', '-e', `HEAD:${filePath}`],
							{
								encoding: 'utf-8',
								timeout: 3000,
								cwd: workingDir,
								stdio: 'pipe',
							},
						);
						fileExistsInHead = true;
					} catch (e: unknown) {
						// If git binary itself is missing or crashed, that's critical
						if (e && typeof e === 'object' && 'code' in e) {
							const err = e as { code?: string; status?: number };
							if (err.code === 'ENOENT') {
								gitBinaryMissing = true;
								gitError = e;
							}
						}
						// git ran but file not in HEAD — it's a new/untracked file
						// fileExistsInHead stays false
					}

					// Propagate git binary ENOENT immediately — don't let it be caught by outer catch
					if (gitBinaryMissing && gitError) {
						throw gitError;
					}

					try {
						let oldContent: string;
						const newContent: string = fs.readFileSync(
							path.join(workingDir, filePath),
							'utf-8',
						);

						if (fileExistsInHead) {
							// File exists in HEAD, get old content
							oldContent = child_process.execFileSync(
								'git',
								['show', `HEAD:${filePath}`],
								{
									encoding: 'utf-8',
									timeout: 5000,
									cwd: workingDir,
									stdio: 'pipe',
									maxBuffer: 5 * 1024 * 1024,
								},
							);
						} else {
							// New file — no previous content
							oldContent = '';
						}

						astResult = await computeASTDiff(filePath, oldContent, newContent);
					} catch (_e: unknown) {
						// Silently skip: file-read errors (including deleted files) and parse failures
						astResult = null;
					}

					// Include results with changes OR error-only results (usedAST: false with error message)
					if (
						astResult &&
						(astResult.changes.length > 0 || astResult.error !== undefined)
					) {
						astDiffs.push(astResult);
					}
				}

				// Classify all changes
				const allClassifiedChanges = classifyChanges(astDiffs);

				// Apply filters if provided
				let filteredChanges = allClassifiedChanges;

				if (typedArgs.classification) {
					filteredChanges = filteredChanges.filter(
						(change) => change.category === typedArgs.classification,
					);
				}

				if (typedArgs.riskLevel) {
					filteredChanges = filteredChanges.filter(
						(change) => change.riskLevel === typedArgs.riskLevel,
					);
				}

				// Generate summary from filtered changes
				const summary = generateSummary(filteredChanges);

				return JSON.stringify(summary, null, 2);
			} catch (e) {
				const errorResult: DiffSummaryError = {
					error:
						e instanceof Error
							? `diff_summary failed: ${e.message}`
							: 'diff_summary failed: unknown error',
					success: false,
				};
				return JSON.stringify(errorResult, null, 2);
			}
		},
	},
);
