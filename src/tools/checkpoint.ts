import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	consumeConfirmToken,
	issueConfirmToken,
} from '../commands/destructive-purge';
import {
	readGitRepositoryStatusDetailedAsync,
	readGitStatusAsync,
} from '../commands/git-status-read';
import {
	backupTrackedChangesBeforeRollback,
	isUnsafeDirtyRelPath,
	sanitizeDiagnosticText,
} from '../commands/reset-backup';
import {
	describeUnreadableCause,
	formatExcludedRecord,
	measureGitDestruction,
	ROLLBACK_GIT_KIND,
	trackedDirtyCandidates,
} from '../commands/rollback-gate';
import { loadPluginConfigWithMeta } from '../config';
import {
	buildTaskCompletionDescriptor,
	ensureTaskCheckpointReceipt,
	updateTaskCheckpointReceipt,
} from '../db/task-checkpoint-receipt.js';
import { appendCoreEventSync } from '../events/core-events.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { readLedgerEvents } from '../plan/ledger.js';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import {
	GitBinaryMissingError,
	GitSpawnCwdError,
	isGitBinaryMissing,
	isSpawnCwdMissing,
	isSpawnCwdUnreadable,
} from '../utils/git-binary-missing-error.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import {
	isTransientSpawnError,
	MAX_TRANSIENT_RETRIES,
	transientBackoff,
} from '../utils/transient-retry.js';
import { createSwarmTool } from './create-tool';

const CHECKPOINT_LOG_PATH = '.swarm/checkpoints.json';
const PLAN_LOCK_PATH = 'plan.json';
const CHECKPOINT_AGENT_NAME = 'checkpoint';
const MAX_LABEL_LENGTH = 100;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const CHECKPOINT_LOCK_MAX_ATTEMPTS = 20;
const CHECKPOINT_LOCK_DELAY_MS = 250;
const CHECKPOINT_LOCK_DEADLINE_MS = 45_000;
const CHECKPOINT_RECEIPT_LOOKUP_LIMIT = 25;

const SHELL_METACHARACTERS = /[;|&$`(){}<>!'"]/;
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9_ -]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const NON_ASCII_PATTERN = /[^\x20-\x7E]/;

type MutationAction = 'save' | 'restore' | 'delete' | 'save_task_completion';

interface CheckpointEntry {
	label: string;
	sha: string;
	timestamp: string;
}

interface CheckpointLog {
	version: number;
	checkpoints: CheckpointEntry[];
}

interface RetentionEvent {
	event: 'checkpoint_retention_applied';
	evicted_labels: string[];
	evicted_count: number;
	remaining_count: number;
}

export const _internals: {
	tryAcquireLock: typeof tryAcquireLock;
	loadPlan: typeof loadPlan;
	gitExec: typeof gitExec;
	sleep: (ms: number) => Promise<void>;
	findCommitByExactSubject: typeof findCommitByExactSubject;
	stageAllExcludingSwarm: typeof stageAllExcludingSwarm;
	afterTaskEligibilityRead?: (
		directory: string,
		taskId: string,
	) => Promise<void>;
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name. Exposed for test
	 * injection (mirrors `src/git/branch.ts`'s `_internals.resolveGitExecutable`
	 * convention) so a test that mocks `node:child_process` wholesale to drive
	 * `gitExec`'s retry/classification logic can stub a fixed value instead of
	 * having the real candidate-probing loop consume the same mocked
	 * `spawnSync` call slots the test is asserting on.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
	/**
	 * Feedback-round seam (#3441 review): the restore path's destruction
	 * measurement is reachable through this slot so a test can stub the
	 * measurement without mocking the whole rollback-gate module (whose
	 * process-global mock.module form leaks across co-run files).
	 */
	measureGitDestruction: typeof measureGitDestruction;
	/**
	 * Feedback-round seams (PRR-011): the two async reader probes are
	 * reachable through slots so tests stub them by PROPERTY ASSIGNMENT
	 * (restored in afterEach) instead of mock.module — the module-level
	 * registration is process-global and poisoned co-run files.
	 */
	readGitStatusAsync: typeof readGitStatusAsync;
	readGitRepositoryStatusDetailedAsync: typeof readGitRepositoryStatusDetailedAsync;
	/** #3763 AC3: staged-state capture seam (tests stub to force failures). */
	captureIndexEntryForBackup: typeof captureIndexEntryForBackup;
	/**
	 * FB-001 (#3763 feedback round): the authoritative porcelain read that
	 * confirms deletions is a seam so a test can force the lossy/unreadable
	 * status the restore gate must fail closed on (non-UTF-8 names cannot be
	 * created on Windows, so the branch is otherwise untestable there).
	 */
	statusTokensFatal: typeof statusTokensFatal;
} = {
	tryAcquireLock,
	loadPlan,
	gitExec,
	sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	findCommitByExactSubject,
	stageAllExcludingSwarm,
	resolveGitExecutable,
	measureGitDestruction,
	readGitStatusAsync,
	readGitRepositoryStatusDetailedAsync,
	captureIndexEntryForBackup,
	statusTokensFatal,
};

function serializeResult(
	action: MutationAction | 'list' | 'unknown',
	payload: Record<string, unknown>,
): string {
	return JSON.stringify(
		{
			action,
			...payload,
		},
		null,
		2,
	);
}

function containsNonAsciiChars(label: string): boolean {
	for (let i = 0; i < label.length; i++) {
		const charCode = label.charCodeAt(i);
		if (charCode < 0x20 || charCode > 0x7e) {
			return true;
		}
	}
	return false;
}

function validateLabel(label: string): string | null {
	if (!label || label.length === 0) {
		return 'label is required';
	}
	if (label.length > MAX_LABEL_LENGTH) {
		return `label exceeds maximum length of ${MAX_LABEL_LENGTH}`;
	}
	if (label.startsWith('--')) {
		return 'label cannot start with "--" (git flag pattern)';
	}
	if (CONTROL_CHAR_PATTERN.test(label)) {
		return 'label contains control characters';
	}
	if (NON_ASCII_PATTERN.test(label)) {
		return 'label contains non-ASCII or invalid characters';
	}
	if (containsNonAsciiChars(label)) {
		return 'label contains non-ASCII characters (must be printable ASCII only)';
	}
	if (SHELL_METACHARACTERS.test(label)) {
		return 'label contains shell metacharacters';
	}
	if (!SAFE_LABEL_PATTERN.test(label)) {
		return 'label contains invalid characters (use alphanumeric, hyphen, underscore, space)';
	}
	if (!/[a-zA-Z0-9_]/.test(label)) {
		return 'label cannot be whitespace-only';
	}
	if (label.includes('..') || label.includes('/') || label.includes('\\')) {
		return 'label contains path traversal sequence';
	}
	return null;
}

function getCheckpointLogPath(directory: string): string {
	return path.join(directory, CHECKPOINT_LOG_PATH);
}

function readCheckpointLog(directory: string): CheckpointLog {
	const logPath = getCheckpointLogPath(directory);
	try {
		if (fs.existsSync(logPath)) {
			const content = fs.readFileSync(logPath, 'utf-8');
			const parsed = JSON.parse(content) as CheckpointLog;
			if (!parsed.checkpoints || !Array.isArray(parsed.checkpoints)) {
				return { version: 1, checkpoints: [] };
			}
			return parsed;
		}
	} catch {
		// Corrupted or unreadable log falls back to empty.
	}
	return { version: 1, checkpoints: [] };
}

function writeCheckpointLog(log: CheckpointLog, directory: string): void {
	const logPath = getCheckpointLogPath(directory);
	const dir = path.dirname(logPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tempPath = `${logPath}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(log, null, 2), 'utf-8');
	fs.renameSync(tempPath, logPath);
}

