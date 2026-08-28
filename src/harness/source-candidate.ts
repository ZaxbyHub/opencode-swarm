import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import * as path from 'node:path';
import type { HarnessEvolutionConfig } from '../config/schema.js';
import { isPolicyProtectedPath } from '../security/protected-path-policy.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { validateTargetWithinRoot } from '../utils/path-security.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
	type HarnessCandidateFileV1,
	type HarnessCandidateManifestV1,
	parseHarnessCandidateManifest,
} from './contracts.js';
import { sha256 } from './hash.js';

const SHA_RE = /^[a-f0-9]{40,64}$/;
const RECORD_VERSION = 1 as const;
const GIT_TIMEOUT_MS = 3_000;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

export type HarnessSourceCandidateFileV1 = HarnessCandidateFileV1;
export type HarnessSourceCandidateV1 = HarnessCandidateManifestV1 & {
	/** Inert evidence only. No production API applies this patch. */
	patch?: string;
};

type ValidationFailureCode =
	| 'ALLOWLIST_EMPTY'
	| 'INVALID_BASE_SHA'
	| 'STALE_BASE'
	| 'PATCH_TOO_LARGE'
	| 'UNSUPPORTED_PATCH'
	| 'PATH_REJECTED'
	| 'PATH_NOT_ALLOWLISTED'
	| 'PROTECTED_PATH'
	| 'GIT_FAILED'
	| 'UNTRACKED_PATH'
	| 'UNSUPPORTED_TRACKED_MODE'
	| 'SYMLINK_PATH'
	| 'HARDLINK_PATH'
	| 'BINARY_FILE'
	| 'FILE_TOO_LARGE'
	| 'TOTAL_TOO_LARGE'
	| 'FILE_COUNT_EXCEEDED'
	| 'LINE_COUNT_EXCEEDED'
	| 'PATH_CHANGED_DURING_VALIDATION'
	| 'PATCH_DOES_NOT_APPLY';

export type SourceCandidateValidationResult =
	| { ok: true; candidate: HarnessSourceCandidateV1 }
	| { ok: false; code: ValidationFailureCode; reason: string };

interface GitCommandResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

interface GitBinaryCommandResult {
	ok: boolean;
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

interface ParsedHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: string[];
}

interface ParsedFilePatch {
	oldRelativePath: string | null;
	relativePath: string;
	operation: 'modify' | 'add' | 'delete' | 'rename' | 'copy' | 'mode';
	oldMode?: string;
	newMode?: string;
	oldObjectId?: string;
	newObjectId?: string;
	hunks: ParsedHunk[];
}

interface ParsedPatch {
	files: ParsedFilePatch[];
}

interface PathIdentitySnapshot {
	exists: boolean;
	isSymbolicLink?: boolean;
	isFile?: boolean;
	nlink?: number;
	size?: number;
	mtimeMs?: number;
	ctimeMs?: number;
	dev?: number | bigint;
	ino?: number | bigint;
	mode?: number;
}

function normalizeRelativePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function decodeQuotedGitPathToken(value: string): string | null {
	if (!value.startsWith('"') || !value.endsWith('"')) return null;
	let decoded = '';
	for (let index = 1; index < value.length - 1; index++) {
		const current = value[index]!;
		if (current !== '\\') {
			decoded += current;
			continue;
		}
		const next = value[index + 1];
		if (!next) return null;
		if (/[0-7]/.test(next)) {
			let octal = next;
			let cursor = index + 2;
			while (cursor < value.length - 1 && octal.length < 3) {
				const digit = value[cursor]!;
				if (!/[0-7]/.test(digit)) break;
				octal += digit;
				cursor++;
			}
			decoded += String.fromCharCode(Number.parseInt(octal, 8));
			index += octal.length;
			continue;
		}
		const escaped =
			next === 't'
				? '\t'
				: next === 'n'
					? '\n'
					: next === 'r'
						? '\r'
						: next === 'b'
							? '\b'
							: next === 'f'
								? '\f'
								: next;
		decoded += escaped;
		index++;
	}
	return decoded;
}

