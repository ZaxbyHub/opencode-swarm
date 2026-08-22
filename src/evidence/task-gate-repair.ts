import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	parseTaskEvidence,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { loadPlan } from '../plan/manager.js';
import { swarmState } from '../state.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import { assertStrictTaskId } from '../validation/task-id.js';
import {
	atomicWriteFile,
	taskEvidenceRelPath,
	withTaskEvidenceLock,
} from './task-file.js';
import {
	readTaskGateRequirementsReceipts,
	type TaskGateRequirementsReceipt,
} from './task-gate-requirements.js';

export const TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL =
	'requirements_reconstruction';

const TASK_GATE_EVIDENCE_QUARANTINE_DIR = path.join(
	'evidence',
	'task-gate-quarantine',
);
const MAX_TASK_GATE_EVIDENCE_BYTES = 256 * 1024;
const MAX_TASK_GATE_EVIDENCE_QUARANTINE_FILES = 32;
const MAX_TASK_GATE_EVIDENCE_QUARANTINE_BYTES = 12 * 1024 * 1024;
const MAX_TASK_GATE_EVIDENCE_QUARANTINE_DIRECTORY_ENTRIES = 128;
const MAX_TASK_GATE_EVIDENCE_QUARANTINE_RECORD_BYTES = 768 * 1024;
const TASK_GATE_EVIDENCE_QUARANTINE_SCHEMA_VERSION = 1;
const GENERIC_REPAIR_REASONS = new Set([
	'fix',
	'repair',
	'test',
	'debug',
	'unknown',
	'n/a',
	'na',
	'none',
]);

export interface RepairGateEvidenceArgs {
	task_id: string;
	reason: string;
	expected_sha256?: string;
	expected_generation?: number;
}

export interface RepairGateEvidenceContext {
	sessionID?: string;
	messageID?: string;
}

export interface RepairGateEvidenceResult {
	success: boolean;
	message: string;
	errors?: string[];
	repaired?: boolean;
	task_id?: string;
	required_gates?: string[];
	requirements_state?: 'known' | 'unknown';
	quarantine_digest?: string;
	quarantine_path?: string;
	repaired_generation?: number;
	next_actions?: string[];
}

interface ReadTaskEvidenceResult {
	status: 'unreadable' | 'oversized' | 'corrupt' | 'valid';
	filePath: string;
	bytes: Buffer;
	sha256: string;
	evidence?: TaskEvidence;
	generation?: number;
	error?: Error;
}

type TaskEvidenceReadResult = { status: 'missing' } | ReadTaskEvidenceResult;
type QuarantinableTaskEvidenceRead = ReadTaskEvidenceResult & {
	status: 'corrupt' | 'valid';
};

function isQuarantinableTaskEvidenceRead(
	read: TaskEvidenceReadResult,
): read is QuarantinableTaskEvidenceRead {
	return read.status === 'corrupt' || read.status === 'valid';
}

interface TaskGateEvidenceQuarantineRecord {
	schemaVersion: typeof TASK_GATE_EVIDENCE_QUARANTINE_SCHEMA_VERSION;
	taskId: string;
	recordedAt: string;
	reason: string;
	caller: {
		sessionId: string | null;
		messageId: string | null;
		agentName: string | null;
	};
	original: {
		path: string;
		sha256: string;
		sizeBytes: number;
		status: 'corrupt' | 'valid';
		observedGeneration: number | null;
		receiptGeneration: number | null;
		requirementsState: 'known' | 'unknown' | null;
	};
	parseError: {
		name: string;
		message: string;
		code: string | null;
	} | null;
	content: {
		encoding: 'base64';
		bytes: string;
	};
}