function appendRetentionEvent(directory: string, event: RetentionEvent): void {
	try {
		appendCoreEventSync(directory, {
			...event,
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Best-effort event logging only.
	}
}

function loadCheckpointConfig(directory: string): {
	maxCheckpoints: number;
	allowEmptyCommits: boolean;
} {
	let maxCheckpoints = 20;
	let allowEmptyCommits = false;
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		maxCheckpoints = config.checkpoint?.max_retention ?? maxCheckpoints;
		allowEmptyCommits = config.checkpoint?.allow_empty_commits === true;
	} catch {
		// Defaults are fine when config loading fails.
	}
	return { maxCheckpoints, allowEmptyCommits };
}

function appendCheckpointEntry(
	directory: string,
	log: CheckpointLog,
	entry: CheckpointEntry,
	maxCheckpoints: number,
): void {
	const existing = log.checkpoints.find(
		(checkpoint) => checkpoint.label === entry.label,
	);
	if (existing) {
		if (existing.sha !== entry.sha) {
			throw new Error(
				`checkpoint log conflict: label "${entry.label}" already exists with a different SHA`,
			);
		}
		return;
	}

	log.checkpoints.push(entry);
	if (log.checkpoints.length > maxCheckpoints) {
		const evicted = log.checkpoints.splice(
			0,
			log.checkpoints.length - maxCheckpoints,
		);
		appendRetentionEvent(directory, {
			event: 'checkpoint_retention_applied',
			evicted_labels: evicted.map((checkpoint) => checkpoint.label),
			evicted_count: evicted.length,
			remaining_count: log.checkpoints.length,
		});
	}
}

function upsertTaskCompletionCheckpointEntry(
	directory: string,
	log: CheckpointLog,
	entry: CheckpointEntry,
	maxCheckpoints: number,
): void {
	const existingIndex = log.checkpoints.findIndex(
		(checkpoint) => checkpoint.label === entry.label,
	);
	if (existingIndex >= 0) {
		const existing = log.checkpoints[existingIndex];
		if (existing.sha === entry.sha) {
			return;
		}
		log.checkpoints[existingIndex] = entry;
		return;
	}

	log.checkpoints.push(entry);
	if (log.checkpoints.length > maxCheckpoints) {
		const evicted = log.checkpoints.splice(
			0,
			log.checkpoints.length - maxCheckpoints,
		);
		appendRetentionEvent(directory, {
			event: 'checkpoint_retention_applied',
			evicted_labels: evicted.map((checkpoint) => checkpoint.label),
			evicted_count: evicted.length,
			remaining_count: log.checkpoints.length,
		});
	}
}

function stageAllExcludingSwarm(directory: string): void {
	const paths = listNonSwarmDirtyPaths(directory);
	// Literal pathspecs are load-bearing (#3763): a plain `git add -- <path>`
	// treats the argument as a glob, so a real file named `[.]swarm/marker.txt`
	// would also stage the ignored `.swarm` tree. `--literal-pathspecs` (a
	// global git flag) makes every argument match itself only.
	const CHUNK = 50;
	for (let i = 0; i < paths.length; i += CHUNK) {
		_internals.gitExec(
			[
				'--literal-pathspecs',
				'add',
				'--all',
				'--',
				...paths.slice(i, i + CHUNK),
			],
			directory,
		);
	}
}

/** Porcelain XY codes that mean "unmerged" — staging one would silently
 * resolve a conflict, so ordinary checkpoint save refuses them instead
 * (#3763 plan v3, critic round 2). */
const UNMERGED_STATUS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function isSwarmRuntimePath(rel: string): boolean {
	return rel === '.swarm' || rel.startsWith('.swarm/');
}

/**
 * Project-directory-relative prefix of the repo root's path space
 * (FB-002, #3763 feedback round). `git status --porcelain` emits paths
 * relative to the REPO ROOT even when run with `-- .` from a subdirectory
 * project root (a legitimate nested `.opencode/` root per AGENTS.md #2127),
 * while `git add`/`commit` below run with `cwd=directory`. Both sides must
 * speak the same base: the parser strips this prefix from every porcelain
 * path, and the commit arms re-anchor the `.swarm` exclusion at it.
 * Returns '' for the ordinary repo-root project, 'pkg/' for a subdirectory
 * root, and refuses pathspec-metacharacter prefixes fail-closed.
 */
function projectRootPrefix(directory: string): string {
	// The prefix comes from GIT (`rev-parse --show-prefix`), never from
	// mixing a git-emitted toplevel with the JS-resolved directory: on
	// Windows CI runners `os.tmpdir()` resolves to the 8.3 short form while
	// `--show-toplevel` prints the long form, and lexical path math between
	// the two silently misclassifies every porcelain path (the #3668 FB-026
	// class). `--show-prefix` is printed by the same git invocation that
	// prints the porcelain paths, so the base is always consistent: '' at
	// the repo root, 'pkg/' for a subdirectory project root.
	// FB-002 (#3763 feedback round): strip ONLY the trailing line terminator.
	// A `.trim()` would also eat a legitimate leading-space directory name and
	// desync the prefix from git's porcelain spelling.
	const raw = gitExec(['rev-parse', '--show-prefix'], directory).replace(
		/[\r\n]+$/,
		'',
	);
	if (raw === '') return '';
	const posixRel = raw.replace(/\/+$/, '');
	// A directory name containing pathspec magic would corrupt the
	// exclusion patterns — refuse rather than mis-scope.
	if (/[\\[\]?*]|\.\.|:\(/.test(posixRel)) {
		throw new Error(
			'checkpoint refused: the project directory path contains git-pathspec metacharacters — move the project to a plain path',
		);
	}
	return `${posixRel}/`;
}

/**
 * One fatal-decoded `git status --porcelain -z` read of the project subtree
 * (FB-001 save side + X-F03 companion, #3763 feedback round). Reading as a
 * buffer and decoding with `fatal: true` means a repo-controlled name whose
 * bytes are not valid UTF-8 (git emits raw bytes on POSIX) REFUSES the
 * operation instead of arriving as a U+FFFD-corrupted string that could
 * neither be staged faithfully nor matched against `.swarm`.
 */
/**
 * Commit-arm pathspec scope (#3763 AC2 + FB-002 feedback round): commit only
 * the project subtree and never let `.swarm` runtime state enter the
 * checkpoint commit through EITHER commit arm. The exclusion patterns are
 * re-anchored at the git-provided project prefix so a subdirectory project
 * root excludes ITS `.swarm` (`:(exclude,top)pkg/.swarm`), while the
 * repo-root case stays byte-identical to `:(exclude,top).swarm`.
 */
function nonSwarmCommitPathspec(directory: string): string[] {
	const prefix = projectRootPrefix(directory);
	return [
		'.',
		`:(exclude,top)${prefix}.swarm`,
		`:(exclude,top)${prefix}.swarm/**`,
	];
}

function statusTokensFatal(directory: string): string[] {
	// Transient spawn failures RETRY exactly like every other git call in
	// this module (runGitBounded); only a committedly unreadable status or a
	// lossy-decoded name refuses.
	let raw: Buffer;
	try {
		raw = runGitBounded(
			['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'],
			directory,
			'buffer',
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/ENOBUFS/i.test(message)) {
			throw new Error(
				'checkpoint refused: git status output exceeded the 5 MB capture limit (an extremely large dirty tree) — commit or clean files and retry',
			);
		}
		throw new Error(
			`git status could not be read: ${sanitizeDiagnosticText(message)}`,
		);
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
	} catch {
		throw new Error(
			'checkpoint refused: git status reported file names that are not valid UTF-8 — rename or commit them before saving',
		);
	}
}

/**
 * Enumerate dirty paths EXCLUDING `.swarm` runtime state (#3763 AC1/AC2).
 *
 * Parses `git status --porcelain -z --untracked-files=all` as a complete
 * record state machine: rename/copy records carry TWO NUL-separated tokens
 * (destination first, source second); both sides are classified against
 * `.swarm` independently. Cross-`.swarm`-boundary renames/copies and any
 * unmerged (conflicted) record REFUSE the staging before any mutation —
 * a partial rename staging or a silently-resolved conflict is never
 * acceptable from an ordinary checkpoint save.
 */
function listNonSwarmDirtyPaths(directory: string): string[] {
	const tokens = statusTokensFatal(directory);
	// FB-002 (#3763 feedback round): porcelain paths are repo-ROOT-relative;
	// add/commit below run with `cwd=directory`. Normalize every path to the
	// PROJECT base by stripping the git-provided prefix.
	const prefix = projectRootPrefix(directory);
	const toProjectRel = (rel: string): string => {
		if (prefix) {
			if (!rel.startsWith(prefix)) {
				// The `-- .` scoping guarantees every record lives under the
				// project directory; anything else is unparsable state.
				throw new Error(
					`checkpoint staging refused: git status reported ${sanitizeDiagnosticText(rel)} outside the project subtree (${sanitizeDiagnosticText(prefix)}…)`,
				);
			}
			rel = rel.slice(prefix.length);
		}
		// FB-018 defense-in-depth (round 5): single shared platform-aware
		// containment predicate — exported sink and staging parser cannot
		// drift apart (the round-4 mixed-separator hole was the separate
		// inline copies disagreeing under Windows union splitting).
		if (isUnsafeDirtyRelPath(rel)) {
			throw new Error(
				`checkpoint staging refused: git status reported a path outside the project root (${sanitizeDiagnosticText(rel)})`,
			);
		}
		return rel;
	};
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i];
		if (!record) continue;
		const xy = record.slice(0, 2);
		if (record.length < 4 || record.charCodeAt(2) !== 32 /* space */) {
			throw new Error(
				`checkpoint staging refused: unparsable git status record ${JSON.stringify(record.slice(0, 40))}`,
			);
		}
		if (UNMERGED_STATUS.has(xy)) {
			throw new Error(
				`checkpoint staging refused: ${sanitizeDiagnosticText(record.slice(3))} has unresolved conflicts (${xy}); resolve them before saving a checkpoint`,
			);
		}
		const to = toProjectRel(record.slice(3));
		if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
			const from = tokens[i + 1] ?? '';
			if (!from) {
				throw new Error(
					`checkpoint staging refused: truncated rename/copy record for ${sanitizeDiagnosticText(to)}`,
				);
			}
			i += 1; // consume the source token
			const fromChecked = toProjectRel(from);
			const toIsSwarm = isSwarmRuntimePath(to);
			const fromIsSwarm = isSwarmRuntimePath(fromChecked);
			if (toIsSwarm !== fromIsSwarm) {
				throw new Error(
					`checkpoint staging refused: rename/copy crosses the .swarm boundary (${sanitizeDiagnosticText(fromChecked)} -> ${sanitizeDiagnosticText(to)}); move or revert it before saving a checkpoint`,
				);
			}
			if (!toIsSwarm) {
				// Stage ONLY the destination: a rename's source no longer
				// exists on disk AND is already gone from the index, so a
				// literal `git add --all -- <source>` is a fatal "did not
				// match any files" (4.5 review round 1); the index already
				// carries the removal, and staging `to` completes the
				// rename. A copy's source is unchanged — staging the
				// destination alone is sufficient there too.
				paths.push(to);
			}
			continue;
		}
		if (xy[0] === 'D') {
			// A STAGED deletion (`D `, e.g. after `git rm`): the path is in
			// neither the worktree nor the index, so a literal
			// `git add --all -- <path>` is a fatal "did not match any files"
			// (4.5 review round 2) — and there is nothing to stage: the
			// index already carries the removal and the scoped commit
			// includes it. Unstaged worktree deletions (` D`) still stage
			// through the push below (the index still holds the path).
			continue;
		}
		if (!isSwarmRuntimePath(to)) {
			paths.push(to);
		}
	}
	return [...new Set(paths)];
}

