/**
 * Epic v2 C3 (X1) — residue commits for non-coder writers.
 *
 * Coders of an open git epic are isolated in worktrees and their work lands
 * as a commit (`task-landing.ts`). Other agents write in the MAIN tree: the
 * test_engineer writes the task's tests, the docs agent writes docs, and so
 * on. Left uncommitted, those files are invisible to a rework coder (its
 * worktree is cut from HEAD) and collide with its landing. So:
 *
 *   - when a non-coder delegation for a task of the open epic returns —
 *     a foreground Task (the delegation gate's after-hook) or a background
 *     one (the completion observer) — {@link commitEpicResidueAfterDelegation}
 *     commits the main-tree writes still uncommitted on the epic branch:
 *     the returning agent's own recorded writes as
 *     `swarm(task <id>): <agent> residue`, then the rest of the task's
 *     attribution and frozen scope as `swarm(task <id>): residue` (no
 *     agent is claimed for files it did not record), each with the plan's
 *     `Swarm-Plan:` trailer. Files another still-running delegation has
 *     recorded (the concurrent Stage B reviewer/test_engineer) are left
 *     alone: they belong to that writer and may be half-written;
 *   - `epic_next_wave` runs {@link commitTaskResidue} again for each task of
 *     the closing wave (a missed after-hook, a failed attempt); before a new
 *     wave the remaining dirty paths belong to no task
 *     ({@link classifyDirtyBaseline}).
 *
 * Attribution of a path to a task: the task's declared scope in the CURRENT
 * (or closing) wave — literal files or directories, never globs — its write
 * attribution in any session of this project, or, for the after-hook, any
 * write recorded on the delegated agent's own child session. Scopes of
 * earlier waves never attribute anything (later edits there are the
 * user's). Never `.swarm/` (at any depth), never git pathspec magic; staging
 * and the commit use `:(literal)` pathspecs, and the commit is `--only` so
 * anything else in the index stays out of it. Every residue write is
 * serialized with worktree merge-backs (one writer of the primary index at
 * a time), and a failed commit restores the touched index entries exactly
 * (the user's own staged state included).
 *
 * Subprocess discipline (AGENTS.md #3): status is read through `gitExec`;
 * `git add` / `git commit` (and the index restore after a failed commit) run ONCE
 * each through `gitExecOnce`; the commit is non-interactive
 * (`--no-verify`, `-c commit.gpgsign=false`, closed stdin, timeout).
 * Fail-open: every failure is a critical warning — the after-hook must never
 * break, and `epic_next_wave` turns a persistent failure into `git-failed`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { _internals as gitBranchInternals } from '../git/branch.js';
import { runSerializedWithMergeBacks } from '../hooks/delegation-gate/worktree-isolation.js';
import {
	getAgentSession as getAgentSession_import,
	swarmState,
} from '../state.js';
import * as logger from '../utils/logger.js';
import { canonicalAttributionPath } from '../utils/path.js';
import { checkEpicBranch as checkEpicBranch_import } from './epic-branch.js';
import { gitExecOnce } from './git-once.js';
import {
	type EpicRecordV1,
	epicSentinelExists as epicSentinelExists_import,
	getOpenEpic as getOpenEpic_import,
	readPlanTaskRef as readPlanTaskRef_import,
} from './lifecycle.js';
import { formatEpicTaskCommitMessage } from './plan-key.js';
import { collectTaskAttribution as collectTaskAttribution_import } from './wave-close.js';

/**
 * Inline pathspec budget for `git commit` argv (Windows caps the command
 * line at 32 767 chars); larger lists go through `--pathspec-from-file`.
 */
const COMMIT_ARGV_PATHSPEC_BUDGET_BYTES = 24 * 1024;
const PATHSPEC_CHUNK = 200;
/** Bound on the dirty entries one classification considers. */
const MAX_DIRTY_ENTRIES = 5000;

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	epicSentinelExists: epicSentinelExists_import,
	getOpenEpic: getOpenEpic_import,
	readPlanTaskRef: readPlanTaskRef_import,
	checkEpicBranch: checkEpicBranch_import,
	collectTaskAttribution: collectTaskAttribution_import,
	getAgentSession: getAgentSession_import,
	/** Every in-process agent session (id → state), for in-flight writers. */
	listAgentSessions: () => swarmState.agentSessions.entries(),
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	gitExecOnce,
	/** One writer at a time in the primary checkout (merge-back queue). */
	serializeWithMergeBacks: <T>(task: () => T | Promise<T>): Promise<T> =>
		runSerializedWithMergeBacks(task),
	now: (): number => Date.now(),
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True for a path inside a `.swarm/` directory at any depth. */
export function isSwarmStatePath(file: string): boolean {
	const normalized = file.replace(/\\/g, '/');
	return (
		normalized === '.swarm' ||
		normalized.startsWith('.swarm/') ||
		normalized.includes('/.swarm/') ||
		normalized.endsWith('/.swarm')
	);
}