function sha256(bytes: Buffer | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function normalizeRepairReason(reason: string): string {
	const normalized = reason.trim().replace(/\s+/g, ' ');
	if (normalized.length < 12) {
		throw new Error(
			'TASK_GATE_EVIDENCE_REASON_REQUIRED: repair_gate_evidence requires a substantive reason of at least 12 characters.',
		);
	}
	if (GENERIC_REPAIR_REASONS.has(normalized.toLowerCase())) {
		throw new Error(
			'TASK_GATE_EVIDENCE_REASON_REQUIRED: repair_gate_evidence requires a substantive reason, not a placeholder.',
		);
	}
	return normalized;
}

function canonicalizeRepairRoot(directory: string): string {
	const requestedRoot = path.resolve(directory);
	const requestedStat = fs.lstatSync(requestedRoot);
	if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
		throw new Error(
			'TASK_GATE_EVIDENCE_ROOT_UNSAFE: repair_gate_evidence requires a canonical project root directory, not a symlink, junction, reparse point, or non-directory path.',
		);
	}
	const canonicalRoot = fs.realpathSync(requestedRoot);
	assertProjectRoot(canonicalRoot);
	return canonicalRoot;
}

function assertExistingRegularPath(root: string, relativePath: string): void {
	const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
	let cursor = root;
	for (const segment of segments) {
		cursor = path.join(cursor, segment);
		if (!fs.existsSync(cursor)) return;
		const stat = fs.lstatSync(cursor);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`TASK_GATE_EVIDENCE_PATH_UNSAFE: ${relativePath} contains a symlink, junction, or reparse point.`,
			);
		}
	}
}

function taskEvidenceFilePath(directory: string, taskId: string): string {
	const relativePath = taskEvidenceRelPath(taskId);
	assertExistingRegularPath(directory, '.swarm');
	assertExistingRegularPath(directory, path.join('.swarm', 'evidence'));
	assertExistingRegularPath(directory, path.join('.swarm', relativePath));
	return validateSwarmPath(directory, relativePath);
}

function readTaskEvidenceForRepair(
	directory: string,
	taskId: string,
): TaskEvidenceReadResult {
	const filePath = taskEvidenceFilePath(directory, taskId);
	let pathStat: fs.Stats;
	try {
		pathStat = fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'missing' };
		}
		return {
			status: 'unreadable',
			filePath,
			bytes: Buffer.alloc(0),
			sha256: sha256(''),
			error: error as Error,
		};
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		return {
			status: 'unreadable',
			filePath,
			bytes: Buffer.alloc(0),
			sha256: sha256(''),
			error: new Error(
				'TASK_GATE_EVIDENCE_UNREADABLE: evidence path is not a regular file',
			),
		};
	}
	if (pathStat.size > MAX_TASK_GATE_EVIDENCE_BYTES) {
		return {
			status: 'oversized',
			filePath,
			bytes: Buffer.alloc(0),
			sha256: sha256(''),
			error: new Error(
				`TASK_GATE_EVIDENCE_OVERSIZED: ${pathStat.size} bytes exceeds ${MAX_TASK_GATE_EVIDENCE_BYTES}`,
			),
		};
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
			return {
				status: 'unreadable',
				filePath,
				bytes: Buffer.alloc(0),
				sha256: sha256(''),
				error: new Error(
					'TASK_GATE_EVIDENCE_UNREADABLE: evidence changed while being opened',
				),
			};
		}
		const bytes = fs.readFileSync(descriptor);
		if (bytes.byteLength > MAX_TASK_GATE_EVIDENCE_BYTES) {
			return {
				status: 'oversized',
				filePath,
				bytes: Buffer.alloc(0),
				sha256: sha256(''),
				error: new Error(
					`TASK_GATE_EVIDENCE_OVERSIZED: ${bytes.byteLength} bytes exceeds ${MAX_TASK_GATE_EVIDENCE_BYTES}`,
				),
			};
		}
		const digest = sha256(bytes);
		try {
			const evidence = parseTaskEvidence(bytes.toString('utf8'), taskId);
			return {
				status: 'valid',
				filePath,
				bytes,
				sha256: digest,
				evidence,
				generation: evidence.workflow?.generation,
			};
		} catch (error) {
			return {
				status: 'corrupt',
				filePath,
				bytes,
				sha256: digest,
				error: error as Error,
			};
		}
	} finally {
		try {
			fs.closeSync(descriptor);
		} catch {
			// Best-effort close after bounded read.
		}
	}
}

