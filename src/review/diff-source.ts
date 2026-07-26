/**
 * Canonical, bounded Git diff collection for review-model consumers.
 *
 * This module is intentionally independent from hooks and command dispatch so
 * automatic review, phase review, Lean review, and `/swarm review` can bind to
 * one identical scope. Every Git child is array-spawned with an explicit cwd,
 * ignored stdin, bounded streams, a timeout, and best-effort cleanup.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type BunCompatSpawnOptions,
	type BunCompatStream,
	bunSpawn,
} from '../utils/bun-compat.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const METADATA_OUTPUT_LIMIT = 256 * 1024;
const STDERR_OUTPUT_LIMIT = 64 * 1024;
const MAX_REF_LENGTH = 200;
const SHA_PATTERN = /^[0-9a-f]{6,64}$/i;

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export interface InclusiveLineRange {
	start: number;
	end: number;
}

export type ReviewDiffSelector =
	| { kind: 'default' }
	| { kind: 'base'; ref: string }
	| {
			kind: 'range';
			from: string;
			to: string;
			operator: '..' | '...';
	  }
	| { kind: 'working-tree' };

export type ReviewDiffSelectorParseResult =
	| { ok: true; selector: ReviewDiffSelector; json: boolean }
	| {
			ok: false;
			code: 'INVALID_ARGUMENT' | 'INVALID_REF' | 'AMBIGUOUS_SELECTOR';
			reason: string;
	  };

export type ReviewDiffSkipCode =
	| 'UNSAFE_PATH'
	| 'PATH_OUTSIDE_ROOT'
	| 'MISSING_FILE'
	| 'SYMLINK_OR_REPARSE'
	| 'NON_REGULAR_FILE'
	| 'BINARY_FILE'
	| 'UNREADABLE_FILE'
	| 'UNTRACKED_FILE_TRUNCATED'
	| 'TOTAL_SCOPE_TRUNCATED'
	| 'UNPARSEABLE_DIFF_PATH'
	| 'TRACKED_BINARY'
	| 'CONCURRENT_PATH_MUTATION'
	| 'FILE_LIST_FALLBACK_TRUNCATED'
	| 'FILE_LIST_FALLBACK_INCOMPLETE'
	| 'FILE_LIST_FALLBACK_UNAVAILABLE';

export interface ReviewDiffSkipReason {
	code: ReviewDiffSkipCode;
	path?: string;
	detail: string;
}

export interface ReviewDiffCompleteness {
	complete: boolean;
	truncated: boolean;
	skipReasons: ReviewDiffSkipReason[];
	fileListFallback?: {
		files: string[];
		complete: boolean;
		truncated: boolean;
	};
}

export interface ReviewDiffFileScope {
	kind: 'added' | 'modified' | 'deleted' | 'renamed';
	oldPath?: string;
	newPath?: string;
}

export interface ParsedUnifiedDiffScope {
	changedLines: Map<string, InclusiveLineRange[]>;
	deletedLines: Map<string, InclusiveLineRange[]>;
	files: Map<string, ReviewDiffFileScope>;
	warnings: ReviewDiffSkipReason[];
}

export interface ReviewDiffStalenessMetadata {
	collectedAt: string;
	headSha: string;
	selectorKey: string;
	includesWorkingTree: boolean;
	scopeHash: string;
}

interface ReviewDiffScopeFields {
	selector: ReviewDiffSelector;
	canonicalText: string;
	reviewTextBytes: number;
	scopeHash: string;
	headSha: string;
	baseRef?: string;
	baseSha?: string;
	mergeBase?: string;
	rangeToSha?: string;
	changedLines: Map<string, InclusiveLineRange[]>;
	deletedLines: Map<string, InclusiveLineRange[]>;
	files: Map<string, ReviewDiffFileScope>;
	completeness: ReviewDiffCompleteness;
	staleness: ReviewDiffStalenessMetadata;
}

export type ReviewDiffResult =
	| ({ status: 'ok' } & ReviewDiffScopeFields)
	| ({ status: 'clean' } & ReviewDiffScopeFields)
	| {
			status: 'error';
			code:
				| 'INVALID_DIRECTORY'
				| 'NOT_REPOSITORY_ROOT'
				| 'HEAD_UNAVAILABLE'
				| 'BASE_UNAVAILABLE'
				| 'MERGE_BASE_UNAVAILABLE'
				| 'GIT_FAILED'
				| 'GIT_TIMEOUT'
				| 'GIT_OUTPUT_LIMIT';
			reason: string;
	  };

export interface CollectReviewDiffOptions {
	directory: string;
	selector?: ReviewDiffSelector;
	timeoutMs?: number;
	maxBytes?: number;
	maxUntrackedFileBytes?: number;
}

function isSafeRef(ref: string): boolean {
	return (
		ref.length > 0 &&
		ref.length <= MAX_REF_LENGTH &&
		!ref.startsWith('-') &&
		/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(ref) &&
		!ref.includes('..') &&
		!ref.includes('//') &&
		!ref.includes('@{') &&
		ref !== '@' &&
		!ref.endsWith('.') &&
		!ref.endsWith('/') &&
		!ref.endsWith('.lock')
	);
}

/**
 * Parse `/swarm review` argv. Exactly one selector is accepted; `--json` is
 * orthogonal and may appear before or after it.
 */
