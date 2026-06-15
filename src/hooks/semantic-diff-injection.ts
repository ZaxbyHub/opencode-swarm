/**
 * Semantic diff injection for the system-enhancer hook.
 *
 * Computes a semantic AST diff summary for changed files and produces
 * a markdown block for injection into the reviewer agent's context.
 *
 * Failure mode: silent. If git is unavailable or AST diff fails,
 * returns null — the reviewer simply doesn't get the extra context.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ASTDiffResult, computeASTDiff } from '../diff/ast-diff.js';
import {
	type ClassifiedChange,
	classifyChanges,
} from '../diff/semantic-classifier.js';
import {
	generateSummary,
	generateSummaryMarkdown,
	type SemanticDiffSummary,
} from '../diff/summary-generator.js';
import { getImporters, normalizeGraphPath } from '../tools/repo-graph.js';
import {
	GitBinaryMissingError,
	isGitBinaryMissing,
} from '../utils/git-binary-missing-error.js';
import { getCachedGraph } from './repo-graph-injection.js';

async function execGit(
	directory: string,
	args: string[],
	options?: {
		timeout?: number;
		maxBuffer?: number;
	},
): Promise<string> {
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			const execOpts: Record<string, unknown> = {
				encoding: 'utf-8',
				cwd: directory,
				timeout: options?.timeout,
				maxBuffer: options?.maxBuffer,
				stdio: ['ignore', 'pipe', 'pipe'],
			};
			child_process.execFile(
				'git',
				args,
				execOpts as child_process.ExecFileOptionsWithStringEncoding,
				(
					error: child_process.ExecFileException | null,
					output: string,
					_stderr: string,
				) => {
					if (error) {
						reject(error);
						return;
					}
					resolve(output ?? '');
				},
			);
		});
		return stdout;
	} catch (err) {
		if (isGitBinaryMissing(err)) {
			throw new GitBinaryMissingError('git binary is not available', {
				cause: err,
			});
		}
		throw err;
	}
}

/**
 * Build a semantic diff summary block for the given changed files.
 *
 * For each file:
 * 1. Gets old content from git HEAD (cat-file -e check first)
 * 2. Gets new content from working tree
 * 3. Runs computeASTDiff
 * 4. Collects all AST diffs
 * 5. Builds fileConsumers map from repo graph (getImporters().length per file)
 * 6. Runs classifyChanges with fileConsumers
 * 7. Runs generateSummary + generateSummaryMarkdown
 *
 * Returns null if no changes are detected or on failure.
 */
export async function buildSemanticDiffBlock(
	directory: string,
	changedFiles: string[],
	maxFiles = 10,
): Promise<string | null> {
	if (changedFiles.length === 0) return null;

	try {
		const realDirectory = fs.realpathSync(directory);

		// Cap to prevent excessive computation
		const filesToProcess = changedFiles.slice(0, maxFiles);

		const astDiffs: ASTDiffResult[] = [];

		// Build fileConsumers map from repo graph
		const graph = getCachedGraph(directory);
		const fileConsumers: Record<string, number> = {};
		if (graph) {
			for (const f of filesToProcess) {
				// Relativize against directory for graph key matching
				const relativePath = path.isAbsolute(f)
					? path.relative(directory, f)
					: f;
				const normalized = normalizeGraphPath(relativePath);
				fileConsumers[normalized] = getImporters(graph, normalized).length;
				// Store with original path for classifyChanges lookup
				fileConsumers[f] = fileConsumers[normalized];
			}
		}

		for (const filePath of filesToProcess) {
			const normalizedPath = path.normalize(filePath);
			const resolvedPath = path.resolve(directory, normalizedPath);
			const relativeToDir = path.relative(directory, resolvedPath);
			if (relativeToDir.startsWith('..') || path.isAbsolute(relativeToDir)) {
				continue; // Skip files that escape the repo root
			}

			let realResolvedPath: string;
			try {
				realResolvedPath = fs.realpathSync(resolvedPath);
			} catch {
				// Broken symlink or missing file — skip gracefully
				continue;
			}

			const realRelativeToDir = path.relative(realDirectory, realResolvedPath);
			if (
				realRelativeToDir.startsWith('..') ||
				path.isAbsolute(realRelativeToDir)
			) {
				continue; // Symlink escapes repo root
			}

			try {
				// Check if file exists in HEAD
				let fileExistsInHead = false;
				try {
					await execGit(directory, ['cat-file', '-e', `HEAD:${filePath}`], {
						timeout: 3000,
					});
					fileExistsInHead = true;
				} catch (err) {
					// git binary ENOENT (missing binary) — abort immediately
					if (err instanceof GitBinaryMissingError) {
						throw err;
					}
					// Otherwise git ran but file not in HEAD — treat as new/untracked file
					fileExistsInHead = false;
				}

				const oldContent = fileExistsInHead
					? await execGit(directory, ['show', `HEAD:${filePath}`], {
							timeout: 5000,
							maxBuffer: 5 * 1024 * 1024,
						})
					: '';

				const newContent = await fs.promises.readFile(
					realResolvedPath,
					'utf-8',
				);

				const astResult = await computeASTDiff(
					filePath,
					oldContent,
					newContent,
				);

				if (
					astResult &&
					(astResult.changes.length > 0 || astResult.error !== undefined)
				) {
					astDiffs.push(astResult);
				}
			} catch (err) {
				// Re-throw git binary ENOENT to outer catch (returns null for whole block)
				// But NOT fs.readFile ENOENT (deleted files should be silently skipped)
				if (err instanceof GitBinaryMissingError) {
					throw err;
				}
				// Parse failure, deleted file ENOENT, or other error — skip this file
			}
		}

		if (astDiffs.length === 0) return null;

		const classifiedChanges: ClassifiedChange[] = classifyChanges(
			astDiffs,
			fileConsumers,
		);

		if (classifiedChanges.length === 0) return null;

		const summary: SemanticDiffSummary = generateSummary(classifiedChanges);
		const markdown = generateSummaryMarkdown(summary);

		return `## SEMANTIC DIFF SUMMARY\n${markdown}`;
	} catch {
		// Always return null — never throw
		return null;
	}
}
