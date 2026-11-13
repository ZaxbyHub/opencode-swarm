/**
 * Centralized task ID validation (#452 item 2).
 *
 * Two strictness levels exist by design:
 *
 * - **Strict** (`isStrictTaskId`): Only numeric N.M or N.M.P format.
 *   Use for gate-evidence operations where task IDs map to plan phases/tasks.
 *
 * - **Broad** (`isValidTaskId` / `sanitizeTaskId`): Accepts numeric, retrospective
 *   (retro-N), internal tool IDs (sast_scan, etc.), and general alphanumeric.
 *   Use for evidence storage, trajectory logging, and other paths that handle
 *   non-plan task IDs.
 *
 * Both levels reject path traversal, null bytes, control characters, and
 * other unsafe patterns.
 */

/** Strict numeric format: 1.1, 1.2.3, 10.5.100 */
const STRICT_TASK_ID_PATTERN = /^\d+\.\d+(\.\d+)*$/;

/** Retrospective IDs: retro-1, retro-42 */
const RETRO_TASK_ID_REGEX = /^retro-\d+$/;

/** Internal automated-tool IDs */
const INTERNAL_TOOL_ID_REGEX =
	/^(?:sast_scan|quality_budget|syntax_check|placeholder_scan|sbom_generate|build|secretscan)$/;

/**
 * Single-source predicate for the reserved fixed tool-evidence ids (#3681
 * item 5). Consumers that must exempt legitimate non-plan evidence bundles
 * (the diagnose orphan filter) reuse THIS rather than restating the set —
 * the writers all route through saveEvidence with one of these ids and are
 * enumerated at the INTERNAL_TOOL_ID_REGEX definition.
 */
export function isInternalToolEvidenceId(taskId: string): boolean {
	return INTERNAL_TOOL_ID_REGEX.test(taskId);
}

/** General safe alphanumeric: must start with letter/digit, body allows dots, hyphens, underscores */
const GENERAL_TASK_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Check for unsafe characters common to all validation levels.
 * Returns an error message if unsafe, or undefined if safe.
 */
function checkUnsafeChars(taskId: string): string | undefined {
	if (!taskId || taskId.length === 0) {
		return 'Invalid task ID: empty string';
	}
	if (/\0/.test(taskId)) {
		return 'Invalid task ID: contains null bytes';
	}
	for (let i = 0; i < taskId.length; i++) {
		if (taskId.charCodeAt(i) < 32) {
			return 'Invalid task ID: contains control characters';
		}
	}
	if (taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
		return 'Invalid task ID: path traversal detected';
	}
	return undefined;
}

/**
 * Strict validation: only numeric N.M or N.M.P format.
 * Use for gate-evidence operations where task IDs correspond to plan phases/tasks.
 */
export function isStrictTaskId(taskId: string): boolean {
	if (!taskId) return false;
	const unsafeMsg = checkUnsafeChars(taskId);
	if (unsafeMsg) return false;
	return STRICT_TASK_ID_PATTERN.test(taskId);
}

/**
 * Broad validation: accepts numeric, retrospective, internal tool, and
 * general alphanumeric task IDs.
 * Use for evidence storage, trajectory logging, and non-plan task ID paths.
 */
export function isValidTaskId(taskId: string): boolean {
	if (!taskId) return false;
	const unsafeMsg = checkUnsafeChars(taskId);
	if (unsafeMsg) return false;
	return (
		STRICT_TASK_ID_PATTERN.test(taskId) ||
		RETRO_TASK_ID_REGEX.test(taskId) ||
		INTERNAL_TOOL_ID_REGEX.test(taskId) ||
		GENERAL_TASK_ID_REGEX.test(taskId)
	);
}

/**
 * Throws if the task ID fails strict validation.
 * Use as a guard at the top of functions that build file paths from task IDs.
 */
export function assertStrictTaskId(taskId: string): void {
	if (!isStrictTaskId(taskId)) {
		throw new Error(
			`Invalid taskId: "${taskId}". Must match N.M or N.M.P (e.g. "1.1", "1.2.3").`,
		);
	}
}

/**
 * Validates and returns the task ID (broad validation).
 * Throws with a descriptive message if the ID is invalid.
 * Replaces evidence/manager.ts sanitizeTaskId for new callers.
 */
export function sanitizeTaskId(taskId: string): string {
	const unsafeMsg = checkUnsafeChars(taskId);
	if (unsafeMsg) {
		throw new Error(unsafeMsg);
	}
	if (
		STRICT_TASK_ID_PATTERN.test(taskId) ||
		RETRO_TASK_ID_REGEX.test(taskId) ||
		INTERNAL_TOOL_ID_REGEX.test(taskId) ||
		GENERAL_TASK_ID_REGEX.test(taskId)
	) {
		return taskId;
	}
	throw new Error(
		`Invalid task ID: must be alphanumeric (ASCII) with optional hyphens, underscores, or dots, got "${taskId}"`,
	);
}

/**
 * Validation for tool input: returns error message string if invalid, undefined if valid.
 * Strict numeric format only (for update-task-status, declare-scope, etc.).
 */
export function validateTaskIdFormat(taskId: string): string | undefined {
	if (!STRICT_TASK_ID_PATTERN.test(taskId)) {
		return `Invalid taskId "${taskId}". Must match pattern N.M or N.M.P (e.g., "1.1", "1.2.3")`;
	}
	return undefined;
}
