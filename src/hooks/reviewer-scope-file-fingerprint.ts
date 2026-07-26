import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_REVIEWER_SCOPE_FINGERPRINT_BYTES = 1_048_576;
export const MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES = 4_194_304;

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

export const _internals = {
	readFileSync: fs.readFileSync,
};

function normalizedProjectFile(directory: string, file: string): string | null {
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
 * Capture the exact post-write file state with a bounded read. Oversized,
 * non-regular, path-racing, and unreadable targets fail closed to null.
 */
export function captureReviewerScopeFileFingerprint(
	directory: string,
	file: string,
	maxBytes = MAX_REVIEWER_SCOPE_FINGERPRINT_BYTES,
): ReviewerScopeFileFingerprint | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
	const normalized = normalizedProjectFile(directory, file);
	if (!normalized) return null;
	let canonicalRoot: string;
	let canonicalParent: string;
	const absolute = path.resolve(directory, normalized);
	try {
		canonicalRoot = fs.realpathSync(path.resolve(directory));
		canonicalParent = fs.realpathSync(path.dirname(absolute));
	} catch {
		return null;
	}
	if (!isWithinRoot(canonicalRoot, canonicalParent)) return null;
	let before: fs.Stats;
	try {
		before = fs.lstatSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { file: normalized, kind: 'deleted' };
		}
		return null;
	}
	if (before.isSymbolicLink()) return null;
	try {
		const canonicalTarget = fs.realpathSync(absolute);
		if (
			!isWithinRoot(canonicalRoot, canonicalTarget) ||
			path.dirname(canonicalTarget) !== canonicalParent
		) {
			return null;
		}
	} catch {
		return null;
	}
	if (
		!before.isFile() ||
		!Number.isSafeInteger(before.size) ||
		before.size < 0 ||
		before.size > MAX_REVIEWER_SCOPE_FINGERPRINT_BYTES ||
		before.size > maxBytes
	) {
		return null;
	}
	try {
		const content = _internals.readFileSync(absolute);
		if (
			content.byteLength !== before.size ||
			content.byteLength > MAX_REVIEWER_SCOPE_FINGERPRINT_BYTES
		) {
			return null;
		}
		const after = fs.lstatSync(absolute);
		if (
			!after.isFile() ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		) {
			return null;
		}
		return {
			file: normalized,
			kind: 'file',
			size: content.byteLength,
			hash: crypto.createHash('sha256').update(content).digest('hex'),
		};
	} catch {
		return null;
	}
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
