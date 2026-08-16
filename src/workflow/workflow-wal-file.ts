import * as fs from 'node:fs';
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	type CoderSettlementWal,
	parseCoderSettlementWal,
	parseTaskRepairWal,
	parseTaskTerminalWal,
	type TaskRepairWal,
	type TaskTerminalWal,
} from './workflow-wal-schema.js';

const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });
const CODER_SETTLEMENT_MAX_BYTES = 64 * 1024 * 1024;
const SMALL_WORKFLOW_WAL_MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

type WorkflowWalKind = 'coder-settlement' | 'task-repair' | 'task-terminal';

type WorkflowWalByKind = {
	'coder-settlement': CoderSettlementWal;
	'task-repair': TaskRepairWal;
	'task-terminal': TaskTerminalWal;
};

type OpenFile = (filePath: string, flags: string) => Promise<FileHandle>;

export const _internals: {
	openFile: OpenFile;
	openFileSync: typeof fs.openSync;
	readFileSync: typeof fs.readSync;
	closeFileSync: typeof fs.closeSync;
} = {
	openFile: open as OpenFile,
	openFileSync: fs.openSync,
	readFileSync: fs.readSync,
	closeFileSync: fs.closeSync,
};

function maxBytesFor(kind: WorkflowWalKind): number {
	return kind === 'coder-settlement'
		? CODER_SETTLEMENT_MAX_BYTES
		: SMALL_WORKFLOW_WAL_MAX_BYTES;
}

function remediationFor(kind: WorkflowWalKind): string {
	switch (kind) {
		case 'coder-settlement':
			return 'Preserve this file, reconcile the task lane, and only then move it aside.';
		case 'task-repair':
			return 'Preserve this file, reconcile the repair transition, and only then move it aside.';
		case 'task-terminal':
			return 'Preserve this file and reconcile the task terminal transition before moving it aside.';
	}
}

function unreadableCode(kind: WorkflowWalKind): string {
	return kind === 'coder-settlement'
		? 'CODER_SETTLEMENT_WAL_UNREADABLE'
		: kind === 'task-repair'
			? 'TASK_REPAIR_WAL_UNREADABLE'
			: 'TASK_TERMINAL_WAL_UNREADABLE';
}

function walIoError(
	kind: WorkflowWalKind,
	filePath: string,
	action: 'open' | 'read' | 'close',
	error: unknown,
): Error {
	const detail = error instanceof Error ? error.message : String(error);
	return new Error(
		`${unreadableCode(kind)}: could not ${action} ${filePath} (${detail}). ${remediationFor(kind)}`,
		{ cause: error },
	);
}

function oversizeMessage(
	kind: WorkflowWalKind,
	filePath: string,
	maxBytes: number,
): never {
	if (kind === 'coder-settlement') {
		throw new Error(
			`CODER_SETTLEMENT_WAL_OVERSIZE: ${filePath} exceeds the 64 MiB safety limit. Preserve this file, reconcile the lane, reduce or partition the declared scope, and only then move the WAL aside.`,
		);
	}
	throw new Error(
		`${kind === 'task-repair' ? 'TASK_REPAIR' : 'TASK_TERMINAL'}_WAL_OVERSIZE: ${filePath} exceeds the ${maxBytes} byte safety limit. ${remediationFor(kind)}`,
	);
}

function decodeUtf8(
	kind: WorkflowWalKind,
	filePath: string,
	bytes: Uint8Array,
): string {
	try {
		return UTF8_FATAL_DECODER.decode(bytes);
	} catch (error) {
		const code =
			kind === 'coder-settlement'
				? 'CODER_SETTLEMENT_WAL_UNREADABLE'
				: kind === 'task-repair'
					? 'TASK_REPAIR_WAL_UNREADABLE'
					: 'TASK_TERMINAL_WAL_UNREADABLE';
		throw new Error(
			`${code}: ${filePath} is not valid UTF-8 (${error instanceof Error ? error.message : String(error)}). ${remediationFor(kind)}`,
		);
	}
}

function validateWal<K extends WorkflowWalKind>(
	kind: K,
	raw: string,
	filePath: string,
	expectedTaskId: string,
): WorkflowWalByKind[K] {
	switch (kind) {
		case 'coder-settlement':
			return parseCoderSettlementWal(
				raw,
				filePath,
				expectedTaskId,
			) as WorkflowWalByKind[K];
		case 'task-repair':
			return parseTaskRepairWal(
				raw,
				filePath,
				expectedTaskId,
			) as WorkflowWalByKind[K];
		case 'task-terminal':
			return parseTaskTerminalWal(
				raw,
				filePath,
				expectedTaskId,
			) as WorkflowWalByKind[K];
	}
}

