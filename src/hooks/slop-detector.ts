/**
 * Slop detector — PostToolUse hook that checks for AI code quality anti-patterns.
 * Fires after Write and Edit tool calls. Runs 4 heuristics and emits an advisory
 * system message when findings are detected. Non-blocking, <500ms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SlopDetectorConfig } from '../config/schema';
export type { SlopDetectorConfig };

const WRITE_EDIT_TOOLS = new Set([
	'write',
	'edit',
	'apply_patch',
	'create_file',
]);

interface SlopFinding {
	type:
		| 'abstraction_bloat'
		| 'dead_export'
		| 'comment_strip'
		| 'boilerplate_explosion'
		| 'stale_import'
		| 'duplicate_utility';
	detail: string;
}

/**
 * Count occurrences of a pattern in a string.
 */
function countMatches(text: string, pattern: RegExp): number {
	return (text.match(pattern) ?? []).length;
}

/**
 * Heuristic 1: Abstraction bloat — 3+ new class declarations in a single diff.
 */
function checkAbstractionBloat(
	content: string,
	threshold: number,
): SlopFinding | null {
	const newClasses = countMatches(
		content,
		/^\+.*\b(?:class|struct|impl)\s+\w+/gm,
	);
	if (newClasses >= threshold) {
		return {
			type: 'abstraction_bloat',
			detail: `${newClasses} new class declarations added (threshold: ${threshold}). Consider whether all abstractions are necessary.`,
		};
	}
	return null;
}

/**
 * Heuristic 2: Comment stripping — removed 5+ comment lines, added zero.
 */
