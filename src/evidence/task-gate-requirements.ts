import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type {
	TaskEvidence,
	TaskWorkflowTransitionEvent,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import { atomicWriteFile } from './task-file.js';

const MAX_TASK_GATE_REQUIREMENTS_BYTES = 256 * 1024;

const TaskGateRequirementsReceiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		taskId: z.string().min(1).max(120),
		generation: z.number().int().min(0),
		normalizedRole: z.string().min(1).max(120),
		testEngineerExempt: z.boolean().nullable(),
		requiredGates: z.array(z.string()).min(1).max(16),
		sourceEvent: z.string().min(1).max(120),
		sourceTransitionId: z.string().min(1).max(200).nullable(),
		recordedAt: z.string().min(1).max(128),
		previousChainHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		chainHash: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export type TaskGateRequirementsReceipt = z.infer<
	typeof TaskGateRequirementsReceiptSchema
>;

export function taskGateRequirementsReceiptPath(
	directory: string,
	taskId: string,
): string {
	return validateSwarmPath(
		directory,
		path.join('evidence', 'task-gate-requirements', `${taskId}.jsonl`),
	);
}

function samePath(left: string, right: string): boolean {
	const normalize = (value: string) =>
		process.platform === 'win32'
			? path.resolve(value).toLowerCase()
			: path.resolve(value);
	return normalize(left) === normalize(right);
}

function assertSafeRequirementsParent(
	directory: string,
	create: boolean,
): string {
	assertProjectRoot(directory, undefined, 'task gate requirements');
	const rootStat = fs.lstatSync(directory);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error(
			'TASK_GATE_REQUIREMENTS_UNREADABLE: project root is not a regular directory',
		);
	}
	const canonicalRoot = fs.realpathSync(directory);
	if (!samePath(canonicalRoot, directory)) {
		throw new Error(
			'TASK_GATE_REQUIREMENTS_UNREADABLE: project root is redirected',
		);
	}
	const segments = ['.swarm', 'evidence', 'task-gate-requirements'];
	let current = canonicalRoot;
	for (const segment of segments) {
		current = path.join(current, segment);
		let info: fs.Stats;
		try {
			info = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				if (!create) return current;
				try {
					fs.mkdirSync(current);
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
						throw mkdirError;
					}
				}
				info = fs.lstatSync(current);
			} else {
				throw error;
			}
		}
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(
				'TASK_GATE_REQUIREMENTS_UNREADABLE: receipt parent is redirected or not a directory',
			);
		}
		const canonicalCurrent = fs.realpathSync(current);
		if (!samePath(canonicalCurrent, current)) {
			throw new Error(
				'TASK_GATE_REQUIREMENTS_UNREADABLE: receipt parent escaped the project root',
			);
		}
	}
	return current;
}

