/**
 * Epic v2 C3 — git refs as the epic's durable markers.
 *
 * Under `refs/swarm/epics/<epicKey>/` an open git epic keeps:
 *
 *   - `base`         → the commit the epic started from (written at start);
 *   - `waves/<seq>`  → HEAD when wave `<seq>` closed;
 *   - `tasks/<id>`   → the commit proving task `<id>`'s work is on the epic
 *                      branch (its newest `swarm(task <id>):` landing or
 *                      residue commit for this plan inside its wave, else
 *                      the wave's close HEAD).
 *
 * The epic record is the source of truth (`EpicTaskOutcome.marker`,
 * `EpicWaveRecord.closeHead`, `git.baseCommit`); the refs mirror it
 * ({@link syncEpicRefs}): a missing ref is created with the create-only form
 * `git update-ref <ref> <sha> ""`, an existing ref with the recorded value is
 * left alone (idempotent), and a ref with another value (left over by an
 * earlier epic of the same key with `retain_refs`, or a raced write) is
 * compare-and-swapped to the recorded value. The refs are gc roots for the
 * epic's commits while it is open, survive in every linked worktree (refs
 * are shared), and are never pushed or fetched by default (`git push` /
 * `git clone` carry only branches and tags; `--mirror` copies them).
 *
 * Predecessor evidence ({@link isCommitAncestorOfHead}): a dependency
 * completed in an earlier wave is satisfied only when its task ref exists
 * and is an ancestor of HEAD — a rebase or amend that dropped the commit
 * makes the dependent `predecessor-missing` until `/swarm epic status
 * --repair-refs` ({@link repairEpicTaskRefs}) re-adopts the task's commit.
 *
 * At `/swarm epic close` the report captures every ref and the refs are
 * deleted ({@link deleteEpicRefs}) unless `epic.retain_refs: true`.
 *
 * Subprocess discipline (AGENTS.md #3): reads use `gitExec`
 * (`src/git/branch.ts`); every ref write/delete is ONE attempt
 * (`git-once.ts`) — a timed-out `update-ref` is judged by re-reading the ref.
 */

import { _internals as gitBranchInternals } from '../git/branch.js';
import { assertSafeGitRefArg } from '../git/safe-ref.js';
import { gitExecOnce, gitProbeExitCode } from './git-once.js';
import type { EpicRecordV1 } from './lifecycle.js';
import {
	MARKER_LOG_FORMAT,
	parseTaskMarkerLog,
	scrubTaskIdForGitSubject,
} from './plan-key.js';

/** Root namespace of every epic's refs. */
export const EPIC_REFS_ROOT = 'refs/swarm/epics';
/** Bound on the commits a marker lookup or repair walks. */
export const MARKER_LOOKUP_MAX_COMMITS = 2000;
/** Bound on the refs listed for one epic. */
const MAX_EPIC_REFS = 20_000;

const SHA_RE = /^[0-9a-f]{40,64}$/;
const SAFE_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	gitExecOnce,
	gitProbeExitCode,
};

export function isFullSha(value: unknown): value is string {
	return typeof value === 'string' && SHA_RE.test(value);
}

/**
 * A task id as one ref path component: strict-looking ids (`1.2`, `2.10.3`,
 * `setup-db`) verbatim; anything else (or a `.lock` suffix) hex-encoded
 * behind `_x`, which no verbatim component can start with.
 */
export function taskRefComponent(taskId: string): string {
	if (SAFE_COMPONENT_RE.test(taskId) && !taskId.endsWith('.lock')) {
		return taskId;
	}
	return `_x${Buffer.from(taskId, 'utf8').toString('hex')}`;
}

export function epicRefPrefix(epicKey: string): string {
	return assertSafeGitRefArg(`${EPIC_REFS_ROOT}/${epicKey}`, 'epic ref prefix');
}

export function epicBaseRef(epicKey: string): string {
	return `${epicRefPrefix(epicKey)}/base`;
}

export function epicWaveRef(epicKey: string, seq: number): string {
	return `${epicRefPrefix(epicKey)}/waves/${Math.trunc(seq)}`;
}

export function epicTaskRef(epicKey: string, taskId: string): string {
	return assertSafeGitRefArg(
		`${epicRefPrefix(epicKey)}/tasks/${taskRefComponent(taskId)}`,
		'epic task ref',
	);
}

/**
 * Every ref under the epic's namespace (full name → sha). One bounded
 * `git for-each-ref`. Throws when git fails.
 */
export function readEpicRefs(
	directory: string,
	epicKey: string,
): Map<string, string> {
	const output = _internals.gitExec(
		[
			'for-each-ref',
			`--count=${MAX_EPIC_REFS}`,
			'--format=%(objectname) %(refname)',
			epicRefPrefix(epicKey),
		],
		directory,
	);
	const refs = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const space = line.indexOf(' ');
		if (space <= 0) continue;
		const sha = line.slice(0, space);
		const name = line.slice(space + 1).trim();
		if (isFullSha(sha) && name.length > 0) refs.set(name, sha);
	}
	return refs;
}