function parseGitPathToken(
	value: string,
	startIndex = 0,
): { token: string; nextIndex: number } | null {
	if (startIndex >= value.length) return null;
	if (value[startIndex] === '"') {
		let index = startIndex + 1;
		while (index < value.length) {
			const current = value[index]!;
			if (current === '\\') {
				index += 2;
				continue;
			}
			if (current === '"') {
				return {
					token: value.slice(startIndex, index + 1),
					nextIndex: index + 1,
				};
			}
			index++;
		}
		return null;
	}
	let index = startIndex;
	while (index < value.length && value[index] !== ' ') index++;
	return { token: value.slice(startIndex, index), nextIndex: index };
}

function parseGitPathValue(
	value: string,
	expectedPrefix?: 'a/' | 'b/',
): string | null {
	const trimmed = value.trim();
	const parsed = parseGitPathToken(trimmed);
	if (!parsed || parsed.nextIndex !== value.trim().length) return null;
	const decoded = parsed.token.startsWith('"')
		? decodeQuotedGitPathToken(parsed.token)
		: parsed.token;
	if (!decoded) return null;
	if (decoded === '/dev/null') return decoded;
	if (expectedPrefix && !decoded.startsWith(expectedPrefix)) return null;
	return normalizeRelativePath(
		expectedPrefix ? decoded.slice(expectedPrefix.length) : decoded,
	);
}

function parseGitHeaderPath(
	line: string,
	headerPrefix: '--- ' | '+++ ',
	expectedPathPrefix?: 'a/' | 'b/',
): string | null {
	if (!line.startsWith(headerPrefix)) return null;
	return parseGitPathValue(line.slice(headerPrefix.length), expectedPathPrefix);
}

function parseDiffGitLine(line: string): {
	oldPath: string;
	newPath: string;
} | null {
	const prefix = 'diff --git ';
	if (!line.startsWith(prefix)) return null;
	const body = line.slice(prefix.length);
	const oldToken = parseGitPathToken(body);
	if (!oldToken) return null;
	let cursor = oldToken.nextIndex;
	while (cursor < body.length && body[cursor] === ' ') cursor++;
	const newToken = parseGitPathToken(body, cursor);
	if (!newToken) return null;
	cursor = newToken.nextIndex;
	while (cursor < body.length && body[cursor] === ' ') cursor++;
	if (cursor !== body.length) return null;
	const oldDecoded = parseGitPathValue(oldToken.token, 'a/');
	const newDecoded = parseGitPathValue(newToken.token, 'b/');
	if (!oldDecoded || !newDecoded) return null;
	return { oldPath: oldDecoded, newPath: newDecoded };
}

