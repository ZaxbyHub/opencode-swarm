/**
 * Static recovery-invocation guidance (issue #2665).
 *
 * One shell-correct form per supported shell for the recovery entry points,
 * plus the category glossary and the deterministic-repair boundary text the
 * operator runbook publishes. Everything here is a module constant: this
 * module MUST NOT read environment variables or the host platform, or any
 * environment signal to choose an invocation string — the contract is
 * documented per shell, never sniffed (issue #2665 AC3: "without introducing
 * a new heuristic path detector"; the anti-detection source scan lives in
 * tests/unit/workflow/task-recovery-status.test.ts).
 */

/** The compact operator runbook that carries the full guidance. */
export const RECOVERY_RUNBOOK_DOC_PATH =
	'docs/troubleshooting/recovery-runbook.md';

export interface RecoveryInvocationForm {
	/** Shell or entry surface the form is correct for. */
	surface: 'host' | 'powershell' | 'git-bash' | 'cli';
	/** Shell-correct invocation string (placeholders in angle brackets). */
	invocation: string;
	/** One-line explanation, including the known friction where relevant. */
	note: string;
}

/**
 * Shell-correct invocations for `/swarm recover <task_id>`.
 *
 * The Git Bash form doubles the leading slash of the `/swarm ...` message
 * argument: MSYS path conversion rewrites a single leading-slash argument to
 * a path under the Git install root (`C:/Program Files/Git/swarm ...`) before
 * the host ever sees it. Setting `MSYS_NO_PATHCONV=1` for the whole
 * invocation is NOT shell-correct because `--dir /c/...` arguments then stop
 * converting too.
 */
export const RECOVERY_INVOCATIONS: readonly RecoveryInvocationForm[] = [
	{
		surface: 'host',
		invocation: '/swarm recover <task_id>',
		note: 'Host command path — type it verbatim in the OpenCode TUI/GUI command line.',
	},
	{
		surface: 'powershell',
		invocation: "opencode run --dir <project-dir> '/swarm recover <task_id>'",
		note: 'PowerShell headless — single quotes keep the /swarm message argument literal.',
	},
	{
		surface: 'git-bash',
		invocation: 'opencode run --dir <project-dir> "//swarm recover <task_id>"',
		note: 'Git Bash (MSYS) headless — the leading slash is doubled because MSYS rewrites a single leading-slash argument to C:/Program Files/Git/swarm …; do NOT set MSYS_NO_PATHCONV=1 globally (it breaks --dir /c/... conversion).',
	},
	{
		surface: 'cli',
		invocation: 'bunx opencode-swarm run recover <task_id> [--force]',
		note: 'Shell-neutral CLI — same command in every shell; --force is an operator assertion that no dispatch is genuinely in flight.',
	},
] as const;

/** One-line per-shell quick forms for operator-facing output surfaces. */
export function renderRecoveryInvocationQuickForms(
	docPath: string = RECOVERY_RUNBOOK_DOC_PATH,
): string {
	return [
		`Shell-correct invocations (see ${docPath}):`,
		`- host command path: /swarm recover <task_id>`,
		`- PowerShell headless: opencode run --dir <project-dir> '/swarm recover <task_id>'`,
		`- Git Bash (MSYS) headless: opencode run --dir <project-dir> "//swarm recover <task_id>" (leading slash doubled — MSYS rewrites a single leading slash; never set MSYS_NO_PATHCONV=1 for the whole invocation)`,
		`- shell-neutral CLI: bunx opencode-swarm run recover <task_id> [--force]`,
	].join('\n');
}