function caseKey(file: string): string {
	return process.platform === 'win32' ? file.toLowerCase() : file;
}

/** One uncommitted path outside `.swarm/` (porcelain v1). */
export interface DirtyEntry {
	path: string;
	untracked: boolean;
	/**
	 * False when the change is fully staged already (worktree column blank):
	 * `git add` must skip it (a staged deletion no longer matches a pathspec).
	 */
	needsAdd?: boolean;
	/** Source path of a rename/copy record (its deletion is staged). */
	origin?: string;
}

/**
 * Uncommitted paths outside `.swarm/` (untracked files listed individually).
 * Throws when git fails.
 */
export function listDirtyEntries(directory: string): DirtyEntry[] {
	const output = _internals.gitExec(
		['status', '--porcelain=v1', '-z', '--untracked-files=all'],
		directory,
	);
	const entries: DirtyEntry[] = [];
	const records = output.split('\0');
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const file = record.slice(3).replace(/\\/g, '/');
		let origin: string | undefined;
		if (code.includes('R') || code.includes('C')) {
			i += 1;
			origin = records[i]?.replace(/\\/g, '/');
		}
		if (isSwarmStatePath(file)) continue;
		entries.push({
			path: file,
			untracked: code === '??',
			needsAdd: code[1] !== ' ',
			...(origin ? { origin } : {}),
		});
		if (entries.length >= MAX_DIRTY_ENTRIES) break;
	}
	return entries;
}

/** `file` equals a declared path or lies under a declared directory. */
function coveredBy(file: string, declared: readonly string[]): boolean {
	const key = caseKey(file);
	return declared.some((entry) => {
		const d = caseKey(entry.replace(/\\/g, '/').replace(/\/+$/, ''));
		return d.length > 0 && (key === d || key.startsWith(`${d}/`));
	});
}

/** Result of one residue commit attempt. */
export type ResidueCommitResult =
	| { status: 'nothing' }
	| { status: 'committed'; sha: string | null; files: string[] }
	| { status: 'failed'; error: string; files: string[] };

function literal(file: string): string {
	return `:(literal)${file}`;
}

/** Index entries (`mode sha` per path, stage 0) of `files`. */
function readIndexEntries(
	directory: string,
	files: readonly string[],
): Map<string, string> {
	const entries = new Map<string, string>();
	for (let i = 0; i < files.length; i += PATHSPEC_CHUNK) {
		const out = _internals.gitExec(
			[
				'ls-files',
				'-s',
				'-z',
				'--',
				...files.slice(i, i + PATHSPEC_CHUNK).map(literal),
			],
			directory,
		);
		for (const record of out.split('\0')) {
			// `<mode> <sha> <stage>\t<path>`
			const tab = record.indexOf('\t');
			if (tab < 0) continue;
			const [mode, sha, stage] = record.slice(0, tab).split(' ');
			if (stage !== '0') continue;
			entries.set(record.slice(tab + 1), `${mode} ${sha}`);
		}
	}
	return entries;
}

/**
 * Put the index entries of `files` back exactly as `before` recorded them:
 * reset to HEAD, then re-apply a pre-staged blob (`--cacheinfo`) or a
 * pre-staged deletion (`--force-remove`). The user's own staged state —
 * including a partially staged file — survives a failed residue commit.
 */
function restoreIndexEntries(
	directory: string,
	files: readonly string[],
	before: Map<string, string>,
): void {
	for (let i = 0; i < files.length; i += PATHSPEC_CHUNK) {
		_internals.gitExecOnce(
			['reset', '-q', '--', ...files.slice(i, i + PATHSPEC_CHUNK).map(literal)],
			directory,
		);
	}
	const after = readIndexEntries(directory, files);
	for (const file of files) {
		const wanted = before.get(file);
		const actual = after.get(file);
		if (wanted === actual) continue;
		if (wanted) {
			const [mode, sha] = wanted.split(' ');
			_internals.gitExecOnce(
				['update-index', '--cacheinfo', `${mode},${sha},${file}`],
				directory,
			);
		} else {
			_internals.gitExecOnce(
				['update-index', '--force-remove', '--', file],
				directory,
			);
		}
	}
}

