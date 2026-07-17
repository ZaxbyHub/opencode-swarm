import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { validateTargetWithinRoot } from '../utils/path-security';
import { createSwarmTool } from './create-tool';
import {
	consumeExtractCodeBlocksPlan,
	type ExtractCodeBlocksArgs,
	type ExtractCodeBlocksPlan,
} from './file-extractor-planner';

export { extractFilename } from './file-extractor-planner';

function closeAll(descriptors: number[]): void {
	for (const descriptor of descriptors) {
		try {
			fs.closeSync(descriptor);
		} catch {
			// Best-effort cleanup after a failed transaction.
		}
	}
}

function removeCreatedFiles(filePaths: string[]): void {
	for (const filePath of filePaths) {
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Best-effort rollback. O_EXCL guarantees these were created by us.
		}
	}
}

function removeEmptyCreatedDirectories(
	targetDir: string,
	directory: string,
): void {
	let current = targetDir;
	while (current !== directory) {
		try {
			fs.rmdirSync(current);
		} catch {
			break;
		}
		const parent = path.dirname(current);
		if (parent === current || path.relative(directory, parent).startsWith('..'))
			break;
		current = parent;
	}
}

/** Extract code blocks from content and save them as one atomic write set. */
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
	execute: async (unknownArgs: unknown, directory: string) => {
		const args = unknownArgs as ExtractCodeBlocksArgs;
		let plan: ExtractCodeBlocksPlan;
		try {
			plan = consumeExtractCodeBlocksPlan(args, directory);
		} catch (error) {
			return `Error: extraction planning failed — ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		if (plan.status === 'noop') {
			return plan.reason === 'content-required'
				? 'Error: content is required'
				: 'No code blocks found in content.';
		}
		if (plan.status === 'invalid') return `Error: ${plan.reason}`;

		// Revalidate every final, collision-resolved target before the first
		// mutation. A failure anywhere aborts the complete write set.
		for (const file of plan.files) {
			const reason = validateTargetWithinRoot(file.relativePath, directory);
			if (reason)
				return `Error: Rejected write outside workspace: ${file.absolutePath} — ${reason}`;
		}

		const targetDirExisted = fs.existsSync(plan.targetDir);
		const descriptors: number[] = [];
		const createdFiles: string[] = [];
		try {
			if (!targetDirExisted) fs.mkdirSync(plan.targetDir, { recursive: true });

			// Parent canonicalization can change while mkdir runs. Check the whole
			// target set again, then reserve every leaf with O_EXCL before writing.
			for (const file of plan.files) {
				const reason = validateTargetWithinRoot(file.relativePath, directory);
				if (reason)
					throw new Error(
						`Rejected write outside workspace: ${file.absolutePath} — ${reason}`,
					);
				const descriptor = fs.openSync(
					file.absolutePath,
					fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
				);
				descriptors.push(descriptor);
				createdFiles.push(file.absolutePath);
			}

			for (let index = 0; index < plan.files.length; index++) {
				const descriptor = descriptors[index];
				const file = plan.files[index];
				if (descriptor === undefined || file === undefined) {
					throw new Error('Internal extraction transaction mismatch');
				}
				fs.writeFileSync(descriptor, file.code, 'utf8');
			}
		} catch (error) {
			closeAll(descriptors);
			removeCreatedFiles(createdFiles);
			if (!targetDirExisted)
				removeEmptyCreatedDirectories(plan.targetDir, directory);
			return `Error: extraction transaction aborted — ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		closeAll(descriptors);

		let result = `Extracted ${plan.files.length} file(s):\n`;
		for (const file of plan.files) result += `  - ${file.absolutePath}\n`;
		return result;
	},
});