export function parseReviewDiffSelector(
	argv: readonly string[],
): ReviewDiffSelectorParseResult {
	let selector: ReviewDiffSelector | undefined;
	let json = false;
	const setSelector = (
		next: ReviewDiffSelector,
	): ReviewDiffSelectorParseResult | undefined => {
		if (selector) {
			return {
				ok: false,
				code: 'AMBIGUOUS_SELECTOR',
				reason: 'review accepts exactly one diff selector',
			};
		}
		selector = next;
		return undefined;
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--json') {
			json = true;
			continue;
		}
		if (arg === '--working-tree') {
			const error = setSelector({ kind: 'working-tree' });
			if (error) return error;
			continue;
		}
		if (arg === '--base') {
			const ref = argv[++index];
			if (ref === undefined) {
				return {
					ok: false,
					code: 'INVALID_ARGUMENT',
					reason: '--base requires one ref',
				};
			}
			if (!isSafeRef(ref)) {
				return {
					ok: false,
					code: 'INVALID_REF',
					reason: `unsafe or malformed Git ref: ${ref}`,
				};
			}
			const error = setSelector({ kind: 'base', ref });
			if (error) return error;
			continue;
		}
		if (arg === '--range') {
			const range = argv[++index];
			if (range === undefined) {
				return {
					ok: false,
					code: 'INVALID_ARGUMENT',
					reason: '--range requires from..to or from...to',
				};
			}
			const match = /^(.+?)(\.\.\.?)(.+)$/.exec(range);
			if (
				!match ||
				(match[2] !== '..' && match[2] !== '...') ||
				!isSafeRef(match[1]) ||
				!isSafeRef(match[3])
			) {
				return {
					ok: false,
					code: 'INVALID_REF',
					reason: `unsafe or malformed Git range: ${range}`,
				};
			}
			const error = setSelector({
				kind: 'range',
				from: match[1],
				to: match[3],
				operator: match[2],
			});
			if (error) return error;
			continue;
		}
		return {
			ok: false,
			code: 'INVALID_ARGUMENT',
			reason: `unknown review argument: ${arg}`,
		};
	}

	return { ok: true, selector: selector ?? { kind: 'default' }, json };
}

function normalizeRelativePath(raw: string): string | null {
	if (
		raw.length === 0 ||
		hasControlCharacter(raw) ||
		raw.startsWith('/') ||
		raw.startsWith('\\\\') ||
		/^[A-Za-z]:[\\/]/.test(raw)
	) {
		return null;
	}
	const slashPath = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
	const normalized = path.posix.normalize(slashPath);
	if (
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.startsWith('/') ||
		hasControlCharacter(normalized)
	) {
		return null;
	}
	return normalized;
}

function diffHeaderPath(raw: string, prefix: 'a/' | 'b/'): string | null {
	const trimmed = raw.trimEnd();
	if (trimmed === '/dev/null') return null;
	if (trimmed.startsWith('"')) return null;
	const withoutPrefix = trimmed.startsWith(prefix)
		? trimmed.slice(prefix.length)
		: trimmed;
	return normalizeRelativePath(withoutPrefix);
}

function addLine(
	map: Map<string, InclusiveLineRange[]>,
	file: string,
	line: number,
): void {
	if (!Number.isSafeInteger(line) || line < 1) return;
	const ranges = map.get(file) ?? [];
	const previous = ranges.at(-1);
	if (previous && previous.end + 1 === line) {
		previous.end = line;
	} else if (!previous || line > previous.end) {
		ranges.push({ start: line, end: line });
	}
	map.set(file, ranges);
}

/**
 * Parse actual +/- lines, rather than trusting hunk counts. A line is eligible
 * for anchoring only when its content was present in the exact text sent to the
 * reviewer; a line-boundary-truncated hunk therefore cannot overclaim scope.
 */
