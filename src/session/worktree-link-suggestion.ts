/**
 * Worktree link suggestion (auto-detect + manual confirm).
 *
 * When a session starts in a repository that has more than one git worktree and
 * this worktree is NOT yet linked to a shared knowledge store, emit a one-time,
 * non-blocking suggestion to run `/swarm link`. Detection is advisory only —
 * sharing is never enabled automatically; the user confirms with `/swarm link`.
 *
 * Safety (AGENTS.md Invariants 1, 3, 8):
 * - Fully fail-open: any error is swallowed; never throws.
 * - Bounded subprocess: array-form `git`, explicit `-C <dir>`, timeout, no shell.
 * - Off the init critical path: callers invoke this fire-and-forget (not awaited).
 * - Suggested-once per session, tracked in a FIFO-bounded module map.
 */

import { execFile } from 'node:child_process';
import { isLinked } from '../hooks/knowledge-link.js';
import { advisoryWarn } from '../services/warning-buffer.js';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';

const GIT_TIMEOUT_MS = 1_500;

/** Bounded set of sessions already suggested (Invariant 8: explicit eviction). */
const MAX_SUGGESTED_SESSIONS = 500;
const _suggestedSessions = new Set<string>();

function markSuggested(sessionId: string): void {
	// Atomic check-evict-add to prevent concurrent races from overshooting MAX_SUGGESTED_SESSIONS.
	// If already present, no-op (idempotent).
	if (_suggestedSessions.has(sessionId)) {
		return;
	}

	// Only evict if we're at capacity and need to make room for the new entry.
	if (_suggestedSessions.size >= MAX_SUGGESTED_SESSIONS) {
		const oldest = _suggestedSessions.values().next().value;
		if (oldest !== undefined) {
			_suggestedSessions.delete(oldest);
		}
	}

	_suggestedSessions.add(sessionId);
}

/** Count worktrees via `git worktree list --porcelain`. Returns 0 on any failure. */
async function countWorktrees(directory: string): Promise<number> {
	// Resolution failure (every candidate rejected) maps onto this function's
	// existing "any failure -> 0" contract, same as a spawn failure would —
	// no new throw introduced at this call site.
	let gitExecutable: string;
	try {
		gitExecutable = await resolveGitExecutableAsync();
	} catch {
		return 0;
	}
	return new Promise<number>((resolve) => {
		try {
			const child = execFile(
				gitExecutable,
				['-C', directory, 'worktree', 'list', '--porcelain'],
				{ timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf-8' },
				(err, stdout) => {
					if (err || typeof stdout !== 'string') {
						resolve(0);
						return;
					}
					// Each worktree record begins with a line `worktree <path>`.
					let count = 0;
					for (const line of stdout.split('\n')) {
						if (line.startsWith('worktree ')) count++;
					}
					resolve(count);
				},
			);
			// Close stdin immediately: `git worktree list` reads nothing, and a
			// never-closed stdin pipe under Bun on Windows can block child exit
			// (AGENTS.md invariant 3). The `timeout` is the hard backstop.
			try {
				child.stdin?.end();
			} catch {
				/* stdin already closed */
			}
			// Defensive: ensure a spawn error resolves rather than hanging.
			child.on('error', () => resolve(0));
		} catch {
			resolve(0);
		}
	});
}

/**
 * Best-effort, once-per-session suggestion to link this worktree. Never throws.
 * Intended to be called fire-and-forget (not awaited) from the session-start path.
 */
export async function maybeSuggestWorktreeLink(
	directory: string,
	sessionId: string,
): Promise<void> {
	try {
		if (!directory || !sessionId) return;
		if (_suggestedSessions.has(sessionId)) return;
		markSuggested(sessionId);

		// Already sharing — nothing to suggest.
		if (isLinked(directory)) return;

		const worktrees = await countWorktrees(directory);
		if (worktrees > 1) {
			advisoryWarn(
				`[opencode-swarm] Detected ${worktrees} git worktrees of this repo. ` +
					'Run `/swarm link` in each to share swarm knowledge across them ' +
					'(or `/swarm link <name>` to share with similar projects).',
			);
		}
	} catch {
		// Advisory only — never disrupt the session.
	}
}

export const _internals = {
	maybeSuggestWorktreeLink,
	countWorktrees,
	resetSuggested: (): void => {
		_suggestedSessions.clear();
	},
};
