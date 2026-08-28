import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export interface ProtectedManifestV1 {
	v: 1;
	root: string;
	digest: string;
	entries: readonly string[];
}
const LIMITS = {
	files: 5_000,
	bytes: 64 * 1024 * 1024,
	depth: 32,
	elapsedMs: 10_000,
};

/** Snapshot a protected regular-file tree; ambiguity and budget exhaustion fail closed. */
export async function snapshotProtectedTree(
	root: string,
): Promise<ProtectedManifestV1> {
	const started = Date.now();
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink())
		throw new Error('PROTECTED_INPUT_AMBIGUOUS:root');
	const canonicalRoot = await realpath(root);
	const entries: string[] = [];
	if (rootStat.isFile()) {
		if (rootStat.nlink > 1) throw new Error('PROTECTED_INPUT_AMBIGUOUS:root');
		const content = await readFile(canonicalRoot);
		const afterRead = await lstat(canonicalRoot);
		if (
			`${afterRead.dev}:${afterRead.ino}:${afterRead.size}:${afterRead.mtimeMs}` !==
			`${rootStat.dev}:${rootStat.ino}:${rootStat.size}:${rootStat.mtimeMs}`
		)
			throw new Error('PROTECTED_INPUT_REPLACED_DURING_READ:root');
		entries.push(
			`f\0.\0${rootStat.size}\0${rootStat.mode}\0${createHash('sha256').update(content).digest('hex')}`,
		);
		return Object.freeze({
			v: 1,
			root: canonicalRoot,
			digest: createHash('sha256').update(entries[0]).digest('hex'),
			entries: Object.freeze(entries),
		});
	}
	if (!rootStat.isDirectory())
		throw new Error('PROTECTED_INPUT_AMBIGUOUS:root');
	let fileCount = 0;
	let byteCount = 0;
	async function walk(directory: string, depth: number): Promise<void> {
		if (depth > LIMITS.depth || Date.now() - started > LIMITS.elapsedMs)
			throw new Error('PROTECTED_INPUT_INTEGRITY_BUDGET_EXCEEDED');
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			const absolute = path.join(directory, child.name);
			const stat = await lstat(absolute);
			const relative = path
				.relative(canonicalRoot, absolute)
				.replace(/\\/g, '/');
			if (stat.isSymbolicLink())
				throw new Error(`PROTECTED_INPUT_AMBIGUOUS:${relative}`);
			if (stat.isDirectory()) {
				entries.push(`d\0${relative}\0${stat.mode}`);
				await walk(absolute, depth + 1);
				continue;
			}
			if (!stat.isFile() || stat.nlink > 1)
				throw new Error(`PROTECTED_INPUT_AMBIGUOUS:${relative}`);
			const identityBefore = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
			fileCount += 1;
			byteCount += stat.size;
			if (
				fileCount > LIMITS.files ||
				byteCount > LIMITS.bytes ||
				Date.now() - started > LIMITS.elapsedMs
			)
				throw new Error('PROTECTED_INPUT_INTEGRITY_BUDGET_EXCEEDED');
			const contentHash = createHash('sha256')
				.update(await readFile(absolute))
				.digest('hex');
			const afterRead = await lstat(absolute);
			if (
				`${afterRead.dev}:${afterRead.ino}:${afterRead.size}:${afterRead.mtimeMs}` !==
				identityBefore
			)
				throw new Error(`PROTECTED_INPUT_REPLACED_DURING_READ:${relative}`);
			entries.push(
				`f\0${relative}\0${stat.size}\0${stat.mode}\0${contentHash}`,
			);
		}
	}
	await walk(canonicalRoot, 0);
	return Object.freeze({
		v: 1,
		root: canonicalRoot,
		digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
		entries: Object.freeze(entries),
	});
}

export async function verifyProtectedTree(
	before: ProtectedManifestV1,
): Promise<void> {
	const after = await snapshotProtectedTree(before.root);
	if (
		after.digest !== before.digest ||
		after.entries.length !== before.entries.length
	)
		throw new Error('PROTECTED_INPUT_INTEGRITY_VIOLATION');
}

/** Mandatory transaction wrapper for governed evaluators. Verification always runs. */
export async function withProtectedInputIntegrity<T>(
	root: string,
	operation: () => Promise<T>,
): Promise<T> {
	const before = await snapshotProtectedTree(root);
	let result: T | undefined;
	let operationError: unknown;
	try {
		result = await operation();
	} catch (error) {
		operationError = error;
	}
	await verifyProtectedTree(before);
	if (operationError !== undefined) throw operationError;
	return result as T;
}

export interface ProtectedSetManifestV1 {
	v: 1;
	roots: readonly string[];
	states: readonly (ProtectedManifestV1 | 'missing')[];
}

async function snapshotRootOrMissing(
	root: string,
): Promise<ProtectedManifestV1 | 'missing'> {
	try {
		return await snapshotProtectedTree(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
		throw error;
	}
}

export async function snapshotProtectedSet(
	roots: readonly string[],
): Promise<ProtectedSetManifestV1> {
	const normalized = [
		...new Set(roots.map((root) => path.resolve(root))),
	].sort();
	const states: Array<ProtectedManifestV1 | 'missing'> = [];
	for (const root of normalized) states.push(await snapshotRootOrMissing(root));
	return Object.freeze({
		v: 1,
		roots: Object.freeze(normalized),
		states: Object.freeze(states),
	});
}

export async function verifyProtectedSet(
	before: ProtectedSetManifestV1,
): Promise<void> {
	for (let index = 0; index < before.roots.length; index++) {
		const after = await snapshotRootOrMissing(before.roots[index]);
		const previous = before.states[index];
		if (previous === 'missing' || after === 'missing') {
			if (previous !== after)
				throw new Error('PROTECTED_INPUT_INTEGRITY_VIOLATION');
			continue;
		}
		if (
			previous.digest !== after.digest ||
			previous.entries.length !== after.entries.length
		)
			throw new Error('PROTECTED_INPUT_INTEGRITY_VIOLATION');
	}
}

export async function withProtectedSetIntegrity<T>(
	roots: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	const before = await snapshotProtectedSet(roots);
	let result: T | undefined;
	let operationError: unknown;
	try {
		result = await operation();
	} catch (error) {
		operationError = error;
	}
	await verifyProtectedSet(before);
	if (operationError !== undefined) throw operationError;
	return result as T;
}