export function taskGateEvidenceQuarantinePath(
	directory: string,
	taskId: string,
	digest: string,
): string {
	return validateSwarmPath(
		directory,
		path.join(
			TASK_GATE_EVIDENCE_QUARANTINE_DIR,
			`${taskId}.${digest}.v${TASK_GATE_EVIDENCE_QUARANTINE_SCHEMA_VERSION}.json`,
		),
	);
}

function parseErrorMetadata(error: Error | undefined): {
	name: string;
	message: string;
	code: string | null;
} | null {
	if (!error) return null;
	return {
		name: error.name || 'Error',
		message: error.message || String(error),
		code:
			typeof (error as NodeJS.ErrnoException).code === 'string'
				? (error as NodeJS.ErrnoException).code!
				: null,
	};
}

function parseQuarantineRecord(
	raw: string,
): TaskGateEvidenceQuarantineRecord | null {
	try {
		const parsed = JSON.parse(raw) as Partial<TaskGateEvidenceQuarantineRecord>;
		if (
			parsed?.schemaVersion !== TASK_GATE_EVIDENCE_QUARANTINE_SCHEMA_VERSION ||
			typeof parsed.taskId !== 'string' ||
			typeof parsed.recordedAt !== 'string' ||
			typeof parsed.reason !== 'string' ||
			typeof parsed.original?.path !== 'string' ||
			typeof parsed.original?.sha256 !== 'string' ||
			typeof parsed.content?.bytes !== 'string' ||
			parsed.content?.encoding !== 'base64'
		) {
			return null;
		}
		return parsed as TaskGateEvidenceQuarantineRecord;
	} catch {
		return null;
	}
}

function buildQuarantineRecord(
	taskId: string,
	read: QuarantinableTaskEvidenceRead,
	reason: string,
	context: RepairGateEvidenceContext | undefined,
	receiptGeneration: number | null,
): TaskGateEvidenceQuarantineRecord {
	const agentName =
		context?.sessionID != null
			? (swarmState.activeAgent.get(context.sessionID) ??
				swarmState.agentSessions.get(context.sessionID)?.agentName ??
				null)
			: null;
	return {
		schemaVersion: TASK_GATE_EVIDENCE_QUARANTINE_SCHEMA_VERSION,
		taskId,
		recordedAt: new Date().toISOString(),
		reason,
		caller: {
			sessionId: context?.sessionID?.trim() || null,
			messageId: context?.messageID?.trim() || null,
			agentName,
		},
		original: {
			path: read.filePath,
			sha256: read.sha256,
			sizeBytes: read.bytes.byteLength,
			status: read.status,
			observedGeneration: read.generation ?? null,
			receiptGeneration,
			requirementsState: read.evidence?.requirements_state ?? null,
		},
		parseError: parseErrorMetadata(read.error),
		content: {
			encoding: 'base64',
			bytes: read.bytes.toString('base64'),
		},
	};
}

