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
 * Hardening (feedback round PRR-011/F-R18/19/21): the write goes through the
 * canonical atomic writer (temp + fsync + rename, mode 0o600) so a concurrent
 * `git commit -F` can never observe a torn file; the resolved target is
 * proven — lexically AND through realpath once the directory exists — to
 * stay inside the dedicated temp subdirectory and OUTSIDE the repository (a
 * TMPDIR pointing into the checkout is refused); files are pruned after
 * MESSAGE_FILE_TTL_MS on each call so the directory stays bounded.
 */

import { createHash } from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
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
 * authoring call.
 */
function pruneStaleMessageFiles(): void {
	try {
		const dir = commitMessageTargetDir();
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
		mkdirSync(resolvedDir, { recursive: true });
		let realpathDir = resolvedDir;
		try {
			realpathDir = realpathSync(resolvedDir);
		} catch {
			// Directory vanished between mkdir and realpath — mkdir again below
			// via the atomic writer's own parent handling is not available, so
			// re-create and continue with the lexical path.
			mkdirSync(resolvedDir, { recursive: true });
		}
		const realpathTarget = path.join(
			realpathDir,
			path.basename(resolvedTarget),
		);
		if (
			!realpathTarget.startsWith(realpathDir + path.sep) &&
			realpathTarget !== realpathDir
		) {
			return JSON.stringify({
				success: false,
				message:
					'Commit-message file path escaped the swarm-pr-feedback-commit-msg directory through a symlink; refusing to write',
			});
		}
		if (insideRepo(realpathDir)) {
			return JSON.stringify({
				success: false,
				message:
					'The resolved temp directory points inside the repository through a symlink; refusing to write',
			});
		}
		pruneStaleMessageFiles();
		await atomicWriteFileAnyRoot(realpathTarget, message, {
			mode: 0o600,
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