function checkCommentStrip(
	content: string,
	threshold: number,
): SlopFinding | null {
	const removedComments = countMatches(content, /^-\s*(?:\/[/*]|#|--)/gm);
	const addedComments = countMatches(content, /^\+\s*(?:\/[/*]|#|--)/gm);
	if (removedComments >= threshold && addedComments === 0) {
		return {
			type: 'comment_strip',
			detail: `${removedComments} comment lines removed and 0 added. Verify comments were not documenting important behaviour.`,
		};
	}
	return null;
}

/**
 * Heuristic 3: Boilerplate explosion — 200+ lines added for a fix/patch/update/tweak task.
 */
function checkBoilerplateExplosion(
	content: string,
	taskDescription: string,
	threshold: number,
): SlopFinding | null {
	const addedLines = countMatches(content, /^\+[^+]/gm);
	const isSmallTask =
		/\b(fix|patch|update|tweak|adjust|correct|remove|rename|change)\b/i.test(
			taskDescription,
		);
	if (isSmallTask && addedLines >= threshold) {
		return {
			type: 'boilerplate_explosion',
			detail: `${addedLines} lines added for a "${taskDescription.slice(0, 40)}" task (threshold: ${threshold}). Review for scope creep.`,
		};
	}
	return null;
}

/**
 * Recursively walk a directory and collect all files matching any of the given extensions.
 * Excludes node_modules, .git, and symlinks pointing to directories (prevents infinite loops).
 */
function walkFiles(dir: string, exts: string[], deadline?: number): string[] {
	const results: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (deadline !== undefined && Date.now() > deadline) break; // time budget
			if (entry.isSymbolicLink()) continue; // skip symlinks to avoid infinite loops
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') continue;
				results.push(...walkFiles(full, exts, deadline));
			} else if (entry.isFile()) {
				if (exts.some((ext) => entry.name.endsWith(ext))) {
					results.push(full);
				}
			}
		}
	} catch {
		/* skip permission errors */
	}
	return results;
}

/**
 * Heuristic 4: Dead exports — new export not found in any project import.
 * Quick grep-style check using a file read. Fast approximation only.
 */
function checkDeadExports(
	content: string,
	projectDir: string,
	startTime: number,
): SlopFinding | null {
	// Dead-export heuristic only applies to JS/TS projects
	const hasPackageJson = fs.existsSync(path.join(projectDir, 'package.json'));
	if (!hasPackageJson) return null;

	const exportMatches = content.matchAll(
		/^\+(?:export)\s+(?:function|class|const|type|interface)\s+(\w{3,})/gm,
	);
	const newExports: string[] = [];
	for (const match of exportMatches) {
		if (match[1]) newExports.push(match[1]);
	}
	if (newExports.length === 0) return null;

	const files = walkFiles(
		projectDir,
		['.ts', '.tsx', '.js', '.jsx'],
		startTime + 480,
	);

	const deadExports: string[] = [];
	for (const name of newExports) {
		if (Date.now() - startTime > 480) break; // time budget
		try {
			const importPattern = new RegExp(`\\bimport\\b[^;]*\\b${name}\\b`, 'g');
			let found = false;
			for (const file of files) {
				if (found || Date.now() - startTime > 480) break; // time budget inside loop
				try {
					const text = fs.readFileSync(file, 'utf-8');
					if (importPattern.test(text)) found = true;
					importPattern.lastIndex = 0; // reset for reuse
				} catch {
					// skip unreadable files
				}
			}
			if (!found) deadExports.push(name);
		} catch {
			// skip on any error
		}
	}

	if (deadExports.length === 0) return null;
	return {
		type: 'dead_export',
		detail: `New exports not found in any import: ${deadExports.slice(0, 3).join(', ')}. Verify these are intentionally exported.`,
	};
}

/**
 * Heuristic 5: Stale imports — import identifiers not used in the file body.
 * Lightweight check using regex on the content only (no file-system search).
 */
function checkStaleImports(
	content: string,
	threshold: number,
): SlopFinding | null {
	const lines = content.split('\n');
	const importLines: number[] = [];
	const importIdentifiers: string[] = [];

	const namedImportRe = /^(?:\+)?import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/;
	const defaultImportRe = /^(?:\+)?import\s+(\w+)\s+from\s*['"][^'"]+['"]/;
	const nsImportRe = /^(?:\+)?import\s+\*\s+as\s+(\w+)\s+from\s*['"][^'"]+['"]/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/^[+-]/, '');
		const trimmed = line.trim();

		if (trimmed.startsWith('export {') || trimmed.startsWith('export type {'))
			continue;

		const named = namedImportRe.exec(trimmed);
		if (named) {
			importLines.push(i);
			for (const part of named[1].split(',')) {
				const cleaned = part
					.trim()
					.replace(/^type\s+/, '')
					.split(/\s+as\s+/)
					.pop()
					?.trim();
				if (cleaned && /^\w+$/.test(cleaned) && cleaned.length >= 2) {
					importIdentifiers.push(cleaned);
				}
			}
			continue;
		}

		const ns = nsImportRe.exec(trimmed);
		if (ns?.[1]) {
			importLines.push(i);
			importIdentifiers.push(ns[1]);
			continue;
		}

		const def = defaultImportRe.exec(trimmed);
		if (def?.[1] && def[1] !== 'type') {
			importLines.push(i);
			importIdentifiers.push(def[1]);
		}
	}

	if (importIdentifiers.length === 0) return null;

	const bodyLines = lines.filter((_, i) => !importLines.includes(i));
	const body = bodyLines.join('\n');

	const staleImports: string[] = [];
	for (const id of importIdentifiers) {
		const usageRe = new RegExp(`\\b${id}\\b`);
		if (!usageRe.test(body)) {
			staleImports.push(id);
		}
	}

	if (staleImports.length < threshold) return null;

	return {
		type: 'stale_import',
		detail: `${staleImports.length} unused import identifier(s): ${staleImports.slice(0, 3).join(', ')}${staleImports.length > 3 ? '...' : ''}. Remove stale imports.`,
	};
}

/**
 * Heuristic 6: Duplicate utility — new export name already exists in utility directories.
 * Checks src/utils/, src/hooks/, src/tools/, src/services/ for name collisions.
 */
