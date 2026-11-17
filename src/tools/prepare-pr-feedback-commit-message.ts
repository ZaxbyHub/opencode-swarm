/**
 * prepare_pr_feedback_commit_message — sanctioned authoring surface for
 * PR_FEEDBACK commit messages that contain shell metacharacters (issue #3315
 * D8, Option B).
 *
 * The PR_FEEDBACK shell classifier deliberately rejects `git commit -m`
 * payloads containing `; & < >`, backtick, newline, or command substitution
 * regardless of quoting (cross-shell injection safety), so an attribution
 * trailer such as `Co-Authored-By: X <noreply@anthropic.com>` cannot be
 * committed inline. `git commit -F <file>` is admitted by the classifier, but
 * only for a message file that resolves OUTSIDE the repository (an in-repo
 * message file is an untracked file that breaks the clean-tree arming check,
 * and architect write containment refuses outside-repo writes). This tool is
 * the missing authoring step: it writes the exact message bytes ATOMICALLY to
 * a deterministic file under the OS temp directory (outside every repository)
 * and returns the path to hand to `git commit -F`.
 *
 * Hardening (feedback round PRR-011/F-R18/19/21 + issue #3486): the write goes
 * through the canonical atomic writer (temp + fsync + rename, mode 0o600) so a
 * concurrent `git commit -F` can never observe a torn file; the fixed-name
 * directory is ACQUIRED with a real proof before any use — lstat refusal for a
 * planted symlink/junction or non-directory, current-user ownership and a
 * healed/verified 0700 mode on POSIX, creation at 0700 with a post-create
 * re-lstat, and a same-tick validateTarget re-proof at the write boundary —
 * plus the lexical and realpath containment refusals (a TMPDIR pointing into
 * the checkout is refused); files are pruned after MESSAGE_FILE_TTL_MS on
 * each call so the directory stays bounded.
 */

import { createHash } from 'node:crypto';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readPrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { atomicWriteFileAnyRoot } from '../utils/atomic-write.js';
import { createSwarmTool } from './create-tool';

const MAX_COMMIT_MESSAGE_CHARS = 8192;
/** Authored files are pruned on the next call after this TTL (FB-9/F-R19). */
const MESSAGE_FILE_TTL_MS = 24 * 60 * 60 * 1000;

const PreparePrFeedbackCommitMessageArgsSchema = z
	.object({
		message: z
			.string()
			.refine((value) => value.trim().length > 0, {
				message: 'message must not be empty or whitespace-only',
			})
			.refine((value) => value.length <= MAX_COMMIT_MESSAGE_CHARS, {
				message: `message must be at most ${MAX_COMMIT_MESSAGE_CHARS} characters`,
			})
			.refine((value) => !value.includes('\0'), {
				message: 'message must not contain NUL bytes',
			})
			.transform((value) => value.trim()),
	})
	.strict();

function commitMessageTargetDir(): string {
	return path.join(tmpdir(), 'swarm-pr-feedback-commit-msg');
}

/**
 * Dependency seam for tests (repo DI convention): the fs primitives the
 * directory guard reasons over, so ownership-mismatch and heal-failure legs
 * are injectable without mock.module. Restore mutations in afterEach.
 */
export const _internals = {
	lstatSync,
	mkdirSync,
	chmodSync,
	realpathSync,
};

/** Outcome of {@link acquireCommitMessageDir}: a proven-real directory or a refusal reason. */
type CommitMessageDirAcquisition =
	| { ok: true; dir: string }
	| { ok: false; message: string };

/**
 * Acquire the fixed-name commit-message directory with a real proof (issue
 * #3486): the name must be a real directory — never a symlink or junction —
 * that the current user owns with mode 0700 (POSIX), created fresh at 0700
 * when absent. The post-create re-lstat is the create-race proof:
 * mkdirSync(recursive) succeeds over an existing junction on win32 and over
 * an existing symlink-to-dir elsewhere, so only the re-lstat catches a link
 * planted between the ENOENT and the mkdir. The guard replaced a re-proof
 * that was tautological (path.join of a basename always stays inside the
 * joined directory) plus an insideRepo() check that passed for any
 * outside-repo target — together they let a planted link redirect both the
 * TTL prune and the authored write into an attacker-chosen directory.
 */
