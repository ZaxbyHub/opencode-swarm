/**
 * Shared detector implementation for the no-sync-spawn ratchet
 * (tests/unit/hooks/no-sync-spawn-ratchet.test.ts) and its self-test
 * (tests/unit/hooks/no-sync-spawn-detector-selftest.test.ts).
 *
 * Extracted by the #3317 CHECK_WRONG amendment so the self-test keeps guarding
 * THIS detector (no duplicated copy) while both test files stay under the
 * FR-006 500-line cap.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** Direct synchronous subprocess CALL (mirrors check-c11's call-site regex). */
export const SYNC_SPAWN_CALL_PATTERN =
	/\b(spawnSync|execSync|execFileSync)\s*\(/g;

/** Sync snapshot identifier remaining after permitted seam forms are stripped. */
export const SYNC_SNAPSHOT_RESIDUE_PATTERN = /\bcaptureWorkspaceSnapshot\b/g;

/** Sync changed-files helper — forbidden residue in the R-1 hook files. */
export const SYNC_CHANGED_RESIDUE_PATTERN = /\bchangedFilesSinceSnapshot\b/g;

/** The sync git runner — forbidden inside the async twins' body slices. */
export const SYNC_RUNNER_PATTERN = /\brunGit\b/g;

export const ASYNC_TWIN_EXPORT_PATTERN =
	/export (?:async )?function captureWorkspaceSnapshotAsync\b|export const captureWorkspaceSnapshotAsync\b/;

export const ASYNC_CHANGED_TWIN_EXPORT_PATTERN =
	/export (?:async )?function changedFilesSinceSnapshotAsync\b|export const changedFilesSinceSnapshotAsync\b/;

export interface Violation {
	file: string;
	line: number;
	excerpt: string;
}

export function describeViolations(violations: Violation[]): string {
	return violations
		.map((v) => `${v.file}:${v.line} — ${v.excerpt.trim()}`)
		.join('; ');
}

function lineOfIndex(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** Collect every match of a GLOBAL regex with file:line evidence. */
export function scan(file: string, src: string, pattern: RegExp): Violation[] {
	const out: Violation[] = [];
	for (const match of src.matchAll(pattern)) {
		out.push({
			file,
			line: lineOfIndex(src, match.index ?? 0),
			excerpt: match[0],
		});
	}
	return out;
}

/**
 * Mirrors check-c11.ts's `stripPermittedReferences` for an arbitrary sync
 * identifier: dotted member access (`_internals.captureWorkspaceSnapshot`) and
 * object-key shorthand (`{ captureWorkspaceSnapshot: fn }` /
 * `, captureWorkspaceSnapshot: fn,`) are the permitted DI seam forms. Everything
 * else that still names the sync helper — import bindings, bare calls, aliased
 * destructures — is a violation: those forms make the sync spawn reachable from
 * the hook path.
 */
export function stripPermittedReferences(
	text: string,
	identifier: string,
): string {
	return text
		.replace(new RegExp(`\\.\\s*${identifier}\\b`, 'g'), '')
		.replace(new RegExp(`[{,]\\s*${identifier}\\s*:`, 'g'), (m) =>
			m.replace(identifier, ''),
		);
}

/**
 * Removes the `probeBranchExists` function body from coder-settlement.ts before
 * the sync-spawn scan. That helper (#2236 recovery self-heal) is the recurrence
 * sweep's explicitly classified OUT_OF_CLASS direct spawnSync — a lock-held
 * recovery-path probe. The carve-out is by exact function name, so a rename
 * makes its call visible again (fail-closed), and any NEW sync spawn elsewhere
 * in the file still bites.
 */
export function stripClassifiedRecoveryProbe(text: string): string {
	const start = /^function probeBranchExists\(/m.exec(text);
	if (!start || start.index === undefined) return text;
	const rest = text.slice(start.index + 1);
	const nextFn = rest.search(/\n(?:export )?(?:async )?function /);
	return nextFn >= 0
		? text.slice(0, start.index) + rest.slice(nextFn)
		: text.slice(0, start.index);
}

/**
 * Body slice of an exported async twin, mirroring check-c11's slicing exactly:
 * from the export match through just before the next line-start `export `.
 * Returns null when the twin is not exported.
 */
export function exportedBodySlice(
	src: string,
	exportPattern: RegExp,
): string | null {
	const exportMatch = exportPattern.exec(src);
	if (!exportMatch || exportMatch.index === undefined) {
		return null;
	}
	const bodyStart = exportMatch.index;
	const nextExport = src.slice(bodyStart + 10).search(/^export /m);
	return nextExport >= 0
		? src.slice(bodyStart, bodyStart + 10 + nextExport)
		: src.slice(bodyStart);
}

export function readSource(rel: string): string {
	return readFileSync(join(ROOT, rel), 'utf-8');
}
