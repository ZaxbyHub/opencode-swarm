/**
 * Declare scope tool for setting the file scope for coder delegations.
 * Implements FR-010: Declare coder scope before delegation.
 * This tool must be called before delegating to coder to enable scope containment checking.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { PlanSchema } from '../config/plan-schema';
import { checkWriteTargetForSymlink } from '../hooks/guardrails';
import {
	createScopeBinding,
	registerScopeBinding,
} from '../scope/scope-binding';
import { writeScopeBindingToDisk } from '../scope/scope-persistence';
import { ensureAgentSession } from '../state';
import { validateTaskIdFormat as _validateTaskIdFormat } from '../validation/task-id';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the declare_scope tool
 */
export interface DeclareScopeArgs {
	taskId: string;
	files: string[];
	whitelist?: string[];
	working_directory?: string;
}

/**
 * Result from executing declare_scope
 */
export interface DeclareScopeResult {
	success: boolean;
	message: string;
	taskId?: string;
	fileCount?: number;
	errors?: string[];
	warnings?: string[];
}

/**
 * Validate that taskId matches the required format (N.M or N.M.P).
 * @param taskId - The task ID to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validateTaskIdFormat(taskId: string): string | undefined {
	return _validateTaskIdFormat(taskId);
}

/**
 * Validate file entries for security concerns.
 * @param files - Array of file paths to validate
 * @returns Array of error messages, empty if all valid
 */
export function validateFiles(files: string[]): string[] {
	const errors: string[] = [];

	for (const file of files) {
		// Check for null bytes
		if (file.includes('\0')) {
			errors.push(`Invalid file "${file}": null bytes are not allowed`);
		}

		// Check for path traversal
		if (file.includes('..')) {
			errors.push(
				`Invalid file "${file}": path traversal sequences (..) are not allowed`,
			);
		}

		// Check for length limit
		if (file.length > 4096) {
			errors.push(
				`Invalid file "${file}": path exceeds maximum length of 4096 characters`,
			);
		}
	}

	return errors;
}

/**
 * Execute the declare_scope tool.
 * Validates the taskId and files, then sets the declared scope on all active architect sessions.
 * @param args - The declare scope arguments
 * @param fallbackDir - Fallback directory for plan lookup
 * @returns DeclareScopeResult with success status and details
 */
