/**
 * Completion verification tool - deterministic pre-check verifying that plan task
 * identifiers exist in their target source files before phase completion.
 * Blocks if obviously incomplete.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { hasActiveTurboMode } from '../state';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

/**
 * Arguments for the completion_verify tool
 */
export interface CompletionVerifyArgs {
	/** The phase number to check */
	phase: number;
	/** Session ID (optional, auto-provided by plugin context) */
	sessionID?: string;
	/** Explicit project root directory override */
	working_directory?: string;
}

/**
 * Result returned when a task is blocked due to missing identifier
 */
interface BlockedTask {
	task_id: string;
	identifier: string;
	file_path: string;
	reason: string;
}

/**
 * Result structure for completion verification
 */
interface CompletionVerifyResult {
	success: boolean;
	phase: number;
	status: 'passed' | 'blocked';
	reason?: string;
	tasksChecked: number;
	tasksSkipped: number;
	tasksBlocked: number;
	blockedTasks: BlockedTask[];
}

/**
 * Evidence entry for completion verification
 */
interface CompletionVerifyEntry {
	task_id: string;
	type: 'completion_verify';
	timestamp: string;
	agent: string;
	verdict: 'pass' | 'fail';
	summary: string;
	phase: number;
	tasks_checked: number;
	tasks_skipped: number;
	tasks_blocked: number;
	blocked_tasks: BlockedTask[];
}

/**
 * Evidence bundle structure
 */
interface EvidenceBundle {
	schema_version: string;
	task_id: string;
	created_at: string;
	entries: CompletionVerifyEntry[];
}

/**
 * Plan task structure (from plan.json)
 */
interface PlanTask {
	id: string;
	description: string;
	status: string;
	files_touched?: string[];
}

/**
 * Plan phase structure (from plan.json)
 */
interface PlanPhase {
	id: number;
	name: string;
	tasks: PlanTask[];
}

/**
 * Plan structure (from plan.json)
 */
interface Plan {
	phases: PlanPhase[];
}

/**
 * Extract all matches from a regex against a string.
 * Uses matchAll which requires the 'g' flag on the regex (all callers use global regexes).
 */
function extractMatches(regex: RegExp, text: string): RegExpMatchArray[] {
	return Array.from(text.matchAll(regex));
}

/**
 * Parse identifiers from a task description.
 * Matches:
 * - Backtick-wrapped identifiers: `identifier`
 * - camelCase function names: sequences starting with lowercase (at least 3 chars)
 * - PascalCase type names: sequences starting with uppercase (at least 3 chars)
 * - Config key patterns: dotted paths like config.keyName or AGENT_TOOL_MAP
 * - Quoted paths: './relative-path' or "./relative-path"
 */