function acquireCommitMessageDir(
	resolvedDir: string,
): CommitMessageDirAcquisition {
	let stats: Stats;
	try {
		stats = _internals.lstatSync(resolvedDir);
	} catch {
		// First use — create private, then prove what actually exists now.
		try {
			_internals.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
		} catch (error) {
			return {
				ok: false,
				message: `could not be created (${error instanceof Error ? error.message : String(error)})`,
			};
		}
		try {
			stats = _internals.lstatSync(resolvedDir);
		} catch (error) {
			return {
				ok: false,
				message: `vanished after creation (${error instanceof Error ? error.message : String(error)})`,
			};
		}
	}
	if (stats.isSymbolicLink()) {
		return { ok: false, message: 'exists as a symlink' };
	}
	if (!stats.isDirectory()) {
		return { ok: false, message: 'is not a directory' };
	}
	// Ownership and mode are enforced on POSIX only: on Windows lstat exposes
	// neither a meaningful uid (process.getuid is undefined) nor an enforced
	// mode — the per-user %TEMP% root is the ownership boundary there.
	if (process.platform !== 'win32') {
		const uid = process.getuid?.();
		if (uid !== undefined && stats.uid !== uid) {
			return {
				ok: false,
				message: `is not owned by the current user (remove the existing directory ${resolvedDir} or chown it to the current user, then retry)`,
			};
		}
		// Require EXACTLY 0700, not merely "no group/other bits": a restrictive
		// 0500/0600 (owner r-x / rw-) passes a & 0o077 test but has no owner
		// write/execute, so the later file write fails with a confusing EACCES.
		// Any non-0700 mode (legacy umask defaults like 0755, or a restrictive
		// 0500/0600) is healed rather than refused: ownership already passed,
		// so tightening/normalising the mode is safe.
		if ((stats.mode & 0o777) !== 0o700) {
			try {
				_internals.chmodSync(resolvedDir, 0o700);
				stats = _internals.lstatSync(resolvedDir);
			} catch (error) {
				return {
					ok: false,
					message: `could not be restricted to mode 0700 (${error instanceof Error ? error.message : String(error)})`,
				};
			}
			if ((stats.mode & 0o777) !== 0o700) {
				return {
					ok: false,
					message: 'could not be restricted to mode 0700',
				};
			}
		}
	}
	return { ok: true, dir: resolvedDir };
}

/** Deterministic, outside-every-repository home for the authored message. */
function resolvePrFeedbackCommitMessageFilePath(
	sessionID: string,
	message: string,
): string {
	const sanitizedSession = sessionID.replace(/[^A-Za-z0-9._-]/g, '_');
	const digest = createHash('sha256')
		.update(message, 'utf8')
		.digest('hex')
		.slice(0, 16);
	return path.join(
		commitMessageTargetDir(),
		`${sanitizedSession}-${digest}.txt`,
	);
}

/**
 * FB-9/F-R21: prune authored files older than the TTL so the shared temp
 * directory stays bounded. Best-effort — a prune failure never fails the
 * authoring call. Same-tick re-proof at entry (4.5 review round): the directory
 * acquired earlier is re-lstat'd before the walk, so a directory swapped for a
 * link after the acquisition is NEVER pruned through (the stale-file deletions
 * the TTL performs cannot be redirected into a link target).
 */
function pruneStaleMessageFiles(dir: string): void {
	try {
		const dirStats = _internals.lstatSync(dir);
		if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
			// Swapped for a link (or replaced by a non-directory) after the
			// acquisition — skip the prune rather than walk through it.
			return;
		}
		const now = Date.now();
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith('.txt')) continue;
			const full = path.join(dir, entry);
			try {
				const stats = statSync(full);
				if (now - stats.mtimeMs > MESSAGE_FILE_TTL_MS) {
					rmSync(full, { force: false });
				}
			} catch {
				// A file that vanished or cannot be stat'd is skipped.
			}
		}
	} catch {
		// No directory yet (first call) or unreadable — nothing to prune.
	}
}

