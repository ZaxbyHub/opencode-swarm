/**
 * Stable per-worktree identity (issue #1848 §1).
 *
 * `resolveWorktreeId` returns a stable UUID that is UNIQUE PER WORKTREE (not
 * per cohort). It is the primary ownership key for the curation-policy layer:
 * a worktree may directly mutate a knowledge entry only when it is the proven
 * producer (`entry.producer.worktree_id === actorWorktreeId`).
 *
 * CRITICAL: this id is stored at `<directory>/.swarm/worktree-id.json` via the
 * RAW directory path — it is deliberately NOT link-resolved. Two sibling
 * worktrees of the same cohort share a knowledge store but have DISTINCT
 * worktree ids, which is exactly what makes cohort-safe ownership decisions
 * possible.
 *
 * This module performs no git subprocess calls and is never imported on the
 * plugin-init path. It is called lazily by the curation stamping path and the
 * authorization policy. Fail-open: if the id file cannot be read or written, a
 * transient ephemeral id is returned so curation never hard-blocks on an I/O
 * hiccup.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const WORKTREE_ID_FILENAME = 'worktree-id.json';

interface WorktreeIdFile {
	worktree_id: string;
	created_at: string;
}

/**
 * Seam for dependency injection in tests. Tests override `readFile`,
 * `writeFile`, and `randomUUID` to avoid touching the real filesystem / entropy.
 */
export const _internals = {
	readFile,
	writeFile,
	existsSync,
	mkdir,
	randomUUID,
};

/**
 * Resolve the stable per-worktree id, creating it on first call if absent.
 * Returns a transient ephemeral id on I/O failure (fail-open).
 */
export async function resolveWorktreeId(directory: string): Promise<string> {
	const dir = path.normalize(path.resolve(directory, '.swarm'));
	const idPath = path.join(dir, WORKTREE_ID_FILENAME);

	try {
		if (_internals.existsSync(idPath)) {
			const raw = await _internals.readFile(idPath, 'utf-8');
			const parsed = JSON.parse(raw) as Partial<WorktreeIdFile>;
			if (
				parsed &&
				typeof parsed.worktree_id === 'string' &&
				parsed.worktree_id
			) {
				return parsed.worktree_id;
			}
		}
	} catch {
		// Fall through to generation; the file may be corrupt or unreadable.
	}

	// Generate + persist a new stable id. Best-effort: if write fails, return a
	// transient ephemeral id (it won't persist across sessions, but curation
	// proceeds without hard-blocking).
	const newId = _internals.randomUUID();
	try {
		await _internals.mkdir(dir, { recursive: true });
		const record: WorktreeIdFile = {
			worktree_id: newId,
			created_at: new Date().toISOString(),
		};
		await _internals.writeFile(
			idPath,
			`${JSON.stringify(record, null, 2)}\n`,
			'utf-8',
		);
	} catch {
		// Fail-open: return the ephemeral id without persisting.
	}
	return newId;
}