/**
 * Shared bounded git runner (invariant 3): array-form spawn, explicit cwd,
 * stdin ignored, timeout, bounded output, transient-retry classification —
 * the discipline `gitExec` always had, extracted so the buffer-decoded
 * porcelain read (FB-001) keeps the SAME retry semantics as the string path
 * instead of failing a save on the first transient ETIMEDOUT (round-2
 * regression caught by checkpoint.git-failure.test.ts).
 */
function runGitBounded(args: string[], cwd: string, encoding: 'utf-8'): string;
function runGitBounded(args: string[], cwd: string, encoding: 'buffer'): Buffer;
function runGitBounded(
	args: string[],
	cwd: string,
	encoding: 'utf-8' | 'buffer',
): string | Buffer {
	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = child_process.spawnSync(
			_internals.resolveGitExecutable(),
			args,
			{
				cwd,
				encoding,
				timeout: GIT_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				maxBuffer: GIT_MAX_BUFFER_BYTES,
			},
		);

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			const message = result.error.message ?? '';
			const isTransient =
				isTransientSpawnError(result.error) ||
				/ETIMEDOUT|timed out/i.test(message);

			if (!isTransient || attempt >= MAX_TRANSIENT_RETRIES - 1) {
				// #2236 F0d: this is the other site that formatted a raw spawn
				// message into user-visible text. An ENOENT here does NOT mean git
				// is missing — it means that just as often when `cwd` has been torn
				// down. Classify with the cwd we already hold rather than leaking
				// the raw errno. Classification lives inside the throw branch so
				// the transient-retry set above is untouched.
				if (isSpawnCwdMissing(result.error, cwd)) {
					throw new GitSpawnCwdError(cwd, 'missing');
				}
				if (isSpawnCwdUnreadable(result.error, cwd)) {
					throw new GitSpawnCwdError(cwd, 'unreadable');
				}
				if (isGitBinaryMissing(result.error, cwd)) {
					throw new GitBinaryMissingError(
						`git executable is not available on PATH (working directory ${cwd} exists)`,
						{ cause: result.error },
					);
				}
				throw new Error(
					`git failed to start: ${code ?? 'unknown'} - ${message}`,
				);
			}

			transientBackoff(attempt);
			continue;
		}

		if (result.status === 0) {
			return encoding === 'buffer'
				? ((result.stdout as Buffer | null) ?? Buffer.alloc(0))
				: ((result.stdout as string | null) ?? '');
		}

		const stderrText =
			typeof result.stderr === 'string'
				? result.stderr.trim()
				: Buffer.isBuffer(result.stderr)
					? result.stderr.toString('utf-8').trim()
					: '';
		throw new Error(stderrText || `git exited with code ${result.status}`);
	}

	throw new Error('git command failed after transient retries');
}

