import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateTargetWithinRoot } from '../utils/path-security';

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

const MAX_EXTRACTED_FILES = 256;
const MAX_COLLISION_ATTEMPTS = 10_000;

export interface ExtractCodeBlocksArgs {
	content?: string;
	output_dir?: string;
	prefix?: string;
}

export interface PlannedExtractFile {
	filename: string;
	absolutePath: string;
	relativePath: string;
	code: string;
}

export type ExtractCodeBlocksPlan =
	| { status: 'ready'; targetDir: string; files: PlannedExtractFile[] }
	| { status: 'noop'; reason: 'content-required' | 'no-code-blocks' }
	| { status: 'invalid'; reason: string };

const cachedPlans = new WeakMap<
	object,
	{ directory: string; plan: ExtractCodeBlocksPlan }
>();

/** Extract a deterministic filename from code content or context. */
export function extractFilename(
	code: string,
	language: string,
	index: number,
): string {
	const lines = code.trim().split('\n');
	const ext = EXT_MAP[language.toLowerCase()] ?? '.txt';
	const firstLine = lines[0]?.trim() ?? '';
	const filenameMatch = firstLine.match(/^[#/]+\s*filename[:\s]+(\S+\.\w+)/i);
	if (filenameMatch?.[1]) return filenameMatch[1];
	const bareMatch = firstLine.match(/^[#/]+\s*(\w+\.\w+)\s*$/);
	if (bareMatch?.[1]) return bareMatch[1];

	for (const line of lines.slice(0, 5)) {
		const defMatch = line.match(/^(?:def\s+|class\s+)(\w+)/);
		if (defMatch?.[1] && !defMatch[1].startsWith('_')) {
			return `${defMatch[1]}${ext}`;
		}
		const psMatch = line.match(/^function\s+([\w-]+)/i);
		if (psMatch?.[1]) return `${psMatch[1]}${ext}`;
	}

	// Determinism is security-relevant: pre-execution authorization and execution
	// must resolve the same target rather than generating different timestamps.
	return `output_${index + 1}${ext}`;
}

function lstatIfPresent(filePath: string): fs.Stats | null {
	try {
		return fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function reservationKey(filename: string): string {
	// A plan authorized on Linux may execute on a case-insensitive Windows or
	// macOS filesystem. Reserve case-folded names for portable collision safety.
	return path.normalize(filename).toLowerCase();
}

export function planExtractCodeBlocks(
	args: ExtractCodeBlocksArgs,
	directory: string,
): ExtractCodeBlocksPlan {
	const { content, output_dir: outputDir, prefix } = args;
	if (!content) return { status: 'noop', reason: 'content-required' };

	const matches = [...content.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
	if (matches.length === 0) return { status: 'noop', reason: 'no-code-blocks' };
	if (matches.length > MAX_EXTRACTED_FILES) {
		return {
			status: 'invalid',
			reason: `Too many code blocks (${matches.length}; maximum ${MAX_EXTRACTED_FILES})`,
		};
	}

	let targetDir = directory;
	if (outputDir !== undefined && outputDir.trim() !== '') {
		const reason = validateTargetWithinRoot(outputDir, directory);
		if (reason)
			return { status: 'invalid', reason: `output_dir rejected — ${reason}` };
		targetDir = path.resolve(directory, outputDir);
	}

	const reserved = new Set<string>();
	const files: PlannedExtractFile[] = [];
	for (let index = 0; index < matches.length; index++) {
		const language = matches[index]?.[1] ?? '';
		const code = matches[index]?.[2] ?? '';
		let filename = extractFilename(code, language, index);
		if (prefix) filename = `${prefix}_${filename}`;

		if (filename.includes('/') || filename.includes('\\')) {
			return {
				status: 'invalid',
				reason: `Rejected unsafe filename (must be a bare name): ${filename}`,
			};
		}

		const requestedPath = path.join(targetDir, filename);
		const requestedStat = lstatIfPresent(requestedPath);
		if (requestedStat?.isSymbolicLink()) {
			return {
				status: 'invalid',
				reason: `Rejected write through symlink: ${requestedPath}`,
			};
		}

		const base = path.basename(filename, path.extname(filename));
		const ext = path.extname(filename);
		let candidate = filename;
		let counter = 1;
		while (
			reserved.has(reservationKey(candidate)) ||
			lstatIfPresent(path.join(targetDir, candidate)) !== null
		) {
			if (counter > MAX_COLLISION_ATTEMPTS) {
				return {
					status: 'invalid',
					reason: `Too many filename collisions for ${filename}`,
				};
			}
			candidate = `${base}_${counter}${ext}`;
			counter++;
		}

		const absolutePath = path.join(targetDir, candidate);
		const relativePath = path.relative(directory, absolutePath) || candidate;
		const reason = validateTargetWithinRoot(relativePath, directory);
		if (reason) {
			return {
				status: 'invalid',
				reason: `Rejected write outside workspace: ${absolutePath} — ${reason}`,
			};
		}
		reserved.add(reservationKey(candidate));
		files.push({
			filename: candidate,
			absolutePath,
			relativePath,
			code: code.trim(),
		});
	}

	return { status: 'ready', targetDir, files };
}

/**
 * Plan once per tool-argument object so every pre-execution guard and the tool
 * execution itself use the exact same collision-resolved targets.
 */
export function getOrPlanExtractCodeBlocks(
	args: ExtractCodeBlocksArgs,
	directory: string,
): ExtractCodeBlocksPlan {
	if (typeof args === 'object' && args !== null) {
		const cached = cachedPlans.get(args);
		if (cached?.directory === directory) return cached.plan;
		const plan = planExtractCodeBlocks(args, directory);
		cachedPlans.set(args, { directory, plan });
		return plan;
	}
	return planExtractCodeBlocks(args, directory);
}

export function consumeExtractCodeBlocksPlan(
	args: ExtractCodeBlocksArgs,
	directory: string,
): ExtractCodeBlocksPlan {
	const plan = getOrPlanExtractCodeBlocks(args, directory);
	if (typeof args === 'object' && args !== null) cachedPlans.delete(args);
	return plan;
}