async function quarantineTaskEvidenceBytes(
	directory: string,
	taskId: string,
	read: QuarantinableTaskEvidenceRead,
	reason: string,
	context: RepairGateEvidenceContext | undefined,
	receiptGeneration: number | null,
): Promise<{ digest: string; filePath: string }> {
	const digest = read.sha256;
	const quarantineDir = validateSwarmPath(
		directory,
		TASK_GATE_EVIDENCE_QUARANTINE_DIR,
	);
	await fs.promises.mkdir(quarantineDir, { recursive: true });
	const dirStat = await fs.promises.lstat(quarantineDir);
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
		throw new Error(
			'TASK_GATE_EVIDENCE_QUARANTINE_UNREADABLE: quarantine is not a regular directory',
		);
	}
	const target = taskGateEvidenceQuarantinePath(directory, taskId, digest);
	const record = buildQuarantineRecord(
		taskId,
		read,
		reason,
		context,
		receiptGeneration,
	);
	const serialized = JSON.stringify(record, null, 2);
	const serializedBytes = Buffer.byteLength(serialized, 'utf8');
	if (serializedBytes > MAX_TASK_GATE_EVIDENCE_QUARANTINE_RECORD_BYTES) {
		throw new Error(
			'TASK_GATE_EVIDENCE_QUARANTINE_FULL: quarantine payload exceeds the bounded record size limit',
		);
	}
	const reconcileExisting = async (): Promise<boolean> => {
		let existingStat: fs.Stats;
		try {
			existingStat = await fs.promises.lstat(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw error;
		}
		if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
			throw new Error(
				'TASK_GATE_EVIDENCE_QUARANTINE_MISMATCH: existing quarantine path is not a regular immutable record',
			);
		}
		const existingRaw = await fs.promises.readFile(target, 'utf8');
		const existingRecord = parseQuarantineRecord(existingRaw);
		if (
			existingRecord &&
			existingRecord.taskId === taskId &&
			existingRecord.original.path === read.filePath &&
			existingRecord.original.sha256 === read.sha256 &&
			existingRecord.content.bytes === read.bytes.toString('base64')
		) {
			return true;
		}
		throw new Error(
			'TASK_GATE_EVIDENCE_QUARANTINE_MISMATCH: existing quarantine record does not match the repaired evidence source',
		);
	};
	if (await reconcileExisting()) return { digest, filePath: target };

	let count = 0;
	let totalBytes = 0;
	let scanned = 0;
	const handle = await fs.promises.opendir(quarantineDir, { bufferSize: 16 });
	try {
		for await (const entry of handle) {
			scanned += 1;
			if (scanned > MAX_TASK_GATE_EVIDENCE_QUARANTINE_DIRECTORY_ENTRIES) {
				throw new Error(
					'TASK_GATE_EVIDENCE_QUARANTINE_FULL: too many quarantine entries',
				);
			}
			if (
				!entry.isFile() ||
				!/^[0-9.]+\.[a-f0-9]{64}\.v1\.json$/.test(entry.name)
			) {
				continue;
			}
			count += 1;
			const candidate = path.join(quarantineDir, entry.name);
			const candidateStat = await fs.promises.lstat(candidate);
			if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
				throw new Error(
					'TASK_GATE_EVIDENCE_QUARANTINE_UNREADABLE: invalid quarantine artifact',
				);
			}
			totalBytes += candidateStat.size;
			if (
				count >= MAX_TASK_GATE_EVIDENCE_QUARANTINE_FILES ||
				totalBytes + serializedBytes > MAX_TASK_GATE_EVIDENCE_QUARANTINE_BYTES
			) {
				throw new Error(
					'TASK_GATE_EVIDENCE_QUARANTINE_FULL: quarantine retention limit reached',
				);
			}
		}
	} finally {
		try {
			await handle.close();
		} catch {
			// Async iteration closes on normal completion.
		}
	}

	const tempPath = path.join(
		quarantineDir,
		`.pending.${process.pid}.${randomUUID()}.json`,
	);
	let fileHandle: fs.promises.FileHandle | undefined;
	try {
		fileHandle = await fs.promises.open(tempPath, 'wx');
		await fileHandle.writeFile(serialized, 'utf8');
		await fileHandle.sync();
		await fileHandle.close();
		fileHandle = undefined;
		await fs.promises.link(tempPath, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		if (await reconcileExisting()) return { digest, filePath: target };
		throw error;
	} finally {
		await fileHandle?.close().catch(() => undefined);
		await fs.promises.unlink(tempPath).catch(() => undefined);
	}

	return { digest, filePath: target };
}