function safeTaskGateRequirementsReceiptPath(
	directory: string,
	taskId: string,
	createParent: boolean,
): string {
	const parent = assertSafeRequirementsParent(directory, createParent);
	return path.join(parent, `${taskId}.jsonl`);
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function canonicalReceiptPayload(
	receipt: Omit<TaskGateRequirementsReceipt, 'chainHash'>,
): string {
	return JSON.stringify({
		...receipt,
		requiredGates: [...receipt.requiredGates],
	});
}

function computeChainHash(
	receipt: Omit<TaskGateRequirementsReceipt, 'chainHash'>,
): string {
	return sha256(canonicalReceiptPayload(receipt));
}

function readBoundedTextFile(filePath: string): string | null {
	let pathStat: fs.Stats;
	try {
		pathStat = fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		throw new Error(
			'TASK_GATE_REQUIREMENTS_UNREADABLE: receipt path is not a regular file',
		);
	}
	if (pathStat.size > MAX_TASK_GATE_REQUIREMENTS_BYTES) {
		throw new Error(
			`TASK_GATE_REQUIREMENTS_OVERSIZED: ${pathStat.size} bytes exceeds ${MAX_TASK_GATE_REQUIREMENTS_BYTES}`,
		);
	}
	const descriptor = fs.openSync(
		filePath,
		fs.constants.O_RDONLY |
			((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
	);
	try {
		const openedStat = fs.fstatSync(descriptor);
		if (
			!openedStat.isFile() ||
			openedStat.dev !== pathStat.dev ||
			openedStat.ino !== pathStat.ino
		) {
			throw new Error(
				'TASK_GATE_REQUIREMENTS_UNREADABLE: receipt changed while being opened',
			);
		}
		if (openedStat.size > MAX_TASK_GATE_REQUIREMENTS_BYTES) {
			throw new Error(
				`TASK_GATE_REQUIREMENTS_OVERSIZED: ${openedStat.size} bytes exceeds ${MAX_TASK_GATE_REQUIREMENTS_BYTES}`,
			);
		}
		return fs.readFileSync(descriptor, 'utf-8');
	} finally {
		fs.closeSync(descriptor);
	}
}

export async function readTaskGateRequirementsReceipts(
	directory: string,
	taskId: string,
): Promise<TaskGateRequirementsReceipt[]> {
	const filePath = safeTaskGateRequirementsReceiptPath(
		directory,
		taskId,
		false,
	);
	const text = readBoundedTextFile(filePath);
	if (text === null) return [];
	const receipts: TaskGateRequirementsReceipt[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const parsed = TaskGateRequirementsReceiptSchema.parse(JSON.parse(line));
		if (parsed.taskId !== taskId) {
			throw new Error(
				`TASK_GATE_REQUIREMENTS_IDENTITY_MISMATCH: expected ${taskId}, found ${parsed.taskId}`,
			);
		}
		const { chainHash, ...withoutChainHash } = parsed;
		const expectedHash = computeChainHash(withoutChainHash);
		if (expectedHash !== chainHash) {
			throw new Error(
				`TASK_GATE_REQUIREMENTS_CHAIN_MISMATCH: receipt for ${taskId} failed hash validation`,
			);
		}
		const previousChainHash = receipts.at(-1)?.chainHash ?? null;
		if (parsed.previousChainHash !== previousChainHash) {
			throw new Error(
				`TASK_GATE_REQUIREMENTS_CHAIN_MISMATCH: receipt for ${taskId} failed linkage validation`,
			);
		}
		receipts.push(parsed);
	}
	return receipts;
}

function deriveReceiptRole(
	event: TaskWorkflowTransitionEvent,
): { normalizedRole: string; testEngineerExempt: boolean | null } | null {
	switch (event.type) {
		case 'accepted_mutation':
		case 'dispatch_attempted':
		case 'dispatch_no_mutation':
			if (
				typeof event.agentType === 'string' &&
				event.agentType.trim().length > 0
			) {
				return {
					normalizedRole: event.agentType.trim(),
					testEngineerExempt:
						event.agentType === 'coder'
							? event.context?.testEngineerExempt === true
							: null,
				};
			}
			return null;
		case 'stage_b_completed':
		case 'gate_recorded':
			return {
				normalizedRole: event.gate,
				testEngineerExempt: null,
			};
		default:
			return null;
	}
}

function shouldAppendReceipt(
	current: TaskEvidence | null,
	next: TaskEvidence,
	role: { normalizedRole: string; testEngineerExempt: boolean | null },
): boolean {
	if (next.required_gates.length === 0) return false;
	const currentGeneration = current?.workflow?.generation ?? -1;
	const nextGeneration = next.workflow?.generation ?? -1;
	if (current === null) return true;
	if (
		JSON.stringify(current.required_gates) !==
		JSON.stringify(next.required_gates)
	) {
		return true;
	}
	if ((current.test_engineer_exempt ?? null) !== role.testEngineerExempt) {
		return true;
	}
	return currentGeneration !== nextGeneration;
}

export async function appendTaskGateRequirementsReceiptIfNeeded(
	directory: string,
	taskId: string,
	current: TaskEvidence | null,
	next: TaskEvidence,
	event: TaskWorkflowTransitionEvent,
): Promise<void> {
	const role = deriveReceiptRole(event);
	if (!role || !shouldAppendReceipt(current, next, role)) return;

	const filePath = safeTaskGateRequirementsReceiptPath(directory, taskId, true);
	const receipts = await readTaskGateRequirementsReceipts(directory, taskId);
	const latest = receipts.at(-1);
	const baseReceipt = {
		schemaVersion: 1 as const,
		taskId,
		generation: next.workflow?.generation ?? 0,
		normalizedRole: role.normalizedRole,
		testEngineerExempt: role.testEngineerExempt,
		requiredGates: [...next.required_gates],
		sourceEvent: event.type,
		sourceTransitionId: event.transitionId ?? null,
		recordedAt: new Date().toISOString(),
		previousChainHash: latest?.chainHash ?? null,
	};
	const receipt: TaskGateRequirementsReceipt = {
		...baseReceipt,
		chainHash: computeChainHash(baseReceipt),
	};

	if (
		latest &&
		latest.generation === receipt.generation &&
		latest.normalizedRole === receipt.normalizedRole &&
		latest.testEngineerExempt === receipt.testEngineerExempt &&
		JSON.stringify(latest.requiredGates) ===
			JSON.stringify(receipt.requiredGates) &&
		latest.sourceTransitionId === receipt.sourceTransitionId
	) {
		return;
	}

	const lines = [...receipts, receipt].map((entry) => JSON.stringify(entry));
	assertSafeRequirementsParent(directory, false);
	await atomicWriteFile(filePath, `${lines.join('\n')}\n`);
	assertSafeRequirementsParent(directory, false);
}