function checkDuplicateUtility(
	content: string,
	projectDir: string,
	startTime: number,
	targetFile?: string,
): SlopFinding | null {
	// Parse new export names using the same regex as checkDeadExports
	const exportMatches = content.matchAll(
		/^\+(?:export)\s+(?:function|class|const|type|interface)\s+(\w{3,})/gm,
	);
	const newExports: string[] = [];
	for (const match of exportMatches) {
		if (match[1]) newExports.push(match[1]);
	}
	if (newExports.length === 0) return null;

	// Time budget: 480ms max
	const deadline = startTime + 480;

	// Walk utility directories for name collision
	const utilityDirs = [
		'src/utils/',
		'src/hooks/',
		'src/tools/',
		'src/services/',
	];
	for (const utilDir of utilityDirs) {
		if (Date.now() > deadline) break;
		const utilPath = path.join(projectDir, utilDir);
		if (!fs.existsSync(utilPath)) continue;

		const files = walkFiles(utilPath, ['.ts', '.tsx', '.js', '.jsx'], deadline);
		for (const file of files) {
			if (Date.now() > deadline) break;
			// Skip the file currently being written/edited to avoid false positives
			if (targetFile && path.resolve(file) === path.resolve(targetFile))
				continue;
			try {
				const text = fs.readFileSync(file, 'utf-8');
				// Check if file exports something with the same name
				for (const name of newExports) {
					// Look for export declaration with this name
					const exportPattern = new RegExp(
						`\\bexport\\s+(?:function|class|const|type|interface)\\s+${name}\\b`,
					);
					if (exportPattern.test(text)) {
						return {
							type: 'duplicate_utility',
							detail: `New export "${name}" already exists in ${utilDir}. Reuse the existing utility instead of duplicating it.`,
						};
					}
				}
			} catch {
				// skip unreadable files
			}
		}
	}

	return null;
}

export interface SlopDetectorHook {
	toolAfter: (
		input: { tool: string; sessionID: string },
		output: { output?: unknown; args?: unknown },
	) => Promise<void>;
}

export function createSlopDetectorHook(
	config: SlopDetectorConfig,
	projectDir: string,
	injectSystemMessage: (sessionId: string, message: string) => void,
): SlopDetectorHook {
	return {
		toolAfter: async (input, output) => {
			if (!config.enabled) return;
			if (!WRITE_EDIT_TOOLS.has(input.tool.toLowerCase())) return;

			// Extract actual written/edited content from args (not output.output which is a confirmation msg)
			const args = output.args as Record<string, unknown> | undefined;
			const content = (() => {
				if (typeof args?.content === 'string') return args.content; // write
				if (typeof args?.newString === 'string') return args.newString; // edit
				if (typeof args?.patch === 'string') return args.patch; // apply_patch
				if (typeof args?.file_text === 'string') return args.file_text; // create_file
				return '';
			})();
			if (!content || content.length < 10) return;

			// Get target file path for self-exclusion in duplicate utility check
			const targetFilePath =
				typeof args?.filePath === 'string' ? args.filePath : undefined;

			// Get task description from args for boilerplate check
			const taskDescription =
				typeof args?.description === 'string'
					? args.description
					: typeof args?.task === 'string'
						? args.task
						: '';

			const startTime = Date.now();
			const findings: SlopFinding[] = [];

			try {
				const bloat = checkAbstractionBloat(content, config.classThreshold);
				if (bloat) findings.push(bloat);

				const strip = checkCommentStrip(content, config.commentStripThreshold);
				if (strip) findings.push(strip);

				const explosion = checkBoilerplateExplosion(
					content,
					taskDescription,
					config.diffLineThreshold,
				);
				if (explosion) findings.push(explosion);
			} catch {
				// heuristics 1-3 are best-effort — never let them fail the hook
			}

			if (Date.now() - startTime < 400) {
				try {
					const dead = checkDeadExports(content, projectDir, startTime);
					if (dead) findings.push(dead);
				} catch {
					// dead export check is best-effort
				}

				// heuristic 6: duplicate utility check
				try {
					const dupUtil = checkDuplicateUtility(
						content,
						projectDir,
						startTime,
						targetFilePath,
					);
					if (dupUtil) findings.push(dupUtil);
				} catch {
					// duplicate utility check is best-effort
				}
			}

			// heuristic 5: stale imports
			try {
				const stale = checkStaleImports(
					content,
					config.importHygieneThreshold ?? 2,
				);
				if (stale) findings.push(stale);
			} catch {
				// stale import check is best-effort
			}

			if (findings.length === 0) return;

			const findingText = findings
				.map((f) => `  • ${f.type}: ${f.detail}`)
				.join('\n');
			const message = `SLOP CHECK: ${findings.length} potential issue(s) detected after ${input.tool}:\n${findingText}\nReview before proceeding.`;

			injectSystemMessage(input.sessionID, message);
		},
	};
}