function isWithinPrefix(relativePath: string, prefix: string): boolean {
	return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function isAllowlisted(
	relativePath: string,
	allowlist: readonly string[],
): boolean {
	return allowlist.some((prefix) =>
		isWithinPrefix(relativePath, normalizeRelativePath(prefix)),
	);
}

function isProtectedPath(
	relativePath: string,
	extraProtectedPaths: readonly string[],
): boolean {
	return isPolicyProtectedPath(relativePath, {
		additional: [
			'.opencode',
			'.claude',
			'.agents',
			'dist',
			'evaluation-fixtures',
			'src/services/skill-improver',
			'src/services/skill-optimizer',
			'src/evidence',
			'scripts',
			...extraProtectedPaths,
		],
	});
}

function parseCount(token: string | undefined): number {
	if (!token) return 1;
	const parsed = Number.parseInt(token, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}

function validateParsedHunk(hunk: ParsedHunk): boolean {
	if (hunk.oldCount < 0 || hunk.newCount < 0) return false;
	if (hunk.oldCount === 0 ? hunk.oldStart < 0 : hunk.oldStart < 1) return false;
	if (hunk.newCount === 0 ? hunk.newStart < 0 : hunk.newStart < 1) return false;

	let oldSeen = 0;
	let newSeen = 0;
	let previousWasContent = false;
	for (const line of hunk.lines) {
		if (line === '\\ No newline at end of file') {
			if (!previousWasContent) return false;
			previousWasContent = false;
			continue;
		}
		const marker = line[0];
		if (marker === ' ') {
			oldSeen++;
			newSeen++;
		} else if (marker === '-') {
			oldSeen++;
		} else if (marker === '+') {
			newSeen++;
		} else {
			return false;
		}
		previousWasContent = true;
	}
	return oldSeen === hunk.oldCount && newSeen === hunk.newCount;
}

function validateHunkOrdering(hunks: readonly ParsedHunk[]): boolean {
	let nextOldAnchor = 0;
	let nextNewAnchor = 0;
	for (const hunk of hunks) {
		const oldAnchor = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
		const newAnchor = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
		if (oldAnchor < nextOldAnchor || newAnchor < nextNewAnchor) return false;
		nextOldAnchor = oldAnchor + hunk.oldCount;
		nextNewAnchor = newAnchor + hunk.newCount;
	}
	return true;
}

function parsePatch(patch: string): ParsedPatch | null {
	const lines = patch.replace(/\r\n/g, '\n').split('\n');
	const files: ParsedFilePatch[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (!line) {
			index++;
			continue;
		}
		const diffLine = parseDiffGitLine(line);
		if (!diffLine) return null;
		const oldPath = diffLine.oldPath;
		const newPath = diffLine.newPath;
		index++;
		let operation: ParsedFilePatch['operation'] =
			oldPath === newPath ? 'modify' : 'rename';
		let declaredOldPath = oldPath;
		let declaredNewPath = newPath;
		let oldMode: string | undefined;
		let newMode: string | undefined;
		let oldObjectId: string | undefined;
		let newObjectId: string | undefined;

		while (index < lines.length) {
			const header = lines[index]!;
			if (!header) {
				index++;
				continue;
			}
			if (parseDiffGitLine(header)) break;
			if (header.startsWith('new file mode ')) {
				operation = 'add';
				newMode = header.slice('new file mode '.length);
				index++;
				continue;
			}
			if (header.startsWith('deleted file mode ')) {
				operation = 'delete';
				oldMode = header.slice('deleted file mode '.length);
				index++;
				continue;
			}
			if (header.startsWith('rename from ')) {
				operation = 'rename';
				const parsedPath = parseGitPathValue(
					header.slice('rename from '.length),
				);
				if (!parsedPath || parsedPath === '/dev/null') return null;
				declaredOldPath = parsedPath;
				index++;
				continue;
			}
			if (header.startsWith('rename to ')) {
				const parsedPath = parseGitPathValue(header.slice('rename to '.length));
				if (!parsedPath || parsedPath === '/dev/null') return null;
				declaredNewPath = parsedPath;
				index++;
				continue;
			}
			if (header.startsWith('copy from ')) {
				operation = 'copy';
				const parsedPath = parseGitPathValue(header.slice('copy from '.length));
				if (!parsedPath || parsedPath === '/dev/null') return null;
				declaredOldPath = parsedPath;
				index++;
				continue;
			}
			if (header.startsWith('copy to ')) {
				const parsedPath = parseGitPathValue(header.slice('copy to '.length));
				if (!parsedPath || parsedPath === '/dev/null') return null;
				declaredNewPath = parsedPath;
				index++;
				continue;
			}
			if (header.startsWith('old mode ')) {
				operation = 'mode';
				oldMode = header.slice('old mode '.length);
				index++;
				continue;
			}
			if (header.startsWith('new mode ')) {
				newMode = header.slice('new mode '.length);
				index++;
				continue;
			}
			if (
				header.startsWith('similarity index ') ||
				header.startsWith('dissimilarity index ')
			) {
				index++;
				continue;
			}
			if (header === 'GIT binary patch' || header.startsWith('Binary files ')) {
				return null;
			}
			if (header.startsWith('index ')) {
				const objectMatch =
					/^index ([a-f0-9]{7,64})\.\.([a-f0-9]{7,64})(?: [0-7]{6})?$/.exec(
						header,
					);
				if (!objectMatch) return null;
				oldObjectId = objectMatch[1];
				newObjectId = objectMatch[2];
				index++;
				continue;
			}
			const parsedOldHeader = parseGitHeaderPath(
				header,
				'--- ',
				operation === 'add' ? undefined : 'a/',
			);
			const parsedNewHeader = parseGitHeaderPath(
				String(lines[index + 1] ?? ''),
				'+++ ',
				operation === 'delete' ? undefined : 'b/',
			);
			const expectedOld = operation === 'add' ? '/dev/null' : declaredOldPath;
			const expectedNew =
				operation === 'delete' ? '/dev/null' : declaredNewPath;
			if (parsedOldHeader !== expectedOld) return null;
			if (parsedNewHeader !== expectedNew) return null;
			index += 2;
			break;
		}

		const hunks: ParsedHunk[] = [];
		while (index < lines.length) {
			const hunkHeader = lines[index]!;
			if (!hunkHeader) {
				index++;
				continue;
			}
			if (parseDiffGitLine(hunkHeader)) break;
			const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
				hunkHeader,
			);
			if (!hunkMatch) return null;
			index++;
			const hunkLines: string[] = [];
			while (index < lines.length) {
				const hunkLine = lines[index]!;
				if (hunkLine === '') {
					index++;
					continue;
				}
				if (hunkLine.startsWith('@@ -') || parseDiffGitLine(hunkLine)) {
					break;
				}
				if (
					hunkLine.startsWith(' ') ||
					hunkLine.startsWith('+') ||
					hunkLine.startsWith('-') ||
					hunkLine === '\\ No newline at end of file'
				) {
					hunkLines.push(hunkLine);
					index++;
					continue;
				}
				return null;
			}
			hunks.push({
				oldStart: Number.parseInt(hunkMatch[1]!, 10),
				oldCount: parseCount(hunkMatch[2]),
				newStart: Number.parseInt(hunkMatch[3]!, 10),
				newCount: parseCount(hunkMatch[4]),
				lines: hunkLines,
			});
			if (!validateParsedHunk(hunks[hunks.length - 1]!)) return null;
		}
		if (
			hunks.length === 0 &&
			operation !== 'mode' &&
			operation !== 'rename' &&
			operation !== 'copy'
		)
			return null;
		if (!validateHunkOrdering(hunks)) return null;
		files.push({
			oldRelativePath: operation === 'add' ? null : declaredOldPath,
			relativePath: operation === 'delete' ? declaredOldPath : declaredNewPath,
			operation,
			oldMode,
			newMode,
			oldObjectId,
			newObjectId,
			hunks,
		});
	}

	return files.length > 0 ? { files } : null;
}

function splitTextLines(text: string): {
	lines: string[];
	trailingNewline: boolean;
} {
	const normalized = text.replace(/\r\n/g, '\n');
	const trailingNewline = normalized.endsWith('\n');
	const lines = normalized.split('\n');
	if (trailingNewline) lines.pop();
	if (normalized.length === 0) lines.length = 0;
	return { lines, trailingNewline };
}

function applyFilePatch(
	baseContent: string,
	patch: ParsedFilePatch,
): string | null {
	const split = splitTextLines(baseContent);
	const source = split.lines;
	const output: string[] = [];
	let cursor = 0;
	let targetHasNoTrailingNewline = false;
	let previousMarker: string | undefined;

	for (const hunk of patch.hunks) {
		const targetIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
		const targetNewIndex =
			hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
		if (targetIndex < cursor) return null;
		while (cursor < targetIndex) {
			output.push(source[cursor]!);
			cursor++;
		}
		if (output.length !== targetNewIndex) return null;
		for (const rawLine of hunk.lines) {
			if (rawLine === '\\ No newline at end of file') {
				if (previousMarker === '+' || previousMarker === ' ') {
					targetHasNoTrailingNewline = true;
				}
				continue;
			}
			const marker = rawLine[0];
			previousMarker = marker;
			const value = rawLine.slice(1);
			if (marker === ' ') {
				if (source[cursor] !== value) return null;
				output.push(value);
				cursor++;
				continue;
			}
			if (marker === '-') {
				if (source[cursor] !== value) return null;
				cursor++;
				continue;
			}
			if (marker === '+') {
				output.push(value);
				continue;
			}
			return null;
		}
	}

	const patchTouchesOldEof = cursor === source.length;
	while (cursor < source.length) {
		output.push(source[cursor]!);
		cursor++;
	}

	const trailingNewline = patchTouchesOldEof
		? !targetHasNoTrailingNewline
		: split.trailingNewline;
	return `${output.join('\n')}${output.length > 0 && trailingNewline ? '\n' : ''}`;
}

function gitBlobObjectId(
	content: Uint8Array,
	algorithm: 'sha1' | 'sha256',
): string {
	const header = Buffer.from(`blob ${content.byteLength}\0`, 'utf8');
	return createHash(algorithm).update(header).update(content).digest('hex');
}

function matchesDeclaredObjectId(actual: string, declared: string): boolean {
	return /^0+$/.test(declared) ? false : actual.startsWith(declared);
}

function decodeTextFile(relativePath: string, buffer: Uint8Array): string {
	if (buffer.includes(0)) {
		throw new Error(`binary file rejected: ${relativePath}`);
	}
	return TEXT_DECODER.decode(buffer);
}

function parseBaseTreeEntry(output: string): {
	mode: string;
	objectId: string;
	relativePath: string;
} | null {
	const trimmed = output.split('\0').find(Boolean)?.trim();
	if (!trimmed) return null;
	const match = /^(\d{6}) blob ([a-f0-9]{40,64})\t(.+)$/.exec(trimmed);
	if (!match) return null;
	return {
		mode: match[1]!,
		objectId: match[2]!,
		relativePath: normalizeRelativePath(match[3]!),
	};
}

function fail(
	code: ValidationFailureCode,
	reason: string,
): SourceCandidateValidationResult {
	return { ok: false, code, reason };
}

function snapshotPathIdentity(absolutePath: string): PathIdentitySnapshot {
	if (!existsSync(absolutePath)) {
		return { exists: false };
	}
	const stat = _internals.lstatSync(absolutePath);
	const isSymbolicLink =
		typeof stat.isSymbolicLink === 'function' ? stat.isSymbolicLink() : false;
	const isFile = typeof stat.isFile === 'function' ? stat.isFile() : false;
	return {
		exists: true,
		isSymbolicLink,
		isFile,
		nlink: stat.nlink,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
	};
}

function samePathIdentity(
	left: PathIdentitySnapshot,
	right: PathIdentitySnapshot,
): boolean {
	if (left.exists !== right.exists) return false;
	if (!left.exists) return true;
	return (
		left.isSymbolicLink === right.isSymbolicLink &&
		left.isFile === right.isFile &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode
	);
}

export async function validateSourceCandidate(args: {
	directory: string;
	config: HarnessEvolutionConfig;
	candidateId: string;
	baseSha: string;
	origin: string;
	patch: string;
}): Promise<SourceCandidateValidationResult> {
	assertProjectRoot(args.directory);
	if (args.config.source_allowlist.length === 0) {
		return fail('ALLOWLIST_EMPTY', 'harness source allowlist is empty');
	}
	if (!SHA_RE.test(args.baseSha)) {
		return fail('INVALID_BASE_SHA', 'baseSha must be a 40-64 hex digest');
	}
	if (Buffer.byteLength(args.patch, 'utf8') > args.config.max_patch_bytes) {
		return fail(
			'PATCH_TOO_LARGE',
			`patch exceeds max_patch_bytes (${args.config.max_patch_bytes})`,
		);
	}
	const base = await _internals.runGitCommand(args.directory, [
		'rev-parse',
		'HEAD',
	]);
	if (!base.ok) {
		return fail(
			'GIT_FAILED',
			`git rev-parse failed: ${base.stderr || base.stdout}`,
		);
	}
	const currentBase = base.stdout.trim().toLowerCase();
	if (currentBase !== args.baseSha.toLowerCase()) {
		return fail(
			'STALE_BASE',
			`source candidate base ${args.baseSha} does not match current HEAD ${currentBase}`,
		);
	}

	const parsed = parsePatch(args.patch);
	if (!parsed) {
		return fail(
			'UNSUPPORTED_PATCH',
			'patch grammar is not an admitted two-way unified diff',
		);
	}
	if (parsed.files.length > args.config.max_files) {
		return fail(
			'FILE_COUNT_EXCEEDED',
			`patch touches ${parsed.files.length} files, exceeding max_files ${args.config.max_files}`,
		);
	}

	const approvedPaths: string[] = [];
	const files: HarnessSourceCandidateFileV1[] = [];
	const admittedPathSnapshots = new Map<string, PathIdentitySnapshot>();
	let totalBytes = 0;
	let totalChangedLines = 0;

	for (const filePatch of parsed.files) {
		const relativePath = normalizeRelativePath(filePatch.relativePath);
		const oldRelativePath = filePatch.oldRelativePath
			? normalizeRelativePath(filePatch.oldRelativePath)
			: null;
		for (const admittedPath of [
			...new Set([relativePath, oldRelativePath].filter(Boolean)),
		] as string[]) {
			const rejection = validateTargetWithinRoot(admittedPath, args.directory);
			if (rejection)
				return fail('PATH_REJECTED', `${admittedPath}: ${rejection}`);
			if (!isAllowlisted(admittedPath, args.config.source_allowlist)) {
				return fail(
					'PATH_NOT_ALLOWLISTED',
					`${admittedPath} is outside the harness source allowlist`,
				);
			}
			if (isProtectedPath(admittedPath, args.config.extra_protected_paths)) {
				return fail(
					'PROTECTED_PATH',
					`${admittedPath} is protected from harness source candidates`,
				);
			}
		}

		const sourcePath = oldRelativePath ?? relativePath;
		for (const admittedPath of [
			...new Set([relativePath, oldRelativePath].filter(Boolean)),
		] as string[]) {
			const absolutePath = path.resolve(args.directory, admittedPath);
			const identity = snapshotPathIdentity(absolutePath);
			admittedPathSnapshots.set(admittedPath, identity);
			if (!identity.exists) continue;
			if (identity.isSymbolicLink)
				return fail('SYMLINK_PATH', `${admittedPath} is a symlink or junction`);
			if (identity.isFile && (identity.nlink ?? 0) > 1) {
				return fail(
					'HARDLINK_PATH',
					`${admittedPath} is a hardlinked file and is not trusted for harness source candidates`,
				);
			}
		}

		const tracked = await _internals.runGitCommand(args.directory, [
			'ls-tree',
			'-z',
			args.baseSha,
			'--',
			sourcePath,
		]);
		if (!tracked.ok) {
			return fail('GIT_FAILED', `git ls-tree failed for ${sourcePath}`);
		}
		const trackedEntry = parseBaseTreeEntry(tracked.stdout);
		if (!trackedEntry && filePatch.operation !== 'add') {
			return fail('UNTRACKED_PATH', `${sourcePath} is not tracked`);
		}
		if (trackedEntry && filePatch.operation === 'add') {
			return fail(
				'UNTRACKED_PATH',
				`${relativePath} already exists in the tracked base`,
			);
		}
		if (filePatch.oldObjectId) {
			if (filePatch.operation === 'add') {
				if (!/^0+$/.test(filePatch.oldObjectId)) {
					return fail(
						'UNSUPPORTED_PATCH',
						`${relativePath} add has a non-zero old object id`,
					);
				}
			} else if (
				!trackedEntry ||
				!matchesDeclaredObjectId(trackedEntry.objectId, filePatch.oldObjectId)
			) {
				return fail(
					'STALE_BASE',
					`${sourcePath} object id does not match the declared patch base`,
				);
			}
		}
		if (
			filePatch.operation !== 'add' &&
			(!trackedEntry || trackedEntry.relativePath !== sourcePath)
		) {
			return fail(
				'UNTRACKED_PATH',
				`${sourcePath} is not an admitted tracked file`,
			);
		}
		if (relativePath !== sourcePath) {
			const targetTracked = await _internals.runGitCommand(args.directory, [
				'ls-tree',
				'-z',
				args.baseSha,
				'--',
				relativePath,
			]);
			if (!targetTracked.ok) {
				return fail('GIT_FAILED', `git ls-tree failed for ${relativePath}`);
			}
			if (parseBaseTreeEntry(targetTracked.stdout)) {
				return fail(
					'UNTRACKED_PATH',
					`${relativePath} already exists in the tracked base`,
				);
			}
		}
		const trackedMode = trackedEntry?.mode ?? filePatch.newMode ?? '100644';
		if (!['100644', '100755'].includes(trackedMode)) {
			return fail(
				'UNSUPPORTED_TRACKED_MODE',
				`${relativePath} uses unsupported tracked mode ${trackedMode}`,
			);
		}

		let beforeBuffer: Uint8Array = Buffer.alloc(0);
		if (trackedEntry) {
			const baseBlob = await _internals.runGitBinaryCommand(
				args.directory,
				['show', '--no-textconv', `${args.baseSha}:${sourcePath}`],
				args.config.max_file_bytes + 1,
			);
			if (!baseBlob.ok) {
				return fail(
					'GIT_FAILED',
					`git show failed for ${sourcePath}: ${baseBlob.stderr}`,
				);
			}
			beforeBuffer = baseBlob.stdout;
		}
		let beforeText: string;
		try {
			beforeText = decodeTextFile(relativePath, beforeBuffer);
		} catch (error) {
			return fail(
				'BINARY_FILE',
				error instanceof Error ? error.message : String(error),
			);
		}
		const patchedText =
			filePatch.hunks.length === 0
				? beforeText
				: applyFilePatch(beforeText, filePatch);
		if (patchedText === null) {
			return fail(
				'PATCH_DOES_NOT_APPLY',
				`${relativePath} did not apply cleanly`,
			);
		}
		const afterText = filePatch.operation === 'delete' ? '' : patchedText;
		if (filePatch.newObjectId) {
			if (filePatch.operation === 'delete') {
				if (!/^0+$/.test(filePatch.newObjectId)) {
					return fail(
						'UNSUPPORTED_PATCH',
						`${relativePath} delete has a non-zero new object id`,
					);
				}
			} else {
				const objectAlgorithm = args.baseSha.length === 64 ? 'sha256' : 'sha1';
				const actualObjectId = gitBlobObjectId(
					Buffer.from(afterText, 'utf8'),
					objectAlgorithm,
				);
				if (!matchesDeclaredObjectId(actualObjectId, filePatch.newObjectId)) {
					return fail(
						'PATCH_DOES_NOT_APPLY',
						`${relativePath} object id does not match reconstructed output`,
					);
				}
			}
		}
		if (
			filePatch.newMode &&
			!['100644', '100755'].includes(filePatch.newMode)
		) {
			return fail(
				'UNSUPPORTED_TRACKED_MODE',
				`${relativePath} requests unsupported mode ${filePatch.newMode}`,
			);
		}
		if (
			filePatch.oldMode &&
			trackedEntry &&
			filePatch.oldMode !== trackedMode
		) {
			return fail(
				'UNSUPPORTED_TRACKED_MODE',
				`${sourcePath} mode does not match the tracked base`,
			);
		}
		if (afterText.includes('\0')) {
			return fail(
				'BINARY_FILE',
				`${relativePath} patch produces binary output`,
			);
		}

		const bytesBefore = Buffer.byteLength(beforeText, 'utf8');
		const bytesAfter = Buffer.byteLength(afterText, 'utf8');
		if (Math.max(bytesBefore, bytesAfter) > args.config.max_file_bytes) {
			return fail(
				'FILE_TOO_LARGE',
				`${relativePath} exceeds max_file_bytes ${args.config.max_file_bytes}`,
			);
		}
		totalBytes += bytesAfter;
		if (totalBytes > args.config.max_total_bytes) {
			return fail(
				'TOTAL_TOO_LARGE',
				`patched output exceeds max_total_bytes ${args.config.max_total_bytes}`,
			);
		}

		let addedLines = 0;
		let removedLines = 0;
		for (const line of filePatch.hunks.flatMap((hunk) => hunk.lines)) {
			if (line.startsWith('+') && !line.startsWith('+++')) addedLines++;
			if (line.startsWith('-') && !line.startsWith('---')) removedLines++;
		}
		const changedLines = addedLines + removedLines;
		totalChangedLines += changedLines;
		if (totalChangedLines > args.config.max_changed_lines) {
			return fail(
				'LINE_COUNT_EXCEEDED',
				`patch exceeds max_changed_lines ${args.config.max_changed_lines}`,
			);
		}

		approvedPaths.push(relativePath);
		files.push({
			relativePath,
			...(oldRelativePath && oldRelativePath !== relativePath
				? { oldRelativePath }
				: {}),
			operation: filePatch.operation,
			trackedMode,
			...(filePatch.newMode ? { afterMode: filePatch.newMode } : {}),
			beforeSha256: sha256(beforeText),
			afterSha256: sha256(afterText),
			bytesBefore,
			bytesAfter,
			addedLines,
			removedLines,
			changedLines,
		});
	}

	for (const [admittedPath, initialIdentity] of admittedPathSnapshots) {
		const absolutePath = path.resolve(args.directory, admittedPath);
		const finalIdentity = snapshotPathIdentity(absolutePath);
		if (!samePathIdentity(initialIdentity, finalIdentity)) {
			return fail(
				'PATH_CHANGED_DURING_VALIDATION',
				`${admittedPath} changed on disk while the harness source candidate was being validated`,
			);
		}
		if (finalIdentity.exists && finalIdentity.isSymbolicLink) {
			return fail(
				'SYMLINK_PATH',
				`${admittedPath} became a symlink or junction during validation`,
			);
		}
		if (
			finalIdentity.exists &&
			finalIdentity.isFile &&
			(finalIdentity.nlink ?? 0) > 1
		) {
			return fail(
				'HARDLINK_PATH',
				`${admittedPath} became a hardlinked file during validation`,
			);
		}
	}

	const manifestBase = {
		v: RECORD_VERSION,
		candidateId: args.candidateId,
		baseSha: args.baseSha.toLowerCase(),
		origin: args.origin,
		patchSha256: sha256(args.patch),
		promptArtifactHashes: [],
		approvedPaths: [...approvedPaths].sort(),
		files,
	};
	const riskTier = deriveHarnessCandidateRiskTier(manifestBase);
	const manifestHash = computeHarnessCandidateManifestHash(manifestBase);
	const manifest = parseHarnessCandidateManifest({
		...manifestBase,
		riskTier,
		manifestHash,
	});
	return {
		ok: true,
		candidate: {
			...manifest,
			patch: args.patch,
		},
	};
}

async function runGitCommand(
	directory: string,
	args: string[],
): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const proc = spawn(resolveGitExecutable(), args, {
			cwd: directory,
			// node:child_process expresses `stdin: 'ignore'` as stdio slot 0.
			// Keep this explicit: a piped stdin can hang Git under Bun/Windows.
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: GIT_TIMEOUT_MS,
		});

		const finish = (result: GitCommandResult) => {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				// best-effort cleanup
			}
			resolve(result);
		};

		proc.stdout?.on('data', (chunk: Buffer) => {
			if (stdoutBytes >= MAX_GIT_OUTPUT_BYTES) return;
			const slice = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - stdoutBytes);
			stdout += slice.toString('utf8');
			stdoutBytes += slice.byteLength;
		});
		proc.stderr?.on('data', (chunk: Buffer) => {
			if (stderrBytes >= MAX_GIT_OUTPUT_BYTES) return;
			const slice = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - stderrBytes);
			stderr += slice.toString('utf8');
			stderrBytes += slice.byteLength;
		});
		proc.on('error', (error) => {
			finish({ ok: false, code: 1, stdout, stderr: String(error) });
		});
		proc.on('close', (code) => {
			finish({ ok: code === 0, code: code ?? 1, stdout, stderr });
		});
	});
}

