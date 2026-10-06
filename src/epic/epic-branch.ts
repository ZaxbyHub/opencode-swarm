/**
 * Epic branch (Epic v2 C1b): the `epic-branch` commit policy.
 *
 * With `epic.commit_policy: 'epic-branch'` (the default) a git epic
 * runs on its own branch `swarm/epic/<epicKey>`:
 *   - `/swarm epic start` checks it out (`git checkout -b`) right after the
 *     lifecycle row is created; the record names it only once the checkout
 *     succeeded (M-e).
 *   - every Epic step that commits or plans against HEAD first verifies HEAD
 *     is still that branch ({@link checkEpicBranch} → EPIC_BRANCH_MISMATCH,
 *     fail closed) — the user may have checked out something else meanwhile.
 *   - `/swarm epic close` lands it back onto the original branch
 *     (`--land squash|merge|none`, default squash: staged, UNCOMMITTED
 *     changes the user reviews and commits). The epic branch itself is never
 *     deleted by the plugin.
 *
 * Read-only git calls go through `gitExec` (`src/git/branch.ts`: array argv,
 * explicit cwd, closed stdin, timeout, bounded output, GIT_TERMINAL_PROMPT=0).
 * State-changing calls (checkout -b, checkout, merge, merge --squash,
 * reset --merge, merge --abort, branch -D) go through `gitExecOnce`
 * (`./git-once.ts`): the same spawn primitive and hardening but WITHOUT
 * `gitExec`'s transient (ETIMEDOUT) retry — re-running a non-idempotent
 * command after a timeout whose effect may already have happened would
 * misreport the state. Callers inspect the actual repository state after any
 * failure instead.
 * Landing additionally pins a non-interactive editor (`GIT_EDITOR=true`,
 * `GIT_MERGE_AUTOEDIT=no`, `--no-edit`) and disables commit signing for the
 * `--land merge` commit, so no merge can wait on an editor or a pinentry.
 * Repository hooks (pre-merge-commit, commit-msg) still run with stdin
 * closed; a hook that rejects the merge is a landing failure, rolled back
 * with `git merge --abort`.
 */

import { _internals as gitBranchInternals } from '../git/branch.js';
import { assertSafeGitRefArg } from '../git/safe-ref.js';
import { type EpicConfigSource, resolveEpicConfig } from './config.js';
import { gitExecOnce } from './git-once.js';
import type {
	EpicCommitPolicy,
	EpicLandMode,
	EpicRecordV1,
} from './lifecycle.js';

/** Branch namespace of every epic branch. */
export const EPIC_BRANCH_PREFIX = 'swarm/epic/';
export const DEFAULT_EPIC_COMMIT_POLICY: EpicCommitPolicy = 'epic-branch';
export const DEFAULT_EPIC_LAND_MODE: EpicLandMode = 'squash';

/** Env for landing commands: never open an editor, never prompt. */
const NON_INTERACTIVE_LANDING_ENV: Record<string, string> = {
	GIT_EDITOR: 'true',
	GIT_MERGE_AUTOEDIT: 'no',
	GIT_TERMINAL_PROMPT: '0',
};

/**
 * DI seam (AGENTS.md invariant 7). Restore in `afterEach`.
 */
export const _internals = {
	gitExec: (args: string[], cwd: string, env?: Record<string, string>) =>
		gitBranchInternals.gitExec(args, cwd, env),
	/** State-changing git commands: one attempt, no transient retry. */
	gitExecOnce,
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `epic.commit_policy`, defaulting to `epic-branch`. */
export function resolveEpicCommitPolicy(
	config: EpicConfigSource,
): EpicCommitPolicy {
	return resolveEpicConfig(config)?.commit_policy ?? DEFAULT_EPIC_COMMIT_POLICY;
}

/** `swarm/epic/<epicKey>`; fail-closed against option injection. */
export function epicBranchName(epicKey: string): string {
	return assertSafeGitRefArg(
		`${EPIC_BRANCH_PREFIX}${epicKey}`,
		'epic branch name',
	);
}

/**
 * Paths with uncommitted changes outside `.swarm/` (tracked or untracked).
 * Throws when git fails. `exec` lets the start module keep its own seam.
 */
export function listDirtyPathsOutsideSwarm(
	directory: string,
	exec: (args: string[], cwd: string) => string = _internals.gitExec,
): string[] {
	const output = exec(
		['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
		directory,
	);
	const dirty: string[] = [];
	const records = output.split('\0');
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const file = record.slice(3);
		// Renames/copies carry the source path in the next NUL record.
		if (code.includes('R') || code.includes('C')) i += 1;
		const normalized = file.replace(/\\/g, '/');
		if (normalized === '.swarm' || normalized.startsWith('.swarm/')) continue;
		dirty.push(normalized);
	}
	return dirty;
}

/**
 * The checked-out branch name, or null for a detached HEAD. Throws when git
 * fails (including an unborn branch, which has no commit to branch from).
 */
export function readCurrentBranch(directory: string): string | null {
	const name = _internals
		.gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], directory)
		.trim();
	return name === 'HEAD' || name.length === 0 ? null : name;
}

