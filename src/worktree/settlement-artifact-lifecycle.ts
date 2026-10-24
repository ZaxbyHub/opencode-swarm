import { lstat, opendir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import type { CoderSettlementWal } from '../workflow/workflow-wal-schema.js';

const MAX_INVENTORY_ENTRIES = 200;
const LIFECYCLE_TARGET = 'locks/coder-settlement-artifacts';

export class SettlementArtifactLifecycleError extends Error {
	constructor(
		readonly code:
			| 'CODER_SETTLEMENT_ARTIFACT_PROTECTED'
			| 'CODER_SETTLEMENT_ARTIFACT_UNCERTAIN',
		detail: string,
	) {
		super(`${code}: ${detail}`);
		this.name = 'SettlementArtifactLifecycleError';
	}
}

export function isSettlementArtifactLifecycleError(
	error: unknown,
): error is SettlementArtifactLifecycleError {
	return error instanceof SettlementArtifactLifecycleError;
}

async function readWal(filePath: string, taskId: string) {
	// The WAL schema also references merge types/constants. Defer that import
	// until admission so merge cleanup can import this helper without a cycle.
	const { readWorkflowWalFile } = await import(
		'../workflow/workflow-wal-file.js'
	);
	return readWorkflowWalFile('coder-settlement', filePath, taskId);
}

async function canonicalizeArtifact(filePath: string): Promise<string> {
	if (!path.isAbsolute(filePath))
		throw uncertain('artifact path is not absolute');
	let candidate = path.resolve(filePath);
	const missing: string[] = [];
	// Missing lane directories still have physical parents. Resolve those rather
	// than treating an inaccessible path or an alias as an unrelated artifact.
	for (let depth = 0; depth < 256; depth++) {
		try {
			const physical = await _internals.realpath(candidate);
			const resolved = path.join(physical, ...missing.reverse());
			return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== 'ENOENT' &&
				(error as NodeJS.ErrnoException).code !== 'ENOTDIR'
			)
				throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw error;
			missing.push(path.basename(candidate));
			candidate = parent;
		}
	}
	throw uncertain('artifact ancestry exceeds the identity bound');
}

export const _internals = {
	tryAcquireLock,
	opendir,
	lstat,
	realpath,
	readWal,
	canonicalize: canonicalizeArtifact,
	assertProjectRoot,
};

function uncertain(detail: string): SettlementArtifactLifecycleError {
	return new SettlementArtifactLifecycleError(
		'CODER_SETTLEMENT_ARTIFACT_UNCERTAIN',
		detail,
	);
}

/**
 * Serialize isolated dispatch publication against destructive lane admission.
 * Lock order is task/evidence -> lifecycle. The callback must never acquire a
 * task/evidence lock or recursively enter this non-reentrant lifecycle lock.
 */
export async function withSettlementArtifactLifecycle<T>(
	directory: string,
	operation: () => Promise<T>,
): Promise<T> {
	let root: string;
	let admission: Awaited<ReturnType<typeof tryAcquireLock>>;
	try {
		_internals.assertProjectRoot(directory);
		root = await _internals.realpath(directory);
		validateSwarmPath(root, LIFECYCLE_TARGET);
		admission = await _internals.tryAcquireLock(
			root,
			LIFECYCLE_TARGET,
			'coder-settlement-artifact-lifecycle',
			'coder-settlement-artifact-lifecycle',
		);
	} catch (error) {
		throw uncertain(
			`cannot acquire lifecycle admission (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!admission.acquired) throw uncertain('lifecycle admission is busy');
	try {
		return await operation();
	} finally {
		await admission.lock._release?.();
	}
}

export interface SettlementArtifactTarget {
	path?: string;
	branch?: string;
}

async function matchesPendingWal(
	wal: CoderSettlementWal,
	target: SettlementArtifactTarget,
	targetPath: string | undefined,
): Promise<boolean> {
	if (wal.state !== 'DISPATCHED' && wal.state !== 'PREPARED') return false;
	if (
		target.branch &&
		(wal.worktree?.branchName === target.branch ||
			wal.mergeProvenance?.branchName === target.branch)
	)
		return true;
	return Boolean(
		targetPath &&
			wal.worktree &&
			(await _internals.canonicalize(wal.worktree.worktreePath)) === targetPath,
	);
}

/**
 * Fail closed on an incomplete inventory. Call only while holding lifecycle
 * admission, and retain that admission until the actual destructive operation
 * finishes; an advisory scan alone cannot authorize a later deletion.
 */
export async function assertSettlementArtifactsRemovable(
	directory: string,
	target: SettlementArtifactTarget,
): Promise<void> {
	if (!target.path && !target.branch)
		throw uncertain('missing artifact identity');
	let handle: Awaited<ReturnType<typeof opendir>> | undefined;
	let failure: unknown;
	try {
		const inventoryPath = validateSwarmPath(directory, 'coder-settlements');
		try {
			const stat = await _internals.lstat(inventoryPath);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw uncertain('settlement inventory is not a direct directory');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		const targetPath = target.path
			? await _internals.canonicalize(target.path)
			: undefined;
		handle = await _internals.opendir(inventoryPath);
		let count = 0;
		while (true) {
			const entry = await handle.read();
			if (!entry) break;
			if (++count > MAX_INVENTORY_ENTRIES)
				throw uncertain('settlement inventory exceeds 200 entries');
			if (entry.isSymbolicLink())
				throw uncertain('settlement inventory contains a symbolic entry');
			if (!entry.name.endsWith('.json')) continue;
			const filePath = path.join(inventoryPath, entry.name);
			const stat = await _internals.lstat(filePath);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw uncertain('settlement record is not a direct regular file');
			const wal = await _internals.readWal(filePath, entry.name.slice(0, -5));
			if (!wal)
				throw uncertain('settlement record disappeared during inventory');
			if (await matchesPendingWal(wal, target, targetPath)) {
				throw new SettlementArtifactLifecycleError(
					'CODER_SETTLEMENT_ARTIFACT_PROTECTED',
					`task ${wal.taskId} has a ${wal.state} settlement; preserve its lane artifacts`,
				);
			}
		}
	} catch (error) {
		failure = isSettlementArtifactLifecycleError(error)
			? error
			: uncertain(
					`cannot verify settlement inventory (${error instanceof Error ? error.message : String(error)})`,
				);
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				failure ??= uncertain('cannot close settlement inventory');
			}
		}
	}
	if (failure) throw failure;
}
