import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { validateTargetWithinRoot } from '../utils/path-security';
import { createSwarmTool } from './create-tool';

// Language to extension mapping
const EXT_MAP: Record<string, string> = {
	python: '.py',
	py: '.py',
	powershell: '.ps1',
	ps1: '.ps1',
	pwsh: '.ps1',
	javascript: '.js',
	js: '.js',
	typescript: '.ts',
	ts: '.ts',
	bash: '.sh',
	sh: '.sh',
	json: '.json',
	yaml: '.yaml',
	yml: '.yaml',
	xml: '.xml',
	html: '.html',
	css: '.css',
	sql: '.sql',
	pester: '.Tests.ps1',
	test: '.Tests.ps1',
	'': '.txt',
};

/**
 * Extract filename from code content or context
 */
export function extractFilename(
	code: string,
	language: string,
	index: number,
): string {
	const lines = code.trim().split('\n');
	const ext = EXT_MAP[language.toLowerCase()] ?? '.txt';

	// Check first line for filename comment
	if (lines.length > 0) {
		const firstLine = lines[0].trim();

		// # filename: example.ps1 or // filename: example.js
		const filenameMatch = firstLine.match(/^[#/]+\s*filename[:\s]+(\S+\.\w+)/i);
		if (filenameMatch) {
			return filenameMatch[1];
		}

		// # example.ps1 (bare filename)
		const bareMatch = firstLine.match(/^[#/]+\s*(\w+\.\w+)\s*$/);
		if (bareMatch) {
			return bareMatch[1];
		}
	}

	// Check for function/class definitions
	for (const line of lines.slice(0, 5)) {
		// def function_name( or class ClassName(
		const defMatch = line.match(/^(?:def\s+|class\s+)(\w+)/);
		if (defMatch && !defMatch[1].startsWith('_')) {
			return `${defMatch[1]}${ext}`;
		}

		// function FunctionName or Function-Name
		const psMatch = line.match(/^function\s+([\w-]+)/i);
		if (psMatch) {
			return `${psMatch[1]}${ext}`;
		}
	}

	// Fallback to timestamp-based name
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return `output_${index + 1}_${timestamp}${ext}`;
}

/**
 * Extract code blocks from content and save to files
 */
export const extract_code_blocks: ToolDefinition = createSwarmTool({
	description:
		'Extract code blocks from text content and save them to files. ' +
		'Parses markdown-style code fences (```language...```) and saves each block. ' +
		'Automatically determines filenames from comments or function names.',
	args: {
		content: z
			.string()
			.describe('Text content containing code blocks to extract'),
		output_dir: z
			.string()
			.optional()
			.describe('Directory to save files (defaults to current directory)'),
		prefix: z
			.string()
			.optional()
			.describe('Optional prefix for generated filenames'),
	},
	execute: async (args: unknown, directory: string) => {
		const { content, output_dir, prefix } = args as {
			content?: string;
			output_dir?: string;
			prefix?: string;
		};

		// SECURITY: output_dir is untrusted input. It must resolve inside the
		// workspace root (`directory`). Reject absolute paths, traversal, and
		// symlink escapes before creating any directory. Without this,
		// extract_code_blocks is an arbitrary out-of-workspace write primitive
		// reachable by (formerly read-only) agents.
		let targetDir: string;
		if (output_dir && output_dir.trim() !== '') {
			const dirReason = validateTargetWithinRoot(output_dir, directory);
			if (dirReason) {
				return `Error: output_dir rejected — ${dirReason}`;
			}
			targetDir = path.resolve(directory, output_dir);
		} else {
			targetDir = directory;
		}

		// Ensure output directory exists
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		// Validate content
		if (!content) {
			return 'Error: content is required';
		}

		// Extract code blocks
		const pattern = /```(\w*)\n([\s\S]*?)```/g;
		const matches = [...content.matchAll(pattern)];

		if (matches.length === 0) {
			return 'No code blocks found in content.';
		}

		const savedFiles: string[] = [];
		const errors: string[] = [];

		for (let i = 0; i < matches.length; i++) {
			const [, language, code] = matches[i];
			let filename = extractFilename(code, language, i);

			// Apply prefix if provided
			if (prefix) {
				filename = `${prefix}_${filename}`;
			}

			// SECURITY: filenames are derived from untrusted `# filename:` comments
			// in LLM-generated content. Require a bare filename — reject anything
			// containing path separators, traversal, or an absolute component so a
			// crafted comment (e.g. `# filename: ../../evil.sh`) cannot escape
			// targetDir.
			if (
				filename.includes('/') ||
				filename.includes('\\') ||
				validateTargetWithinRoot(filename, targetDir) !== null
			) {
				errors.push(
					`Rejected unsafe filename (must be a bare name): ${filename}`,
				);
				continue;
			}

			let filepath = path.join(targetDir, filename);

			// Avoid overwriting - add counter if exists
			const base = path.basename(filepath, path.extname(filepath));
			const ext = path.extname(filepath);
			let counter = 1;
			while (fs.existsSync(filepath)) {
				filepath = path.join(targetDir, `${base}_${counter}${ext}`);
				counter++;
			}

			// Defense in depth: the final resolved path must stay inside the
			// workspace root even after collision-avoidance renaming.
			if (
				validateTargetWithinRoot(
					path.relative(directory, filepath),
					directory,
				) !== null
			) {
				errors.push(`Rejected write outside workspace: ${filepath}`);
				continue;
			}

			// SECURITY (issue #1778 C1): reject a final path that is itself a
			// symlink — including a BROKEN one whose target does not exist.
			// fs.existsSync follows links (a broken link reads as absent, so the
			// collision loop skips it) and a plain write would then follow the
			// link and write OUTSIDE the workspace. lstat does not follow links,
			// so it detects the symlink; it throws only when nothing exists at the
			// path (the normal new-file case), which is safe to proceed with. This
			// pre-check gives an early, specific error message.
			try {
				if (fs.lstatSync(filepath).isSymbolicLink()) {
					errors.push(`Rejected write through symlink: ${filepath}`);
					continue;
				}
			} catch {
				// Path does not exist at all — a genuine new-file write. Proceed.
			}

			// SECURITY (PR #1790 review F-L2-002): the lstat check above and the
			// write below are two separate syscalls with no atomicity between
			// them — a TOCTOU window where an attacker with local write access to
			// targetDir could plant a symlink after the check but before the
			// write. Open with O_CREAT|O_EXCL instead of a plain write: per POSIX,
			// when O_EXCL is set, open() does not follow a symlink at the final
			// path component and fails with EEXIST if ANY entry (including a
			// symlink, broken or not) already occupies that name; on Windows this
			// maps to CreateFile's CREATE_NEW disposition, which fails the same
			// way on an existing reparse point. This closes the race atomically
			// without depending on the platform-inconsistent O_NOFOLLOW flag.
			let fd: number | undefined;
			try {
				fd = fs.openSync(
					filepath,
					fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
				);
				// writeFileSync (not writeSync) so a short write can't silently
				// truncate the file — it loops internally until the full buffer
				// is written, and passing a fd (vs. a path) does not close it.
				fs.writeFileSync(fd, code.trim(), 'utf-8');
				savedFiles.push(filepath);
			} catch (error) {
				errors.push(
					`Failed to save ${filename}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				if (fd !== undefined) {
					try {
						fs.closeSync(fd);
					} catch {
						// best-effort close
					}
				}
			}
		}

		let result = `Extracted ${savedFiles.length} file(s):\n`;
		for (const file of savedFiles) {
			result += `  - ${file}\n`;
		}

		if (errors.length > 0) {
			result += `\nErrors:\n`;
			for (const err of errors) {
				result += `  - ${err}\n`;
			}
		}

		return result;
	},
});