async function runGitBinaryCommand(
	directory: string,
	args: string[],
	maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): Promise<GitBinaryCommandResult> {
	return new Promise((resolve) => {
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = '';
		let stderrBytes = 0;
		let settled = false;
		const proc = spawn(resolveGitExecutable(), args, {
			cwd: directory,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: GIT_TIMEOUT_MS,
		});

		const finish = (result: GitBinaryCommandResult) => {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				// best-effort cleanup
			}
			resolve(result);
		};

		proc.stdout?.on('data', (chunk: Buffer) => {
			if (stdoutBytes >= maxOutputBytes) return;
			const slice = chunk.subarray(0, maxOutputBytes - stdoutBytes);
			stdoutChunks.push(slice);
			stdoutBytes += slice.byteLength;
			if (
				slice.byteLength < chunk.byteLength ||
				stdoutBytes >= maxOutputBytes
			) {
				finish({
					ok: false,
					code: 1,
					stdout: Buffer.concat(stdoutChunks),
					stderr: `git output exceeds bound ${maxOutputBytes}`,
				});
			}
		});
		proc.stderr?.on('data', (chunk: Buffer) => {
			if (stderrBytes >= MAX_GIT_OUTPUT_BYTES) return;
			const slice = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - stderrBytes);
			stderr += slice.toString('utf8');
			stderrBytes += slice.byteLength;
		});
		proc.on('error', (error) => {
			finish({
				ok: false,
				code: 1,
				stdout: Buffer.concat(stdoutChunks),
				stderr: String(error),
			});
		});
		proc.on('close', (code) => {
			finish({
				ok: code === 0,
				code: code ?? 1,
				stdout: Buffer.concat(stdoutChunks),
				stderr,
			});
		});
	});
}

export const _internals: {
	runGitCommand: typeof runGitCommand;
	runGitBinaryCommand: typeof runGitBinaryCommand;
	lstatSync: typeof lstatSync;
} = {
	runGitCommand,
	runGitBinaryCommand,
	lstatSync,
};