export function parseUnifiedDiffScope(text: string): ParsedUnifiedDiffScope {
	const changedLines = new Map<string, InclusiveLineRange[]>();
	const deletedLines = new Map<string, InclusiveLineRange[]>();
	const files = new Map<string, ReviewDiffFileScope>();
	const warnings: ReviewDiffSkipReason[] = [];
	let oldPath: string | undefined;
	let newPath: string | undefined;
	let renameFrom: string | undefined;
	let renameTo: string | undefined;
	let oldLine: number | undefined;
	let newLine: number | undefined;

	const registerFile = (): void => {
		const key = newPath ?? oldPath;
		if (!key) return;
		const kind =
			renameFrom || renameTo || (oldPath && newPath && oldPath !== newPath)
				? 'renamed'
				: !oldPath
					? 'added'
					: !newPath
						? 'deleted'
						: 'modified';
		files.set(key, { kind, oldPath, newPath });
	};

	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			registerFile();
			oldPath = undefined;
			newPath = undefined;
			renameFrom = undefined;
			renameTo = undefined;
			oldLine = undefined;
			newLine = undefined;
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number.parseInt(hunk[1], 10);
			newLine = Number.parseInt(hunk[2], 10);
			continue;
		}
		if (oldLine !== undefined && newLine !== undefined) {
			if (line.startsWith('+')) {
				if (newPath) addLine(changedLines, newPath, newLine);
				newLine++;
				continue;
			}
			if (line.startsWith('-')) {
				if (oldPath) addLine(deletedLines, oldPath, oldLine);
				oldLine++;
				continue;
			}
			if (line.startsWith(' ')) {
				oldLine++;
				newLine++;
				continue;
			}
			if (line.startsWith('\\')) continue;
			oldLine = undefined;
			newLine = undefined;
		}
		if (line.startsWith('rename from ')) {
			renameFrom =
				normalizeRelativePath(line.slice('rename from '.length)) ?? undefined;
			oldPath = renameFrom;
			continue;
		}
		if (line.startsWith('rename to ')) {
			renameTo =
				normalizeRelativePath(line.slice('rename to '.length)) ?? undefined;
			newPath = renameTo;
			registerFile();
			continue;
		}
		if (line.startsWith('--- ')) {
			const raw = line.slice(4);
			oldPath =
				raw.trimEnd() === '/dev/null'
					? undefined
					: (diffHeaderPath(raw, 'a/') ?? undefined);
			if (raw.trimEnd() !== '/dev/null' && !oldPath) {
				warnings.push({
					code: 'UNPARSEABLE_DIFF_PATH',
					detail: `unparseable old-side diff path: ${raw}`,
				});
			}
			continue;
		}
		if (line.startsWith('+++ ')) {
			const raw = line.slice(4);
			newPath =
				raw.trimEnd() === '/dev/null'
					? undefined
					: (diffHeaderPath(raw, 'b/') ?? undefined);
			if (raw.trimEnd() !== '/dev/null' && !newPath) {
				warnings.push({
					code: 'UNPARSEABLE_DIFF_PATH',
					detail: `unparseable new-side diff path: ${raw}`,
				});
			}
			registerFile();
		}
	}
	registerFile();
	return { changedLines, deletedLines, files, warnings };
}

interface BoundedRead {
	text: string;
	truncated: boolean;
}

async function readBoundedStream(
	stream: BunCompatStream,
	maxBytes: number,
	onLimit: () => void,
): Promise<BoundedRead> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total += Math.max(remaining, 0);
				truncated = true;
				onLimit();
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(combined), truncated };
}

type GitResult =
	| { ok: true; stdout: string; truncated: boolean }
	| {
			ok: false;
			code: 'GIT_FAILED' | 'GIT_TIMEOUT' | 'GIT_OUTPUT_LIMIT';
			reason: string;
	  };