function buildRepairTransitionId(taskId: string, source: string): string {
	return `repair_gate_evidence:${taskId}:${source.slice(0, 32)}`;
}

function buildKnownRepairedEvidence(
	taskId: string,
	receipt: TaskGateRequirementsReceipt,
	generation: number,
	source: { sha256: string | null; generation: number | null },
): TaskEvidence {
	return {
		taskId,
		required_gates: [...receipt.requiredGates],
		gates: {},
		requirements_state: 'known',
		test_engineer_exempt: receipt.testEngineerExempt ?? undefined,
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation,
			state: 'idle',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'repair_idle',
			lastTransitionId: buildRepairTransitionId(taskId, receipt.chainHash),
			updatedAt: new Date().toISOString(),
		},
		repair_provenance: {
			source_sha256: source.sha256,
			source_generation: source.generation,
			requirements_receipt_hash: receipt.chainHash,
		},
	};
}

function buildUnknownRepairedEvidence(
	taskId: string,
	seedGeneration: number,
	source: { sha256: string | null; generation: number | null },
): TaskEvidence {
	return {
		taskId,
		required_gates: [TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL],
		gates: {},
		requirements_state: 'unknown',
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation: seedGeneration,
			state: 'idle',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'repair_idle',
			lastTransitionId: buildRepairTransitionId(taskId, 'unknown'),
			updatedAt: new Date().toISOString(),
		},
		repair_provenance: {
			source_sha256: source.sha256,
			source_generation: source.generation,
			requirements_receipt_hash: null,
		},
	};
}

function canonicalizeTaskEvidence(
	taskId: string,
	evidence: TaskEvidence,
): string {
	const validated = parseTaskEvidence(
		JSON.stringify({ ...evidence, taskId }),
		taskId,
	);
	return JSON.stringify(validated, null, 2);
}

function isRepairWorkflowReset(
	taskId: string,
	workflow: TaskEvidence['workflow'] | undefined,
): workflow is NonNullable<TaskEvidence['workflow']> {
	return (
		workflow != null &&
		workflow.state === 'idle' &&
		workflow.retryCount === 0 &&
		workflow.retryEpoch === 0 &&
		workflow.retryHistory.length === 0 &&
		workflow.lastOutcome === 'repair_idle' &&
		typeof workflow.lastTransitionId === 'string' &&
		workflow.lastTransitionId.startsWith(`repair_gate_evidence:${taskId}:`)
	);
}

function isAlreadyRepairedEvidence(
	taskId: string,
	evidence: TaskEvidence | undefined,
	receipt: TaskGateRequirementsReceipt | undefined,
): evidence is TaskEvidence {
	if (!evidence || !isRepairWorkflowReset(taskId, evidence.workflow))
		return false;
	if (Object.keys(evidence.gates).length !== 0) return false;
	if (receipt) {
		return (
			evidence.requirements_state === 'known' &&
			JSON.stringify(evidence.required_gates) ===
				JSON.stringify(receipt.requiredGates) &&
			evidence.workflow.generation > receipt.generation &&
			(evidence.test_engineer_exempt ?? null) ===
				(receipt.testEngineerExempt ?? null) &&
			evidence.repair_provenance?.requirements_receipt_hash ===
				receipt.chainHash
		);
	}
	return (
		evidence.requirements_state === 'unknown' &&
		JSON.stringify(evidence.required_gates) ===
			JSON.stringify([TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL]) &&
		evidence.workflow.generation >= 1
	);
}

function repairedEvidenceMatchesCas(
	evidence: TaskEvidence,
	args: RepairGateEvidenceArgs,
): boolean {
	const provenance = evidence.repair_provenance;
	if (!provenance) {
		return args.expected_sha256 == null && args.expected_generation == null;
	}
	return (
		(args.expected_sha256 == null ||
			provenance.source_sha256 === args.expected_sha256) &&
		(args.expected_generation == null ||
			provenance.source_generation === args.expected_generation)
	);
}

