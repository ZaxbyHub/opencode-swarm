/**
 * Canonical scope construction for Stage-B reviewer receipts.
 *
 * The architect-authored reviewer prompt is not authoritative scope: it can
 * omit files that the coder actually changed. Guardrails records every
 * write-tool target in `modifiedFilesThisCoderTask`, so receipts fingerprint a
 * bounded manifest of repository HEAD, those paths, and their current byte
 * content instead. A base change therefore invalidates the receipt even when
 * the working-file bytes happen to remain identical.
 *
 * Any missing session state, unsafe path, symlink/reparse point, concurrent
 * mutation, or size overflow fails toward no receipt. A durable receipt must
 * never claim a scope the harness could not reconstruct exactly.
 */

import * as child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { peekReviewerScopeGenerationClaim, swarmState } from '../state.js';
import { resolveDelegatedPlanTaskId } from './delegation-gate.js';
import { computeScopeFingerprint } from './review-receipt.js';

const MAX_SCOPE_FILES = 256;
const DEFAULT_MAX_SCOPE_BYTES = 256 * 1024;
const MAX_SCOPE_BYTES = 2 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 5_000;
const HEAD_OUTPUT_BYTES = 256;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export const REVIEWER_TASK_SCOPE_DESCRIPTION = 'reviewer-task-files-v1';

export interface ReviewerTaskScope {
	content: string;
	description: typeof REVIEWER_TASK_SCOPE_DESCRIPTION;
	files: string[];
	headSha: string;
	taskId?: string;
	coderCallID?: string;
	generation?: number;
	sessionIncarnation?: string;
}

export interface ReviewerTaskScopeProvenance {
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
}

export interface ResolveReviewerTaskScopeOptions {
	/** Consume the completed coder's one-shot scope instead of the live list. */
	consumeHandoff?: boolean;
	/** Exact task expected by the returning reviewer/background record. */
	expectedTaskId?: string;
	/** Exact reviewer Task call that claimed the generation. */
	reviewerCallID?: string;
	/** Injectable clock used only for deterministic expiry tests. */
	now?: number;
}

/**
 * Resolve the exact known plan task carried by reviewer/coder Task arguments.
 *
 * This deliberately reuses delegation-gate's canonical extractor so lifecycle
 * identity cannot drift from scope authorization. It checks all supported Task
 * text fields, prefers an unambiguous TASK line, rejects ambiguity, and filters
 * numeric-dot tokens against the current plan.
 */
export async function resolveReviewerScopeTaskId(
	directory: string,
	args: unknown,
): Promise<string | null> {
	if (!args || typeof args !== 'object') return null;
	const record = args as Record<string, unknown>;
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (!plan) return null;
		const knownPlanTaskIds = new Set<string>();
		for (const phase of plan.phases) {
			for (const task of phase.tasks) knownPlanTaskIds.add(task.id);
		}
		if (knownPlanTaskIds.size === 0) return null;
		return resolveDelegatedPlanTaskId(record, knownPlanTaskIds);
	} catch {
		return null;
	}
}

/**
 * Test-only dependency-injection seam. Keeping the spawn binding local avoids
 * process-global `mock.module()` pollution while allowing tests to prove that
 * the production call really creates a child with ignored stdin.
 */
export const _internals: {
	spawn: typeof child_process.spawn;
	realpath: typeof fs.promises.realpath;
	lstatBigInt: (path: fs.PathLike) => Promise<fs.BigIntStats>;
	open: typeof fs.promises.open;
	fileHandleStatBigInt: (
		handle: fs.promises.FileHandle,
	) => Promise<fs.BigIntStats>;
} = {
	spawn: child_process.spawn,
	realpath: fs.promises.realpath,
	lstatBigInt: (path) => fs.promises.lstat(path, { bigint: true }),
	open: fs.promises.open,
	fileHandleStatBigInt: (handle) => handle.stat({ bigint: true }),
};

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function canonicalPath(relativePath: string): string {
	return relativePath.split(path.sep).join('/');
}