function gitExec(args: string[], cwd: string): string {
	return runGitBounded(args, cwd, 'utf-8');
}

function getCurrentSha(directory: string): string {
	return gitExec(['rev-parse', 'HEAD'], directory).trim();
}

/**
 * Binary-safe capture of one dirty path's STAGED (index) state into
 * `<backupDir>/index/<rel>` (#3763 AC3). Returns the recorded mode, or null
 * when the path has no index entry. Any failure THROWS — the backup producer
 * converts it into `recoveryComplete: false` so the restore gate refuses
 * (never a partial silent capture).
 */
function captureIndexEntryForBackup(input: {
	directory: string;
	backupDir: string;
	rel: string;
}): { mode: string; gitlink?: boolean; sha?: string } | null {
	const stageOut = _internals.gitExec(
		['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', input.rel],
		input.directory,
	);
	const records = stageOut
		.split('\0')
		.filter((record) => record.length > 0)
		.map((record) => {
			const tab = record.indexOf('\t');
			if (tab <= 0) {
				throw new Error(`unparsable ls-files --stage record for ${input.rel}`);
			}
			const meta = record.slice(0, tab).split(' ');
			return { mode: meta[0], sha: meta[1], stage: Number(meta[2]) };
		})
		.filter((entry) => entry.mode && entry.sha);
	if (records.length === 0) return null;
	if (records.length > 1 || records[0].stage !== 0) {
		throw new Error(
			`unmerged index records for ${input.rel} (${records.length} entries) — staged-state capture is incomplete`,
		);
	}
	const { mode, sha } = records[0];
	if (mode === '160000') {
		// FB-003 (#3763 feedback round): a gitlink (submodule pointer) has no
		// blob object — `cat-file blob <commit-sha>` exits 128 and used to
		// refuse the whole restore over a dirty submodule. Record the sha
		// honestly; the reset restores the pointer itself.
		return { mode, gitlink: true, sha };
	}
	// FB-020: the sha is repo/index-derived data feeding an operand position —
	// shape-validate it (git emits lowercase hex, but the capture is a sink).
	if (!/^[0-9a-f]{40,64}$/.test(sha)) {
		throw new Error(
			`unparsable index blob sha for ${input.rel} — staged-state capture is incomplete`,
		);
	}
	const dest = path.join(input.backupDir, 'index', input.rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	// FB-003: stream the blob STRAIGHT into the destination fd instead of
	// buffering it through maxBuffer — a staged blob larger than the old 5 MB
	// pipe cap used to ENOBUFS and refuse the restore of any dirty tree
	// containing it (#3763 feedback round). Binary-safe by construction (raw
	// fd write, no decoding — replaces the encoding:'buffer' spawnSync).
	const fd = fs.openSync(dest, 'w');
	let captureError: Error | null = null;
	try {
		const result = child_process.spawnSync(
			_internals.resolveGitExecutable(),
			['cat-file', 'blob', sha],
			{
				cwd: input.directory,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: 64 * 1024, // stderr only; stdout flows to the fd
				stdio: ['ignore', fd, 'pipe'],
				windowsHide: true,
				encoding: 'buffer',
			},
		);
		if (result.error || result.status !== 0) {
			captureError = new Error(
				`cat-file capture failed for ${input.rel}@${sha}${
					result.error
						? `: ${(result.error as NodeJS.ErrnoException).code === 'ENOBUFS' ? 'stderr overflow' : result.error.message}`
						: result.status !== 0
							? ` (exit ${result.status})`
							: ''
				}`,
			);
		}
	} finally {
		fs.closeSync(fd);
	}
	if (captureError) {
		// Never leave a half-written staged blob in a backup humans read.
		try {
			fs.rmSync(dest, { force: true });
		} catch {
			// best-effort
		}
		throw captureError;
	}
	return { mode };
}

function findCommitByExactSubject(
	directory: string,
	subject: string,
): string | null {
	const output = _internals.gitExec(
		[
			'log',
			'HEAD',
			'--format=%H%x00%s',
			'--fixed-strings',
			`--grep=${subject}`,
			'-n',
			String(CHECKPOINT_RECEIPT_LOOKUP_LIMIT),
		],
		directory,
	);
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		const nulIndex = line.indexOf('\0');
		if (nulIndex <= 0) continue;
		const sha = line.slice(0, nulIndex).trim();
		const candidateSubject = line.slice(nulIndex + 1);
		if (
			sha.length === 40 &&
			/^[a-f0-9]{40}$/i.test(sha) &&
			candidateSubject === subject
		) {
			return sha;
		}
	}
	return null;
}

async function withTaskCompletionLocksResult<T>(input: {
	directory: string;
	taskId: string;
	run: () => Promise<T>;
	onBusy?: (attempts: number) => T;
	onFailure?: (error: unknown) => T;
}): Promise<T> {
	const deadline = Date.now() + CHECKPOINT_LOCK_DEADLINE_MS;
	let attempts = 0;

	while (attempts < CHECKPOINT_LOCK_MAX_ATTEMPTS && Date.now() <= deadline) {
		attempts++;
		let planLockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
		try {
			planLockResult = await _internals.tryAcquireLock(
				input.directory,
				PLAN_LOCK_PATH,
				CHECKPOINT_AGENT_NAME,
				`save-task-completion-plan-${input.taskId}`,
			);
		} catch (error) {
			if (input.onFailure) {
				return input.onFailure(error);
			}
			return serializeResult('save_task_completion', {
				success: false,
				error: `save_task_completion failed: ${sanitizeDiagnosticText(
					error instanceof Error ? error.message : String(error),
				)}`,
			}) as T;
		}

		if (!planLockResult.acquired) {
			if (
				attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
				Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
			) {
				break;
			}
			await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
			continue;
		}

		try {
			let checkpointLockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
			try {
				checkpointLockResult = await _internals.tryAcquireLock(
					input.directory,
					CHECKPOINT_LOG_PATH,
					CHECKPOINT_AGENT_NAME,
					`save-task-completion-checkpoint-${input.taskId}`,
				);
			} catch (error) {
				if (input.onFailure) {
					return input.onFailure(error);
				}
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: ${sanitizeDiagnosticText(
						error instanceof Error ? error.message : String(error),
					)}`,
				}) as T;
			}

			if (!checkpointLockResult.acquired) {
				if (
					attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
					Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
				) {
					break;
				}
				await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
				continue;
			}

			try {
				return await input.run();
			} catch (error) {
				if (input.onFailure) {
					return input.onFailure(error);
				}
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: ${sanitizeDiagnosticText(
						error instanceof Error ? error.message : String(error),
					)}`,
				}) as T;
			} finally {
				if (checkpointLockResult.lock._release) {
					try {
						await checkpointLockResult.lock._release();
					} catch {
						// Release failure is advisory only.
					}
				}
			}
		} finally {
			if (planLockResult.lock._release) {
				try {
					await planLockResult.lock._release();
				} catch {
					// Release failure is advisory only.
				}
			}
		}
	}

	if (input.onBusy) {
		return input.onBusy(attempts);
	}
	return serializeResult('save_task_completion', {
		success: false,
		status: 'checkpoint_busy',
		error:
			'checkpoint_busy: checkpoint or plan state is locked by another operation; retry after the current mutation completes',
		retryable: true,
		attempts,
	}) as T;
}