async function runGit(
	directory: string,
	args: string[],
	options: {
		timeoutMs: number;
		maxStdoutBytes: number;
		allowTruncate?: boolean;
	},
): Promise<GitResult> {
	const spawnOptions: BunCompatSpawnOptions = {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: options.timeoutMs,
	};
	let proc: ReturnType<typeof bunSpawn>;
	try {
		proc = _internals.bunSpawn(
			['git', '-c', 'core.quotepath=false', ...args],
			spawnOptions,
		);
	} catch (error) {
		return {
			ok: false,
			code: 'GIT_FAILED',
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let limited = false;
	const kill = (): void => {
		limited = true;
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	};
	try {
		const operation = Promise.all([
			proc.exited,
			readBoundedStream(proc.stdout, options.maxStdoutBytes, kill),
			readBoundedStream(proc.stderr, STDERR_OUTPUT_LIMIT, kill),
		]);
		const [exitCode, stdout, stderr] = await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(
					() => reject(new Error('REVIEW_DIFF_GIT_TIMEOUT')),
					options.timeoutMs,
				);
			}),
		]);
		if (stdout.truncated && !options.allowTruncate) {
			return {
				ok: false,
				code: 'GIT_OUTPUT_LIMIT',
				reason: `Git stdout exceeded ${options.maxStdoutBytes} bytes`,
			};
		}
		if (stderr.truncated) {
			return {
				ok: false,
				code: 'GIT_OUTPUT_LIMIT',
				reason: `Git stderr exceeded ${STDERR_OUTPUT_LIMIT} bytes`,
			};
		}
		if (exitCode !== 0 && !(stdout.truncated && options.allowTruncate)) {
			return {
				ok: false,
				code: 'GIT_FAILED',
				reason: stderr.text.trim() || `Git exited with code ${exitCode}`,
			};
		}
		return { ok: true, stdout: stdout.text, truncated: stdout.truncated };
	} catch (error) {
		if (error instanceof Error && error.message === 'REVIEW_DIFF_GIT_TIMEOUT') {
			return {
				ok: false,
				code: 'GIT_TIMEOUT',
				reason: `Git exceeded ${options.timeoutMs}ms`,
			};
		}
		return {
			ok: false,
			code: limited ? 'GIT_OUTPUT_LIMIT' : 'GIT_FAILED',
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup; the child may already have exited.
		}
	}
}

