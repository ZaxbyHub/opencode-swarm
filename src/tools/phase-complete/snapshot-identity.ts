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

export function computePhaseEvidenceSnapshot(directory: string): string {
	const root = fs.realpathSync(directory);
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
			for (const name of names.sort(compareUtf8)) {
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
				path: path.relative(root, absolute).replaceAll('\\', '/'),
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