async function withCheckpointMutationLock(input: {
	action: MutationAction;
	directory: string;
	operationKey: string;
	run: () => Promise<string>;
	onContendedAttempt?: () => string | null;
}): Promise<string> {
	const result = await withCheckpointMutationLockResult({
		action: input.action,
		directory: input.directory,
		operationKey: input.operationKey,
		run: input.run,
		onContendedAttempt: input.onContendedAttempt,
	});
	return result;
}

async function withCheckpointMutationLockResult<T>(input: {
	action: MutationAction;
	directory: string;
	operationKey: string;
	run: () => Promise<T>;
	onContendedAttempt?: () => T | null;
	onBusy?: (attempts: number) => T;
	onFailure?: (error: unknown) => T;
}): Promise<T> {
	const deadline = Date.now() + CHECKPOINT_LOCK_DEADLINE_MS;
	let attempts = 0;

	while (attempts < CHECKPOINT_LOCK_MAX_ATTEMPTS && Date.now() <= deadline) {
		attempts++;
		let lockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
		try {
			lockResult = await _internals.tryAcquireLock(
				input.directory,
				CHECKPOINT_LOG_PATH,
				CHECKPOINT_AGENT_NAME,
				input.operationKey,
			);
		} catch (error) {
			if (input.onFailure) {
				return input.onFailure(error);
			}
			return serializeResult(input.action, {
				success: false,
				error: `${input.action} failed: ${sanitizeDiagnosticText(
					error instanceof Error ? error.message : String(error),
				)}`,
			}) as T;
		}

		if (lockResult.acquired) {
			try {
				try {
					return await input.run();
				} catch (error) {
					if (input.onFailure) {
						return input.onFailure(error);
					}
					return serializeResult(input.action, {
						success: false,
						error: `${input.action} failed: ${sanitizeDiagnosticText(
							error instanceof Error ? error.message : String(error),
						)}`,
					}) as T;
				}
			} finally {
				if (lockResult.lock._release) {
					try {
						await lockResult.lock._release();
					} catch {
						// Release failure is advisory only.
					}
				}
			}
		}

		const contended = input.onContendedAttempt?.();
		if (contended) return contended;
		if (
			attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
			Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
		) {
			break;
		}
		await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
	}

	if (input.onBusy) {
		return input.onBusy(attempts);
	}
	return serializeResult(input.action, {
		success: false,
		status: 'checkpoint_busy',
		error:
			'checkpoint_busy: checkpoint state is locked by another operation; retry after the current mutation completes',
		retryable: true,
		attempts,
	}) as T;
}

function handleSave(label: string, directory: string): string {
	try {
		const { maxCheckpoints, allowEmptyCommits } =
			loadCheckpointConfig(directory);
		const log = readCheckpointLog(directory);
		const existingCheckpoint = log.checkpoints.find(
			(checkpoint) => checkpoint.label === label,
		);
		if (existingCheckpoint) {
			return serializeResult('save', {
				success: false,
				error: `duplicate label: "${label}" already exists. Use a different label or delete the existing checkpoint first.`,
			});
		}

		const timestamp = new Date().toISOString();
		_internals.stageAllExcludingSwarm(directory);
		// Scoped to non-`.swarm` paths (#3763): a pre-staged `.swarm` entry
		// must neither trigger the "has staged changes" probe nor enter an
		// ordinary checkpoint commit through EITHER commit arm — the same
		// pathspec scoping save_task_completion's commit already uses.
		// FB-002: the exclusion anchors at the git-provided project prefix
		// so a subdirectory project root excludes ITS .swarm.
		const commitScope = nonSwarmCommitPathspec(directory);
		const hasStagedChanges = (() => {
			try {
				gitExec(
					['diff', '--cached', '--quiet', '--', ...commitScope],
					directory,
				);
				return false;
			} catch {
				return true;
			}
		})();

		if (hasStagedChanges) {
			gitExec(
				['commit', '-m', `checkpoint: ${label}`, '--', ...commitScope],
				directory,
			);
		} else if (allowEmptyCommits) {
			gitExec(
				[
					'commit',
					'--allow-empty',
					'-m',
					`checkpoint: ${label}`,
					'--',
					...commitScope,
				],
				directory,
			);
		}

		const newSha = getCurrentSha(directory);
		appendCheckpointEntry(
			directory,
			log,
			{
				label,
				sha: newSha,
				timestamp,
			},
			maxCheckpoints,
		);
		writeCheckpointLog(log, directory);

		return serializeResult('save', {
			success: true,
			label,
			sha: newSha,
			message: `Checkpoint saved: "${label}"`,
		});
	} catch (e) {
		return serializeResult('save', {
			success: false,
			error:
				e instanceof Error
					? `save failed: ${sanitizeDiagnosticText(e.message)}`
					: 'save failed: unknown error',
		});
	}
}

export async function saveCheckpointRecord(
	label: string,
	directory: string,
): Promise<{
	success: boolean;
	sha?: string;
	error?: string;
	warning?: string;
}> {
	const labelError = validateLabel(label);
	if (labelError) {
		return { success: false, error: labelError };
	}
	return withCheckpointMutationLockResult({
		action: 'save',
		directory,
		operationKey: `save-record-${label}`,
		run: async () => {
			const log = readCheckpointLog(directory);
			if (log.checkpoints.find((checkpoint) => checkpoint.label === label)) {
				return { success: false, error: `duplicate label: "${label}"` };
			}
			let sha = '';
			// #3427: the repository probe rides the shared async reader
			// (bounded, killable) instead of the local sync gitExec retry
			// chain — on a host whose sync spawns stall (#3275), this leg no
			// longer blocks the save path. This is a DURABLE write inside the
			// mutation lock, so unlike the entry preflight it keeps bounded
			// transient tolerance: readGitStatusAsync retries a transient
			// spawn failure once (feedback round PRR-003) instead of letting
			// a single EBUSY/EPERM/ETIMEDOUT record a sha-less checkpoint.
			// NOTE: readGitStatusAsync resolves to a full GitStatusReadResult
			// object (always truthy) — branch on `.ok`, never on the object.
			const saveProbe = await _internals.readGitStatusAsync(
				['rev-parse', '--git-dir'],
				directory,
			);
			if (saveProbe.ok) {
				try {
					sha = getCurrentSha(directory);
				} catch {
					sha = '';
				}
			}
			appendCheckpointEntry(
				directory,
				log,
				{
					label,
					sha,
					timestamp: new Date().toISOString(),
				},
				loadCheckpointConfig(directory).maxCheckpoints,
			);
			writeCheckpointLog(log, directory);
			const result: {
				success: boolean;
				sha?: string;
				error?: string;
				warning?: string;
			} = { success: true, sha };
			if (!sha) {
				result.warning =
					'no git restore target - checkpoint recorded without a SHA (directory may not be a git repository or HEAD is unavailable)';
			}
			return result;
		},
		onBusy: () => ({
			success: false,
			error:
				'checkpoint_busy: checkpoint state is locked by another operation; retry after the current mutation completes',
		}),
		onFailure: (error) => ({
			success: false,
			error:
				error instanceof Error
					? sanitizeDiagnosticText(error.message)
					: 'unknown error',
		}),
	});
}