function commitPaths(
	directory: string,
	message: string,
	files: string[],
	toAdd: string[],
): string | null {
	const base = [
		'-c',
		'commit.gpgsign=false',
		'commit',
		'--only',
		'--no-verify',
		'-m',
		message,
	];
	const pathspecs = files.map(literal);
	const inlineBytes = pathspecs.reduce(
		(sum, p) => sum + Buffer.byteLength(p, 'utf-8') + 1,
		0,
	);
	// The index entries before we touch anything, so a failure restores
	// them exactly (a read failure aborts before any write).
	const before = readIndexEntries(directory, files);
	try {
		for (let i = 0; i < toAdd.length; i += PATHSPEC_CHUNK) {
			_internals.gitExecOnce(
				['add', '-A', '--', ...toAdd.slice(i, i + PATHSPEC_CHUNK).map(literal)],
				directory,
			);
		}
		if (inlineBytes <= COMMIT_ARGV_PATHSPEC_BUDGET_BYTES) {
			_internals.gitExecOnce([...base, '--', ...pathspecs], directory);
		} else {
			const gitPath = _internals
				.gitExec(
					[
						'rev-parse',
						'--git-path',
						`swarm-epic-residue-${process.pid}-${_internals.now()}`,
					],
					directory,
				)
				.trim();
			const specFile = path.resolve(directory, gitPath);
			try {
				fs.writeFileSync(specFile, `${pathspecs.join('\0')}\0`, 'utf-8');
				_internals.gitExecOnce(
					[...base, `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'],
					directory,
				);
			} finally {
				try {
					fs.rmSync(specFile, { force: true });
				} catch {
					// best-effort cleanup of the transient pathspec file
				}
			}
		}
	} catch (error) {
		// Restore the index exactly: a staged-but-uncommitted residue would
		// make the next landing merge refuse, and the user's own staged
		// entries must survive. Working-tree bytes are never touched.
		try {
			restoreIndexEntries(directory, files, before);
		} catch (restoreError) {
			logger.criticalWarn(
				`[epic] could not restore the index after a failed residue commit (${errorText(restoreError)}); check \`git status\` for: ${files.slice(0, 10).join(', ')}`,
			);
		}
		throw error;
	}
	try {
		const head = _internals.gitExec(['rev-parse', 'HEAD'], directory).trim();
		return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
	} catch {
		return null;
	}
}

/**
 * Commit, as task `taskId`'s residue, the dirty paths that are among
 * `candidates` (exact repo-relative paths) or covered by `scopes` (declared
 * files or directories). `dirty` is the current status (read once by the
 * caller). Rename sources follow their destination.
 */
export function commitTaskResidue(args: {
	directory: string;
	epic: EpicRecordV1;
	taskId: string;
	label: string;
	candidates: Iterable<string>;
	scopes?: readonly string[];
	dirty: readonly DirtyEntry[];
}): ResidueCommitResult {
	const wanted = new Set<string>();
	for (const candidate of args.candidates) {
		if (
			typeof candidate === 'string' &&
			candidate.length > 0 &&
			!candidate.startsWith(':') &&
			!isSwarmStatePath(candidate)
		) {
			wanted.add(caseKey(candidate.replace(/\\/g, '/')));
		}
	}
	const files = new Set<string>();
	const toAdd = new Set<string>();
	const scopes = (args.scopes ?? []).filter(
		(entry) => entry.length > 0 && !entry.startsWith(':'),
	);
	const globLike = scopes.filter((entry) => /[*?]/.test(entry));
	if (globLike.length > 0) {
		logger.warn(
			`[epic] task ${args.taskId}: declared scope entries are literal files or directories, never globs; ${globLike.slice(0, 5).join(', ')} only match a path spelled exactly like that.`,
		);
	}
	for (const entry of args.dirty) {
		if (
			!wanted.has(caseKey(entry.path)) &&
			!(scopes.length > 0 && coveredBy(entry.path, scopes))
		) {
			continue;
		}
		files.add(entry.path);
		if (entry.needsAdd !== false) toAdd.add(entry.path);
		if (entry.origin && !isSwarmStatePath(entry.origin)) {
			files.add(entry.origin);
		}
	}
	if (files.size === 0) return { status: 'nothing' };
	const list = [...files].sort();
	try {
		const sha = commitPaths(
			args.directory,
			formatEpicTaskCommitMessage(args.taskId, args.epic.planKey, args.label),
			list,
			[...toAdd].sort(),
		);
		return { status: 'committed', sha, files: list };
	} catch (error) {
		return { status: 'failed', error: errorText(error), files: list };
	}
}

/**
 * Files written by OTHER delegations that are still running (their session
 * is `delegationActive` and is not one of `exclude`). The Stage B reviewer and
 * test_engineer run concurrently: when one returns, the other may still be
 * writing inside the same task's scope, so those paths must not be swept
 * into the returning agent's residue (a half-written file, under the wrong
 * agent's name). They are committed when their own writer returns, or by the
 * wave-close residue pass.
 */
function inFlightWriterFiles(
	directory: string,
	exclude: ReadonlySet<string>,
): Set<string> {
	const files = new Set<string>();
	for (const [id, session] of _internals.listAgentSessions()) {
		if (exclude.has(id) || !session?.delegationActive) continue;
		if (!(session.modifiedFilesByTask instanceof Map)) continue;
		for (const entries of session.modifiedFilesByTask.values()) {
			for (const file of entries) {
				const canonical = canonicalAttributionPath(file, directory);
				if (canonical !== null) files.add(caseKey(canonical));
			}
		}
	}
	return files;
}

function childSessionFiles(
	directory: string,
	ids: Array<string | null | undefined>,
): string[] {
	const files: string[] = [];
	for (const id of new Set(ids)) {
		if (typeof id !== 'string' || id.length === 0) continue;
		const session = _internals.getAgentSession(id);
		if (!session || !(session.modifiedFilesByTask instanceof Map)) continue;
		for (const entries of session.modifiedFilesByTask.values()) {
			for (const file of entries) {
				const canonical = canonicalAttributionPath(file, directory);
				if (canonical !== null) files.push(canonical);
			}
		}
	}
	return files;
}

/**
 * The frozen declared scope of `taskId` in the epic's CURRENT wave (the
 * issued, active one), or `[]`. Scopes of earlier, closed waves never
 * attribute a later write: the user's edits there are not a task's residue.
 */
export function declaredScopeOf(epic: EpicRecordV1, taskId: string): string[] {
	const wave = epic.waves.find(
		(w) => w.seq === epic.activeWaveSeq && w.status === 'issued',
	);
	return [...(wave?.files[taskId] ?? [])];
}

/** What the delegation gate hands the after-hook seam. */
export interface EpicResidueRequest {
	directory: string;
	/** Raw `subagent_type` of the returned Task delegation. */
	agent: string;
	sessionID: string | undefined;
	/** Plan task id(s) the delegation served (lazy: Epic-only work). */
	resolveTaskIds: () => Promise<string[]>;
	/** The delegated agent's child session id(s) (lazy). */
	childSessionIds: () => Promise<Array<string | null | undefined>>;
}

/**
 * After-hook seam (delegation gate, Task `tool.execute.after`): commit the
 * residue of a non-coder writer that served a task of the open git epic.
 * One `existsSync` and nothing else when no epic is open. Never throws.
 */
export async function commitEpicResidueAfterDelegation(
	request: EpicResidueRequest,
): Promise<void> {
	try {
		if (!_internals.epicSentinelExists(request.directory)) return;
		const agent = stripKnownSwarmPrefix(request.agent);
		// Coders land through their worktree; the architect never delegates
		// to itself.
		if (agent === 'coder' || agent === 'architect') return;
		const epic = _internals.getOpenEpic(request.directory);
		if (!epic || !epic.git.isRepo) return;
		const taskIds = (await request.resolveTaskIds()).filter(
			(id) => _internals.readPlanTaskRef(request.directory, id) !== null,
		);
		if (taskIds.length === 0) return;
		const branch = _internals.checkEpicBranch(request.directory, epic);
		if (!branch.ok) {
			logger.criticalWarn(
				`[epic] ${agent} residue for task ${taskIds.join(', ')} NOT committed: ${branch.message}`,
			);
			return;
		}
		const childIds = await request.childSessionIds();
		const childFiles = childSessionFiles(request.directory, childIds);
		const exclude = new Set(
			[...childIds, request.sessionID].filter(
				(id): id is string => typeof id === 'string' && id.length > 0,
			),
		);
		const inFlight = inFlightWriterFiles(request.directory, exclude);
		// Serialized with worktree merge-backs: a landing and a residue commit
		// never contend for the primary checkout's index.
		await _internals.serializeWithMergeBacks(() =>
			commitResidueForTasks(
				request,
				epic,
				agent,
				taskIds,
				childFiles,
				inFlight,
			),
		);
	} catch (error) {
		logger.criticalWarn(
			`[epic] residue commit after a ${request.agent} delegation failed (non-fatal; epic_next_wave retries): ${errorText(error)}`,
		);
	}
}

function commitResidueForTasks(
	request: EpicResidueRequest,
	epic: EpicRecordV1,
	agent: string,
	taskIds: string[],
	childFiles: string[],
	inFlight: ReadonlySet<string> = new Set(),
): void {
	try {
		// Never touch a path another still-running delegation is writing.
		const dirty = listDirtyEntries(request.directory).filter(
			(entry) => !inFlight.has(caseKey(entry.path)),
		);
		if (dirty.length === 0) return;
		let remaining = dirty;
		const commitStep = (
			taskId: string,
			label: string,
			candidates: Iterable<string>,
			scopes: readonly string[],
		): boolean => {
			const result = commitTaskResidue({
				directory: request.directory,
				epic,
				taskId,
				label,
				candidates,
				scopes,
				dirty: remaining,
			});
			if (result.status === 'failed') {
				logger.criticalWarn(
					`[epic] ${label} for task ${taskId} could not be committed (${result.error}); epic_next_wave retries before the next wave. Files: ${result.files.slice(0, 10).join(', ')}`,
				);
				return false;
			}
			if (result.status === 'committed') {
				const done = new Set(result.files.map(caseKey));
				remaining = remaining.filter((entry) => !done.has(caseKey(entry.path)));
			}
			return true;
		};
		for (const [index, taskId] of taskIds.entries()) {
			// 1. The returning agent's own writes, under its name. They cannot
			// be split between the tasks a multi-task delegation served: they
			// go with the first task.
			if (
				index === 0 &&
				childFiles.length > 0 &&
				!commitStep(taskId, `${agent} residue`, childFiles, [])
			) {
				return;
			}
			// 2. The rest of the task's attributed writes and frozen scope (so a
			// rework coder's worktree, cut from HEAD, sees them), under the
			// neutral label wave close uses: no agent is claimed for files it
			// did not record.
			if (
				!commitStep(
					taskId,
					'residue',
					_internals.collectTaskAttribution(
						request.directory,
						request.sessionID,
						taskId,
					),
					declaredScopeOf(epic, taskId),
				)
			) {
				return;
			}
		}
	} catch (error) {
		logger.criticalWarn(
			`[epic] residue commit after a ${request.agent} delegation failed (non-fatal; epic_next_wave retries): ${errorText(error)}`,
		);
	}
}

/** Dirty paths before a new wave, by what Epic does with them. */
export interface DirtyBaselineClassification {
	/** Tracked changes: block the next wave (`dirty-baseline`). */
	unattributedTracked: string[];
	/** Untracked files: advisory only. */
	unattributedUntracked: string[];
}

/**
 * Classify the dirty paths before a new wave (X1 `dirty-baseline`). Residue
 * is only ever attributed to tasks of the CURRENT wave (the after-hook) or
 * the closing wave (`epic_next_wave` commits it before the close), so when a
 * new wave is about to be issued nothing dirty belongs to a task any more:
 * a later edit under an earlier task's declared directory is the user's,
 * never swept into that task's residue. Tracked changes block; untracked
 * files are only reported.
 */
export function classifyDirtyBaseline(
	dirty: readonly DirtyEntry[],
): DirtyBaselineClassification {
	const unattributedTracked: string[] = [];
	const unattributedUntracked: string[] = [];
	for (const entry of dirty) {
		(entry.untracked ? unattributedUntracked : unattributedTracked).push(
			entry.path,
		);
	}
	return { unattributedTracked, unattributedUntracked };
}