function readOneRef(directory: string, ref: string): string | null {
	const output = _internals.gitExec(
		['for-each-ref', '--count=1', '--format=%(objectname)', ref],
		directory,
	);
	const sha = output.trim().split(/\r?\n/)[0] ?? '';
	return isFullSha(sha) ? sha : null;
}

/**
 * Point `ref` at `sha`: create-only when missing (`update-ref <ref> <sha> ""`),
 * no-op when already there, compare-and-swap from `existing` otherwise. One
 * attempt; on failure the ref is re-read and the call succeeds only when it
 * now holds `sha`. Throws otherwise.
 */
export function writeEpicRef(
	directory: string,
	ref: string,
	sha: string,
	existing: string | null,
): 'created' | 'unchanged' | 'updated' {
	if (!isFullSha(sha)) throw new Error(`not a full commit id: ${sha}`);
	assertSafeGitRefArg(ref, 'epic ref write');
	if (existing === sha) return 'unchanged';
	try {
		_internals.gitExecOnce(['update-ref', ref, sha, existing ?? ''], directory);
		return existing === null ? 'created' : 'updated';
	} catch (error) {
		if (readOneRef(directory, ref) === sha) {
			return existing === null ? 'created' : 'updated';
		}
		throw error;
	}
}

/** The refs the epic record says should exist (full name → sha). */
export function desiredEpicRefs(record: EpicRecordV1): Map<string, string> {
	const desired = new Map<string, string>();
	if (!record.git.isRepo) return desired;
	if (isFullSha(record.git.baseCommit)) {
		desired.set(epicBaseRef(record.epicKey), record.git.baseCommit);
	}
	for (const wave of record.waves) {
		if (wave.status === 'closed' && isFullSha(wave.closeHead)) {
			desired.set(epicWaveRef(record.epicKey, wave.seq), wave.closeHead);
		}
	}
	for (const outcome of Object.values(record.tasks)) {
		const sha = outcome.marker?.sha;
		if (outcome.resolution === 'completed' && isFullSha(sha)) {
			desired.set(epicTaskRef(record.epicKey, outcome.taskId), sha);
		}
	}
	return desired;
}

/**
 * Make the epic's refs mirror its record (see the module header). Returns
 * the refs after the sync. Throws when git fails.
 */
export function syncEpicRefs(
	directory: string,
	record: EpicRecordV1,
): Map<string, string> {
	const existing = readEpicRefs(directory, record.epicKey);
	for (const [ref, sha] of desiredEpicRefs(record)) {
		writeEpicRef(directory, ref, sha, existing.get(ref) ?? null);
		existing.set(ref, sha);
	}
	return existing;
}

/** `git merge-base --is-ancestor <sha> HEAD`. Throws when git fails. */
export function isCommitAncestorOfHead(
	directory: string,
	sha: string,
): boolean {
	if (!isFullSha(sha)) return false;
	return (
		_internals.gitProbeExitCode(
			['merge-base', '--is-ancestor', sha, 'HEAD'],
			directory,
		) === 0
	);
}

/**
 * Delete every ref under the epic's namespace (each `update-ref -d` guarded
 * by its current value, one attempt each). Never throws; failures are
 * returned for the close report.
 */
export function deleteEpicRefs(
	directory: string,
	epicKey: string,
): { deleted: string[]; failed: string[] } {
	const deleted: string[] = [];
	const failed: string[] = [];
	let refs: Map<string, string>;
	try {
		refs = readEpicRefs(directory, epicKey);
	} catch (error) {
		return {
			deleted,
			failed: [
				`${epicRefPrefix(epicKey)}/* (${error instanceof Error ? error.message : String(error)})`,
			],
		};
	}
	for (const [ref, sha] of refs) {
		try {
			_internals.gitExecOnce(['update-ref', '-d', ref, sha], directory);
			deleted.push(ref);
		} catch {
			failed.push(ref);
		}
	}
	return { deleted, failed };
}

/**
 * The newest `swarm(task <id>):` commit of each task in `taskIds` whose
 * `Swarm-Plan:` trailer is `planKey`, among `range` (e.g. `<base>..HEAD`).
 * One bounded `git log` (merge commits included — a landing is a merge).
 * Throws when git fails.
 */
export function findTaskCommits(
	directory: string,
	range: string,
	planKey: string,
	taskIds: readonly string[],
): Map<string, string> {
	const wanted = new Map<string, string>();
	for (const id of taskIds) wanted.set(scrubTaskIdForGitSubject(id), id);
	const found = new Map<string, string>();
	if (wanted.size === 0) return found;
	const output = _internals.gitExec(
		[
			'log',
			'-z',
			'--extended-regexp',
			'--grep=^swarm\\(task [^)]+\\):',
			`--max-count=${MARKER_LOOKUP_MAX_COMMITS}`,
			MARKER_LOG_FORMAT,
			range,
			'--',
		],
		directory,
	);
	for (const marker of parseTaskMarkerLog(output)) {
		if (marker.planKey !== planKey) continue;
		const taskId = wanted.get(marker.taskId);
		if (taskId !== undefined && !found.has(taskId)) {
			found.set(taskId, marker.sha);
		}
	}
	return found;
}

