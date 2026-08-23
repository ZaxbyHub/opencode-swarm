/**
 * Durable, phase-bound proof that a required swarm role completed successfully.
 *
 * Foreground Task calls are correlated in memory only until their terminal
 * tool.execute.after event. Background calls promote the same reservation to
 * this store's durable pending list and are completed only by the trusted
 * background completion observer.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { BackgroundDelegationRecord } from '../background/pending-delegations.js';
import {
	extractDispatchIds,
	parseTaskEnvelope,
	type TaskEnvelope,
} from '../background/task-envelope.js';
import { captureWorkspaceSnapshot } from '../background/workspace-snapshot.js';
import { getCurrentPhase, type Plan } from '../config/plan-schema.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { classifyTaskResult } from '../hooks/task-result-classifier.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { computePlanStructureHash } from '../plan/ledger.js';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { stableCanonicalStringify } from '../utils/stable-stringify.js';
import { withEvidenceLock } from './lock.js';
import { atomicWriteFile } from './task-file.js';

export const PHASE_PARTICIPATION_FILE = 'evidence/phase-participation.json';
export const PHASE_PARTICIPATION_QUARANTINE_DIR =
	'evidence/phase-participation-quarantine';
export const MAX_PHASE_PARTICIPATION_BYTES = 256 * 1024;
export const MAX_PHASE_PARTICIPATION_PENDING = 128;
export const MAX_PHASE_PARTICIPATION_RECEIPTS = 128;
export const MAX_PHASE_PARTICIPATION_QUARANTINE_FILES = 16;
export const MAX_PHASE_PARTICIPATION_QUARANTINE_BYTES = 1024 * 1024;
export const MAX_PHASE_PARTICIPATION_QUARANTINE_DIRECTORY_ENTRIES = 64;
const MAX_PENDING_IN_MEMORY = 128;
const MAX_ID_CHARS = 256;

const WorkspaceSchema = z
	.object({
		directory: z.string().max(4096),
		gitHead: z.string().max(256).nullable(),
		prHeadSha: z.string().max(256).nullable(),
	})
	.strict();

const BindingSchema = z
	.object({
		role: z.string().min(1).max(120),
		prefixedRole: z.string().min(1).max(120),
		planId: z.string().min(1).max(512),
		planIdentityHash: z.string().length(64),
		planStructureHash: z.string().length(64),
		phase: z.number().int().nonnegative(),
		taskId: z.string().min(1).max(120).nullable(),
		parentSessionId: z.string().min(1).max(MAX_ID_CHARS),
		callId: z.string().min(1).max(MAX_ID_CHARS),
		// Audit-only provenance. Current policy decides which roles are required;
		// changing it must not erase proof that an already-required role completed.
		policyDigest: z.string().length(64),
		workspace: WorkspaceSchema,
		capturedAt: z.number().int().nonnegative(),
	})
	.strict();

const PendingSchema = BindingSchema.extend({
	childSessionId: z.string().min(1).max(MAX_ID_CHARS),
}).strict();

const ReceiptSchema = PendingSchema.extend({
	receiptId: z.string().length(64),
	resultDigest: z.string().length(64),
	completedAt: z.number().int().nonnegative(),
	childIdentityAvailable: z.boolean(),
}).strict();

const StoreSchema = z
	.object({
		schemaVersion: z.literal(1),
		pending: z.array(PendingSchema).max(MAX_PHASE_PARTICIPATION_PENDING),
		receipts: z.array(ReceiptSchema).max(MAX_PHASE_PARTICIPATION_RECEIPTS),
	})
	.strict();

type Binding = z.infer<typeof BindingSchema>;
type Pending = z.infer<typeof PendingSchema>;
type Receipt = z.infer<typeof ReceiptSchema>;
type Store = z.infer<typeof StoreSchema>;
type ParticipationWorkspace = z.infer<typeof WorkspaceSchema>;

export interface ParticipationReadResult {
	status: 'missing' | 'valid' | 'corrupt' | 'unreadable' | 'oversized';
	found: boolean;
}

const foregroundReservations = new Map<string, Binding>();

function emptyStore(): Store {
	return { schemaVersion: 1, pending: [], receipts: [] };
}

function correlationKey(parentSessionId: string, callId: string): string {
	return `${parentSessionId}\0${callId}`;
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function policyDigest(policy: unknown): string {
	return sha256(stableCanonicalStringify(policy ?? {}));
}

function captureParticipationWorkspace(
	directory: string,
): ParticipationWorkspace {
	const workspace = captureWorkspaceSnapshot(directory, {
		resolveCurrentPrHeadSha: true,
	});
	return {
		directory: workspace.directory,
		gitHead: workspace.gitHead,
		prHeadSha: workspace.prHeadSha,
	};
}

function boundedPut(binding: Binding): void {
	const key = correlationKey(binding.parentSessionId, binding.callId);
	foregroundReservations.delete(key);
	foregroundReservations.set(key, binding);
	while (foregroundReservations.size > MAX_PENDING_IN_MEMORY) {
		const oldest = foregroundReservations.keys().next().value as
			| string
			| undefined;
		if (!oldest) break;
		foregroundReservations.delete(oldest);
	}
}

function takeBinding(parentSessionId: string, callId: string): Binding | null {
	const key = correlationKey(parentSessionId, callId);
	const binding = foregroundReservations.get(key) ?? null;
	foregroundReservations.delete(key);
	return binding;
}

async function persistWithBindingRecovery(
	directory: string,
	binding: Binding,
	operation: () => Promise<void>,
): Promise<void> {
	try {
		await withEvidenceLock(
			directory,
			PHASE_PARTICIPATION_FILE,
			'docs',
			'phase-participation',
			operation,
		);
	} catch (error) {
		// The outer hook fails open after reporting persistence errors. Restore the
		// exact bounded binding so replaying this result can retry the atomic write.
		boundedPut(binding);
		throw error;
	}
}

function buildBinding(input: {
	plan: Plan;
	phase: number;
	role: string;
	parentSessionId: string;
	callId: string;
	taskId: string | null;
	policy: unknown;
	directory: string;
}): Binding {
	return {
		role: stripKnownSwarmPrefix(input.role),
		prefixedRole: input.role,
		planId: derivePlanId(input.plan),
		planIdentityHash: derivePlanIdentityHash(input.plan),
		planStructureHash: computePlanStructureHash(input.plan),
		phase: input.phase,
		taskId: input.taskId,
		parentSessionId: input.parentSessionId,
		callId: input.callId,
		policyDigest: policyDigest(input.policy),
		workspace: captureParticipationWorkspace(input.directory),
		capturedAt: Date.now(),
	};
}

function extractPlanTaskId(args: Record<string, unknown>): string | null {
	const raw = args.task_id ?? args.taskId;
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return raw.trim().slice(0, 120);
	}
	const text = [args.prompt, args.description, args.task]
		.filter((value): value is string => typeof value === 'string')
		.join('\n');
	return /(?:^|\n)\s*TASK:\s*(\d+\.\d+(?:\.\d+)*)\b/i.exec(text)?.[1] ?? null;
}

function storePath(directory: string): string {
	return validateSwarmPath(directory, PHASE_PARTICIPATION_FILE);
}

function readRawStore(
	directory: string,
):
	| { status: 'missing' }
	| { status: 'unreadable'; error: unknown }
	| { status: 'oversized'; bytes: number }
	| { status: 'corrupt'; bytes: Buffer }
	| { status: 'valid'; store: Store } {
	let filePath: string;
	try {
		filePath = storePath(directory);
	} catch (error) {
		return { status: 'unreadable', error };
	}
	let descriptor: number | undefined;
	let bytes: Buffer;
	try {
		const pathStat = fs.lstatSync(filePath);
		if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
			return {
				status: 'unreadable',
				error: new Error('Participation projection is not a regular file'),
			};
		}
		if (pathStat.size > MAX_PHASE_PARTICIPATION_BYTES) {
			return { status: 'oversized', bytes: pathStat.size };
		}
		descriptor = fs.openSync(
			filePath,
			fs.constants.O_RDONLY |
				((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
		);
		const openedStat = fs.fstatSync(descriptor);
		if (
			!openedStat.isFile() ||
			openedStat.dev !== pathStat.dev ||
			openedStat.ino !== pathStat.ino
		) {
			return {
				status: 'unreadable',
				error: new Error(
					'Participation projection changed while it was being opened',
				),
			};
		}
		if (openedStat.size > MAX_PHASE_PARTICIPATION_BYTES) {
			return { status: 'oversized', bytes: openedStat.size };
		}
		const bounded = Buffer.allocUnsafe(MAX_PHASE_PARTICIPATION_BYTES + 1);
		let offset = 0;
		while (offset < bounded.byteLength) {
			const read = fs.readSync(
				descriptor,
				bounded,
				offset,
				bounded.byteLength - offset,
				null,
			);
			if (read === 0) break;
			offset += read;
		}
		if (offset > MAX_PHASE_PARTICIPATION_BYTES) {
			return { status: 'oversized', bytes: offset };
		}
		bytes = bounded.subarray(0, offset);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return { status: 'missing' };
		return { status: 'unreadable', error };
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The read result still fails closed if the descriptor cannot close.
			}
		}
	}
	try {
		return {
			status: 'valid',
			store: StoreSchema.parse(JSON.parse(bytes.toString('utf8'))),
		};
	} catch {
		return { status: 'corrupt', bytes };
	}
}

/**
 * Canonical atomic write for the bytes store (issue #2035): containment,
 * registered `canonical-v1` temp grammar, fsync, bounded rename retry, exact
 * own-temp cleanup, and cache invalidation. The historical
 * `target.tmp.<pid>.<ts>` grammar stays registered for residue discovery.
 */