function buildRepairNextActions(
	taskId: string,
	evidence: TaskEvidence,
): string[] {
	if (evidence.requirements_state === 'known') {
		return [
			`Delegate coder on task ${taskId} to produce a fresh accepted_mutation for the repaired evidence generation ${evidence.workflow?.generation}.`,
			`Rerun Stage A for task ${taskId} until pre_check passes for the new generation.`,
			`Rerun Stage B gates [${evidence.required_gates.join(', ')}] for task ${taskId} before attempting completion again.`,
		];
	}
	return [
		`Delegate the owning implementation agent on task ${taskId} to regenerate authoritative required gates for a new exact-task generation.`,
		`Rerun Stage A for task ${taskId} after the new mutation is recorded.`,
		`Rerun the exact Stage B gates for task ${taskId} only after the authoritative required gates are re-recorded; the reconstruction sentinel fails closed until then.`,
	];
}

function invalidateTaskEvidenceSessionFallbacks(taskId: string): void {
	for (const session of swarmState.agentSessions.values()) {
		if (session.currentTaskId === taskId) {
			session.currentTaskId = null;
		}
		if (session.lastCoderDelegationTaskId === taskId) {
			session.lastCoderDelegationTaskId = null;
		}
		session.taskWorkflowStates?.delete(taskId);
		session.taskWorkflowCache?.delete(taskId);
		session.stageBCompletion?.delete(taskId);
		session.taskCouncilApproved?.delete(taskId);
		session.taskCouncilWorkflowGeneration?.delete(taskId);
		session.gateLog?.delete(taskId);
		session.partialGateWarningsIssuedForTask?.delete(taskId);
		session.completionGateWarnedForTask?.delete(taskId);
		if (session.lastGateFailure?.taskId === taskId) {
			session.lastGateFailure = null;
		}
	}
}