/** The range an epic's own commits live in: `<base>..HEAD`, or all of HEAD. */
export function epicCommitRange(record: EpicRecordV1): string {
	return isFullSha(record.git.baseCommit)
		? `${record.git.baseCommit}..HEAD`
		: 'HEAD';
}

/** One task's repair verdict (`/swarm epic status --repair-refs`). */
export interface EpicRefRepair {
	taskId: string;
	status: 'ok' | 'repaired' | 'needs-attention';
	sha: string | null;
	detail: string;
}

/**
 * Plan `/swarm epic status --repair-refs` (MINOR 11). For every completed
 * task the epic recorded, and every task in `unrecorded` (completed in the
 * plan during the epic but outside a wave), the task's commit must be
 * reachable from HEAD. When it is not (a rebase or amend rewrote it, or no
 * ref was ever written) the task's commit is re-adopted: its newest
 * `swarm(task <id>):` commit for this plan in the epic's range, else (a
 * recorded task) the newest commit in that range touching its declared
 * files; neither ⇒ `needs-attention`. Returns the verdicts and the adopted
 * commits — `recorded` ones the caller CASes into the epic record (then
 * {@link syncEpicRefs}), `unrecorded` ones it writes as refs directly.
 * Throws when git fails.
 */
export function planEpicTaskRefRepair(
	directory: string,
	record: EpicRecordV1,
	unrecorded: readonly string[],
): {
	repairs: EpicRefRepair[];
	recorded: Map<string, string>;
	unrecorded: Map<string, string>;
} {
	const repairs: EpicRefRepair[] = [];
	const recorded = new Map<string, string>();
	const adoptedUnrecorded = new Map<string, string>();
	const refs = readEpicRefs(directory, record.epicKey);
	const broken: string[] = [];
	const reachable = (sha: string | null | undefined): sha is string =>
		isFullSha(sha) && isCommitAncestorOfHead(directory, sha);
	for (const outcome of Object.values(record.tasks)) {
		if (outcome.resolution !== 'completed') continue;
		const sha = outcome.marker?.sha ?? null;
		if (reachable(sha)) {
			repairs.push({
				taskId: outcome.taskId,
				status: 'ok',
				sha,
				detail: 'reachable from HEAD',
			});
		} else {
			broken.push(outcome.taskId);
		}
	}
	const brokenUnrecorded: string[] = [];
	for (const taskId of unrecorded) {
		if (record.tasks[taskId]) continue;
		const sha = refs.get(epicTaskRef(record.epicKey, taskId));
		if (reachable(sha)) {
			repairs.push({
				taskId,
				status: 'ok',
				sha,
				detail: 'reachable from HEAD',
			});
		} else {
			brokenUnrecorded.push(taskId);
		}
	}
	if (broken.length === 0 && brokenUnrecorded.length === 0) {
		return { repairs, recorded, unrecorded: adoptedUnrecorded };
	}
	const range = epicCommitRange(record);
	const markers = findTaskCommits(directory, range, record.planKey, [
		...broken,
		...brokenUnrecorded,
	]);
	const needsAttention = (taskId: string): void => {
		repairs.push({
			taskId,
			status: 'needs-attention',
			sha: null,
			detail:
				'no commit reachable from HEAD carries its work — commit it on the epic branch with the subject `swarm(task <id>): …` and the plan trailer, then rerun --repair-refs',
		});
	};
	for (const taskId of broken) {
		let sha = markers.get(taskId) ?? null;
		let how = 'its `swarm(task …)` commit for this plan';
		const declared = (record.tasks[taskId]?.declared ?? []).filter(
			(file) => file.length > 0 && !file.startsWith(':'),
		);
		if (!sha && declared.length > 0) {
			const out = _internals
				.gitExec(
					[
						'log',
						'--max-count=1',
						'--format=%H',
						range,
						'--',
						...declared.slice(0, 200).map((file) => `:(literal)${file}`),
					],
					directory,
				)
				.trim();
			if (isFullSha(out)) {
				sha = out;
				how = 'the newest commit touching its declared files';
			}
		}
		if (!sha) {
			needsAttention(taskId);
			continue;
		}
		recorded.set(taskId, sha);
		repairs.push({
			taskId,
			status: 'repaired',
			sha,
			detail: `re-pointed to ${sha.slice(0, 12)} (${how})`,
		});
	}
	for (const taskId of brokenUnrecorded) {
		const sha = markers.get(taskId);
		if (!sha) {
			needsAttention(taskId);
			continue;
		}
		adoptedUnrecorded.set(taskId, sha);
		repairs.push({
			taskId,
			status: 'repaired',
			sha,
			detail: `adopted ${sha.slice(0, 12)} (its \`swarm(task …)\` commit for this plan; completed outside a wave)`,
		});
	}
	return { repairs, recorded, unrecorded: adoptedUnrecorded };
}
