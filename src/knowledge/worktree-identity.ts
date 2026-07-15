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

/**
 * Canonical shape of the ids this module generates via `randomUUID()`.
 * The stored `worktree_id` MUST match this to be trusted (F-01 / PRR-009):
 * `worktree-id.json` is attacker-writable, so an arbitrary string must never
 * be accepted as an ownership key. A non-UUID value is treated as a corrupt
 * file and regenerated (fail-safe).
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorktreeIdFile {
	worktree_id: string;
	created_at: string;
}

/**
 * Parse + validate the persisted id file. Returns the stored id only when it is
 * a well-formed UUID (the exact shape this module generates); otherwise returns
 * `undefined` so the caller regenerates a fresh, trusted id.
 */
function readValidatedId(raw: string): string | undefined {
	const parsed = JSON.parse(raw) as Partial<WorktreeIdFile>;
	if (
		parsed &&
		typeof parsed.worktree_id === 'string' &&
		UUID_RE.test(parsed.worktree_id)
	) {
		return parsed.worktree_id;
	}
	return undefined;
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

	// True when the id file is present but its contents are missing / malformed /
	// not a valid UUID. In that case we OVERWRITE to repair the file (F-01);
	// otherwise (file absent) we EXCLUSIVELY CREATE to converge concurrent
	// first-callers onto a single id (F-21).
	let repairInvalidFile = false;

	try {
		if (_internals.existsSync(idPath)) {
			const raw = await _internals.readFile(idPath, 'utf-8');
			// F-01 / PRR-009: only trust a stored id that matches the UUID shape
			// this module itself generates. `worktree-id.json` is attacker-writable,
			// so a missing/malformed/non-UUID value must never be accepted as an
			// ownership key — treat it as corrupt and regenerate (fail-safe).
			const validated = readValidatedId(raw);
			if (validated !== undefined) {
				return validated;
			}
			// File present but untrusted → regenerate and overwrite to repair.
			repairInvalidFile = true;
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
		const payload = `${JSON.stringify(record, null, 2)}\n`;

		if (repairInvalidFile) {
			// Existing file is untrusted: overwrite in place to repair it (F-01).
			await _internals.writeFile(idPath, payload, {
				encoding: 'utf-8',
				flag: 'w',
			});
		} else {
			// F-21 (race): create with the exclusive `'wx'` flag. O_EXCL guarantees
			// exactly one concurrent first-time caller wins the create; a temp-file +
			// rename would NOT converge, because rename overwrites the destination and
			// lets the last racer silently clobber the first id. If a racing caller
			// already created the file (EEXIST), re-read it and prefer its persisted
			// valid id, so concurrent first-calls converge on ONE id.
			try {
				await _internals.writeFile(idPath, payload, {
					encoding: 'utf-8',
					flag: 'wx',
				});
			} catch (err) {
				if (
					(err as NodeJS.ErrnoException)?.code === 'EEXIST' ||
					_internals.existsSync(idPath)
				) {
					const raw = await _internals.readFile(idPath, 'utf-8');
					const validated = readValidatedId(raw);
					if (validated !== undefined) {
						return validated;
					}
				}
				// Non-race failure (e.g. permissions): fall through to fail-open.
				throw err;
			}
		}
	} catch {
		// Fail-open: return the ephemeral id without persisting.
	}
	return newId;
}