/** True when the local branch exists. Throws when git fails. */
export function localBranchExists(directory: string, branch: string): boolean {
	const safe = assertSafeGitRefArg(branch, 'epic branch lookup');
	const output = _internals.gitExec(
		['branch', '--list', '--format=%(refname:short)', safe],
		directory,
	);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.includes(branch);
}

/** `git checkout -b <branch>` from the current HEAD. Throws git's stderr. */
export function checkoutNewEpicBranch(directory: string, branch: string): void {
	_internals.gitExecOnce(
		['checkout', '-b', assertSafeGitRefArg(branch, 'epic branch create')],
		directory,
	);
}

/** `git checkout <branch>`. Throws git's stderr. */
export function checkoutExistingBranch(
	directory: string,
	branch: string,
): void {
	_internals.gitExecOnce(
		['checkout', assertSafeGitRefArg(branch, 'epic branch checkout')],
		directory,
	);
}

/** Tip of a local branch, or null when it does not exist / git fails. */
function branchTip(directory: string, branch: string): string | null {
	try {
		return _internals
			.gitExec(
				[
					'rev-parse',
					'-q',
					'--verify',
					`refs/heads/${assertSafeGitRefArg(branch, 'epic branch tip')}`,
				],
				directory,
			)
			.trim();
	} catch {
		return null;
	}
}

/**
 * Best-effort undo of a just-created epic branch (start rollback), driven
 * by the ACTUAL repository state (a failed or timed-out `checkout -b` may
 * or may not have created the branch / switched HEAD): switch back to the
 * original branch when HEAD is on the epic branch, then delete the epic
 * branch only while its tip is still `baseCommit` (no work on it). Returns
 * the problems, if any, for the refusal text.
 */
export function undoEpicBranchCreate(
	directory: string,
	originalBranch: string,
	branch: string,
	baseCommit: string,
): string[] {
	const failures: string[] = [];
	let current: string | null = null;
	try {
		current = readCurrentBranch(directory);
	} catch (error) {
		failures.push(`could not read the current branch: ${errorText(error)}`);
	}
	if (current === branch) {
		try {
			checkoutExistingBranch(directory, originalBranch);
		} catch (error) {
			failures.push(
				`git checkout ${originalBranch} failed: ${errorText(error)} — HEAD is still on \`${branch}\`; run \`git checkout ${originalBranch}\``,
			);
			return failures;
		}
	}
	const tip = branchTip(directory, branch);
	if (tip === null) return failures;
	if (tip !== baseCommit) {
		failures.push(
			`\`${branch}\` was kept: it no longer points at the start commit`,
		);
		return failures;
	}
	try {
		_internals.gitExecOnce(
			['branch', '-D', '--', assertSafeGitRefArg(branch, 'epic branch undo')],
			directory,
		);
	} catch (error) {
		failures.push(
			`git branch -D ${branch} failed: ${errorText(error)} — delete it with \`git branch -D ${branch}\` before retrying`,
		);
	}
	return failures;
}

export type EpicBranchCheck =
	| { ok: true }
	| {
			ok: false;
			code: 'EPIC_BRANCH_MISMATCH';
			expected: string | null;
			actual: string | null;
			message: string;
	  };

/**
 * Branch-drift guard (M-e): under the epic-branch policy HEAD must be the
 * recorded epic branch. One `git rev-parse --abbrev-ref HEAD`; a git failure
 * or an unrecorded branch fails closed. Current-branch / non-git epics
 * always pass.
 */
