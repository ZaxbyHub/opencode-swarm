import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import * as path from 'node:path';
import { assertProjectRoot } from '../utils/project-boundary.js';
import { validateSwarmPath } from './utils.js';

export const RECEIPT_SCHEMA_VERSION = 2;
export const RECEIPT_CUTOVER_VERSION = 1;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 500;
// One elapsed deadline covers stale-owner inspection, bounded Linux zombie
// probes, and retry waits. Individual probes cannot multiply the lock budget.
const UNINITIALIZED_LOCK_STALE_MS = 30_000;
const PROC_STATE_READ_TIMEOUT_MS = 25;

export interface ReceiptLedgerPaths {
	root: string;
	swarmDir: string;
	journal: string;
	snapshot: string;
	archive: string;
	quarantine: string;
	lockTarget: string;
	legacyEvents: string;
	legacyBaseline: string;
	linkPointer: string;
}

export type ReceiptStoreErrorCode =
	| 'lock_timeout'
	| 'store_unavailable'
	| 'store_corrupt';

export class ReceiptStoreError extends Error {
	constructor(
		readonly code: ReceiptStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ReceiptStoreError';
	}
}

export function resolveReceiptLedgerPaths(
	directory: string,
): ReceiptLedgerPaths {
	assertProjectRoot(directory, undefined, 'knowledge receipt state');
	let root: string;
	try {
		root = fs.realpathSync(directory);
	} catch {
		throw new ReceiptStoreError(
			'store_unavailable',
			'cannot canonicalize project root',
		);
	}
	return {
		root,
		swarmDir: path.join(root, '.swarm'),
		journal: validateSwarmPath(root, 'knowledge-receipts-v2.jsonl'),
		snapshot: validateSwarmPath(root, 'knowledge-receipts-v2.snapshot.json'),
		archive: validateSwarmPath(root, 'knowledge-receipts-v2-archive.jsonl'),
		quarantine: validateSwarmPath(
			root,
			'knowledge-receipts-v2-quarantine.json',
		),
		lockTarget: validateSwarmPath(root, 'knowledge-receipts-v2.lock'),
		legacyEvents: validateSwarmPath(root, 'knowledge-events.jsonl'),
		legacyBaseline: validateSwarmPath(root, 'knowledge-counter-baseline.json'),
		linkPointer: validateSwarmPath(root, 'link.json'),
	};
}

function validateExistingRegularFile(filePath: string): void {
	if (!fs.existsSync(filePath)) return;
	const info = fs.lstatSync(filePath);
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new ReceiptStoreError(
			'store_unavailable',
			`receipt artifact is not a regular file: ${path.basename(filePath)}`,
		);
	}
}

async function preparePaths(paths: ReceiptLedgerPaths): Promise<void> {
	await mkdir(paths.swarmDir, { recursive: true });
	const swarmInfo = fs.lstatSync(paths.swarmDir);
	if (swarmInfo.isSymbolicLink() || !swarmInfo.isDirectory()) {
		throw new ReceiptStoreError(
			'store_unavailable',
			'.swarm is not a real project-local directory',
		);
	}
	if (
		fs.realpathSync(path.dirname(paths.journal)) !==
		fs.realpathSync(paths.swarmDir)
	) {
		throw new ReceiptStoreError(
			'store_unavailable',
			'receipt artifact parent escaped the project .swarm directory',
		);
	}
	for (const artifact of [
		paths.journal,
		paths.snapshot,
		paths.archive,
		paths.quarantine,
		paths.lockTarget,
	]) {
		validateExistingRegularFile(artifact);
	}
}

interface LockOwner {
	owner_token: string;
	pid: number;
	created_at_ms: number;
	root_identity: string;
}

interface FileIdentity {
	dev: number;
	ino: number;
}

function samePath(left: string, right: string): boolean {
	const normalize = (value: string) =>
		process.platform === 'win32'
			? path.resolve(value).toLowerCase()
			: path.resolve(value);
	return normalize(left) === normalize(right);
}

interface MutationParentDependencies {
	lstat: typeof lstat;
	realpath: typeof realpath;
}