function samePath(left: string, right: string): boolean {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === 'win32'
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

function sameFileIdentity(
	left: fs.BigIntStats,
	right: fs.BigIntStats,
): boolean {
	return (
		(left.dev !== 0n || left.ino !== 0n) &&
		(right.dev !== 0n || right.ino !== 0n) &&
		left.dev === right.dev &&
		left.ino === right.ino
	);
}

function sameCanonicalDirectory(left: string, right: string): boolean {
	if (samePath(left, right)) return true;
	try {
		const leftStat = _internals.lstatBigIntSync(left);
		const rightStat = _internals.lstatBigIntSync(right);
		return (
			leftStat.isDirectory() &&
			rightStat.isDirectory() &&
			!leftStat.isSymbolicLink() &&
			!rightStat.isSymbolicLink() &&
			(leftStat.dev !== 0n || leftStat.ino !== 0n) &&
			sameFileIdentity(leftStat, rightStat)
		);
	} catch {
		return false;
	}
}

function sameFileSnapshot(
	left: fs.BigIntStats,
	right: fs.BigIntStats,
): boolean {
	return (
		sameFileIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== '..' &&
		!path.isAbsolute(relative)
	);
}

function selectorKey(selector: ReviewDiffSelector): string {
	switch (selector.kind) {
		case 'default':
			return 'default';
		case 'base':
			return `base:${selector.ref}`;
		case 'range':
			return `range:${selector.from}${selector.operator}${selector.to}`;
		case 'working-tree':
			return 'working-tree';
	}
}

function boundedPositiveInteger(
	value: number | undefined,
	fallback: number,
	maximum: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function truncateAtLineBoundary(text: string, maxBytes: number): string {
	const marker = '\n... [review diff truncated: max_bytes]\n';
	const markerBytes = Buffer.byteLength(marker);
	if (maxBytes <= markerBytes) return marker.slice(0, maxBytes);
	const source = Buffer.from(text, 'utf8');
	if (source.byteLength <= maxBytes) return text;
	let prefix = source.subarray(0, maxBytes - markerBytes).toString('utf8');
	const lastNewline = prefix.lastIndexOf('\n');
	if (lastNewline >= 0) prefix = prefix.slice(0, lastNewline + 1);
	return `${prefix}${marker}`;
}

function parseBoundedNulPathList(
	text: string,
	truncated: boolean,
): {
	files: string[];
	complete: boolean;
} {
	const rawEntries = text.split('\0');
	if (rawEntries.at(-1) === '') rawEntries.pop();
	if (truncated && !text.endsWith('\0')) rawEntries.pop();
	const files = new Set<string>();
	let complete = !truncated;
	for (const rawEntry of rawEntries) {
		const normalized = normalizeRelativePath(rawEntry);
		if (!normalized) {
			complete = false;
			continue;
		}
		files.add(normalized);
	}
	return {
		files: [...files].sort((left, right) => left.localeCompare(right)),
		complete,
	};
}

function syntheticUntrackedDiff(
	file: string,
	content: string,
	contentWasTruncated: boolean,
): string {
	const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.length === 0 ? [] : normalized.split('\n');
	if (lines.at(-1) === '') lines.pop();
	const body = lines.map((line) => `+${line}`).join('\n');
	return [
		`diff --git a/${file} b/${file}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${file}`,
		`@@ -0,0 +1,${lines.length} @@`,
		body,
		contentWasTruncated ? '... [untracked file truncated]' : '',
		'',
	]
		.filter((line, index, all) => line.length > 0 || index === all.length - 1)
		.join('\n');
}

function readSafeUntracked(
	root: string,
	rawPath: string,
	maxFileBytes: number,
): { text?: string; truncated: boolean; skip?: ReviewDiffSkipReason } {
	const normalized = normalizeRelativePath(rawPath);
	if (!normalized) {
		return {
			truncated: false,
			skip: {
				code: 'UNSAFE_PATH',
				path: rawPath,
				detail: 'untracked path is absolute, traversing, or contains controls',
			},
		};
	}
	const candidate = path.resolve(root, ...normalized.split('/'));
	if (!isContained(root, candidate)) {
		return {
			truncated: false,
			skip: {
				code: 'PATH_OUTSIDE_ROOT',
				path: normalized,
				detail: 'untracked path resolves outside the project root',
			},
		};
	}
	let handle: number | undefined;
	try {
		const pathStat = _internals.lstatBigIntSync(candidate);
		if (pathStat.isSymbolicLink()) {
			return {
				truncated: false,
				skip: {
					code: 'SYMLINK_OR_REPARSE',
					path: normalized,
					detail: 'symlink, junction, or reparse-point content is not reviewed',
				},
			};
		}
		if (!pathStat.isFile()) {
			return {
				truncated: false,
				skip: {
					code: 'NON_REGULAR_FILE',
					path: normalized,
					detail: 'untracked path is not a regular file',
				},
			};
		}
		const canonicalBeforeOpen = _internals.realpathSync(candidate);
		if (!isContained(root, canonicalBeforeOpen)) {
			return {
				truncated: false,
				skip: {
					code: 'PATH_OUTSIDE_ROOT',
					path: normalized,
					detail: 'canonical untracked path escapes the project root',
				},
			};
		}
		handle = _internals.openSync(canonicalBeforeOpen, 'r');
		const openedBeforeRead = _internals.fstatBigIntSync(handle);
		const canonicalAfterOpen = _internals.realpathSync(candidate);
		if (
			!openedBeforeRead.isFile() ||
			!sameFileSnapshot(pathStat, openedBeforeRead) ||
			!samePath(canonicalBeforeOpen, canonicalAfterOpen) ||
			!isContained(root, canonicalAfterOpen)
		) {
			return {
				truncated: false,
				skip: {
					code: 'CONCURRENT_PATH_MUTATION',
					path: normalized,
					detail:
						'untracked path identity or containment changed while it was opened',
				},
			};
		}
		const requested = Math.max(1, maxFileBytes + 1);
		const bytes = Buffer.alloc(requested);
		let count = 0;
		while (count < requested) {
			const read = _internals.readSync(
				handle,
				bytes,
				count,
				requested - count,
				count,
			);
			if (read === 0) break;
			count += read;
		}
		const openedAfterRead = _internals.fstatBigIntSync(handle);
		const canonicalAfterRead = _internals.realpathSync(candidate);
		if (
			!sameFileSnapshot(openedBeforeRead, openedAfterRead) ||
			!samePath(canonicalBeforeOpen, canonicalAfterRead) ||
			!isContained(root, canonicalAfterRead) ||
			(openedBeforeRead.size <= BigInt(maxFileBytes) &&
				BigInt(count) !== openedBeforeRead.size)
		) {
			return {
				truncated: false,
				skip: {
					code: 'CONCURRENT_PATH_MUTATION',
					path: normalized,
					detail:
						'untracked path identity, metadata, or containment changed while it was read',
				},
			};
		}
		const bounded = bytes.subarray(0, Math.min(count, maxFileBytes));
		if (bounded.includes(0)) {
			return {
				truncated: false,
				skip: {
					code: 'BINARY_FILE',
					path: normalized,
					detail: 'untracked file contains NUL bytes',
				},
			};
		}
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bounded);
		} catch {
			return {
				truncated: false,
				skip: {
					code: 'BINARY_FILE',
					path: normalized,
					detail: 'untracked file is not valid UTF-8 text',
				},
			};
		}
		return {
			text,
			truncated:
				openedBeforeRead.size > BigInt(maxFileBytes) || count > maxFileBytes,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		return {
			truncated: false,
			skip: {
				code: code === 'ENOENT' ? 'MISSING_FILE' : 'UNREADABLE_FILE',
				path: normalized,
				detail: error instanceof Error ? error.message : String(error),
			},
		};
	} finally {
		if (handle !== undefined) {
			try {
				_internals.closeSync(handle);
			} catch {
				// Best-effort file descriptor cleanup.
			}
		}
	}
}

async function resolveCommit(
	root: string,
	ref: string,
	timeoutMs: number,
): Promise<string | null> {
	const result = await runGit(
		root,
		['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
		{ timeoutMs, maxStdoutBytes: METADATA_OUTPUT_LIMIT },
	);
	const sha = result.ok ? result.stdout.trim() : '';
	return SHA_PATTERN.test(sha) ? sha : null;
}

async function resolveDefaultBase(
	root: string,
	timeoutMs: number,
): Promise<{ ref: string; sha: string } | null> {
	const symbolic = await runGit(
		root,
		['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
		{ timeoutMs, maxStdoutBytes: METADATA_OUTPUT_LIMIT },
	);
	const candidates = [
		symbolic.ok ? symbolic.stdout.trim() : '',
		'origin/main',
		'origin/master',
		'main',
		'master',
	].filter(
		(candidate, index, all) => candidate && all.indexOf(candidate) === index,
	);
	for (const ref of candidates) {
		if (!isSafeRef(ref)) continue;
		const sha = await resolveCommit(root, ref, timeoutMs);
		if (sha) return { ref, sha };
	}
	return null;
}

function errorFromGit(
	result: Exclude<GitResult, { ok: true }>,
): ReviewDiffResult {
	return { status: 'error', code: result.code, reason: result.reason };
}

/**
 * Collect one canonical review scope. Default/base scopes are merge-base
 * through the current tracked working tree plus safe untracked text. Exact
 * ranges are committed-only. Working-tree scopes compare HEAD to tracked and
 * safe untracked content.
 */
export async function collectReviewDiff(
	options: CollectReviewDiffOptions,
): Promise<ReviewDiffResult> {
	const selector = options.selector ?? { kind: 'default' };
	const timeoutMs = boundedPositiveInteger(
		options.timeoutMs,
		DEFAULT_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
	);
	const maxBytes = boundedPositiveInteger(
		options.maxBytes,
		DEFAULT_MAX_BYTES,
		MAX_REVIEW_BYTES,
	);
	const maxUntrackedFileBytes = boundedPositiveInteger(
		options.maxUntrackedFileBytes,
		DEFAULT_MAX_UNTRACKED_FILE_BYTES,
		MAX_UNTRACKED_FILE_BYTES,
	);
	let root: string;
	try {
		root = _internals.realpathSync(options.directory);
	} catch (error) {
		return {
			status: 'error',
			code: 'INVALID_DIRECTORY',
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	const topLevel = await runGit(root, ['rev-parse', '--show-toplevel'], {
		timeoutMs,
		maxStdoutBytes: METADATA_OUTPUT_LIMIT,
	});
	if (!topLevel.ok) {
		if (topLevel.code === 'GIT_TIMEOUT') return errorFromGit(topLevel);
		return {
			status: 'error',
			code: 'NOT_REPOSITORY_ROOT',
			reason: topLevel.reason,
		};
	}
	let gitRoot: string;
	try {
		gitRoot = _internals.realpathSync(topLevel.stdout.trim());
	} catch {
		return {
			status: 'error',
			code: 'NOT_REPOSITORY_ROOT',
			reason: 'Git top-level path is not a readable directory',
		};
	}
	if (!sameCanonicalDirectory(root, gitRoot)) {
		return {
			status: 'error',
			code: 'NOT_REPOSITORY_ROOT',
			reason: 'directory must be the canonical Git project root',
		};
	}

	const headResult = await runGit(
		root,
		['rev-parse', '--verify', 'HEAD^{commit}'],
		{ timeoutMs, maxStdoutBytes: METADATA_OUTPUT_LIMIT },
	);
	const headSha = headResult.ok ? headResult.stdout.trim() : '';
	if (!headResult.ok || !SHA_PATTERN.test(headSha)) {
		if (!headResult.ok && headResult.code === 'GIT_TIMEOUT')
			return errorFromGit(headResult);
		return {
			status: 'error',
			code: 'HEAD_UNAVAILABLE',
			reason: headResult.ok
				? 'HEAD did not resolve to a commit'
				: headResult.reason,
		};
	}

	let baseRef: string | undefined;
	let baseSha: string | undefined;
	let mergeBase: string | undefined;
	let rangeToSha: string | undefined;
	let revision: string;
	const includesWorkingTree = selector.kind !== 'range';
	if (selector.kind === 'default' || selector.kind === 'base') {
		const base =
			selector.kind === 'base'
				? {
						ref: selector.ref,
						sha: await resolveCommit(root, selector.ref, timeoutMs),
					}
				: await resolveDefaultBase(root, timeoutMs);
		if (!base || !base.sha) {
			return {
				status: 'error',
				code: 'BASE_UNAVAILABLE',
				reason: `unable to resolve ${selector.kind === 'base' ? selector.ref : 'a default branch'}`,
			};
		}
		baseRef = base.ref;
		baseSha = base.sha;
		const merge = await runGit(root, ['merge-base', '--', base.sha, headSha], {
			timeoutMs,
			maxStdoutBytes: METADATA_OUTPUT_LIMIT,
		});
		mergeBase = merge.ok ? merge.stdout.trim() : undefined;
		if (!merge.ok || !mergeBase || !SHA_PATTERN.test(mergeBase)) {
			if (!merge.ok && merge.code === 'GIT_TIMEOUT') return errorFromGit(merge);
			return {
				status: 'error',
				code: 'MERGE_BASE_UNAVAILABLE',
				reason: merge.ok ? 'merge-base was empty or malformed' : merge.reason,
			};
		}
		revision = mergeBase;
	} else if (selector.kind === 'range') {
		baseRef = selector.from;
		baseSha =
			(await resolveCommit(root, selector.from, timeoutMs)) ?? undefined;
		const toSha = await resolveCommit(root, selector.to, timeoutMs);
		if (!baseSha || !toSha) {
			return {
				status: 'error',
				code: 'BASE_UNAVAILABLE',
				reason: 'one or both exact-range refs could not be resolved',
			};
		}
		rangeToSha = toSha;
		const merge = await runGit(root, ['merge-base', '--', baseSha, toSha], {
			timeoutMs,
			maxStdoutBytes: METADATA_OUTPUT_LIMIT,
		});
		mergeBase = merge.ok ? merge.stdout.trim() : undefined;
		if (!merge.ok || !mergeBase || !SHA_PATTERN.test(mergeBase)) {
			if (!merge.ok && merge.code === 'GIT_TIMEOUT') return errorFromGit(merge);
			return {
				status: 'error',
				code: 'MERGE_BASE_UNAVAILABLE',
				reason: merge.ok ? 'range merge-base was malformed' : merge.reason,
			};
		}
		revision = `${baseSha}${selector.operator}${toSha}`;
	} else {
		revision = 'HEAD';
	}

	const diff = await runGit(
		root,
		[
			'diff',
			'--no-ext-diff',
			'--no-color',
			'--find-renames',
			'--unified=3',
			revision,
			'--',
		],
		{
			timeoutMs,
			maxStdoutBytes: maxBytes + 1,
			allowTruncate: true,
		},
	);
	if (!diff.ok) return errorFromGit(diff);

	const skipReasons: ReviewDiffSkipReason[] = [];
	let canonicalText = diff.stdout;
	let truncated =
		diff.truncated || Buffer.byteLength(canonicalText, 'utf8') > maxBytes;
	if (truncated) {
		canonicalText = truncateAtLineBoundary(canonicalText, maxBytes);
		skipReasons.push({
			code: 'TOTAL_SCOPE_TRUNCATED',
			detail: `tracked diff exceeded the ${maxBytes}-byte review cap`,
		});
	}
	if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(canonicalText)) {
		skipReasons.push({
			code: 'TRACKED_BINARY',
			detail: 'tracked binary changes have no reviewable line anchors',
		});
	}

	let untrackedCount = 0;
	let untrackedPaths: string[] = [];
	if (includesWorkingTree) {
		const untracked = await runGit(
			root,
			['ls-files', '--others', '--exclude-standard', '-z'],
			{ timeoutMs, maxStdoutBytes: METADATA_OUTPUT_LIMIT },
		);
		if (!untracked.ok) return errorFromGit(untracked);
		const paths = untracked.stdout
			.split('\0')
			.filter((item) => item.length > 0);
		untrackedPaths = paths;
		untrackedCount = paths.length;
		if (!truncated) {
			let totalScopeFull = false;
			for (const rawPath of paths) {
				const read = readSafeUntracked(root, rawPath, maxUntrackedFileBytes);
				if (read.skip) {
					skipReasons.push(read.skip);
					continue;
				}
				const normalized = normalizeRelativePath(rawPath);
				if (!normalized || read.text === undefined) continue;
				if (read.truncated) {
					skipReasons.push({
						code: 'UNTRACKED_FILE_TRUNCATED',
						path: normalized,
						detail: `untracked file exceeded ${maxUntrackedFileBytes} bytes`,
					});
				}
				if (totalScopeFull) continue;
				const synthetic = syntheticUntrackedDiff(
					normalized,
					read.text,
					read.truncated,
				);
				const separator = canonicalText.length > 0 ? '\n' : '';
				const candidate = `${canonicalText}${separator}${synthetic}`;
				if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
					canonicalText = truncateAtLineBoundary(candidate, maxBytes);
					truncated = true;
					skipReasons.push({
						code: 'TOTAL_SCOPE_TRUNCATED',
						path: normalized,
						detail: `review scope exceeded the ${maxBytes}-byte total cap`,
					});
					totalScopeFull = true;
					continue;
				}
				canonicalText = candidate;
			}
		}
	}

	let fileListFallback: ReviewDiffCompleteness['fileListFallback'];
	if (truncated) {
		const trackedFiles = await runGit(
			root,
			[
				'diff',
				'--no-ext-diff',
				'--no-color',
				'--find-renames',
				'--name-only',
				'-z',
				revision,
				'--',
			],
			{
				timeoutMs,
				maxStdoutBytes: METADATA_OUTPUT_LIMIT,
				allowTruncate: true,
			},
		);
		const normalizedUntracked = parseBoundedNulPathList(
			`${untrackedPaths.join('\0')}${untrackedPaths.length > 0 ? '\0' : ''}`,
			false,
		);
		if (trackedFiles.ok) {
			const normalizedTracked = parseBoundedNulPathList(
				trackedFiles.stdout,
				trackedFiles.truncated,
			);
			const files = [
				...new Set([...normalizedTracked.files, ...normalizedUntracked.files]),
			].sort((left, right) => left.localeCompare(right));
			const complete =
				normalizedTracked.complete && normalizedUntracked.complete;
			fileListFallback = {
				files,
				complete,
				truncated: trackedFiles.truncated,
			};
			if (!complete) {
				skipReasons.push({
					code: trackedFiles.truncated
						? 'FILE_LIST_FALLBACK_TRUNCATED'
						: 'FILE_LIST_FALLBACK_INCOMPLETE',
					detail: trackedFiles.truncated
						? `changed-file fallback exceeded ${METADATA_OUTPUT_LIMIT} bytes`
						: 'changed-file fallback omitted one or more unsafe paths',
				});
			}
		} else {
			fileListFallback = {
				files: normalizedUntracked.files,
				complete: false,
				truncated: false,
			};
			skipReasons.push({
				code: 'FILE_LIST_FALLBACK_UNAVAILABLE',
				detail: `changed-file fallback unavailable: ${trackedFiles.reason}`,
			});
		}
	}

	const parsed = parseUnifiedDiffScope(canonicalText);
	skipReasons.push(...parsed.warnings);
	const reviewTextBytes = Buffer.byteLength(canonicalText, 'utf8');
	const hashPayload = JSON.stringify({
		selector,
		baseRef: baseRef ?? null,
		baseSha: baseSha ?? null,
		mergeBase: mergeBase ?? null,
		rangeToSha: rangeToSha ?? null,
		headSha,
		canonicalText,
		fileListFallback: fileListFallback ?? null,
	});
	const scopeHash = createHash('sha256')
		.update(hashPayload, 'utf8')
		.digest('hex');
	const completeness: ReviewDiffCompleteness = {
		complete: skipReasons.length === 0 && !truncated,
		truncated,
		skipReasons,
		fileListFallback,
	};
	const staleness: ReviewDiffStalenessMetadata = {
		collectedAt: new Date().toISOString(),
		headSha,
		selectorKey: selectorKey(selector),
		includesWorkingTree,
		scopeHash,
	};
	const scope: ReviewDiffScopeFields = {
		selector,
		canonicalText,
		reviewTextBytes,
		scopeHash,
		headSha,
		baseRef,
		baseSha,
		mergeBase,
		rangeToSha,
		changedLines: parsed.changedLines,
		deletedLines: parsed.deletedLines,
		files: parsed.files,
		completeness,
		staleness,
	};
	const clean =
		canonicalText.trim().length === 0 &&
		untrackedCount === 0 &&
		skipReasons.length === 0;
	return { status: clean ? 'clean' : 'ok', ...scope };
}

/**
 * File-scoped injection seam. Production reads through this object at each
 * call site so tests can replace one boundary without process-global mocks.
 */
export const _internals: {
	bunSpawn: typeof bunSpawn;
	realpathSync: typeof fs.realpathSync;
	lstatBigIntSync: (path: fs.PathLike) => fs.BigIntStats;
	openSync: typeof fs.openSync;
	fstatBigIntSync: (fd: number) => fs.BigIntStats;
	readSync: typeof fs.readSync;
	closeSync: typeof fs.closeSync;
} = {
	bunSpawn,
	realpathSync: fs.realpathSync,
	lstatBigIntSync: (path) => fs.lstatSync(path, { bigint: true }),
	openSync: fs.openSync,
	fstatBigIntSync: (fd) => fs.fstatSync(fd, { bigint: true }),
	readSync: fs.readSync,
	closeSync: fs.closeSync,
};