function pathKey(relativePath: string): string {
	return process.platform === 'win32'
		? relativePath.toLowerCase()
		: relativePath;
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

async function missingPathParentIsContained(
	root: string,
	absolutePath: string,
): Promise<boolean> {
	let current = path.dirname(absolutePath);
	for (;;) {
		try {
			const canonical = await _internals.realpath(current);
			return samePath(root, canonical) || isContained(root, canonical);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
		}
		const parent = path.dirname(current);
		if (samePath(parent, current)) return false;
		current = parent;
	}
}

async function readBoundedHandle(
	handle: fs.promises.FileHandle,
	maxBytes: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			buffer.byteLength - offset,
			offset,
		);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

async function resolveHeadSha(directory: string): Promise<string | null> {
	let child: child_process.ChildProcess | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		child = _internals.spawn('git', ['rev-parse', '--verify', 'HEAD'], {
			cwd: directory,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: HEAD_TIMEOUT_MS,
			windowsHide: true,
		});

		return await new Promise<string | null>((resolve) => {
			let settled = false;
			let stdoutBytes = 0;
			const stdoutChunks: Buffer[] = [];
			const finish = (value: string | null): void => {
				if (settled) return;
				settled = true;
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				resolve(value);
			};
			const killAndFail = (): void => {
				try {
					child?.kill();
				} catch {
					// Best-effort cleanup; the child may already have exited.
				}
				finish(null);
			};

			timeoutHandle = setTimeout(killAndFail, HEAD_TIMEOUT_MS);
			timeoutHandle.unref?.();
			child?.once('error', killAndFail);
			child?.stdout?.on('data', (chunk: Buffer | string) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += bytes.byteLength;
				if (stdoutBytes > HEAD_OUTPUT_BYTES) {
					killAndFail();
					return;
				}
				stdoutChunks.push(bytes);
			});
			child?.once('close', (exitCode) => {
				if (exitCode !== 0 || stdoutBytes > HEAD_OUTPUT_BYTES) {
					finish(null);
					return;
				}
				const sha = Buffer.concat(stdoutChunks).toString('utf-8').trim();
				finish(HEAD_SHA_PATTERN.test(sha) ? sha : null);
			});
		});
	} catch {
		return null;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		try {
			child?.kill();
		} catch {
			// Best-effort cleanup; the child may already have exited.
		}
	}
}

/**
 * Build the exact scope fingerprint input for a guardrails-observed file list.
 */
export async function buildReviewerTaskScope(
	directory: string,
	modifiedFiles: readonly string[],
	maxBytes = DEFAULT_MAX_SCOPE_BYTES,
	provenance?: ReviewerTaskScopeProvenance,
): Promise<ReviewerTaskScope | null> {
	if (
		modifiedFiles.length === 0 ||
		modifiedFiles.length > MAX_SCOPE_FILES ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > MAX_SCOPE_BYTES
	) {
		return null;
	}

	let lexicalRoot: string;
	let realRoot: string;
	try {
		lexicalRoot = path.resolve(directory);
		realRoot = await _internals.realpath(lexicalRoot);
	} catch {
		return null;
	}
	const headSha = await resolveHeadSha(realRoot);
	if (!headSha) return null;

	const candidates = new Map<
		string,
		{ absolutePath: string; relativePath: string }
	>();
	for (const rawPath of modifiedFiles) {
		if (
			typeof rawPath !== 'string' ||
			rawPath.length === 0 ||
			hasControlCharacter(rawPath)
		) {
			return null;
		}
		const absolutePath = path.resolve(lexicalRoot, rawPath);
		if (!isContained(lexicalRoot, absolutePath)) return null;
		const relativePath = canonicalPath(
			path.relative(lexicalRoot, absolutePath),
		);
		if (relativePath.length === 0 || relativePath.startsWith('-')) return null;
		candidates.set(pathKey(relativePath), { absolutePath, relativePath });
	}

	const ordered = [...candidates.values()].sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath, 'en'),
	);
	if (ordered.length === 0) return null;

	let totalBytes = 0;
	const stableFiles: Array<{
		absolutePath: string;
		canonicalPath: string;
		stat: fs.BigIntStats;
	}> = [];
	const deletedPaths: string[] = [];
	const records: string[] = [
		'opencode-swarm-reviewer-task-scope-v1',
		JSON.stringify({ head: headSha }),
	];
	if (provenance) {
		records.push(
			JSON.stringify({
				task_id: provenance.taskId,
				coder_call_id: provenance.coderCallID,
				generation: provenance.generation,
				session_incarnation: provenance.sessionIncarnation,
			}),
		);
	}
	for (const candidate of ordered) {
		let before: fs.BigIntStats;
		try {
			before = await _internals.lstatBigInt(candidate.absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				if (
					!(await missingPathParentIsContained(
						realRoot,
						candidate.absolutePath,
					))
				) {
					return null;
				}
				deletedPaths.push(candidate.absolutePath);
				records.push(
					JSON.stringify({
						path: candidate.relativePath,
						state: 'deleted',
					}),
				);
				continue;
			}
			return null;
		}

		if (!before.isFile() || before.isSymbolicLink()) return null;
		let realCandidate: string;
		try {
			realCandidate = await _internals.realpath(candidate.absolutePath);
		} catch {
			return null;
		}
		if (!isContained(realRoot, realCandidate)) return null;
		if (before.size > BigInt(maxBytes - totalBytes)) return null;

		let handle: fs.promises.FileHandle | undefined;
		let bytes: Buffer;
		let openedBefore: fs.BigIntStats;
		try {
			handle = await _internals.open(realCandidate, 'r');
			openedBefore = await _internals.fileHandleStatBigInt(handle);
			const canonicalAfterOpen = await _internals.realpath(
				candidate.absolutePath,
			);
			if (
				!openedBefore.isFile() ||
				!sameFileSnapshot(before, openedBefore) ||
				!samePath(realCandidate, canonicalAfterOpen) ||
				!isContained(realRoot, canonicalAfterOpen)
			) {
				return null;
			}
			bytes = await readBoundedHandle(handle, maxBytes - totalBytes);
			const openedAfter = await _internals.fileHandleStatBigInt(handle);
			const canonicalAfterRead = await _internals.realpath(
				candidate.absolutePath,
			);
			if (
				!sameFileSnapshot(openedBefore, openedAfter) ||
				!samePath(realCandidate, canonicalAfterRead) ||
				!isContained(realRoot, canonicalAfterRead) ||
				BigInt(bytes.byteLength) !== openedBefore.size
			) {
				return null;
			}
		} catch {
			return null;
		} finally {
			await handle?.close().catch(() => {});
		}
		totalBytes += bytes.byteLength;
		stableFiles.push({
			absolutePath: candidate.absolutePath,
			canonicalPath: realCandidate,
			stat: openedBefore,
		});
		records.push(
			JSON.stringify({
				path: candidate.relativePath,
				state: 'file',
				bytes: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex'),
			}),
		);
	}

	for (const stable of stableFiles) {
		try {
			const current = await _internals.lstatBigInt(stable.absolutePath);
			const canonical = await _internals.realpath(stable.absolutePath);
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				!sameFileSnapshot(stable.stat, current) ||
				!samePath(stable.canonicalPath, canonical) ||
				!isContained(realRoot, canonical)
			) {
				return null;
			}
		} catch {
			return null;
		}
	}
	for (const deletedPath of deletedPaths) {
		try {
			await _internals.lstatBigInt(deletedPath);
			return null;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== 'ENOENT' ||
				!(await missingPathParentIsContained(realRoot, deletedPath))
			) {
				return null;
			}
		}
	}
	const finalHeadSha = await resolveHeadSha(realRoot);
	if (finalHeadSha !== headSha) return null;

	return {
		content: `${records.join('\n')}\n`,
		description: REVIEWER_TASK_SCOPE_DESCRIPTION,
		files: ordered.map((candidate) => candidate.relativePath),
		headSha,
		...(provenance
			? {
					taskId: provenance.taskId,
					coderCallID: provenance.coderCallID,
					generation: provenance.generation,
					sessionIncarnation: provenance.sessionIncarnation,
				}
			: {}),
	};
}