async function validateMutationParent(
	filePath: string,
	dependencies: MutationParentDependencies = { lstat, realpath },
): Promise<string> {
	const parent = path.dirname(path.resolve(filePath));
	const info = await dependencies.lstat(parent);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new ReceiptStoreError(
			'store_unavailable',
			'receipt artifact parent is not a real directory',
		);
	}
	const canonical = await dependencies.realpath(parent);
	const canonicalInfo = await dependencies.lstat(canonical);
	if (
		canonicalInfo.isSymbolicLink() ||
		!canonicalInfo.isDirectory() ||
		(!samePath(canonical, parent) &&
			!sameIdentity(
				{ dev: info.dev, ino: info.ino },
				{ dev: canonicalInfo.dev, ino: canonicalInfo.ino },
			))
	) {
		throw new ReceiptStoreError(
			'store_unavailable',
			'receipt artifact parent identity changed before mutation',
		);
	}
	return canonical;
}

async function existingFileIdentity(
	filePath: string,
): Promise<FileIdentity | null> {
	try {
		const info = await lstat(filePath);
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new ReceiptStoreError(
				'store_unavailable',
				`receipt artifact is not a regular file: ${path.basename(filePath)}`,
			);
		}
		return { dev: info.dev, ino: info.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function sameIdentity(
	left: FileIdentity | null,
	right: FileIdentity | null,
): boolean {
	return (
		left !== null &&
		right !== null &&
		left.dev === right.dev &&
		left.ino === right.ino
	);
}

async function syncParentDirectory(parent: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(parent, 'r');
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Windows does not support opening a directory as a FileHandle. The rename
		// is still atomic there; POSIX platforms must durably sync the directory.
		if (
			process.platform !== 'win32' ||
			(code !== 'EISDIR' && code !== 'EPERM' && code !== 'EACCES')
		) {
			throw error;
		}
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function writeAll(
	handle: Awaited<ReturnType<typeof open>>,
	content: string,
): Promise<void> {
	const bytes = Buffer.from(content, 'utf8');
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			bytes.length - offset,
			null,
		);
		if (bytesWritten <= 0) throw new Error('receipt write made no progress');
		offset += bytesWritten;
	}
}

async function readLinuxProcStat(
	pid: number,
	signal: AbortSignal,
): Promise<string> {
	return await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
}

async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		_internals.killProcess(pid);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
	if (_internals.platform() !== 'linux') return true;

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const procRead = _internals
			.readLinuxProcStat(pid, controller.signal)
			.catch(() => null);
		const timedOut = new Promise<null>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(null);
			}, _internals.procStateReadTimeoutMs);
		});
		const statLine = await Promise.race([procRead, timedOut]);
		if (statLine === null) return true;
		// /proc/<pid>/stat is `pid (comm) state ...`; comm may contain spaces or
		// parentheses, so parse the state after the final closing parenthesis.
		const commandEnd = statLine.lastIndexOf(')');
		if (commandEnd < 0) return true;
		const state = statLine
			.slice(commandEnd + 1)
			.trimStart()
			.charAt(0);
		return state !== 'Z';
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function readLockOwner(
	lockPath: string,
	expectedRoot?: string,
): Promise<LockOwner | null> {
	try {
		validateExistingRegularFile(lockPath);
		const parsed = JSON.parse(
			await readFile(lockPath, 'utf8'),
		) as Partial<LockOwner>;
		if (
			typeof parsed.owner_token !== 'string' ||
			!parsed.owner_token ||
			!Number.isInteger(parsed.pid) ||
			(parsed.pid ?? 0) <= 0 ||
			!Number.isFinite(parsed.created_at_ms) ||
			typeof parsed.root_identity !== 'string' ||
			!parsed.root_identity ||
			(expectedRoot !== undefined &&
				!samePath(parsed.root_identity, expectedRoot))
		) {
			return null;
		}
		return parsed as LockOwner;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

async function recoverLockIfSafe(paths: ReceiptLedgerPaths): Promise<void> {
	const lockPath = paths.lockTarget;
	const expectedRoot = paths.root;
	const recoveryOwner: LockOwner = {
		owner_token: randomUUID(),
		pid: process.pid,
		created_at_ms: Date.now(),
		root_identity: expectedRoot,
	};
	const parent = await validateMutationParent(lockPath);
	let claimedPath: string | undefined;
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	const owner = await readLockOwner(lockPath, expectedRoot);
	if (owner && (await _internals.isProcessAlive(owner.pid))) return;
	if (!owner && Date.now() - info.mtimeMs < UNINITIALIZED_LOCK_STALE_MS) return;

	// Rename is the recovery CAS: it atomically claims the exact inode we
	// inspected. We only ever delete the claimed path, never lockPath, so a
	// successor created after the rename cannot be removed by this recovery.
	claimedPath = `${lockPath}.${recoveryOwner.owner_token}.recovering`;
	try {
		await _internals.rename(lockPath, claimedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	await _internals.afterRecoveryRename(paths, claimedPath);

	const claimedInfo = await stat(claimedPath);
	const claimedOwner = await readLockOwner(claimedPath, expectedRoot);
	const sameObservedOwner = owner
		? claimedOwner?.owner_token === owner.owner_token
		: claimedOwner === null;
	const stillRecoverable = owner
		? sameObservedOwner && !(await _internals.isProcessAlive(owner.pid))
		: sameObservedOwner &&
			Date.now() - claimedInfo.mtimeMs >= UNINITIALIZED_LOCK_STALE_MS;
	if (stillRecoverable) {
		await _internals.rm(claimedPath, { force: true });
		claimedPath = undefined;
		await syncParentDirectory(parent);
		return;
	}

	if (!fs.existsSync(lockPath)) {
		await _internals.rename(claimedPath, lockPath);
		claimedPath = undefined;
		await syncParentDirectory(parent);
		return;
	}
	throw new ReceiptStoreError(
		'store_unavailable',
		'receipt recovery claim changed while a successor lock exists',
	);
}

async function acquireReceiptLock(
	paths: ReceiptLedgerPaths,
): Promise<() => Promise<void>> {
	const lockPath = paths.lockTarget;
	const owner: LockOwner = {
		owner_token: randomUUID(),
		pid: process.pid,
		created_at_ms: Date.now(),
		root_identity: paths.root,
	};
	// Use a monotonic clock for the elapsed contention budget. Receipt tests and
	// callers may freeze wall-clock time for deterministic lifecycle timestamps;
	// that must never disable the correctness-lock timeout.
	const deadline = performance.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const parent = await validateMutationParent(lockPath);
			handle = await open(lockPath, 'wx');
			await writeAll(handle, `${JSON.stringify(owner)}\n`);
			await handle.sync();
			const info = await handle.stat();
			if (!info.isFile()) throw new Error('receipt lock is not a regular file');
			await handle.close();
			handle = undefined;
			validateExistingRegularFile(lockPath);
			await syncParentDirectory(parent);
			return async () => {
				const current = await readLockOwner(lockPath, paths.root);
				if (current?.owner_token === owner.owner_token) {
					await rm(lockPath, { force: true });
					await syncParentDirectory(parent);
				}
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			await _internals.recoverLockIfSafe(paths);
			const remainingMs = deadline - performance.now();
			if (remainingMs <= 0) break;
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(LOCK_RETRY_MS, remainingMs)),
			);
		}
	}
	throw new ReceiptStoreError(
		'lock_timeout',
		'receipt correctness lock unavailable before bounded timeout',
	);
}

export async function withReceiptLedgerLock<T>(
	directory: string,
	action: (paths: ReceiptLedgerPaths) => Promise<T>,
): Promise<T> {
	const paths = resolveReceiptLedgerPaths(directory);
	try {
		await preparePaths(paths);
		const release = await acquireReceiptLock(paths);
		try {
			// Revalidate after lock acquisition to close the validation/mutation gap.
			resolveReceiptLedgerPaths(paths.root);
			await preparePaths(paths);
			return await action(paths);
		} finally {
			await release().catch(() => undefined);
		}
	} catch (error) {
		if (error instanceof ReceiptStoreError) throw error;
		throw new ReceiptStoreError(
			'store_unavailable',
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function receiptRecordHash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function readUtf8IfPresent(
	filePath: string,
	maxBytes = 32 * 1024 * 1024,
): Promise<string | null> {
	const bytes = await readBytesIfPresent(filePath, maxBytes);
	return bytes === null ? null : bytes.toString('utf8');
}

/** Read an authoritative receipt artifact without lossy text decoding. */
export async function readBytesIfPresent(
	filePath: string,
	maxBytes = 32 * 1024 * 1024,
): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		validateExistingRegularFile(filePath);
		const before = await stat(filePath);
		if (before.size > maxBytes) {
			throw new ReceiptStoreError(
				'store_corrupt',
				`receipt artifact exceeds ${maxBytes} bytes: ${path.basename(filePath)}`,
			);
		}
		handle = await open(filePath, 'r');
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.size !== before.size
		) {
			throw new ReceiptStoreError(
				'store_unavailable',
				`receipt artifact changed while opening: ${path.basename(filePath)}`,
			);
		}
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs
		) {
			throw new ReceiptStoreError(
				'store_unavailable',
				`receipt artifact changed while reading: ${path.basename(filePath)}`,
			);
		}
		if (bytes.byteLength > maxBytes) {
			throw new ReceiptStoreError(
				'store_corrupt',
				`receipt artifact exceeds ${maxBytes} bytes: ${path.basename(filePath)}`,
			);
		}
		return bytes;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function appendFsynced(
	filePath: string,
	line: string,
): Promise<void> {
	const parent = await validateMutationParent(filePath);
	const before = await existingFileIdentity(filePath);
	const handle = await open(filePath, 'a');
	try {
		const opened = await handle.stat();
		if (!opened.isFile())
			throw new Error('receipt journal is not a regular file');
		if (before && (opened.dev !== before.dev || opened.ino !== before.ino)) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt journal identity changed before append',
			);
		}
		await writeAll(handle, line);
		await handle.sync();
		const after = await existingFileIdentity(filePath);
		if (
			!after ||
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			!samePath(await realpath(path.dirname(filePath)), parent)
		) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt journal identity changed during append',
			);
		}
	} finally {
		await handle.close();
	}
	if (!before) await syncParentDirectory(parent);
}