export function checkEpicBranch(
	directory: string,
	record: EpicRecordV1,
): EpicBranchCheck {
	if (!record.git.isRepo || record.config.commitPolicy !== 'epic-branch') {
		return { ok: true };
	}
	const expected = record.git.epicBranch;
	if (!expected) {
		return {
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected: null,
			actual: null,
			message:
				'EPIC_BRANCH_MISMATCH: this epic uses the epic-branch commit policy but no epic branch was recorded (the start was interrupted). Ask the user to run `/swarm epic close --abandon` and `/swarm epic start` again.',
		};
	}
	let actual: string | null;
	try {
		actual = readCurrentBranch(directory);
	} catch (error) {
		return {
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected,
			actual: null,
			message: `EPIC_BRANCH_MISMATCH: the current branch could not be read (${errorText(error)}), so commits cannot be proven to land on the epic branch \`${expected}\` (fail closed). Remedy: \`git checkout ${expected}\`.`,
		};
	}
	if (actual === expected) return { ok: true };
	return {
		ok: false,
		code: 'EPIC_BRANCH_MISMATCH',
		expected,
		actual,
		message: `EPIC_BRANCH_MISMATCH: the epic's work belongs on \`${expected}\`, but HEAD is ${actual === null ? 'detached' : `on \`${actual}\``}. Ask the user to commit or stash any changes and run \`git checkout ${expected}\`, then retry (or close the epic with \`/swarm epic close\`).`,
	};
}

// ---------------------------------------------------------------------------
// Landing at close
// ---------------------------------------------------------------------------

export type EpicLandingRefusal =
	| 'dirty-worktree'
	| 'epic-branch-missing'
	| 'original-branch-missing'
	| 'detached-head'
	| 'git-failed';

export type EpicLandingPreflight =
	| { kind: 'not-applicable'; detail: string }
	| { kind: 'already-landed'; detail: string }
	/** On the original branch and the epic branch has no changes: no git work. */
	| { kind: 'nothing-to-land'; detail: string }
	| { kind: 'ready'; currentBranch: string | null; nothingToLand: boolean }
	| { kind: 'refused'; reason: EpicLandingRefusal; details: string[] };

/** Where the repository actually ended up after a landing attempt. */
export interface EpicLandingAfterState {
	branch: string | null;
	/** No changes outside `.swarm/` and no merge in progress. */
	clean: boolean;
}

export interface EpicLandingResult {
	status: 'landed' | 'nothing-to-land' | 'conflict' | 'failed';
	conflictFiles: string[];
	detail: string;
	after: EpicLandingAfterState;
}

/** Branch pair of an epic-branch epic, or null when there is nothing to land. */
export function epicBranchPair(
	record: EpicRecordV1,
): { epicBranch: string; originalBranch: string } | null {
	if (
		!record.git.isRepo ||
		record.config.commitPolicy !== 'epic-branch' ||
		!record.git.epicBranch ||
		!record.git.originalBranch
	) {
		return null;
	}
	return {
		epicBranch: record.git.epicBranch,
		originalBranch: record.git.originalBranch,
	};
}

/** `git merge-base --is-ancestor <ancestor> <descendant>`; failure ⇒ false. */
function isAncestorOf(
	directory: string,
	ancestor: string,
	descendant: string,
): boolean {
	try {
		_internals.gitExec(
			[
				'merge-base',
				'--is-ancestor',
				assertSafeGitRefArg(ancestor, 'epic landing ancestry'),
				assertSafeGitRefArg(descendant, 'epic landing ancestry'),
			],
			directory,
		);
		return true;
	} catch {
		return false;
	}
}

/** True when `<original>...<epic>` (merge-base → epic) has no changes. */
function epicHasNoChanges(
	directory: string,
	originalBranch: string,
	epicBranch: string,
): boolean {
	try {
		_internals.gitExec(
			[
				'diff',
				'--quiet',
				`${assertSafeGitRefArg(originalBranch, 'epic landing diff')}...${assertSafeGitRefArg(epicBranch, 'epic landing diff')}`,
			],
			directory,
		);
		return true;
	} catch {
		return false; // a difference (exit 1) or a git failure: assume changes
	}
}

/**
 * A squash landing whose staged result is already in the index (a close
 * interrupted after `git merge --squash`). Primary check: the index tree
 * equals `git merge-tree --write-tree HEAD <epic>` (git ≥ 2.38). Fallback
 * when merge-tree is unavailable or fails: the staged diff equals the epic's
 * own diff `HEAD...<epic>` (byte-for-byte, binary-safe). Any failure ⇒ false.
 */