async function atomicWriteBytes(
	filePath: string,
	bytes: Buffer,
): Promise<void> {
	await atomicWriteSwarmFile(filePath, bytes);
}

async function readBoundedRegularFile(
	filePath: string,
	maxBytes: number,
): Promise<Buffer> {
	const pathStat = await fs.promises.lstat(filePath);
	if (
		pathStat.isSymbolicLink() ||
		!pathStat.isFile() ||
		pathStat.size > maxBytes
	) {
		throw new Error(
			'bounded evidence artifact is not a permitted regular file',
		);
	}
	const handle = await fs.promises.open(
		filePath,
		fs.constants.O_RDONLY |
			((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
	);
	try {
		const openedStat = await handle.stat();
		if (
			!openedStat.isFile() ||
			openedStat.dev !== pathStat.dev ||
			openedStat.ino !== pathStat.ino ||
			openedStat.size > maxBytes
		) {
			throw new Error('bounded evidence artifact changed while being opened');
		}
		const bounded = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset < bounded.byteLength) {
			const { bytesRead } = await handle.read(
				bounded,
				offset,
				bounded.byteLength - offset,
				null,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > maxBytes) {
			throw new Error('bounded evidence artifact exceeds its byte limit');
		}
		return bounded.subarray(0, offset);
	} finally {
		try {
			await handle.close();
		} catch {
			// Best-effort close after a bounded read.
		}
	}
}

function quarantineFullError(): Error {
	return new Error(
		'PHASE_PARTICIPATION_QUARANTINE_FULL: preserved corrupt evidence reached its bounded retention limit; an operator must archive the quarantine before docs can be re-dispatched.',
	);
}

async function quarantineCorruptBytes(
	directory: string,
	bytes: Buffer,
): Promise<void> {
	const digest = sha256(bytes);
	const quarantineDir = validateSwarmPath(
		directory,
		PHASE_PARTICIPATION_QUARANTINE_DIR,
	);
	await fs.promises.mkdir(quarantineDir, { recursive: true });
	const quarantineStat = await fs.promises.lstat(quarantineDir);
	if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) {
		throw new Error(
			'PHASE_PARTICIPATION_QUARANTINE_UNREADABLE: quarantine is not a regular directory.',
		);
	}
	const target = validateSwarmPath(
		directory,
		`${PHASE_PARTICIPATION_QUARANTINE_DIR}/${digest}.bin`,
	);
	try {
		const existing = await readBoundedRegularFile(
			target,
			MAX_PHASE_PARTICIPATION_BYTES,
		);
		if (!existing.equals(bytes)) {
			throw new Error('hash-addressed quarantine content mismatch');
		}
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	let count = 0;
	let totalBytes = 0;
	let scanned = 0;
	const handle = await fs.promises.opendir(quarantineDir, { bufferSize: 16 });
	try {
		for await (const entry of handle) {
			scanned += 1;
			if (scanned > MAX_PHASE_PARTICIPATION_QUARANTINE_DIRECTORY_ENTRIES) {
				throw quarantineFullError();
			}
			if (!entry.isFile() || !/^[a-f0-9]{64}\.bin$/.test(entry.name)) continue;
			count += 1;
			const candidate = validateSwarmPath(
				directory,
				`${PHASE_PARTICIPATION_QUARANTINE_DIR}/${entry.name}`,
			);
			const candidateStat = await fs.promises.lstat(candidate);
			if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
				throw new Error(
					'PHASE_PARTICIPATION_QUARANTINE_UNREADABLE: invalid quarantine artifact.',
				);
			}
			totalBytes += candidateStat.size;
			if (
				count >= MAX_PHASE_PARTICIPATION_QUARANTINE_FILES ||
				totalBytes + bytes.byteLength > MAX_PHASE_PARTICIPATION_QUARANTINE_BYTES
			) {
				throw quarantineFullError();
			}
		}
	} finally {
		try {
			await handle.close();
		} catch {
			// Async iteration closes the directory after normal completion.
		}
	}
	await atomicWriteBytes(target, bytes);
}

async function loadWritableStoreUnderLock(directory: string): Promise<Store> {
	const read = readRawStore(directory);
	if (read.status === 'missing') return emptyStore();
	if (read.status === 'valid') return read.store;
	if (read.status === 'corrupt') {
		await quarantineCorruptBytes(directory, read.bytes);
		return emptyStore();
	}
	if (read.status === 'oversized') {
		throw new Error(
			`PHASE_PARTICIPATION_OVERSIZED: ${read.bytes} bytes exceeds ${MAX_PHASE_PARTICIPATION_BYTES}; operator action is required before docs can be re-dispatched.`,
		);
	}
	throw new Error(
		'PHASE_PARTICIPATION_UNREADABLE: operator action is required before docs can be re-dispatched.',
	);
}

async function writeStore(directory: string, store: Store): Promise<void> {
	let validatedStore = StoreSchema.parse(store);
	validatedStore.pending.sort(
		(left, right) => left.capturedAt - right.capturedAt,
	);
	validatedStore.receipts.sort(
		(left, right) => left.completedAt - right.completedAt,
	);
	let serialized = JSON.stringify(validatedStore, null, 2);
	while (
		Buffer.byteLength(serialized, 'utf8') > MAX_PHASE_PARTICIPATION_BYTES
	) {
		const pendingTime = validatedStore.pending[0]?.capturedAt ?? Infinity;
		const receiptTime = validatedStore.receipts[0]?.completedAt ?? Infinity;
		if (pendingTime === Infinity && receiptTime === Infinity) {
			throw new Error(
				'PHASE_PARTICIPATION_WRITE_OVERSIZED: even an empty participation store exceeds its byte limit.',
			);
		}
		if (pendingTime <= receiptTime) validatedStore.pending.shift();
		else validatedStore.receipts.shift();
		validatedStore = StoreSchema.parse(validatedStore);
		serialized = JSON.stringify(validatedStore, null, 2);
	}
	await fs.promises.mkdir(path.dirname(storePath(directory)), {
		recursive: true,
	});
	await atomicWriteFile(storePath(directory), serialized);
}

function bindingMatchesPlan(
	binding: Binding,
	plan: Plan,
	phase: number,
): boolean {
	return (
		binding.planId === derivePlanId(plan) &&
		binding.planIdentityHash === derivePlanIdentityHash(plan) &&
		binding.planStructureHash === computePlanStructureHash(plan) &&
		binding.phase === phase
	);
}

function workspaceIdentityIsFresh(
	expected: ParticipationWorkspace,
	current: ParticipationWorkspace,
): boolean {
	return (
		path.resolve(expected.directory) === path.resolve(current.directory) &&
		expected.gitHead === current.gitHead &&
		expected.prHeadSha === current.prHeadSha
	);
}

function resultText(output: unknown): {
	text: string;
	childSessionId: string | null;
} {
	if (!output || typeof output !== 'object')
		return { text: '', childSessionId: null };
	const record = output as Record<string, unknown>;
	const rawOutput = typeof record.output === 'string' ? record.output : '';
	const envelope = parseTaskEnvelope(rawOutput);
	if (envelope?.state === 'completed') {
		return {
			text: envelope.resultText ?? '',
			childSessionId: envelope.sessionId,
		};
	}
	return { text: rawOutput, childSessionId: null };
}

function envelopeFromOutput(output: unknown): TaskEnvelope | null {
	if (typeof output === 'string') return parseTaskEnvelope(output);
	if (!output || typeof output !== 'object') return null;
	const rawOutput = (output as Record<string, unknown>).output;
	return typeof rawOutput === 'string' ? parseTaskEnvelope(rawOutput) : null;
}

function validateMetadata(
	output: unknown,
	parentSessionId: string,
	childSessionId: string | null,
): { valid: boolean; childSessionId: string | null } {
	if (!output || typeof output !== 'object') {
		return { valid: true, childSessionId };
	}
	const metadata = (output as Record<string, unknown>).metadata;
	if (!metadata || typeof metadata !== 'object') {
		return { valid: true, childSessionId };
	}
	const meta = metadata as Record<string, unknown>;
	if (
		typeof meta.parentSessionId === 'string' &&
		meta.parentSessionId !== parentSessionId
	) {
		return { valid: false, childSessionId: null };
	}
	const metadataChild =
		typeof meta.sessionId === 'string' && meta.sessionId.length > 0
			? meta.sessionId
			: null;
	if (childSessionId && metadataChild && childSessionId !== metadataChild) {
		return { valid: false, childSessionId: null };
	}
	return { valid: true, childSessionId: childSessionId ?? metadataChild };
}

function addReceipt(
	store: Store,
	pending: Pending,
	text: string,
	childIdentityAvailable: boolean,
): void {
	const receiptId = sha256(
		stableCanonicalStringify({
			parentSessionId: pending.parentSessionId,
			callId: pending.callId,
			childSessionId: pending.childSessionId,
			planIdentityHash: pending.planIdentityHash,
			planStructureHash: pending.planStructureHash,
			phase: pending.phase,
			role: pending.role,
		}),
	);
	const receipt: Receipt = {
		...pending,
		receiptId,
		resultDigest: sha256(text),
		completedAt: Date.now(),
		childIdentityAvailable,
	};
	store.receipts = store.receipts.filter(
		(existing) =>
			existing.receiptId !== receiptId &&
			!(
				existing.planIdentityHash === receipt.planIdentityHash &&
				existing.planStructureHash === receipt.planStructureHash &&
				existing.phase === receipt.phase &&
				existing.role === receipt.role
			),
	);
	store.receipts.push(receipt);
	store.receipts = store.receipts.slice(-MAX_PHASE_PARTICIPATION_RECEIPTS);
}

export async function reserveApprovedPhaseParticipation(input: {
	directory: string;
	tool: string;
	parentSessionId: string;
	callId: string;
	args: Record<string, unknown>;
	policy: unknown;
}): Promise<void> {
	if (input.tool.toLowerCase() !== 'task') return;
	const rawRole = input.args.subagent_type;
	if (
		typeof rawRole !== 'string' ||
		stripKnownSwarmPrefix(rawRole) !== 'docs'
	) {
		return;
	}
	const plan = await loadPlan(input.directory);
	if (!plan) return;
	const binding = buildBinding({
		plan,
		phase: getCurrentPhase(plan),
		role: rawRole,
		parentSessionId: input.parentSessionId,
		callId: input.callId,
		taskId: extractPlanTaskId(input.args),
		policy: input.policy,
		directory: input.directory,
	});
	// A real re-dispatch is the sanctioned recovery path for a corrupt readable
	// projection. Recover it before the agent runs so a completed docs call never
	// loses its only chance to persist proof.
	await withEvidenceLock(
		input.directory,
		PHASE_PARTICIPATION_FILE,
		'docs',
		'phase-participation',
		async () => {
			const store = await loadWritableStoreUnderLock(input.directory);
			await writeStore(input.directory, store);
		},
	);
	boundedPut(binding);
}

export async function observePhaseParticipationToolResult(input: {
	directory: string;
	tool: string;
	parentSessionId: string;
	callId: string;
	output: unknown;
}): Promise<void> {
	if (input.tool.toLowerCase() !== 'task') return;
	const binding = takeBinding(input.parentSessionId, input.callId);
	if (!binding) return;
	const envelope = envelopeFromOutput(input.output);
	if (envelope?.state === 'running') {
		const { subagentSessionId } = extractDispatchIds(input.output);
		if (!subagentSessionId || subagentSessionId !== envelope.sessionId) return;
		const pending: Pending = { ...binding, childSessionId: subagentSessionId };
		await persistWithBindingRecovery(input.directory, binding, async () => {
			const store = await loadWritableStoreUnderLock(input.directory);
			store.pending = store.pending.filter(
				(existing) =>
					existing.childSessionId !== pending.childSessionId &&
					!(
						existing.parentSessionId === pending.parentSessionId &&
						existing.callId === pending.callId
					),
			);
			store.pending.push(pending);
			store.pending = store.pending.slice(-MAX_PHASE_PARTICIPATION_PENDING);
			await writeStore(input.directory, store);
		});
		return;
	}
	if (envelope && envelope.state !== 'completed') return;
	const classification = classifyTaskResult(input.output);
	if (classification !== 'success') return;
	const extracted = resultText(input.output);
	const text = extracted.text.trim();
	if (!text) return;
	const metadata = validateMetadata(
		input.output,
		input.parentSessionId,
		extracted.childSessionId,
	);
	if (!metadata.valid) return;
	const childSessionId = metadata.childSessionId;
	const currentPlan = await loadPlan(input.directory);
	if (!currentPlan || !bindingMatchesPlan(binding, currentPlan, binding.phase))
		return;
	if (
		!workspaceIdentityIsFresh(
			binding.workspace,
			captureParticipationWorkspace(input.directory),
		)
	) {
		return;
	}
	const pending: Pending = {
		...binding,
		childSessionId:
			childSessionId ??
			`unavailable:${sha256(correlationKey(input.parentSessionId, input.callId))}`,
	};
	await persistWithBindingRecovery(input.directory, binding, async () => {
		const store = await loadWritableStoreUnderLock(input.directory);
		addReceipt(store, pending, text, childSessionId !== null);
		await writeStore(input.directory, store);
	});
}

export async function completeBackgroundPhaseParticipation(input: {
	directory: string;
	record: BackgroundDelegationRecord;
	resultText: string;
}): Promise<boolean> {
	if (stripKnownSwarmPrefix(input.record.normalizedAgent) !== 'docs')
		return false;
	const text = input.resultText.trim();
	if (!text) return false;
	return withEvidenceLock(
		input.directory,
		PHASE_PARTICIPATION_FILE,
		'docs',
		'phase-participation',
		async () => {
			const store = await loadWritableStoreUnderLock(input.directory);
			const currentPlan = await loadPlan(input.directory);
			const existingReceipt = store.receipts.find(
				(receipt) =>
					receipt.childSessionId === input.record.subagentSessionId &&
					receipt.parentSessionId === input.record.parentSessionId &&
					receipt.callId === input.record.callID &&
					receipt.role === input.record.normalizedAgent &&
					receipt.prefixedRole === input.record.swarmPrefixedAgent &&
					receipt.taskId === input.record.planTaskId,
			);
			if (
				existingReceipt &&
				currentPlan &&
				bindingMatchesPlan(existingReceipt, currentPlan, existingReceipt.phase)
			) {
				return true;
			}
			const pending = store.pending.find(
				(candidate) =>
					candidate.childSessionId === input.record.subagentSessionId &&
					candidate.parentSessionId === input.record.parentSessionId &&
					candidate.callId === input.record.callID &&
					candidate.role === input.record.normalizedAgent &&
					candidate.prefixedRole === input.record.swarmPrefixedAgent &&
					candidate.taskId === input.record.planTaskId,
			);
			if (!pending) return false;
			const plan = currentPlan;
			if (!plan || !bindingMatchesPlan(pending, plan, pending.phase))
				return false;
			// Docs agents legitimately change the dirty tree. Preserve workspace
			// freshness by binding the project root and repository/PR identity while
			// allowing the documentation changes that the role exists to author.
			if (
				!workspaceIdentityIsFresh(
					pending.workspace,
					captureParticipationWorkspace(input.directory),
				)
			) {
				return false;
			}
			if (
				pending.taskId !== null &&
				input.record.ingestion?.state !== 'consumed'
			) {
				return false;
			}
			addReceipt(store, pending, text, true);
			store.pending = store.pending.filter(
				(candidate) => candidate.childSessionId !== pending.childSessionId,
			);
			await writeStore(input.directory, store);
			return true;
		},
	);
}

export function readPhaseParticipation(
	directory: string,
	plan: Plan,
	phase: number,
	role: string,
): ParticipationReadResult {
	const read = readRawStore(directory);
	if (read.status !== 'valid') {
		return { status: read.status, found: false };
	}
	const canonicalRole = stripKnownSwarmPrefix(role);
	const currentWorkspace = captureParticipationWorkspace(directory);
	return {
		status: 'valid',
		found: read.store.receipts.some(
			(receipt) =>
				receipt.role === canonicalRole &&
				bindingMatchesPlan(receipt, plan, phase) &&
				workspaceIdentityIsFresh(receipt.workspace, currentWorkspace),
		),
	};
}

export function resetPhaseParticipationForTests(): void {
	foregroundReservations.clear();
}