export async function repairTaskGateEvidence(
	args: RepairGateEvidenceArgs,
	directory: string,
	context?: RepairGateEvidenceContext,
): Promise<RepairGateEvidenceResult> {
	assertStrictTaskId(args.task_id);
	const normalizedReason = normalizeRepairReason(args.reason);
	const canonicalDirectory = canonicalizeRepairRoot(directory);
	const plan = await loadPlan(canonicalDirectory);
	const task = plan?.phases
		.flatMap((phase) => phase.tasks)
		.find((candidate) => candidate.id === args.task_id);
	if (!task) {
		return {
			success: false,
			message: `TASK_GATE_EVIDENCE_TASK_MISSING: ${args.task_id} is not present in the loaded plan`,
			errors: [`Task ${args.task_id} is not present in .swarm/plan.json.`],
		};
	}

	return withTaskEvidenceLock(
		canonicalDirectory,
		args.task_id,
		'repair_gate_evidence',
		async () => {
			const read = readTaskEvidenceForRepair(canonicalDirectory, args.task_id);
			const receipts = await readTaskGateRequirementsReceipts(
				canonicalDirectory,
				args.task_id,
			);
			const latestReceipt = receipts.at(-1);
			if (
				read.status === 'valid' &&
				isAlreadyRepairedEvidence(args.task_id, read.evidence, latestReceipt)
			) {
				if (!repairedEvidenceMatchesCas(read.evidence, args)) {
					return {
						success: false,
						message: 'TASK_GATE_EVIDENCE_CAS_MISMATCH',
						errors: [
							'TASK_GATE_EVIDENCE_CAS_MISMATCH: the existing repaired generation was created from a different source identity.',
						],
					};
				}
				const nextActions = buildRepairNextActions(args.task_id, read.evidence);
				return {
					success: true,
					repaired: false,
					task_id: args.task_id,
					required_gates: [...read.evidence.required_gates],
					requirements_state: read.evidence.requirements_state,
					repaired_generation: read.evidence.workflow?.generation,
					next_actions: nextActions,
					message: `Task gate evidence for ${args.task_id} is already in repaired fail-closed state.`,
				};
			}

			if (
				typeof args.expected_sha256 === 'string' &&
				read.status !== 'missing' &&
				read.sha256 !== args.expected_sha256
			) {
				return {
					success: false,
					message: 'TASK_GATE_EVIDENCE_CAS_MISMATCH',
					errors: [
						`TASK_GATE_EVIDENCE_CAS_MISMATCH: expected sha256 ${args.expected_sha256}, found ${read.sha256}.`,
					],
				};
			}
			if (typeof args.expected_generation === 'number') {
				const observedGeneration =
					read.status === 'valid' ? read.generation : latestReceipt?.generation;
				if (observedGeneration !== args.expected_generation) {
					return {
						success: false,
						message: 'TASK_GATE_EVIDENCE_CAS_MISMATCH',
						errors: [
							`TASK_GATE_EVIDENCE_CAS_MISMATCH: expected generation ${args.expected_generation}, found ${observedGeneration ?? 'unknown'}.`,
						],
					};
				}
			}
			if (read.status === 'unreadable' || read.status === 'oversized') {
				return {
					success: false,
					message:
						read.error?.message ??
						'TASK_GATE_EVIDENCE_UNREADABLE: repair requires operator intervention before evidence can be rewritten.',
					errors: [
						read.error?.message ??
							`TASK_GATE_EVIDENCE_UNREADABLE: ${args.task_id} could not be read safely for repair.`,
					],
				};
			}
			const nextGeneration =
				Math.max(
					read.status === 'valid' ? (read.generation ?? -1) : -1,
					latestReceipt?.generation ?? -1,
				) + 1;
			let nextEvidence: TaskEvidence;
			if (latestReceipt) {
				nextEvidence = buildKnownRepairedEvidence(
					args.task_id,
					latestReceipt,
					nextGeneration,
					{
						sha256: read.status === 'missing' ? null : read.sha256,
						generation:
							read.status === 'valid'
								? (read.generation ?? null)
								: (latestReceipt.generation ?? null),
					},
				);
			} else if (read.status === 'missing') {
				return {
					success: false,
					message: 'TASK_GATE_EVIDENCE_ABSENT',
					errors: [
						`TASK_GATE_EVIDENCE_ABSENT: ${args.task_id} has no evidence file and no authoritative requirements receipt to rebuild from.`,
					],
				};
			} else {
				nextEvidence = buildUnknownRepairedEvidence(
					args.task_id,
					Math.max(nextGeneration, 1),
					{
						sha256: read.sha256,
						generation:
							read.status === 'valid' ? (read.generation ?? null) : null,
					},
				);
			}

			const serialized = canonicalizeTaskEvidence(args.task_id, nextEvidence);
			let quarantine: { digest: string; filePath: string } | undefined;
			if (isQuarantinableTaskEvidenceRead(read)) {
				quarantine = await quarantineTaskEvidenceBytes(
					canonicalDirectory,
					args.task_id,
					read,
					normalizedReason,
					context,
					latestReceipt?.generation ?? null,
				);
			}
			await atomicWriteFile(
				taskEvidenceFilePath(canonicalDirectory, args.task_id),
				serialized,
			);
			invalidateTaskEvidenceSessionFallbacks(args.task_id);
			const nextActions = buildRepairNextActions(args.task_id, nextEvidence);

			return {
				success: true,
				repaired: true,
				task_id: args.task_id,
				required_gates: [...nextEvidence.required_gates],
				requirements_state: nextEvidence.requirements_state,
				quarantine_digest: quarantine?.digest,
				quarantine_path: quarantine?.filePath,
				repaired_generation: nextEvidence.workflow?.generation,
				next_actions: nextActions,
				message:
					`Repaired task gate evidence for ${args.task_id} into a fresh fail-closed generation ${nextEvidence.workflow?.generation}. ` +
					`Next actions: ${nextActions.join(' ')}`,
			};
		},
	);
}