function squashAlreadyStaged(directory: string, epicBranch: string): boolean {
	const safeEpic = assertSafeGitRefArg(epicBranch, 'epic landing squash check');
	let indexTree: string;
	try {
		indexTree = _internals.gitExec(['write-tree'], directory).trim();
	} catch {
		return false; // unmerged entries ⇒ not a clean staged squash
	}
	try {
		const mergedTree = _internals
			.gitExec(['merge-tree', '--write-tree', 'HEAD', safeEpic], directory)
			.split(/\r?\n/)[0]
			?.trim();
		if (mergedTree) return mergedTree === indexTree;
	} catch {
		// git < 2.38 (no --write-tree) or a conflicting merge: fall back.
	}
	try {
		const staged = _internals.gitExec(
			['diff', '--cached', '--binary'],
			directory,
		);
		const epicDiff = _internals.gitExec(
			['diff', '--binary', `HEAD...${safeEpic}`],
			directory,
		);
		return staged.length > 0 && staged === epicDiff;
	} catch {
		return false;
	}
}

function dirtyRefusal(
	dirty: string[],
	branch: string | null,
	stagedSquashHint: string | null,
): EpicLandingPreflight {
	return {
		kind: 'refused',
		reason: 'dirty-worktree',
		details: [
			`${dirty.length} uncommitted change(s) outside .swarm/ on ${branch ? `\`${branch}\`` : 'a detached HEAD'}: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', …' : ''}.`,
			stagedSquashHint ??
				'Landing switches branches, so the working tree must be clean: commit the changes to the epic branch (or stash them), then rerun `/swarm epic close`.',
		],
	};
}

/**
 * Read-only landing preflight, run BEFORE the close marks the row `closing`
 * (M-f). Refuses a dirty tree, a missing epic/original branch, and a
 * detached HEAD whose commits are on neither branch; detects an
 * already-landed (or nothing-to-land) state so a resumed close is idempotent.
 */
export function preflightEpicLanding(
	directory: string,
	record: EpicRecordV1,
	mode: EpicLandMode,
): EpicLandingPreflight {
	const pair = epicBranchPair(record);
	if (!pair) {
		return {
			kind: 'not-applicable',
			detail:
				record.git.isRepo && record.config.commitPolicy === 'epic-branch'
					? 'no epic branch was recorded — nothing to land'
					: `commit policy ${record.config.commitPolicy}${record.git.isRepo ? '' : ' (non-git)'} — nothing to land`,
		};
	}
	const { epicBranch, originalBranch } = pair;
	let current: string | null;
	let dirty: string[];
	let epicExists: boolean;
	let originalExists: boolean;
	try {
		current = readCurrentBranch(directory);
		dirty = listDirtyPathsOutsideSwarm(directory);
		epicExists = localBranchExists(directory, epicBranch);
		originalExists = localBranchExists(directory, originalBranch);
	} catch (error) {
		return {
			kind: 'refused',
			reason: 'git-failed',
			details: [`git failed while preparing the landing: ${errorText(error)}`],
		};
	}
	if (!originalExists) {
		return {
			kind: 'refused',
			reason: 'original-branch-missing',
			details: [
				`The original branch \`${originalBranch}\` no longer exists, so there is nothing to land onto.`,
				`Recreate it (for example \`git branch ${originalBranch} ${record.git.baseCommit ?? '<commit>'}\`) and rerun \`/swarm epic close\`, or close with \`/swarm epic close --abandon\` (the epic branch is kept).`,
			],
		};
	}
	if (current === null) {
		const safeDetached =
			(epicExists && isAncestorOf(directory, 'HEAD', epicBranch)) ||
			isAncestorOf(directory, 'HEAD', originalBranch);
		if (!safeDetached) {
			return {
				kind: 'refused',
				reason: 'detached-head',
				details: [
					`HEAD is detached at a commit that is on neither \`${epicBranch}\` nor \`${originalBranch}\`; switching branches would orphan it.`,
					`Keep it on a branch first (\`git branch <name>\`, or \`git checkout ${epicBranch}\` and cherry-pick it), then rerun \`/swarm epic close\`.`,
				],
			};
		}
	}
	const onOriginal = current === originalBranch;
	if (mode === 'none') {
		if (onOriginal) {
			return {
				kind: 'already-landed',
				detail: `already on \`${originalBranch}\``,
			};
		}
		return dirty.length > 0
			? dirtyRefusal(dirty, current, null)
			: { kind: 'ready', currentBranch: current, nothingToLand: false };
	}
	if (!epicExists) {
		return {
			kind: 'refused',
			reason: 'epic-branch-missing',
			details: [
				`The epic branch \`${epicBranch}\` no longer exists, so it cannot be landed with --land ${mode}.`,
				'Run `/swarm epic close --land none` to finish closing without landing.',
			],
		};
	}
	if (epicHasNoChanges(directory, originalBranch, epicBranch)) {
		if (onOriginal) {
			return {
				kind: 'nothing-to-land',
				detail: `the epic branch \`${epicBranch}\` has no changes to land`,
			};
		}
		return dirty.length > 0
			? dirtyRefusal(dirty, current, null)
			: { kind: 'ready', currentBranch: current, nothingToLand: true };
	}
	if (
		onOriginal &&
		mode === 'merge' &&
		isAncestorOf(directory, epicBranch, 'HEAD')
	) {
		return {
			kind: 'already-landed',
			detail: `\`${epicBranch}\` is already merged into \`${originalBranch}\``,
		};
	}
	if (
		onOriginal &&
		mode === 'squash' &&
		dirty.length > 0 &&
		squashAlreadyStaged(directory, epicBranch)
	) {
		return {
			kind: 'already-landed',
			detail: `the squash of \`${epicBranch}\` is already staged on \`${originalBranch}\``,
		};
	}
	if (dirty.length > 0) {
		return dirtyRefusal(
			dirty,
			current,
			onOriginal
				? `You are on \`${originalBranch}\`. If these are the staged squash of an earlier close, commit them on \`${originalBranch}\` (or keep them) and finish with \`/swarm epic close --land none\`; otherwise commit or stash them, then rerun \`/swarm epic close\`.`
				: null,
		);
	}
	return { kind: 'ready', currentBranch: current, nothingToLand: false };
}