function parseIdentifiers(description: string): string[] {
	const identifiers = new Set<string>();

	// Match backtick-wrapped identifiers
	const backtickRegex = /`([^`]+)`/g;
	for (const match of extractMatches(backtickRegex, description)) {
		identifiers.add(match[1]);
	}

	// Match camelCase function names (at least 3 chars, starts with lowercase)
	const camelCaseRegex = /\b([a-z][a-zA-Z0-9]{2,})\b/g;
	for (const match of extractMatches(camelCaseRegex, description)) {
		// Exclude common English words that happen to be camelCase
		const word = match[1];
		if (
			word === 'the' ||
			word === 'and' ||
			word === 'for' ||
			word === 'have' ||
			word === 'this' ||
			word === 'with' ||
			word === 'from' ||
			word === 'they' ||
			word === 'been' ||
			word === 'will' ||
			word === 'your' ||
			word === 'also'
		) {
			continue;
		}
		identifiers.add(word);
	}

	// Match PascalCase type names (at least 3 chars, starts with uppercase)
	const pascalCaseRegex = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
	for (const match of extractMatches(pascalCaseRegex, description)) {
		identifiers.add(match[1]);
	}

	// Match config keys: dotted paths like config.keyName or AGENT_TOOL_MAP
	const configKeyRegex = /\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\b/g;
	for (const match of extractMatches(configKeyRegex, description)) {
		identifiers.add(match[1]);
	}

	// Match quoted paths like './relative-path' or "./relative-path"
	const quotedPathRegex = /['"](\.{0,3}(?:src|lib|test)[/\\][^'"]+)['"]/g;
	for (const match of extractMatches(quotedPathRegex, description)) {
		identifiers.add(match[1]);
	}

	return Array.from(identifiers);
}

/**
 * Parse file paths from a task description or files_touched array.
 * If filesTouched is provided, use those paths directly.
 * Otherwise, extract file paths from description.
 */
function parseFilePaths(
	description: string,
	filesTouched?: string[],
): string[] {
	// If files_touched is provided, use those
	if (filesTouched && Array.isArray(filesTouched) && filesTouched.length > 0) {
		return filesTouched;
	}

	const filePaths: string[] = [];

	// Match common source file patterns
	// Patterns like src/**/*.ts, lib/**/*.js, src/path/file.ts
	const srcPathRegex =
		/\b(?:src|lib|test|app|packages?)[/\\][a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/g;
	for (const match of extractMatches(srcPathRegex, description)) {
		filePaths.push(match[0]);
	}

	// Match any path with forward or back slashes that looks like a file path
	// (at least 2 path segments, ending in an extension)
	const genericPathRegex =
		/\b[a-zA-Z0-9_./-]+[/\\][a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+(?=\s|$|[.,;])/g;
	for (const match of extractMatches(genericPathRegex, description)) {
		// Only include if it looks like a code file path (has src, lib, test, etc.)
		const pathStr = match[0];
		if (
			pathStr.includes('src/') ||
			pathStr.includes('src\\') ||
			pathStr.includes('lib/') ||
			pathStr.includes('lib\\') ||
			pathStr.includes('test/') ||
			pathStr.includes('test\\')
		) {
			filePaths.push(pathStr);
		}
	}

	return filePaths;
}

/**
 * Build a human-readable evidence summary for the completion verify result.
 * Kept as a named function to avoid deeply nested ternary operators.
 */
function buildVerifySummary(
	tasksChecked: number,
	tasksSkipped: number,
	tasksBlocked: number,
): string {
	if (tasksBlocked > 0) {
		return `Blocked: ${tasksBlocked} task(s) with missing identifiers`;
	}
	const verified = tasksChecked - tasksSkipped;
	if (tasksSkipped === tasksChecked) {
		return `All ${tasksChecked} completed task(s) skipped — research/inventory tasks`;
	}
	if (tasksSkipped > 0) {
		return `${verified} task(s) verified, ${tasksSkipped} skipped (research tasks)`;
	}
	return `All ${tasksChecked} completed tasks verified successfully`;
}

/**
 * Execute the completion verification check
 */
export async function executeCompletionVerify(
	args: CompletionVerifyArgs,
	directory: string,
): Promise<string> {
	const phase = Number(args.phase);

	// Validate phase number
	if (Number.isNaN(phase) || phase < 1 || !Number.isFinite(phase)) {
		const result: CompletionVerifyResult = {
			success: false,
			phase,
			status: 'blocked',
			reason: 'Invalid phase number',
			tasksChecked: 0,
			tasksSkipped: 0,
			tasksBlocked: 0,
			blockedTasks: [],
		};
		return JSON.stringify(result, null, 2);
	}

	// === Turbo Mode bypass ===
	if (hasActiveTurboMode(args.sessionID)) {
		const result: CompletionVerifyResult = {
			success: true,
			phase,
			status: 'passed',
			reason: 'Turbo Mode active — completion verification bypassed',
			tasksChecked: 0,
			tasksSkipped: 0,
			tasksBlocked: 0,
			blockedTasks: [],
		};
		return JSON.stringify(result, null, 2);
	}

	// Try to read plan.json
	let plan: Plan;
	try {
		const planPath = validateSwarmPath(directory, 'plan.json');
		const planRaw = fs.readFileSync(planPath, 'utf-8');
		plan = JSON.parse(planRaw);
	} catch {
		// If plan.json doesn't exist, return success with warning
		const result: CompletionVerifyResult = {
			success: true,
			phase,
			status: 'passed',
			reason: 'Cannot verify without plan.json',
			tasksChecked: 0,
			tasksSkipped: 0,
			tasksBlocked: 0,
			blockedTasks: [],
		};
		return JSON.stringify(result, null, 2);
	}

	// Find the target phase
	const targetPhase = plan.phases.find((p) => p.id === phase);
	if (!targetPhase) {
		const result: CompletionVerifyResult = {
			success: false,
			phase,
			status: 'blocked',
			reason: `Phase ${phase} not found in plan.json`,
			tasksChecked: 0,
			tasksSkipped: 0,
			tasksBlocked: 0,
			blockedTasks: [],
		};
		return JSON.stringify(result, null, 2);
	}

	// Track verification results
	let tasksChecked = 0;
	let tasksSkipped = 0;
	let tasksBlocked = 0;
	const blockedTasks: BlockedTask[] = [];

	// Process each completed task
	for (const task of targetPhase.tasks) {
		if (task.status !== 'completed') {
			continue;
		}

		tasksChecked++;

		// Get file targets
		const fileTargets = parseFilePaths(task.description, task.files_touched);

		// Get identifiers to look for
		const identifiers = parseIdentifiers(task.description);

		// If no file targets, skip this task — it may be a research/inventory task
		// that produces knowledge artifacts rather than source files.
		// We cannot verify it, but absence of file targets is not evidence of incompleteness.
		//
		// NOTE: `files_touched` defaults to `[]` in the plan schema, so an explicitly-empty
		// `files_touched: []` is indistinguishable from the default. This is intentional:
		// completion_verify is a best-effort signal, not a security gate.
		// The authoritative guard is the update_task_status reviewer gate, which enforces
		// reviewer + test_engineer delegation before any task can reach `completed`.
		if (fileTargets.length === 0) {
			tasksSkipped++;
			continue;
		}

		// If no identifiers parsed, block this task (fail closed — can't verify without identifiers)
		if (identifiers.length === 0) {
			blockedTasks.push({
				task_id: task.id,
				identifier: '',
				file_path: '',
				reason: 'No identifiers — cannot verify completion without identifiers',
			});
			tasksBlocked++;
			continue;
		}

		// Track which identifiers were found across all files (using Set for dedup)
		const foundIdentifiers = new Set<string>();
		// Track if any file failed to read (missing file is obvious incompleteness)
		let hasFileReadFailure = false;

		// Check each file for the identifiers
		for (const filePath of fileTargets) {
			// Normalize path separators to forward slashes for cross-platform consistency
			const normalizedPath = filePath.replace(/\\/g, '/');
			// Resolve file path relative to project root
			const resolvedPath = path.resolve(directory, normalizedPath);

			// Security: reject file paths that escape the project directory.
			// files_touched is LLM-controlled; an absolute or traversal path could
			// exfiltrate arbitrary files. Block and count as a real failure so the
			// phase cannot complete until the plan is corrected.
			// Use path.relative() to detect escape: a relative path starting with '..'
			// means the resolved path is outside the project root.
			const projectRoot = path.resolve(directory);
			const relative = path.relative(projectRoot, resolvedPath);
			const withinProject =
				relative === '' ||
				(!relative.startsWith('..') && !path.isAbsolute(relative));
			if (!withinProject) {
				blockedTasks.push({
					task_id: task.id,
					identifier: '',
					file_path: filePath,
					reason: `File path '${filePath}' escapes the project directory — cannot verify completion`,
				});
				hasFileReadFailure = true;
				continue;
			}

			// Try to read the file
			let fileContent: string;
			try {
				fileContent = fs.readFileSync(resolvedPath, 'utf-8');
			} catch {
				// File doesn't exist or can't be read - block with file-not-found reason
				blockedTasks.push({
					task_id: task.id,
					identifier: '',
					file_path: filePath,
					reason: `File '${filePath}' not found — cannot verify completion`,
				});
				hasFileReadFailure = true;
				continue;
			}

			// Check each identifier across this file, tracking found ones in the Set
			for (const identifier of identifiers) {
				if (fileContent.includes(identifier)) {
					foundIdentifiers.add(identifier);
				}
			}
		}
		const foundCount = foundIdentifiers.size;

		// Block if file read failed OR if NO identifier was found across all target files
		if (hasFileReadFailure || foundCount === 0) {
			// Don't double-add "No identifiers found" if we already have file-not-found entries
			if (!hasFileReadFailure) {
				blockedTasks.push({
					task_id: task.id,
					identifier: '',
					file_path: '',
					reason: 'No identifiers found in target files',
				});
			}
			tasksBlocked++;
		}
	}

	// Build the result
	const now = new Date().toISOString();
	const result: CompletionVerifyResult = {
		success: tasksBlocked === 0,
		phase,
		status: tasksBlocked === 0 ? 'passed' : 'blocked',
		reason:
			tasksBlocked > 0
				? `COMPLETION_INCOMPLETE: ${tasksBlocked} task(s) blocked — missing identifiers or target files`
				: undefined,
		tasksChecked,
		tasksSkipped,
		tasksBlocked,
		blockedTasks,
	};

	// Store evidence to .swarm/evidence/{phase}/completion-verify.json
	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
		const evidencePath = path.join(evidenceDir, 'completion-verify.json');

		// Ensure directory exists
		fs.mkdirSync(evidenceDir, { recursive: true });

		const evidenceBundle: EvidenceBundle = {
			schema_version: '1.0.0',
			task_id: 'completion-verify',
			created_at: now,
			entries: [
				{
					task_id: 'completion-verify',
					type: 'completion_verify',
					timestamp: now,
					agent: 'completion_verify',
					verdict: tasksBlocked === 0 ? 'pass' : 'fail',
					summary: buildVerifySummary(tasksChecked, tasksSkipped, tasksBlocked),
					phase,
					tasks_checked: tasksChecked,
					tasks_skipped: tasksSkipped,
					tasks_blocked: tasksBlocked,
					blocked_tasks: blockedTasks,
				},
			],
		};

		fs.writeFileSync(
			evidencePath,
			JSON.stringify(evidenceBundle, null, 2),
			'utf-8',
		);
	} catch {
		// Non-blocking - don't fail the tool if evidence write fails
	}

	return JSON.stringify(result, null, 2);
}

/**
 * Tool definition for completion_verify
 */
export const completion_verify: ToolDefinition = createSwarmTool({
	description:
		'Deterministic pre-check verifying that plan task identifiers exist in their target source files before phase completion. Blocks if obviously incomplete.',
	args: {
		phase: z.number().describe('The phase number to check'),
		sessionID: z
			.string()
			.optional()
			.describe(
				'Session ID for tracking state (auto-provided by plugin context)',
			),
		working_directory: z
			.string()
			.optional()
			.describe(
				'Explicit project root directory. When provided, .swarm/ is resolved relative to this path instead of the plugin context directory. Use this when CWD differs from the actual project root.',
			),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		let parsedArgs: CompletionVerifyArgs;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				parsedArgs = {
					phase:
						typeof obj.phase === 'number'
							? obj.phase
							: typeof obj.phase === 'string'
								? Number(obj.phase)
								: 0,
					sessionID:
						typeof obj.sessionID === 'string' ? obj.sessionID : undefined,
					working_directory:
						typeof obj.working_directory === 'string'
							? obj.working_directory
							: undefined,
				};
			} else {
				parsedArgs = { phase: 0 };
			}
		} catch {
			return JSON.stringify(
				{
					success: false,
					phase: 0,
					status: 'blocked',
					reason: 'Invalid arguments',
					tasksChecked: 0,
					tasksSkipped: 0,
					tasksBlocked: 0,
					blockedTasks: [],
				},
				null,
				2,
			);
		}

		// Resolve effective directory: explicit working_directory > injected directory
		const dirResult = resolveWorkingDirectory(
			parsedArgs.working_directory,
			directory,
		);
		if (!dirResult.success) {
			return JSON.stringify(
				{
					success: false,
					phase: parsedArgs.phase,
					status: 'blocked',
					reason: dirResult.message,
					tasksChecked: 0,
					tasksSkipped: 0,
					tasksBlocked: 0,
					blockedTasks: [],
				},
				null,
				2,
			);
		}

		return executeCompletionVerify(parsedArgs, dirResult.directory);
	},
});
