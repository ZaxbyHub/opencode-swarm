import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_SNAPSHOT_FILES = 512;
const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

const INPUTS = [
	'.swarm/evidence',
	'.swarm/spec.md',
	'.swarm/knowledge-receipts-v2.jsonl',
	'specs',
	'openspec/specs',
	'openspec/changes',
] as const;

interface SnapshotEntry {
	path: string;
	sha256: string;
	bytes: number;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/**
 * Byte-exact portable relative path (Windows separators become forward
 * slashes; no case-folding — two paths differing only by case hash
 * differently on every platform, including case-insensitive NTFS).
 *
 * Single source for the verification-receipts substrate (#2968) and its
 * verifier (#2970): emission and verification share this normalizer by
 * import, so the two can never drift apart.
 */
export function toPortableRelativePath(root: string, absolute: string): string {
	return path.relative(root, absolute).replaceAll('\\', '/');
}

/**
 * Derived receipt artifacts live under `.swarm/evidence/receipts/` but are
 * REBUILDABLE projections of the gate outputs they summarize — hashing them
 * as source evidence would make every receipt emission mutate the
 * phase-evidence identity the gates enforce (#2968 R2, plan-critic round 1:
 * an emitted receipt flipped `computePhaseEvidenceSnapshot` and would trip
 * `PHASE_PREFLIGHT_STALE`). The snapshot therefore skips exactly this one
 * top-level entry of the `.swarm/evidence` root; behavior is byte-identical
 * when the directory does not exist.
 *
 * FB-008 (#2968 swarm-pr-review): exported as the single source of truth for
 * "derived, non-task top-level entries of `.swarm/evidence`" — the evidence
 * task-ID listing (`listEvidenceTaskIds`, consumed by `/swarm doctor`'s
 * Orphaned-Evidence check) must treat the SAME entries as reserved, or every
 * project that completes a phase gets a false "Orphaned Evidence [receipts]"
 * red on its primary health surface.
 */
export const SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES = new Set(['receipts']);

export function computePhaseEvidenceSnapshot(directory: string): string {
	const root = fs.realpathSync(directory);
	const evidenceRoot = path.join(root, '.swarm', 'evidence');
	const entries: SnapshotEntry[] = [];
	let totalBytes = 0;
	let visitedEntries = 0;

	const visit = (absolute: string): void => {
		if (!isContained(root, absolute)) {
			throw new Error('PHASE_SNAPSHOT_PATH_ESCAPE');
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(
				`PHASE_SNAPSHOT_UNSAFE_PATH: ${path.relative(root, absolute)}`,
			);
		}
		if (stat.isDirectory()) {
			const names: string[] = [];
			const handle = fs.opendirSync(absolute);
			try {
				for (;;) {
					const entry = handle.readSync();
					if (!entry) break;
					visitedEntries += 1;
					if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
						throw new Error('PHASE_SNAPSHOT_ENTRY_LIMIT');
					}
					names.push(entry.name);
				}
			} finally {
				handle.closeSync();
			}
			const isEvidenceRoot = absolute === evidenceRoot;
			for (const name of names.sort(compareUtf8)) {
				if (isEvidenceRoot && SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES.has(name)) {
					continue;
				}
				visit(path.join(absolute, name));
			}
			return;
		}
		if (!stat.isFile()) {
			throw new Error(
				`PHASE_SNAPSHOT_NON_REGULAR: ${path.relative(root, absolute)}`,
			);
		}
		if (entries.length >= MAX_SNAPSHOT_FILES) {
			throw new Error('PHASE_SNAPSHOT_FILE_LIMIT');
		}
		totalBytes += stat.size;
		if (totalBytes > MAX_SNAPSHOT_BYTES) {
			throw new Error('PHASE_SNAPSHOT_BYTE_LIMIT');
		}
		const descriptor = fs.openSync(
			absolute,
			fs.constants.O_RDONLY |
				((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
		);
		try {
			const opened = fs.fstatSync(descriptor);
			if (
				!opened.isFile() ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				opened.size !== stat.size
			) {
				throw new Error('PHASE_SNAPSHOT_CONCURRENT_MUTATION');
			}
			const bytes = fs.readFileSync(descriptor);
			const after = fs.fstatSync(descriptor);
			if (
				after.size !== opened.size ||
				after.mtimeMs !== opened.mtimeMs ||
				after.ctimeMs !== opened.ctimeMs
			) {
				throw new Error('PHASE_SNAPSHOT_CONCURRENT_MUTATION');
			}
			entries.push({
				path: toPortableRelativePath(root, absolute),
				sha256: createHash('sha256').update(bytes).digest('hex'),
				bytes: bytes.byteLength,
			});
		} finally {
			fs.closeSync(descriptor);
		}
	};

	for (const relative of INPUTS) visit(path.join(root, ...relative.split('/')));
	entries.sort((left, right) => compareUtf8(left.path, right.path));
	return createHash('sha256')
		.update(JSON.stringify({ schemaVersion: 1, entries }))
		.digest('hex');
}