export async function executeDeclareScope(
	args: DeclareScopeArgs,
	fallbackDir?: string,
	owner?: { sessionID: string; messageID: string; agentName?: string },
): Promise<DeclareScopeResult> {
	// Step 1: Validate taskId format
	const taskIdError = validateTaskIdFormat(args.taskId);
	if (taskIdError) {
		return {
			success: false,
			message: 'Validation failed',
			errors: [taskIdError],
		};
	}

	// Step 2: Validate files array
	if (!Array.isArray(args.files) || args.files.length === 0) {
		return {
			success: false,
			message: 'Validation failed',
			errors: ['files must be a non-empty array'],
		};
	}

	// Validate each file entry
	const fileErrors = validateFiles(args.files);
	if (fileErrors.length > 0) {
		return {
			success: false,
			message: 'Validation failed',
			errors: fileErrors,
		};
	}

	// Validate whitelist entries if provided
	if (args.whitelist) {
		const whitelistErrors = validateFiles(args.whitelist);
		if (whitelistErrors.length > 0) {
			return {
				success: false,
				message: 'Validation failed',
				errors: whitelistErrors,
			};
		}
	}

	// Step 3: Validate working_directory if provided
	let normalizedDir: string | undefined;
	if (args.working_directory != null && args.working_directory.trim() !== '') {
		// Check for null-byte injection before any processing
		if (args.working_directory.includes('\0')) {
			return {
				success: false,
				message: 'Invalid working_directory: null bytes are not allowed',
				errors: ['Invalid working_directory: null bytes are not allowed'],
			};
		}

		// Check for Windows device paths (e.g., \\.\C:\, \\?\GLOBALROOT\)
		// Applied on all platforms for defense-in-depth (paths may originate from Windows clients)
		{
			const devicePathPattern =
				/^\\\\|^(NUL|CON|AUX|COM[1-9]|LPT[1-9])(\..*)?$/i;
			if (devicePathPattern.test(args.working_directory)) {
				return {
					success: false,
					message:
						'Invalid working_directory: Windows device paths are not allowed',
					errors: [
						'Invalid working_directory: Windows device paths are not allowed',
					],
				};
			}
		}

		// Normalize path first
		normalizedDir = path.normalize(args.working_directory);

		// Check for path traversal sequences
		const pathParts = normalizedDir.split(path.sep);
		if (pathParts.includes('..')) {
			return {
				success: false,
				message:
					'Invalid working_directory: path traversal sequences (..) are not allowed',
				errors: [
					'Invalid working_directory: path traversal sequences (..) are not allowed',
				],
			};
		}

		// Check if directory exists on disk and contains a valid .swarm/plan.json
		const resolvedDir = path.resolve(normalizedDir);
		try {
			const realPath = fs.realpathSync(resolvedDir);
			const planPath = path.join(realPath, '.swarm', 'plan.json');
			if (!fs.existsSync(planPath)) {
				return {
					success: false,
					message: `Invalid working_directory: plan not found in "${realPath}"`,
					errors: [
						`Invalid working_directory: plan not found in "${realPath}"`,
					],
				};
			}
		} catch {
			return {
				success: false,
				message: `Invalid working_directory: path "${resolvedDir}" does not exist or is inaccessible`,
				errors: [
					`Invalid working_directory: path "${resolvedDir}" does not exist or is inaccessible`,
				],
			};
		}

		// Subdirectory containment: reject if normalizedDir is a strict subdirectory of the injected project root
		if (normalizedDir && fallbackDir) {
			try {
				const canonicalWorkingDir = fs.realpathSync(
					path.resolve(normalizedDir),
				);
				const canonicalProjectRoot = fs.realpathSync(path.resolve(fallbackDir));
				if (canonicalWorkingDir.startsWith(canonicalProjectRoot + path.sep)) {
					return {
						success: false,
						message: `working_directory "${normalizedDir}" is a subdirectory of the project root. Use the project root "${fallbackDir}" instead.`,
						errors: [
							`Subdirectory working_directory not allowed — use project root "${fallbackDir}"`,
						],
					};
				}
				// canonicalWorkingDir === canonicalProjectRoot is fine (same dir)
				// canonicalWorkingDir outside canonicalProjectRoot is fine (different project)
			} catch {
				// fallbackDir doesn't exist on disk — skip containment check;
				// plan.json existence check below will catch the invalid path
			}
		}
	}

	// Step 4: Resolve target directory
	if (!normalizedDir && !fallbackDir) {
		return {
			success: false,
			message: 'Cannot resolve project directory',
			errors: [
				'Provide working_directory or ensure the tool is invoked from a project root',
			],
		};
	}
	const directory = (normalizedDir || fallbackDir)!;

	// Step 5: Check that taskId exists in plan.json
	const planPath = path.resolve(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) {
		return {
			success: false,
			message: 'No plan found',
			errors: ['plan.json not found'],
		};
	}

	let rawPlanContent: unknown;
	try {
		rawPlanContent = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
	} catch {
		return {
			success: false,
			message: 'Failed to parse plan.json',
			errors: ['plan.json is not valid JSON'],
		};
	}
	const parsedPlan = PlanSchema.safeParse(rawPlanContent);
	if (!parsedPlan.success) {
		return {
			success: false,
			message: 'Failed to validate plan.json',
			errors: ['plan.json does not match the supported plan schema'],
		};
	}
	const planContent = parsedPlan.data;

	const allTasks =
		planContent.phases?.flatMap(
			(p: { tasks?: { id: string; status: string }[] }) => p.tasks ?? [],
		) ?? [];
	const taskExists = allTasks.some(
		(t: { id: string; status: string }) => t.id === args.taskId,
	);

	if (!taskExists) {
		return {
			success: false,
			message: `Task ${args.taskId} not found in plan`,
			errors: [`Task ${args.taskId} does not exist in plan.json`],
		};
	}

	// Step 6: Check that task is NOT already in 'complete' state
	// Use plan.json as authoritative source (update_task_status only writes to plan.json, not in-memory state)
	const taskInPlan = allTasks.find(
		(t: { id: string; status: string }) => t.id === args.taskId,
	);
	if (taskInPlan && taskInPlan.status === 'completed') {
		return {
			success: false,
			message: `Task ${args.taskId} is already completed`,
			errors: [`Cannot declare scope for completed task ${args.taskId}`],
		};
	}

	// NOTE: A previous global session check was removed here because session
	// state is not keyed by workspace directory.  Task IDs like "1.1" are reused
	// across plans, so checking ALL sessions caused false "already completed"
	// failures when a different workspace had the same task ID complete.
	// The plan.json check above (Step 6) is the authoritative, workspace-scoped
	// source of truth for task completion status.

	// Step 7: Merge files and whitelist (if provided)
	const rawMergedFiles = [...args.files, ...(args.whitelist ?? [])];

	// Step 7b: Normalize absolute paths to relative and collect warnings (Fix for #259)
	// Absolute paths silently fail in checkFileAuthority's prefix matching, so we normalize
	// them here and warn the caller to prevent confusing downstream WRITE BLOCKED errors.
	const warnings: string[] = [];
	const normalizeErrors: string[] = [];
	const dir = directory;
	const mergedFiles = rawMergedFiles.map((file) => {
		if (path.isAbsolute(file)) {
			const relativePath = path.relative(dir, file).replace(/\\/g, '/');
			// Reject paths that resolve outside the project directory
			if (relativePath.startsWith('..')) {
				normalizeErrors.push(
					`Path '${file}' resolves outside the project directory`,
				);
				return file; // Return unchanged; will be rejected below
			}
			warnings.push(
				`Absolute path normalized to relative: '${relativePath}' (was '${file}')`,
			);
			return relativePath;
		}
		return file;
	});

	if (normalizeErrors.length > 0) {
		return {
			success: false,
			message: 'Validation failed',
			errors: normalizeErrors,
		};
	}

	// Step 7c: lstat check — reject scope if any declared file is behind a symlink.
	// Writing through a symlink can redirect writes outside the working directory,
	// bypassing scope containment. Checked here at scope-declaration time so the
	// architect gets an early error rather than a per-write block during coder execution.
	const lstatErrors: string[] = [];
	for (const file of mergedFiles) {
		const block = checkWriteTargetForSymlink(file, dir);
		if (block) {
			lstatErrors.push(block);
		}
	}
	if (lstatErrors.length > 0) {
		return {
			success: false,
			message: 'Scope contains symlink-backed paths',
			errors: lstatErrors,
		};
	}

	// Step 8: Bind authorization only to the authenticated caller. Direct
	// test/CLI calls without ToolContext are validation-only and never persist.
	if (owner?.sessionID && owner.messageID) {
		const binding = createScopeBinding({
			directory: dir,
			plan: planContent,
			taskId: args.taskId,
			files: mergedFiles,
			ownerSessionId: owner.sessionID,
			ownerMessageId: owner.messageID,
			source: 'declare_scope',
		});
		if (!binding) {
			return {
				success: false,
				message: 'Failed to bind scope to the calling session',
				errors: ['Scope identity could not be validated'],
			};
		}
		registerScopeBinding(binding);
		const session = ensureAgentSession(
			owner.sessionID,
			owner.agentName ?? 'architect',
			dir,
		);
		session.declaredCoderScope = mergedFiles;
		session.lastScopeViolation = null;
		await writeScopeBindingToDisk(dir, binding);
	}

	// Ownerless calls intentionally do not persist authorization.

	// Keep the caller-facing contract aligned with the production guards. Direct
	// writes and detected shell/interpreter writes share the same active,
	// Task-correlated binding; unresolvable coder write payloads fail closed.
	warnings.push(
		'SCOPE ENFORCEMENT: This declaration is bound to the caller session and current plan. ' +
			'Direct writes and statically detected shell/interpreter writes must stay inside the active ' +
			'Task-correlated scope; missing or unverifiable coder write authority fails closed with ' +
			'SCOPE_NOT_DECLARED or SCOPE_VIOLATION.',
	);

	return {
		success: true,
		message: 'Scope declared successfully',
		taskId: args.taskId,
		fileCount: mergedFiles.length,
		warnings,
	};
}

/**
 * Tool definition for declare_scope
 */
export const declare_scope: ToolDefinition = createSwarmTool({
	description:
		'Declare the file scope for the next coder delegation. ' +
		'Sets the list of files the coder is permitted to modify for a specific task. ' +
		'Must be called before delegating to coder to enable scope containment checking.',
	args: {
		taskId: z
			.string()
			.min(1)
			.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format')
			.describe(
				'Task ID for which scope is being declared, e.g. "1.1", "1.2.3"',
			),
		files: z
			.array(z.string().min(1).max(4096))
			.min(1)
			.describe('Array of file paths the coder is permitted to modify'),
		whitelist: z
			.array(z.string().min(1).max(4096))
			.optional()
			.describe('Additional file paths to whitelist (merged with files)'),
		working_directory: z
			.string()
			.optional()
			.describe('Working directory where the plan is located'),
	},
	execute: async (args: unknown, _directory: string, ctx) => {
		return JSON.stringify(
			await executeDeclareScope(args as DeclareScopeArgs, _directory, {
				sessionID: ctx?.sessionID ?? '',
				messageID: ctx?.messageID ?? '',
				agentName: ctx?.agent,
			}),
			null,
			2,
		);
	},
});