function listConflictFiles(directory: string): string[] {
	try {
		return _internals
			.gitExec(['diff', '--name-only', '--diff-filter=U', '-z'], directory)
			.split('\0')
			.filter((file) => file.length > 0);
	} catch {
		return [];
	}
}

function hasStagedChanges(directory: string): boolean {
	try {
		_internals.gitExec(['diff', '--cached', '--quiet'], directory);
		return false;
	} catch {
		return true;
	}
}

function mergeInProgress(directory: string): boolean {
	try {
		_internals.gitExec(
			['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
			directory,
		);
		return true;
	} catch {
		return false;
	}
}

/** Actual branch + cleanliness after a landing attempt (never throws). */
function readAfterState(directory: string): EpicLandingAfterState {
	try {
		const branch = readCurrentBranch(directory);
		const clean =
			listDirtyPathsOutsideSwarm(directory).length === 0 &&
			!mergeInProgress(directory);
		return { branch, clean };
	} catch {
		return { branch: null, clean: false };
	}
}

/**
 * Land the epic branch per `mode` after a `ready` preflight: check out the
 * original branch, then squash (staged, uncommitted) / merge (`--no-ff`
 * merge commit) / nothing. On a conflict the attempt is rolled back —
 * squash with `git reset --merge` (a squash writes no MERGE_HEAD, so
 * `merge --abort` cannot be used), merge with `git merge --abort` — and the
 * result reports where the repository actually ended up.
 */
export function performEpicLanding(
	directory: string,
	record: EpicRecordV1,
	mode: EpicLandMode,
	preflight: Extract<EpicLandingPreflight, { kind: 'ready' }>,
): EpicLandingResult {
	const pair = epicBranchPair(record);
	if (!pair) {
		return {
			status: 'failed',
			conflictFiles: [],
			detail: 'no epic branch',
			after: readAfterState(directory),
		};
	}
	const { epicBranch, originalBranch } = pair;
	if (preflight.currentBranch !== originalBranch) {
		try {
			checkoutExistingBranch(directory, originalBranch);
		} catch (error) {
			return {
				status: 'failed',
				conflictFiles: [],
				detail: `git checkout ${originalBranch} failed: ${errorText(error)}`,
				after: readAfterState(directory),
			};
		}
	}
	if (mode === 'none') {
		return {
			status: 'landed',
			conflictFiles: [],
			detail: `checked out \`${originalBranch}\`; \`${epicBranch}\` left as is`,
			after: readAfterState(directory),
		};
	}
	if (preflight.nothingToLand) {
		return {
			status: 'nothing-to-land',
			conflictFiles: [],
			detail: `checked out \`${originalBranch}\`; the epic branch \`${epicBranch}\` has no changes to land`,
			after: readAfterState(directory),
		};
	}
	const safeEpic = assertSafeGitRefArg(epicBranch, 'epic landing merge');
	if (mode === 'squash') {
		try {
			_internals.gitExecOnce(
				['merge', '--squash', '--no-commit', safeEpic],
				directory,
				NON_INTERACTIVE_LANDING_ENV,
			);
			return {
				status: 'landed',
				conflictFiles: [],
				detail: `squashed \`${epicBranch}\` into \`${originalBranch}\` as staged, uncommitted changes`,
				after: readAfterState(directory),
			};
		} catch (error) {
			const conflictFiles = listConflictFiles(directory);
			const rollback: string[] = [];
			if (conflictFiles.length > 0 || hasStagedChanges(directory)) {
				try {
					_internals.gitExecOnce(['reset', '--merge'], directory);
				} catch (resetError) {
					rollback.push(`git reset --merge failed: ${errorText(resetError)}`);
				}
			}
			return {
				status: conflictFiles.length > 0 ? 'conflict' : 'failed',
				conflictFiles,
				detail: [`git merge --squash failed: ${errorText(error)}`, ...rollback]
					.join(' ')
					.trim(),
				after: readAfterState(directory),
			};
		}
	}
	try {
		_internals.gitExecOnce(
			['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', safeEpic],
			directory,
			NON_INTERACTIVE_LANDING_ENV,
		);
		return {
			status: 'landed',
			conflictFiles: [],
			detail: `merged \`${epicBranch}\` into \`${originalBranch}\` (merge commit)`,
			after: readAfterState(directory),
		};
	} catch (error) {
		const conflictFiles = listConflictFiles(directory);
		const rollback: string[] = [];
		if (mergeInProgress(directory)) {
			try {
				_internals.gitExecOnce(['merge', '--abort'], directory);
			} catch (abortError) {
				rollback.push(`git merge --abort failed: ${errorText(abortError)}`);
			}
		}
		return {
			status: conflictFiles.length > 0 ? 'conflict' : 'failed',
			conflictFiles,
			detail: [`git merge failed: ${errorText(error)}`, ...rollback]
				.join(' ')
				.trim(),
			after: readAfterState(directory),
		};
	}
}

/**
 * `--abandon` (and `/swarm close` finalization, MINOR 3): never land; switch
 * back to the original branch when the tree is clean and no detached commit
 * would be orphaned, so the epic branch is not left checked out. Never throws.
 */
export function leaveEpicBranchOnAbandon(
	directory: string,
	record: EpicRecordV1,
): { status: 'checked-out-original' | 'left-in-place'; detail: string } {
	const pair = epicBranchPair(record);
	if (!pair) return { status: 'left-in-place', detail: 'no epic branch' };
	const { epicBranch, originalBranch } = pair;
	try {
		const current = readCurrentBranch(directory);
		if (current === originalBranch) {
			return {
				status: 'checked-out-original',
				detail: `already on \`${originalBranch}\``,
			};
		}
		if (
			current === null &&
			!isAncestorOf(directory, 'HEAD', epicBranch) &&
			!isAncestorOf(directory, 'HEAD', originalBranch)
		) {
			return {
				status: 'left-in-place',
				detail: `HEAD stays detached: its commit is on neither \`${epicBranch}\` nor \`${originalBranch}\` — keep it on a branch, then \`git checkout ${originalBranch}\``,
			};
		}
		const dirty = listDirtyPathsOutsideSwarm(directory);
		if (dirty.length > 0) {
			return {
				status: 'left-in-place',
				detail: `HEAD stays on ${current ? `\`${current}\`` : 'a detached HEAD'}: ${dirty.length} uncommitted change(s) outside .swarm/ — commit or stash them, then \`git checkout ${originalBranch}\``,
			};
		}
		checkoutExistingBranch(directory, originalBranch);
		return {
			status: 'checked-out-original',
			detail: `checked out \`${originalBranch}\`; \`${epicBranch}\` kept`,
		};
	} catch (error) {
		return {
			status: 'left-in-place',
			detail: `could not switch back to \`${originalBranch}\`: ${errorText(error)}`,
		};
	}
}
