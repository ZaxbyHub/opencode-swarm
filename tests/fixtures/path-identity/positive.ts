import defaultPath, * as path from 'node:path';
import { resolve as pathResolve } from 'node:path';

export function direct(directory: string, current: string): boolean {
	return path.resolve(directory) === pathResolve(current);
}

export function projectSessionKey(
	directory: string,
	cache: Map<string, unknown>,
	seen: Set<string>,
	session: string,
): string {
	const normalizedRoot = path.resolve(directory);
	cache.set(normalizedRoot, true);
	seen.add(normalizedRoot);
	return `${normalizedRoot}:${session}`;
}

export function duplicate(directory: string, current: string): boolean {
	return path.resolve(directory) === path.resolve(current);
}

export function defaultImport(directory: string, current: string): boolean {
	return defaultPath.resolve(directory) === defaultPath.resolve(current);
}

export function oneSided(
	directory: string,
	record: { rootPath: string },
): boolean {
	const normalizedRoot = path.resolve(directory);
	return normalizedRoot === record.rootPath;
}

export function directRawDirectory(
	directory: string,
	projectCache: Map<string, unknown>,
): void {
	projectCache.set(directory, true);
}

export function directContextDirectory(
	ctx: { directory: string },
	projectCache: Map<string, unknown>,
): void {
	projectCache.set(ctx.directory, true);
}

export function resolvedContextDirectory(
	ctx: { directory: string },
	other: { directory: string },
): boolean {
	return path.resolve(ctx.directory) === path.resolve(other.directory);
}

export function resolvedContextDirectoryKey(
	ctx: { directory: string },
	projectCache: Map<string, unknown>,
): void {
	const normalizedRoot = path.resolve(ctx.directory);
	projectCache.set(normalizedRoot, true);
}

export function neutralIntermediate(
	directory: string,
	record: { rootPath: string },
	projectCache: Map<string, unknown>,
): boolean {
	const value = path.resolve(directory);
	projectCache.set(value, true);
	return value === record.rootPath;
}

export function assignedIntermediate(
	directory: string,
	projectCache: Map<string, unknown>,
): void {
	let value = '';
	value = path.resolve(directory);
	projectCache.set(value, true);
}

export function twoLayerCache(
	directory: string,
	manifestRootCache: Map<string, string>,
	backendCache: Map<string, unknown>,
): void {
	const projectRoot = manifestRootCache.get(directory);
	if (projectRoot) backendCache.set(projectRoot, true);
}

export const sameWorkspaceRoot = (left: string, right: string): boolean =>
	left === right;

export function protectedWorktree(
	worktreePath: string,
	protectedWorktreePaths: Set<string>,
): boolean {
	return protectedWorktreePaths.has(path.resolve(worktreePath));
}

export function worktreeIdentitySet(values: string[]): Set<string> {
	return new Set(values.map((worktreePath) => path.resolve(worktreePath)));
}

export function worktreePathKey(worktreePath: string): string {
	const normalized = path.normalize(path.resolve(worktreePath));
	return normalized.toLowerCase();
}

export function chainedAndCarriedKeys(
	worktreePath: string,
	ctx: { directory: string },
	projectCache: Map<string, unknown>,
): void {
	let first = '';
	let second = '';
	let folded = '';
	first = path.resolve(worktreePath);
	second = path.normalize(first);
	folded = second.toLowerCase();
	projectCache.set(folded, true);
	const holder = { value: path.resolve(ctx.directory) };
	projectCache.set(holder.value, true);
	// biome-ignore lint/style/useConst: assignment-after-declaration is the recurrence shape under test.
	let assignedResolve: typeof path.resolve;
	assignedResolve = path.resolve;
	projectCache.set(assignedResolve(ctx.directory), true);
}

export function conditionalWorktreeKey(
	worktreePath: string,
	condition: boolean,
): string {
	const resolved = path.resolve(worktreePath);
	return condition ? resolved.toLowerCase() : resolved.toUpperCase();
}