/**
 * Resolve scope only from the architect session's guardrails-owned task state.
 * Receipt collection consumes the completed coder handoff exactly once; direct
 * callers retain the legacy live-list view for diagnostics and drift probes.
 */
export async function resolveReviewerTaskScope(
	directory: string,
	sessionID: string,
	maxBytes = DEFAULT_MAX_SCOPE_BYTES,
	options: ResolveReviewerTaskScopeOptions = {},
): Promise<ReviewerTaskScope | null> {
	const session = swarmState.agentSessions.get(sessionID);
	if (!session) return null;
	if (options.consumeHandoff) {
		const expectedTaskId = options.expectedTaskId;
		const reviewerCallID = options.reviewerCallID;
		if (!expectedTaskId || !reviewerCallID) return null;
		const handoff = peekReviewerScopeGenerationClaim({
			parentSessionID: sessionID,
			taskId: expectedTaskId,
			reviewerCallID,
			now: options.now,
		});
		if (!handoff) return null;
		const snapshot = handoff.reviewerDispatchScope;
		if (!snapshot) return null;
		const current = await buildReviewerTaskScope(
			directory,
			handoff.modifiedFiles,
			maxBytes,
			{
				taskId: handoff.taskId,
				coderCallID: handoff.coderCallID,
				generation: handoff.generation,
				sessionIncarnation: handoff.sessionIncarnation,
			},
		);
		if (
			!current ||
			computeScopeFingerprint(current.content, current.description).hash !==
				snapshot.hash ||
			current.description !== snapshot.description ||
			current.headSha !== snapshot.headSha ||
			JSON.stringify(current.files) !== JSON.stringify(snapshot.files)
		) {
			return null;
		}
		return current;
	}
	return buildReviewerTaskScope(
		directory,
		session.modifiedFilesThisCoderTask,
		maxBytes,
	);
}
