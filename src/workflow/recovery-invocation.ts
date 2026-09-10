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

/** Meaning of each task-recovery status category (runbook glossary source). */
export const RECOVERY_CATEGORY_GLOSSARY: Readonly<Record<string, string>> = {
	missing:
		'No durable receipt exists for the task yet (no settlement WAL, no evidence workflow) — nothing to repair; dispatch normally and re-check.',
	stale:
		'A settlement WAL names an owning transition whose process is gone — deterministic repair via /swarm recover is allowed and idempotent.',
	ambiguous:
		'Another process (or this process) may still own the dispatch — the external effect stays uncertain; close that instance or wait, never force a foreign owner.',
	corrupt:
		'The durable receipt is unparseable — recovery refuses corrupt facts instead of rewriting them; inspect the file and reconcile manually via the runbook.',
	live_wedge:
		'The task settled but its Stage A receipt is missing while green post-settlement pre-check proof exists — deterministically repaired by /swarm recover without re-running the coder or editing evidence.',
	healthy: 'Terminal receipts agree with the workflow state — nothing to do.',
} as const;

/** Where deterministic repair ends and human reconciliation begins. */
export const RECOVERY_BOUNDARY_NOTE =
	'Deterministic repair (dead-owner settlement recovery, wedged Stage A repair) only rewrites local durable state the receipts already justify; it never resolves an external side effect. A live foreign dispatch, an unattributable worktree (CODER_SETTLEMENT_RECOVERY_UNCERTAIN), or a late completion after --force stays uncertain even when local state is repaired — those need a human to reconcile against the other process or provider.';

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
