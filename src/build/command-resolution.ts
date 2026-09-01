import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolvedCommand {
	argv: string[];
	shellCommand: string;
}

interface LocalCommandCandidate {
	absolute: string;
	relative: string;
	requiresNode: boolean;
}

const WINDOWS_LOCAL_SHIM_CANDIDATES: ReadonlyArray<{
	suffix: string;
	requiresNode: boolean;
}> = [
	{ suffix: '.cmd', requiresNode: true },
	{ suffix: '.exe', requiresNode: false },
	{ suffix: '.bat', requiresNode: true },
	{ suffix: '.ps1', requiresNode: true },
	{ suffix: '', requiresNode: true },
];

/**
 * Tokenize a generated command into argv without invoking a shell. Supports
 * single and double quotes for grouping, but never interprets shell
 * metacharacters.
 */
export function tokenizeCommand(command: string): string[] {
	const out: string[] = [];
	let buf = '';
	let quote: '"' | "'" | null = null;
	for (const ch of command.trim()) {
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				buf += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as '"' | "'";
			continue;
		}
		if (ch === ' ' || ch === '\t') {
			if (buf.length > 0) {
				out.push(buf);
				buf = '';
			}
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

function findCommandSuffixStart(command: string): number {
	let quote: '"' | "'" | null = null;
	let sawTokenChar = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				sawTokenChar = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as '"' | "'";
			sawTokenChar = true;
			continue;
		}
		if ((ch === ' ' || ch === '\t') && sawTokenChar) {
			return i;
		}
		if (ch !== ' ' && ch !== '\t') {
			sawTokenChar = true;
		}
	}
	return command.length;
}

function resolveLocalCandidate(
	binary: string,
	workingDir: string,
	platform: NodeJS.Platform = process.platform,
	isAvailable?: (binary: string) => boolean,
): LocalCommandCandidate | null {
	const candidates =
		platform === 'win32'
			? WINDOWS_LOCAL_SHIM_CANDIDATES
			: [{ suffix: '', requiresNode: true }];
	for (const candidate of candidates) {
		const executable = `${binary}${candidate.suffix}`;
		const absolute = path.join(workingDir, 'node_modules', '.bin', executable);
		if (!fs.existsSync(absolute)) continue;
		if (candidate.requiresNode && isAvailable && !isAvailable('node')) continue;
		const relative =
			platform === 'win32'
				? path.win32.join('node_modules', '.bin', executable)
				: path.posix.join('node_modules', '.bin', executable);
		return {
			absolute,
			relative,
			requiresNode: candidate.requiresNode,
		};
	}
	return null;
}

function hasAnyLocalCandidate(
	binary: string,
	workingDir: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const candidates =
		platform === 'win32'
			? WINDOWS_LOCAL_SHIM_CANDIDATES
			: [{ suffix: '', requiresNode: true }];
	for (const candidate of candidates) {
		const executable = `${binary}${candidate.suffix}`;
		if (
			fs.existsSync(path.join(workingDir, 'node_modules', '.bin', executable))
		) {
			return true;
		}
	}
	return false;
}

/** Resolve a plugin-generated command without invoking a package downloader. */
export function resolveLocalCommand(
	command: string,
	workingDir: string,
	isAvailable: (binary: string) => boolean,
	platform: NodeJS.Platform = process.platform,
): ResolvedCommand | null {
	const tokens = tokenizeCommand(command);
	if (tokens.length === 0) return null;
	const [binary, ...args] = tokens;
	if (['npx', 'bunx', 'pnpx'].includes(binary)) return null;
	if (binary.includes('/') || binary.includes('\\')) return null;
	const trimmed = command.trim();
	const local = resolveLocalCandidate(
		binary,
		workingDir,
		platform,
		isAvailable,
	);
	if (local) {
		const shellPath =
			platform === 'win32' ? local.relative : `./${local.relative}`;
		return {
			argv: [local.absolute, ...args],
			shellCommand: `${shellPath}${trimmed.slice(findCommandSuffixStart(trimmed))}`,
		};
	}
	if (hasAnyLocalCandidate(binary, workingDir, platform)) return null;
	return isAvailable(binary) ? { argv: tokens, shellCommand: command } : null;
}

export function resolveLocalNodeTool(
	tool: string,
	args: string[],
	workingDir: string,
	platform: NodeJS.Platform = process.platform,
	isAvailable?: (binary: string) => boolean,
): string[] | null {
	// A repository-local node tool is already the caller's explicit execution
	// target; do not probe the ambient PATH for `node` before returning it.
	// This preserves the local-tool contract and avoids resolution depending on
	// a concurrently changing process CWD in test hosts.
	const local = resolveLocalCandidate(tool, workingDir, platform);
	if (local) return [local.absolute, ...args];
	// FB-001: PATH fallback is allowed only for callers that already own an
	// explicit availability probe; repository-local shims still win first.
	if (hasAnyLocalCandidate(tool, workingDir, platform)) return null;
	return isAvailable?.(tool) ? [tool, ...args] : null;
}