async function renameWithRetry(
	tempPath: string,
	targetPath: string,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			await rename(tempPath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EEXIST')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
		}
	}
	throw lastError;
}

export async function atomicWriteFsynced(
	targetPath: string,
	content: string,
): Promise<void> {
	const parent = await validateMutationParent(targetPath);
	await existingFileIdentity(targetPath);
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tempPath, 'wx');
	let tempIdentity: FileIdentity;
	try {
		await writeAll(handle, content);
		await handle.sync();
		const info = await handle.stat();
		if (!info.isFile()) throw new Error('receipt temp is not a regular file');
		tempIdentity = { dev: info.dev, ino: info.ino };
	} finally {
		await handle.close();
	}
	try {
		const onDiskTemp = await existingFileIdentity(tempPath);
		if (!sameIdentity(onDiskTemp, tempIdentity!)) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt temp identity changed before rename',
			);
		}
		if (!samePath(await realpath(path.dirname(targetPath)), parent)) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt artifact parent identity changed before rename',
			);
		}
		await existingFileIdentity(targetPath);
		await renameWithRetry(tempPath, targetPath);
		const targetIdentity = await existingFileIdentity(targetPath);
		if (!sameIdentity(targetIdentity, tempIdentity!)) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt target identity changed during rename',
			);
		}
		if (!samePath(await realpath(path.dirname(targetPath)), parent)) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt artifact parent identity changed after rename',
			);
		}
		await syncParentDirectory(parent);
	} finally {
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export async function fileMtimeMs(filePath: string): Promise<number | null> {
	try {
		return (await stat(filePath)).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export const _internals = {
	platform: (): NodeJS.Platform => process.platform,
	killProcess: (pid: number): void => {
		process.kill(pid, 0);
	},
	readLinuxProcStat,
	procStateReadTimeoutMs: PROC_STATE_READ_TIMEOUT_MS,
	isProcessAlive,
	rename,
	rm,
	afterRecoveryRename: async (
		_paths: ReceiptLedgerPaths,
		_claimedPath: string,
	): Promise<void> => {},
	recoverLockIfSafe,
	validateMutationParent,
};