async function readBoundedBytes(
	kind: WorkflowWalKind,
	filePath: string,
	maxBytes: number,
): Promise<Uint8Array | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await _internals.openFile(filePath, 'r');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw walIoError(kind, filePath, 'open', error);
	}
	let result: Uint8Array = new Uint8Array();
	let failure: Error | null = null;
	try {
		const limit = maxBytes + 1;
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const remaining = limit - total;
			if (remaining <= 0) break;
			const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, remaining));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			chunks.push(buffer.subarray(0, bytesRead));
			if (total > maxBytes) break;
		}
		result = Buffer.concat(chunks, total);
	} catch (error) {
		failure = walIoError(kind, filePath, 'read', error);
	}
	try {
		await handle.close();
	} catch (error) {
		failure ??= walIoError(kind, filePath, 'close', error);
	}
	if (failure) throw failure;
	return result;
}

function readBoundedBytesSync(
	kind: WorkflowWalKind,
	filePath: string,
	maxBytes: number,
): Uint8Array | null {
	let fd: number;
	try {
		fd = _internals.openFileSync(filePath, 'r');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw walIoError(kind, filePath, 'open', error);
	}
	let result: Uint8Array = new Uint8Array();
	let failure: Error | null = null;
	try {
		const limit = maxBytes + 1;
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const remaining = limit - total;
			if (remaining <= 0) break;
			const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, remaining));
			const bytesRead = _internals.readFileSync(
				fd,
				buffer,
				0,
				buffer.length,
				null,
			);
			if (bytesRead === 0) break;
			total += bytesRead;
			chunks.push(buffer.subarray(0, bytesRead));
			if (total > maxBytes) break;
		}
		result = Buffer.concat(chunks, total);
	} catch (error) {
		failure = walIoError(kind, filePath, 'read', error);
	}
	try {
		_internals.closeFileSync(fd);
	} catch (error) {
		failure ??= walIoError(kind, filePath, 'close', error);
	}
	if (failure) throw failure;
	return result;
}

export async function readWorkflowWalFile<K extends WorkflowWalKind>(
	kind: K,
	filePath: string,
	expectedTaskId: string,
): Promise<WorkflowWalByKind[K] | null> {
	const maxBytes = maxBytesFor(kind);
	const bytes = await readBoundedBytes(kind, filePath, maxBytes);
	if (bytes === null) return null;
	if (bytes.length === 0) {
		throw new Error(
			`${kind === 'coder-settlement' ? 'CODER_SETTLEMENT' : kind === 'task-repair' ? 'TASK_REPAIR' : 'TASK_TERMINAL'}_WAL_UNREADABLE: ${filePath} is empty. ${remediationFor(kind)}`,
		);
	}
	if (bytes.length > maxBytes) oversizeMessage(kind, filePath, maxBytes);
	return validateWal(
		kind,
		decodeUtf8(kind, filePath, bytes),
		filePath,
		expectedTaskId,
	);
}

export function readWorkflowWalFileSync<K extends WorkflowWalKind>(
	kind: K,
	filePath: string,
	expectedTaskId: string,
): WorkflowWalByKind[K] | null {
	const maxBytes = maxBytesFor(kind);
	const bytes = readBoundedBytesSync(kind, filePath, maxBytes);
	if (bytes === null) return null;
	if (bytes.length === 0) {
		throw new Error(
			`${kind === 'coder-settlement' ? 'CODER_SETTLEMENT' : kind === 'task-repair' ? 'TASK_REPAIR' : 'TASK_TERMINAL'}_WAL_UNREADABLE: ${filePath} is empty. ${remediationFor(kind)}`,
		);
	}
	if (bytes.length > maxBytes) oversizeMessage(kind, filePath, maxBytes);
	return validateWal(
		kind,
		decodeUtf8(kind, filePath, bytes),
		filePath,
		expectedTaskId,
	);
}

export async function writeWorkflowWalFile(
	kind: WorkflowWalKind,
	filePath: string,
	wal: CoderSettlementWal | TaskRepairWal | TaskTerminalWal,
): Promise<void> {
	const serialized = `${JSON.stringify(wal, null, 2)}\n`;
	const maxBytes = maxBytesFor(kind);
	if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
		oversizeMessage(kind, filePath, maxBytes);
	}
	validateWal(kind, serialized, filePath, wal.taskId);
	await mkdir(dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, serialized);
}
