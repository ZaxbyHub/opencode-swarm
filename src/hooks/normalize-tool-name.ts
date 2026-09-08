/**
 * Canonical tool-name normalization helpers
 *
 * Strip namespace prefixes (e.g., "mega:write", "mega.search") to get the base tool name.
 */

const NAMESPACE_PREFIX_PATTERN = /^[^:]+[:.]/;

/**
 * Strip namespace prefix from a tool name.
 *
 * Examples:
 *   "opencode:write" → "write"
 *   "opencode.bash" → "bash"
 *   "write" → "write"
 *   undefined/null → undefined
 */
export function normalizeToolName(toolName: string): string;
export function normalizeToolName(
	toolName: null | undefined,
): string | undefined;
export function normalizeToolName(
	toolName: string | null | undefined,
): string | undefined {
	if (!toolName) return undefined;
	return toolName.replace(NAMESPACE_PREFIX_PATTERN, '');
}

/**
 * Strip namespace prefix and lowercase the result.
 *
 * Examples:
 *   "opencode:WRITE" → "write"
 *   "opencode.bash" → "bash"
 *   "write" → "write"
 */
export function normalizeToolNameLowerCase(toolName: string): string {
	return toolName.replace(NAMESPACE_PREFIX_PATTERN, '').toLowerCase();
}

/**
 * Boundary predicate for the OpenCode host's native subagent tool.
 *
 * The host invokes the task tool with the lowercase id `task` (verified against
 * the pinned host source, `anomalyco/opencode` v1.18.3
 * `packages/opencode/src/tool/task.ts`: `const id = "task"`); the capitalised
 * `Task` spelling is accepted as legacy input. Namespace-prefixed ids resolve
 * through the shared normalizer (e.g. `opencode:task`). An id containing a dot
 * is a filesystem-loaded custom tool and is NEVER truncated into the task tool
 * (issue #2529 / audit hostcontract-1-NEW-1). Edge cases all fail closed:
 * `':task'`, `'task:'`, and `'task.'` are not the host id (a colon/dot
 * marker without a namespace prefix normalizes to '' or keeps its marker),
 * and whitespace-padded ids (`' task'`, `'task '`) are rejected without
 * trimming.
 */
export function isTaskToolId(toolName: string | null | undefined): boolean {
	if (!toolName) return false;
	if (toolName.includes('.')) {
		// The SDK hook surface reports the id as `tool.execute.<Tool>`; that
		// host-internal namespace is accepted. Any other dot-bearing id is a
		// filesystem custom tool and is never truncated into the task tool
		// (issue #2529 / review round: delegation-gate.qa regression).
		return /^tool\.[^.:]+\.task$/i.test(toolName);
	}
	return normalizeToolNameLowerCase(toolName) === 'task';
}
