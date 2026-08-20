import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Exact reviewer-scope capture (v2, issue #2100).
 *
 * Every regular file is fingerprinted over its COMPLETE bytes with one fixed
 * chunk buffer — there is no per-file or aggregate byte cap. File identity is
 * never denied by size: resource pressure surfaces as the typed retryable
 * `capture_deadline` (or a per-file race code), and only a successful capture
 * can ever produce a digest. A partial, sampled, or capped digest cannot be
 * represented by this module by construction.
 */

export type ReviewerScopeCaptureFailureCode =
	| 'invalid_request'
	| 'outside_workspace'
	| 'symlink_or_reparse'
	| 'non_regular'
	| 'unreadable'
	| 'workspace_mismatch'
	| 'file_changed_during_capture'
	| 'capture_deadline';

/** `binding_mismatch` and invalid generation identity are lifecycle-level typed errors (reviewer-scope-lifecycle), not per-file capture codes. */
export const RETRYABLE_CAPTURE_FAILURE_CODES: ReadonlySet<ReviewerScopeCaptureFailureCode> =
	new Set<ReviewerScopeCaptureFailureCode>([
		'file_changed_during_capture',
		'capture_deadline',
	]);

export type ReviewerScopeCaptureResult =
	| { kind: 'captured_file'; file: string; size: number; hash: string }
	| { kind: 'captured_deleted'; file: string }
	| {
			kind: 'capture_failed';
			file: string;
			code: ReviewerScopeCaptureFailureCode;
			retryable: boolean;
			detail?: string;
	  };

/** Stored success record persisted on generations and ownership tombstones. */
export type ReviewerScopeFileFingerprint =
	| {
			file: string;
			kind: 'file';
			size: number;
			hash: string;
	  }
	| {
			file: string;
			kind: 'deleted';
	  };

/** Fixed streaming chunk — the only buffer a capture ever allocates. */
export const REVIEWER_SCOPE_CAPTURE_CHUNK_BYTES = 262_144;
/** Bounded attempts for typed retryable capture failures at every call site. */
export const REVIEWER_SCOPE_CAPTURE_ATTEMPTS = 3;
/** Total deadline (ms) for one capture batch (guardrails batch, freshness check, manifest build). */
export const REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS = 10_000;

export const _internals: {
	open: typeof fs.openSync;
	fstat: (fd: number, options: { bigint: true }) => fs.BigIntStats;
	read: typeof fs.readSync;
	close: typeof fs.closeSync;
	lstat: typeof fs.lstatSync;
	stat: (path: fs.PathLike, options: { bigint: true }) => fs.BigIntStats;
	realpathSync: typeof fs.realpathSync;
	now: () => number;
} = {
	open: fs.openSync,
	fstat: (fd, options) => fs.fstatSync(fd, options),
	read: fs.readSync,
	close: fs.closeSync,
	lstat: fs.lstatSync,
	stat: (path, options) => fs.statSync(path, options),
	realpathSync: fs.realpathSync,
	now: Date.now,
};

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function normalizedProjectFile(directory: string, file: string): string | null {
	if (file.includes('\0') || hasControlCharacter(file)) return null;
	const root = path.resolve(directory);
	const absolute = path.resolve(root, file);
	const relative = path.relative(root, absolute).replaceAll('\\', '/');
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith('../') ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return relative;
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/**
 * A deleted path is only a valid deletion when its nearest existing ancestor
 * is still inside the canonical root — otherwise the path escaped the workspace
 * (fail closed) instead of being deleted.
 */
function deletedPathIsContained(
	canonicalRoot: string,
	absolute: string,
): boolean {
	let current = path.dirname(absolute);
	for (;;) {
		try {
			const canonical = _internals.realpathSync(current);
			return (
				canonicalRoot === canonical || isWithinRoot(canonicalRoot, canonical)
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function sameSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	const identityKnown =
		(left.dev !== 0n || left.ino !== 0n) &&
		(right.dev !== 0n || right.ino !== 0n);
	return (
		(!identityKnown || (left.dev === right.dev && left.ino === right.ino)) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

/**
 * Capture the exact current file state with a complete, bounded-memory SHA-256.
 *
 * Failure surfaces are typed: traversal/root escape, symlinks/reparse points,
 * non-regular files, and unreadable targets fail closed as non-retryable codes;
 * open/stat races and capture deadlines are retryable. Deletions under a
 * contained (possibly removed) directory are `captured_deleted`.
 */
export function captureReviewerScopeFileFingerprint(
	directory: string,
	file: string,
	options: { deadlineAt?: number } = {},
): ReviewerScopeCaptureResult {
	if (typeof directory !== 'string' || typeof file !== 'string') {
		return {
			kind: 'capture_failed',
			file: typeof file === 'string' ? file : '',
			code: 'invalid_request',
			retryable: false,
		};
	}
	if (file.includes('\0') || hasControlCharacter(file)) {
		return {
			kind: 'capture_failed',
			file,
			code: 'invalid_request',
			retryable: false,
		};
	}
	const normalized = normalizedProjectFile(directory, file);
	if (!normalized) {
		return {
			kind: 'capture_failed',
			file,
			code: 'outside_workspace',
			retryable: false,
		};
	}
	let canonicalRoot: string;
	let canonicalParent: string;
	const absolute = path.resolve(directory, normalized);
	try {
		canonicalRoot = _internals.realpathSync(path.resolve(directory));
	} catch {
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'outside_workspace',
			retryable: false,
		};
	}
	try {
		canonicalParent = _internals.realpathSync(path.dirname(absolute));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return deletedPathIsContained(canonicalRoot, absolute)
				? { kind: 'captured_deleted', file: normalized }
				: {
						kind: 'capture_failed',
						file: normalized,
						code: 'outside_workspace',
						retryable: false,
					};
		}
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'unreadable',
			retryable: false,
			detail: (error as NodeJS.ErrnoException).code,
		};
	}
	if (!isWithinRoot(canonicalRoot, canonicalParent)) {
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'outside_workspace',
			retryable: false,
		};
	}
	let before: fs.Stats;
	try {
		before = _internals.lstat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return deletedPathIsContained(canonicalRoot, absolute)
				? { kind: 'captured_deleted', file: normalized }
				: {
						kind: 'capture_failed',
						file: normalized,
						code: 'outside_workspace',
						retryable: false,
					};
		}
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'unreadable',
			retryable: false,
			detail: (error as NodeJS.ErrnoException).code,
		};
	}
	if (before.isSymbolicLink()) {
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'symlink_or_reparse',
			retryable: false,
		};
	}
	try {
		const canonicalTarget = _internals.realpathSync(absolute);
		if (
			!isWithinRoot(canonicalRoot, canonicalTarget) ||
			path.dirname(canonicalTarget) !== canonicalParent
		) {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'outside_workspace',
				retryable: false,
			};
		}
	} catch {
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'unreadable',
			retryable: false,
		};
	}
	if (
		!before.isFile() ||
		!Number.isSafeInteger(before.size) ||
		before.size < 0
	) {
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'non_regular',
			retryable: false,
		};
	}
	const openFlags =
		fs.constants.O_RDONLY |
		(process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
	let fd: number | undefined;
	try {
		fd = _internals.open(absolute, openFlags);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ELOOP') {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'file_changed_during_capture',
				retryable: true,
				detail: code,
			};
		}
		if (code === 'EMFILE' || code === 'ENFILE') {
			// Descriptor exhaustion is transient resource pressure: retryable.
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'capture_deadline',
				retryable: true,
				detail: code,
			};
		}
		return {
			kind: 'capture_failed',
			file: normalized,
			code: 'unreadable',
			retryable: false,
			detail: code,
		};
	}
	try {
		const openedBefore = _internals.fstat(fd, { bigint: true });
		if (!openedBefore.isFile()) {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'non_regular',
				retryable: false,
			};
		}
		const hash: Hash = createHash('sha256');
		const chunk = Buffer.alloc(REVIEWER_SCOPE_CAPTURE_CHUNK_BYTES);
		let totalBytes = 0;
		for (;;) {
			if (
				options.deadlineAt !== undefined &&
				_internals.now() > options.deadlineAt
			) {
				return {
					kind: 'capture_failed',
					file: normalized,
					code: 'capture_deadline',
					retryable: true,
				};
			}
			let bytesRead: number;
			try {
				bytesRead = _internals.read(fd, chunk, 0, chunk.byteLength, null);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				return {
					kind: 'capture_failed',
					file: normalized,
					code: 'unreadable',
					retryable: false,
					detail: code,
				};
			}
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			hash.update(
				bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead),
			);
		}
		const openedAfter = _internals.fstat(fd, { bigint: true });
		if (!sameSnapshot(openedBefore, openedAfter)) {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'file_changed_during_capture',
				retryable: true,
			};
		}
		if (totalBytes !== Number(openedBefore.size)) {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'file_changed_during_capture',
				retryable: true,
			};
		}
		// The open descriptor proves the streamed bytes; the path must still
		// refer to that same inode so the digest describes the file a reviewer
		// would read at this path (replacement-same-path defense).
		let pathAfter: fs.BigIntStats;
		try {
			pathAfter = _internals.stat(absolute, { bigint: true });
		} catch {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'file_changed_during_capture',
				retryable: true,
			};
		}
		if (!pathAfter.isFile() || !sameSnapshot(openedBefore, pathAfter)) {
			return {
				kind: 'capture_failed',
				file: normalized,
				code: 'file_changed_during_capture',
				retryable: true,
			};
		}
		return {
			kind: 'captured_file',
			file: normalized,
			size: totalBytes,
			hash: hash.digest('hex'),
		};
	} finally {
		if (fd !== undefined) {
			try {
				_internals.close(fd);
			} catch {
				// Best-effort close; the descriptor is dead either way.
			}
		}
	}
}

/** Convert a successful capture into the stored fingerprint record shape. */
export function reviewerScopeCaptureToFingerprint(
	result: ReviewerScopeCaptureResult,
): ReviewerScopeFileFingerprint | null {
	if (result.kind === 'captured_file') {
		return {
			file: result.file,
			kind: 'file',
			size: result.size,
			hash: result.hash,
		};
	}
	if (result.kind === 'captured_deleted') {
		return { file: result.file, kind: 'deleted' };
	}
	return null;
}

export function reviewerScopeFileFingerprintsEqual(
	left: ReviewerScopeFileFingerprint,
	right: ReviewerScopeFileFingerprint,
): boolean {
	return (
		left.file === right.file &&
		left.kind === right.kind &&
		(left.kind === 'deleted' ||
			(right.kind === 'file' &&
				left.size === right.size &&
				left.hash === right.hash))
	);
}
