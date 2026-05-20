import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
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
		const targetDir = output_dir || directory;

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

			let filepath = path.join(targetDir, filename);

			// Avoid overwriting - add counter if exists
			const base = path.basename(filepath, path.extname(filepath));
			const ext = path.extname(filepath);
			let counter = 1;
			while (fs.existsSync(filepath)) {
				filepath = path.join(targetDir, `${base}_${counter}${ext}`);
				counter++;
			}

			try {
				fs.writeFileSync(filepath, code.trim(), 'utf-8');
				savedFiles.push(filepath);
			} catch (error) {
				errors.push(
					`Failed to save ${filename}: ${error instanceof Error ? error.message : String(error)}`,
				);
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