async function handleRestore(
	label: string,
	directory: string,
	confirmToken?: string,
): Promise<string> {
	try {
		const log = readCheckpointLog(directory);
		const checkpoint = log.checkpoints.find(
			(candidate) => candidate.label === label,
		);
		if (!checkpoint) {
			return serializeResult('restore', {
				success: false,
				error: `checkpoint not found: "${label}"`,
			});
		}

		// FB-004 (#3763 feedback round, pre-existing hazard X-MN): restoring
		// from a SUBDIRECTORY project root runs `git reset --hard` against
		// the PARENT repository — the scope measurement sees no tracked
		// changes there (a nested root has no real `.git` of its own), so
		// the reset destroys every uncommitted tracked change in the parent
		// with no preview, token, or backup. Fail closed until toplevel
		// measurement lands (follow-up issue): checkpoint restore is only
		// safe at the repository root.
		const restorePrefix = projectRootPrefix(directory);
		if (restorePrefix) {
			return serializeResult('restore', {
				success: false,
				error: `checkpoint restore is not supported from a subdirectory project root yet: ${sanitizeDiagnosticText(directory)} is the subdirectory "${sanitizeDiagnosticText(restorePrefix)}" of a parent repository, where a hard reset would destroy the parent's uncommitted work unbacked. The checkpoint "${sanitizeDiagnosticText(label)}" was saved as a real commit and is recorded under this subdirectory's ${sanitizeDiagnosticText(path.join('.swarm', 'checkpoints.json'))} — to recover it manually, from the repository root first commit or stash the parent's own uncommitted work, then use a SCOPED command that does not move HEAD: git restore --source=<checkpoint-sha> -- ${sanitizeDiagnosticText(restorePrefix)} (add --staged to restore the index too). Do NOT run a bare git reset --hard at the root — it would also discard the parent's later commits and uncommitted work, the very hazard this refusal prevents. Or await durable toplevel measurement (follow-up from PR #3901). Do NOT just rerun the restore from the repository root: that root reads a DIFFERENT checkpoint log and would not find this label.`,
			});
		}

		// #2946: a destructive scope (uncommitted tracked work, or untracked
		// files at paths the target tree materializes, that a hard reset
		// would discard) requires the two-step preview + confirm-token
		// contract. The candidate set is derived by the shared rollback-gate
		// module so a token minted by /swarm rollback or /swarm checkpoint
		// (command layer) is consumable here at the sink — and vice versa.
		// Routed through the _internals seam (feedback round) so tests can
		// stub the measurement without a process-global module mock.
		const measurement = await _internals.measureGitDestruction(
			directory,
			checkpoint.sha,
		);
		if (measurement.kind === 'unreadable') {
			// #3317: name WHY the read failed when the async reader could tell
			// (single shared source with the /swarm rollback command). #3434:
			// this also covers an unreadable ls-tree/ls-files enumeration,
			// and the `source` field names WHICH read failed.
			const cause = describeUnreadableCause(measurement, measurement.source);
			const unreadableNote =
				measurement.excludedOutOfRoot &&
				measurement.excludedOutOfRoot.length > 0
					? ` — ${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) had been excluded from the scope before the read failed (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
					: '';
			return serializeResult('restore', {
				success: false,
				error: `cannot verify the working tree (${
					measurement.source === 'enumeration'
						? 'the target-tree listing could not be read'
						: 'git status unreadable'
				}; ${cause})${unreadableNote} — refusing to restore without a preview.`,
			});
		}
		// #3434: bounded diagnostic for out-of-root porcelain records
		// excluded from the destroy scope — surfaced on the preview, the
		// confirmed restore, and the clean-tree restore below, so an
		// exclusion is never silent. Record bytes pass through
		// formatExcludedRecord before reaching operator/agent-visible text.
		const exclusionNote =
			measurement.excludedOutOfRoot.length > 0
				? `${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) were excluded from this scope (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
				: null;
		if (measurement.dirtyRelPaths.length > 0) {
			const candidates = trackedDirtyCandidates(
				directory,
				measurement.dirtyRelPaths,
			);
			const scopeAnchor = candidates[0].path;
			if (!confirmToken) {
				const token = issueConfirmToken(scopeAnchor, directory, {
					kind: ROLLBACK_GIT_KIND,
					candidates,
				});
				const shown = measurement.dirtyRelPaths.slice(0, 10);
				const overflow = measurement.dirtyRelPaths.length - shown.length;
				return serializeResult('restore', {
					success: false,
					requires_confirm: true,
					preview: [
						`Restoring to checkpoint "${label}" runs a hard git reset and would DESTROY ${candidates.length} uncommitted tracked file(s):`,
						...shown.map((p) => `  - ${sanitizeDiagnosticText(p)}`),
						...(overflow > 0 ? [`  (+${overflow} more)`] : []),
						...(exclusionNote ? [`⚠ ${exclusionNote}`] : []),
						'Backups are taken automatically once confirmed.',
					],
					confirm_token: token,
					message:
						'restore preview — re-run with confirm_token to execute (valid 15 minutes)',
				});
			}
			const verdict = consumeConfirmToken(
				scopeAnchor,
				directory,
				confirmToken,
				{ kind: ROLLBACK_GIT_KIND, candidates },
			);
			if (!verdict.ok) {
				return serializeResult('restore', {
					success: false,
					error: verdict.reason,
				});
			}
			// FB-001 (#3763 feedback round): deletions are only recorded when
			// a fresh fatal-decoded porcelain read reports a D in the XY code.
			// An unreadable/lossy status read confirms NOTHING — every
			// fs-invisible path then lands uncovered and the gate refuses.
			const gitDeletions = (() => {
				try {
					const set = new Set<string>();
					const tokens = _internals.statusTokensFatal(directory);
					for (let i = 0; i < tokens.length; i++) {
						const token = tokens[i];
						if (!token) continue;
						if (token.length < 4 || token.charCodeAt(2) !== 32) {
							throw new Error('unparsable git status record');
						}
						const xy = token.slice(0, 2);
						if (xy[0] === 'D' || xy[1] === 'D') {
							set.add(token.slice(3));
						}
						if (/[RC]/.test(xy)) {
							// Two-token record: the DESTINATION exists (it is
							// backed up as a file), and the SOURCE is absent
							// from disk with its content living at the
							// destination — an honest, git-confirmed absence,
							// covering the #2976 intent-to-add rename shape.
							const source = tokens[i + 1] ?? '';
							if (!source) {
								throw new Error('truncated rename/copy record');
							}
							i += 1;
							set.add(source);
						}
					}
					return set;
				} catch {
					return null;
				}
			})();
			const backup = backupTrackedChangesBeforeRollback(
				directory,
				measurement.dirtyRelPaths,
				{
					captureIndexEntry: (input) =>
						_internals.captureIndexEntryForBackup({
							directory,
							...input,
						}),
					confirmDeletion: (rel) => gitDeletions?.has(rel) ?? false,
				},
			);
			// Fail closed when the safety net is incomplete: a destructive
			// restore never proceeds over files whose current bytes were not
			// actually copied (#2976 review F-3), over deletions that were
			// not honestly recorded (#3763 AC4), or when ANY recovery capture
			// step (copies, staged-state capture, manifest) reported failure
			// (#3763 — AC5 generalized: a recovery writer failure refuses
			// the reset even when the file copies themselves succeeded).
			// FB-001 (#3763 feedback round): the gate is pure set coverage
			// against what the backup ACTUALLY captured — a dirty path must
			// appear in copied (file or symlink bytes) or in the
			// git-confirmed recordedDeletions. No third `fs.existsSync`
			// judgment sits between "missing" and "deleted": anything the
			// backup could not classify is uncovered by construction and the
			// restore refuses.
			const copiedSet = new Set(backup.copied);
			const deletedSet = new Set(backup.recordedDeletions);
			// FB-003: gitlink (submodule) pointers are honestly covered — no
			// bytes to copy, no deletion, the reset moves the pointer itself.
			const gitlinkSet = new Set(backup.gitlinkPaths);
			const atRiskExisting =
				measurement.dirtyRelPaths.length - deletedSet.size - gitlinkSet.size;
			const uncovered = measurement.dirtyRelPaths.filter(
				(rel) =>
					!copiedSet.has(rel) && !deletedSet.has(rel) && !gitlinkSet.has(rel),
			);
			if (
				!backup.backupDir ||
				!backup.recoveryComplete ||
				gitDeletions === null ||
				uncovered.length > 0
			) {
				return serializeResult('restore', {
					success: false,
					error: `backup incomplete (${backup.copied.length}/${atRiskExisting} at-risk file(s) copied${
						uncovered.length > 0
							? `, ${uncovered.length} uncovered: ${uncovered
									.slice(0, 5)
									.map((rel) => sanitizeDiagnosticText(rel))
									.join(', ')}${uncovered.length > 5 ? '…' : ''}`
							: ''
					}${
						backup.recoveryComplete && gitDeletions !== null
							? ''
							: gitDeletions === null
								? ', authoritative git status unreadable for deletion confirmation'
								: ', recovery capture incomplete'
					}) — restore refused so nothing is destroyed.${
						backup.warnings.length > 0
							? ` Warnings: ${backup.warnings.map((w) => sanitizeDiagnosticText(w)).join('; ')}`
							: ''
					}`,
				});
			}
			const logBeforeReset = log;
			gitExec(['reset', '--hard', checkpoint.sha], directory);
			writeCheckpointLog(logBeforeReset, directory);
			return serializeResult('restore', {
				success: true,
				label,
				sha: checkpoint.sha,
				backup_dir: backup.backupDir,
				...(backup.warnings.length > 0
					? {
							backup_warnings: backup.warnings.map((w) =>
								sanitizeDiagnosticText(w),
							),
						}
					: {}),
				message: `Restored to checkpoint: "${label}" (hard reset)${
					backup.backupDir
						? `; destroyed bytes backed up to ${sanitizeDiagnosticText(path.relative(directory, backup.backupDir))}`
						: ''
				}${
					backup.warnings.length > 0
						? `; warnings: ${backup.warnings.map((w) => sanitizeDiagnosticText(w)).join('; ')}`
						: ''
				}${
					// #3442: the confirmed destructive restore carries the
					// exclusion note like its preview and clean-tree siblings —
					// a record excluded between preview and confirm is never
					// silently dropped from the executed scope's report.
					exclusionNote ? `; ⚠ ${exclusionNote}` : ''
				}`,
			});
		}

		// Clean tree: nothing tracked to destroy — single-call restore. When
		// every dirty record was out-of-root-excluded (#3434), the operator
		// still sees what was dropped.
		const logBeforeReset = log;
		gitExec(['reset', '--hard', checkpoint.sha], directory);
		writeCheckpointLog(logBeforeReset, directory);

		return serializeResult('restore', {
			success: true,
			label,
			sha: checkpoint.sha,
			message: `Restored to checkpoint: "${label}" (hard reset)${
				exclusionNote ? `; ⚠ ${exclusionNote}` : ''
			}`,
		});
	} catch (e) {
		return serializeResult('restore', {
			success: false,
			error:
				e instanceof Error
					? `restore failed: ${sanitizeDiagnosticText(e.message)}`
					: 'restore failed: unknown error',
		});
	}
}

function handleList(directory: string): string {
	const log = readCheckpointLog(directory);
	const sorted = [...log.checkpoints].sort((a, b) =>
		b.timestamp.localeCompare(a.timestamp),
	);
	return serializeResult('list', {
		success: true,
		count: sorted.length,
		checkpoints: sorted,
	});
}

function handleDelete(label: string, directory: string): string {
	try {
		const log = readCheckpointLog(directory);
		const initialLength = log.checkpoints.length;
		log.checkpoints = log.checkpoints.filter(
			(checkpoint) => checkpoint.label !== label,
		);
		if (log.checkpoints.length === initialLength) {
			return serializeResult('delete', {
				success: false,
				error: `checkpoint not found: "${label}"`,
			});
		}
		writeCheckpointLog(log, directory);
		return serializeResult('delete', {
			success: true,
			label,
			message: `Checkpoint deleted: "${label}"`,
		});
	} catch (e) {
		return serializeResult('delete', {
			success: false,
			error:
				e instanceof Error
					? `delete failed: ${sanitizeDiagnosticText(e.message)}`
					: 'delete failed: unknown error',
		});
	}
}

async function handleSaveTaskCompletion(
	taskId: string,
	directory: string,
): Promise<string> {
	return withTaskCompletionLocksResult({
		directory,
		taskId,
		run: async () => {
			const plan = await _internals.loadPlan(directory);
			if (!plan) {
				return serializeResult('save_task_completion', {
					success: false,
					error:
						'save_task_completion failed: no durable plan is available under .swarm/plan.json',
				});
			}

			const task = plan.phases
				.flatMap((phase) => phase.tasks)
				.find((candidate) => candidate.id === taskId);
			if (!task) {
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: task "${sanitizeDiagnosticText(taskId)}" was not found in the current plan`,
				});
			}
			if (task.status !== 'completed') {
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: task "${sanitizeDiagnosticText(taskId)}" is ${sanitizeDiagnosticText(String(task.status))}, not completed`,
				});
			}
			await _internals.afterTaskEligibilityRead?.(directory, task.id);

			const planIdentityHash = derivePlanIdentityHash(plan);
			const planId = derivePlanId(plan);
			const ledgerEvents = await readLedgerEvents(directory);
			const planEvents = ledgerEvents.filter(
				(event) => event.plan_id === planId,
			);
			const anchor = planEvents.find(
				(event) => event.event_type === 'plan_created',
			);
			const anchorPlan = anchor?.payload?.plan;
			if (anchorPlan && typeof anchorPlan === 'object') {
				const rawIdentity = anchorPlan as { swarm?: unknown; title?: unknown };
				if (
					typeof rawIdentity.swarm !== 'string' ||
					typeof rawIdentity.title !== 'string' ||
					derivePlanIdentityHash({
						swarm: rawIdentity.swarm,
						title: rawIdentity.title,
					}) !== planIdentityHash
				) {
					throw new Error(
						`save_task_completion failed: ledger identity does not match the current plan for task "${task.id}"`,
					);
				}
			}
			const latestTaskStatusEvent = [...planEvents]
				.reverse()
				.find(
					(event) =>
						event.event_type === 'task_status_changed' &&
						event.task_id === task.id,
				);
			if (
				latestTaskStatusEvent &&
				latestTaskStatusEvent.to_status !== 'completed'
			) {
				throw new Error(
					`save_task_completion failed: the authoritative ledger does not record task "${task.id}" as completed`,
				);
			}
			// An initially-completed plan has no task_status_changed event. Its
			// immutable plan_created sequence is the stable completion epoch; zero is
			// reserved for legacy disk-only plans without a readable ledger anchor.
			const completionLedgerSeq =
				latestTaskStatusEvent?.seq ?? anchor?.seq ?? 0;
			const receipt = ensureTaskCheckpointReceipt(
				directory,
				planIdentityHash,
				task.id,
				completionLedgerSeq,
			);
			const descriptor = buildTaskCompletionDescriptor(
				planIdentityHash,
				task.id,
				receipt.generation,
			);
			if (receipt.label !== descriptor.label) {
				throw new Error(
					`Task checkpoint receipt label conflict for ${task.id}: expected ${descriptor.label}, found ${receipt.label}`,
				);
			}
			if (receipt.state === 'logged') {
				return serializeResult('save_task_completion', {
					success: true,
					idempotent: true,
					label: receipt.label,
					sha: receipt.sha,
					receipt_state: receipt.state,
					message: `Checkpoint task completion already logged for "${sanitizeDiagnosticText(descriptor.taskId)}"`,
				});
			}

			const recoveredSha = _internals.findCommitByExactSubject(
				directory,
				descriptor.subject,
			);
			let committedSha: string | null = null;
			committedSha = recoveredSha ?? receipt.sha;

			if (!committedSha) {
				_internals.stageAllExcludingSwarm(directory);
				// Keep the commit path-limited as well as the preceding add. An
				// exclusion on `git add` does not unstage a force-added .swarm file;
				// the pathspec commit excludes it while leaving its index entry intact.
				_internals.gitExec(
					[
						'commit',
						'--allow-empty',
						'-m',
						descriptor.subject,
						'--',
						...nonSwarmCommitPathspec(directory),
					],
					directory,
				);
				committedSha = getCurrentSha(directory);
			}
			if (!committedSha) {
				throw new Error(
					`save_task_completion failed: could not resolve commit SHA for task "${sanitizeDiagnosticText(descriptor.taskId)}"`,
				);
			}

			updateTaskCheckpointReceipt(
				directory,
				descriptor,
				'committed',
				committedSha,
			);

			const log = readCheckpointLog(directory);
			upsertTaskCompletionCheckpointEntry(
				directory,
				log,
				{
					label: descriptor.label,
					sha: committedSha,
					timestamp: new Date().toISOString(),
				},
				loadCheckpointConfig(directory).maxCheckpoints,
			);
			writeCheckpointLog(log, directory);
			const logged = updateTaskCheckpointReceipt(
				directory,
				descriptor,
				'logged',
				committedSha,
			);

			return serializeResult('save_task_completion', {
				success: true,
				label: logged.label,
				sha: committedSha,
				receipt_state: logged.state,
				message: `Checkpoint task completion saved for "${sanitizeDiagnosticText(descriptor.taskId)}"`,
			});
		},
	});
}