export async function executePreparePrFeedbackCommitMessage(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = PreparePrFeedbackCommitMessageArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid commit-message request: ${parsed.error.issues
				.map((issue) =>
					issue.path.length > 0
						? `${issue.path.join('.')}: ${issue.message}`
						: issue.message,
				)
				.join('; ')}`,
		});
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID) {
		return JSON.stringify({
			success: false,
			message: 'Commit-message authoring requires an active sessionID',
		});
	}
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state || state.mode !== 'PR_FEEDBACK' || !state.prHeadSha) {
		return JSON.stringify({
			success: false,
			message:
				'Commit-message authoring requires an active bound PR_FEEDBACK workflow; bind the PR head first',
		});
	}
	const message = parsed.data.message;
	const targetDir = commitMessageTargetDir();
	const targetPath = resolvePrFeedbackCommitMessageFilePath(sessionID, message);
	// Defense in depth (FB-9): the file name is derived from a sanitized
	// session id and a content digest, but the resolved path must still stay
	// inside the dedicated temp subdirectory AND outside the repository (a
	// TMPDIR pointing into the checkout would recreate the in-repo message
	// file the design exists to prevent). The lexical proof runs before the
	// directory exists; a realpath re-proof runs after mkdir so a symlinked
	// directory component cannot redirect the write.
	const resolvedTarget = path.resolve(targetPath);
	const resolvedDir = path.resolve(targetDir);
	const lexicallyInsideTempDir =
		resolvedTarget === resolvedDir ||
		resolvedTarget.startsWith(resolvedDir + path.sep);
	if (!lexicallyInsideTempDir) {
		return JSON.stringify({
			success: false,
			message:
				'Commit-message file path escaped the swarm-pr-feedback-commit-msg directory; refusing to write',
		});
	}
	const repoRoot = path.resolve(directory);
	const insideRepo = (value: string): boolean => {
		const rel = path.relative(repoRoot, value);
		return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
	};
	if (insideRepo(resolvedTarget) || insideRepo(resolvedDir)) {
		return JSON.stringify({
			success: false,
			message:
				'TMPDIR resolves inside the repository; the commit-message file must live outside the repository — refusing to write',
		});
	}
	try {
		// Acquire the fixed-name directory with a real proof before anything
		// touches it (issue #3486): refuse a planted symlink/junction, a
		// non-directory, a foreign owner, or an unrestricable mode — then use
		// ONLY the proven-real lexical directory for the prune and the write.
		const acquisition = acquireCommitMessageDir(resolvedDir);
		if (!acquisition.ok) {
			return JSON.stringify({
				success: false,
				message: `The commit-message temp directory ${acquisition.message}; refusing to write`,
			});
		}
		// Ancestor containment re-proof (kept from the original design): a
		// symlinked ancestor component above the fixed name that resolves
		// inside the repository must still be refused — the lexical checks
		// above cannot see through ancestor links, realpath can.
		let realpathDir = acquisition.dir;
		try {
			realpathDir = _internals.realpathSync(acquisition.dir);
		} catch {
			// Keep the proven lexical directory.
		}
		if (insideRepo(realpathDir)) {
			return JSON.stringify({
				success: false,
				message:
					'The resolved temp directory points inside the repository through a symlink; refusing to write',
			});
		}
		pruneStaleMessageFiles(acquisition.dir);
		const writeTarget = path.join(
			acquisition.dir,
			path.basename(resolvedTarget),
		);
		await atomicWriteFileAnyRoot(writeTarget, message, {
			mode: 0o600,
			// Same-tick re-proof after the writer's event-loop yield: a
			// directory swapped for a link after the acquisition is caught at
			// the last boundary before the temp-write/rename syscalls, instead
			// of writing through the swapped link.
			validateTarget: () => {
				const dirStats = _internals.lstatSync(path.dirname(writeTarget));
				if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
					throw new Error(
						'commit-message temp directory was replaced with a link before the write',
					);
				}
			},
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: `Could not author the commit-message file: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
	return JSON.stringify({
		success: true,
		path: resolvedTarget,
		message:
			'Commit-message file authored outside the repository; commit with git commit -F <path> (the classifier refuses in-repo message files). The file is mode 0600, lives in the OS temp directory, never touches the bound checkout, and is pruned after 24h.',
	});
}

export const prepare_pr_feedback_commit_message: ReturnType<
	typeof createSwarmTool
> = createSwarmTool({
	description:
		'Author a PR_FEEDBACK commit message that contains shell metacharacters (e.g. a Co-Authored-By trailer with <...>) into a file OUTSIDE the repository, returning the path for the sanctioned git commit -F command. The inline -m form is rejected by the shell classifier by design; an in-repo message file would dirty the clean-tree arming check. Requires an active bound PR_FEEDBACK workflow.',
	args: {
		message: PreparePrFeedbackCommitMessageArgsSchema.shape.message,
	},
	execute: executePreparePrFeedbackCommitMessage,
});
