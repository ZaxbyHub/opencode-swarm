/**
 * Diff scope validator — compares files changed in git against the declared scope
 * for a given task in plan.json. Returns a warning string if undeclared files
 * were modified, or null if in-scope, no scope declared, or git unavailable.
 * Never throws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from '../utils/bun-compat';
import { ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS } from '../utils/gitignore-warning';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: { bunSpawn: typeof bunSpawn } = { bunSpawn };

/**
 * Read the declared file scope for a task from .swarm/plan.json.
 * Returns the files array or null if not found / no scope declared.
 */
function getDeclaredScope(taskId: string, directory: string): string[] | null {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		if (!fs.existsSync(planPath)) return null;

		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as {
			phases?: Array<{
				tasks?: Array<{
					id?: string;
					files_touched?: string | string[];
				}>;
			}>;
		};

		for (const phase of plan.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				if (task.id !== taskId) continue;
				const ft = task.files_touched;
				if (Array.isArray(ft) && ft.length > 0) {
					return ft;
				}
				if (typeof ft === 'string' && ft.length > 0) {
					return [ft];
				}
				return null; // Task found but no scope declared
			}
		}
		return null; // Task not found
	} catch {
		return null;
	}
}

/**
 * Run git diff --name-only to get files changed since HEAD~1.
 * Returns array of changed file paths, or null if git is unavailable.
 */
/**
 * Spawn options shared by both `git diff` invocations below.
 *
 * `timeout` and `stdin: 'ignore'` are required to make the call hang-free on
 * every supported platform — see `gitignore-warning.ts` for full rationale.
 * Without `stdin: 'ignore'`, Bun on Windows may leave the child waiting for
 * a stdin EOF that never arrives; without `timeout`, the awaited
 * `Promise.all([proc.exited, proc.stdout.text()])` can block indefinitely
 * if antivirus / credential prompts / NFS stall the child.
 */
const GIT_DIFF_SPAWN_OPTIONS = {
	timeout: ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
	stdin: 'ignore',
	stdout: 'pipe',
	stderr: 'pipe',
} as const;

async function getChangedFiles(directory: string): Promise<string[] | null> {
	try {
		// Try HEAD~1 first (normal case with commits)
		const proc = _internals.bunSpawn(['git', 'diff', '--name-only', 'HEAD~1'], {
			cwd: directory,
			...GIT_DIFF_SPAWN_OPTIONS,
		});

		let exitCode: number;
		let stdout: string;
		try {
			[exitCode, stdout] = await Promise.all([proc.exited, proc.stdout.text()]);
		} finally {
			try {
				proc.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (exitCode === 0) {
			return stdout
				.trim()
				.split('\n')
				.map((f) => f.trim())
				.filter((f) => f.length > 0);
		}

		// Fallback: uncommitted changes vs HEAD
		const proc2 = _internals.bunSpawn(['git', 'diff', '--name-only', 'HEAD'], {
			cwd: directory,
			...GIT_DIFF_SPAWN_OPTIONS,
		});

		let exitCode2: number;
		let stdout2: string;
		try {
			[exitCode2, stdout2] = await Promise.all([
				proc2.exited,
				proc2.stdout.text(),
			]);
		} finally {
			try {
				proc2.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (exitCode2 === 0) {
			return stdout2
				.trim()
				.split('\n')
				.map((f) => f.trim())
				.filter((f) => f.length > 0);
		}

		return null;
	} catch {
		return null; // git not available
	}
}

/**
 * Validate that git-changed files match the declared scope for a task.
 * Returns a warning string if undeclared files were modified, null otherwise.
 * Never throws.
 */
export async function validateDiffScope(
	taskId: string,
	directory: string,
): Promise<string | null> {
	try {
		const declaredScope = getDeclaredScope(taskId, directory);
		if (!declaredScope) return null; // No scope declared — skip

		const changedFiles = await getChangedFiles(directory);
		if (!changedFiles) return null; // git unavailable — skip

		// Filter .swarm/ runtime paths — tracked .swarm files must not produce
		// spurious scope warnings in QA review. .swarm/ is always local runtime state.
		// Normalize ./ prefix before the startsWith check so that git output of the
		// form ./.swarm/foo (rare but theoretically possible) is also filtered.
		const nonSwarmFiles = changedFiles.filter(
			(f) => !f.replace(/\\/g, '/').replace(/^\.\//, '').startsWith('.swarm/'),
		);

		// Normalise paths for comparison (forward slashes, no leading ./)
		const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

		const normScope = new Set(declaredScope.map(normalise));
		const undeclared = nonSwarmFiles
			.map(normalise)
			.filter((f) => !normScope.has(f));

		if (undeclared.length === 0) return null;

		const scopeStr = declaredScope.join(', ');
		const undeclaredStr = undeclared.slice(0, 5).join(', ');
		const extra =
			undeclared.length > 5 ? ` (+${undeclared.length - 5} more)` : '';

		return `SCOPE WARNING: Task ${taskId} declared scope [${scopeStr}] but also modified [${undeclaredStr}${extra}]. Reviewer should verify these changes are intentional.`;
	} catch {
		return null;
	}
}