export const checkpoint: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Save, restore, list, and delete git checkpoints. ' +
		'Use save to create a named snapshot, restore to return tracked files to a checkpoint (a destructive restore previews first and requires a confirm token issued in the preview; destroyed bytes are backed up under .swarm/rollback-backups/), ' +
		'list to see all checkpoints, delete to remove a checkpoint from the log, and save_task_completion to record a retry-safe task completion checkpoint. ' +
		'Git commits are preserved on delete.',
	args: {
		action: z
			.string()
			.describe(
				'Action to perform: save, restore, list, delete, or save_task_completion',
			),
		label: z
			.string()
			.optional()
			.describe('Checkpoint label (required for save, restore, delete)'),
		confirm_token: z
			.string()
			.optional()
			.describe(
				'Confirm token from a destructive-restore preview (required when restore would destroy uncommitted tracked work; the preview response carries the token)',
			),
		task_id: z
			.string()
			.optional()
			.describe('Plan task ID (required for save_task_completion), e.g. "1.1"'),
	},
	execute: async (args, directory) => {
		// #3427: the entry preflight rides the shared async reader
		// (single-attempt `rev-parse --git-dir`, bounded, killable) instead of
		// the local sync gitExec retry chain — on a host whose sync child
		// spawns stall (#3275), every checkpoint action (list and restore
		// alike) no longer blocks up to the transient-retry horizon before
		// refusing. #3442: the probe is the DETAILED twin so the refusal
		// names the cause (non-repository vs unavailable executable vs a git
		// error) instead of a uniform not-a-repository message — still
		// single-attempt, so the wedge fix is unchanged.
		const repoStatus =
			await _internals.readGitRepositoryStatusDetailedAsync(directory);
		if (!repoStatus.isRepo) {
			const reason =
				repoStatus.reason === 'not_git_repo'
					? 'not a git repository'
					: repoStatus.reason === 'git_unavailable'
						? 'git executable is not available'
						: `git probe failed (${sanitizeDiagnosticText(repoStatus.message ?? '')})`;
			return serializeResult('unknown', {
				success: false,
				error: `${reason} - checkpoint tools require a git repository`,
			});
		}

		let action: string;
		let label: string | undefined;
		let confirmToken: string | undefined;
		let taskId: string | undefined;
		try {
			action = String(args.action);
			label =
				args.label !== undefined && args.label !== null
					? String(args.label)
					: undefined;
			confirmToken =
				args.confirm_token !== undefined && args.confirm_token !== null
					? String(args.confirm_token)
					: undefined;
			taskId =
				args.task_id !== undefined && args.task_id !== null
					? String(args.task_id)
					: undefined;
		} catch {
			return serializeResult('unknown', {
				success: false,
				error: 'invalid arguments',
			});
		}

		const validActions = [
			'save',
			'restore',
			'list',
			'delete',
			'save_task_completion',
		];
		if (!validActions.includes(action)) {
			return serializeResult('unknown', {
				success: false,
				error: `invalid action: "${action}". Valid actions: ${validActions.join(', ')}`,
			});
		}

		if (['save', 'restore', 'delete'].includes(action)) {
			if (!label) {
				return serializeResult(action as MutationAction, {
					success: false,
					error: `label is required for ${action} action`,
				});
			}
			const labelError = validateLabel(label);
			if (labelError) {
				return serializeResult(action as MutationAction, {
					success: false,
					error: `invalid label: ${labelError}`,
				});
			}
		}

		if (action === 'save_task_completion') {
			if (!taskId || taskId.trim().length === 0) {
				return serializeResult('save_task_completion', {
					success: false,
					error: 'task_id is required for save_task_completion action',
				});
			}
		}

		switch (action) {
			case 'save':
				return withCheckpointMutationLock({
					action: 'save',
					directory,
					operationKey: `save-${label!}`,
					run: async () => handleSave(label!, directory),
				});
			case 'restore':
				return withCheckpointMutationLock({
					action: 'restore',
					directory,
					operationKey: `restore-${label!}`,
					run: async () => await handleRestore(label!, directory, confirmToken),
				});
			case 'list':
				return handleList(directory);
			case 'delete':
				return withCheckpointMutationLock({
					action: 'delete',
					directory,
					operationKey: `delete-${label!}`,
					run: async () => handleDelete(label!, directory),
				});
			case 'save_task_completion':
				return handleSaveTaskCompletion(taskId!, directory);
			default:
				return serializeResult('unknown', {
					success: false,
					error: 'unreachable',
				});
		}
	},
});
