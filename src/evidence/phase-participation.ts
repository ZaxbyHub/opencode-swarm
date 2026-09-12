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
import { captureWorkspaceSnapshotAsync } from '../background/workspace-snapshot.js';
import { getCurrentPhase, type Plan } from '../config/plan-schema.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	collectPlanTaskIdContextFromPhases,
	toTaskIdPlanContextOptions,
} from '../hooks/plan-task-id-context.js';
import { resolveTaskId } from '../hooks/task-id-resolver.js';
import { classifyTaskResult } from '../hooks/task-result-classifier.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { computePlanStructureHash } from '../plan/ledger.js';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { sameProjectRoot } from '../utils/canonical-root.js';
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

/**
 * Async (issue #2472 W11/R-2): this helper was the last sync capture twin call
 * reachable from the per-tool-call hook chains (the toolBefore docs-Task
 * reserve via `buildBinding`, and the toolAfter completing-docs-Task observe).
 * It routes through `captureWorkspaceSnapshotAsync` so no hook path in this
 * module sync-spawns git. Non-hook callers (background observer, the
 * phase-complete tool read) await the same helper.
 */
async function captureParticipationWorkspace(
	directory: string,
): Promise<ParticipationWorkspace> {
	const workspace = await captureWorkspaceSnapshotAsync(directory, {
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

async function buildBinding(input: {
	plan: Plan;
	phase: number;
	role: string;
	parentSessionId: string;
	callId: string;
	taskId: string | null;
	policy: unknown;
	directory: string;
}): Promise<Binding> {
	return {
		role: stripKnownSwarmPrefix(input.role),
		prefixedRole: input.role,
		planId: derivePlanId(input.plan),
		planIdentityHash: derivePlanIdentityHash(input.plan),
		planStructureHash: receiptStructureHash(input.plan),
		phase: input.phase,
		taskId: input.taskId,
		parentSessionId: input.parentSessionId,
		callId: input.callId,
		policyDigest: policyDigest(input.policy),
		workspace: await captureParticipationWorkspace(input.directory),
		capturedAt: Date.now(),
	};
}

function extractPlanTaskId(
	args: Record<string, unknown>,
	plan: Plan,
): string | null {
	const context = collectPlanTaskIdContextFromPhases(plan.phases);
	const result = resolveTaskId(args, {
		policy: 'plan',
		...toTaskIdPlanContextOptions(context),
	});
	if (result.status !== 'resolved') return null;
	if (
		context.status === 'over_limit' &&
		!plan.phases.some((phase) =>
			phase?.tasks?.some((task) => task?.id === result.taskId),
		)
	) {
		return null;
	}
	return result.taskId;
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

/**
 * Receipt-identity structure hash (issue #2532 follow-up): the plan structure
 * hash with the `current_phase` cursor pinned out.
 *
 * Since #2532, `current_phase` is a LIVE advancing cursor (one durable writer
 * in `savePlan`), and it is part of `computePlanStructureHash`. A docs receipt
 * stamped mid-phase N must stay verifiable after the cursor advances to N+1
 * at phase N's last task completion — an advance is execution progress, not a
 * plan edit — so the receipt identity hashes the structure WITHOUT the
 * cursor. Structural edits (descriptions, tasks, files, dependencies) still
 * rotate the identity and force docs re-dispatch. `computePlanStructureHash`
 * bytes are untouched (they are load-bearing for scope bindings and approved
 * snapshots); only this consumer hashes the cursor-pinned view.
 */
function receiptStructureHash(plan: Plan): string {
	return computePlanStructureHash({ ...plan, current_phase: undefined });
}

function samePlanIdentity(
	binding: Pick<Binding, 'planId' | 'planIdentityHash' | 'planStructureHash'>,
	plan: Plan,
): boolean {
	return (
		binding.planId === derivePlanId(plan) &&
		binding.planIdentityHash === derivePlanIdentityHash(plan) &&
		binding.planStructureHash === receiptStructureHash(plan)
	);
}

function bindingMatchesPlan(
	binding: Binding,
	plan: Plan,
	phase: number,
): boolean {
	return samePlanIdentity(binding, plan) && binding.phase === phase;
}

function workspaceIdentityIsFresh(
	expected: ParticipationWorkspace,
	current: ParticipationWorkspace,
): boolean {
	return (
		sameProjectRoot(expected.directory, current.directory) &&
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

function computeReceiptId(input: {
	parentSessionId: string;
	callId: string;
	childSessionId: string;
	planIdentityHash: string;
	planStructureHash: string;
	phase: number;
	role: string;
}): string {
	return sha256(
		stableCanonicalStringify({
			parentSessionId: input.parentSessionId,
			callId: input.callId,
			childSessionId: input.childSessionId,
			planIdentityHash: input.planIdentityHash,
			planStructureHash: input.planStructureHash,
			phase: input.phase,
			role: input.role,
		}),
	);
}

function addReceipt(
	store: Store,
	pending: Pending,
	text: string,
	childIdentityAvailable: boolean,
): void {
	const receiptId = computeReceiptId(pending);
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
	// Issue #2532: `current_phase` is a LIVE advancing cursor (one durable
	// writer in savePlan advances it when a phase's last task completes), so
	// this stamp is the cursor at dispatch time — typically the phase being
	// worked, but it can lag or lead across async docs runs. Never consume it
	// as an exact gate key: readPhaseParticipation matches cursor-tagged
	// receipts through its cursor tolerance, and rebindCursorTaggedReceipts
	// normalizes them to the completed phase on the phase_complete success
	// path. The binding's structure hash is cursor-independent
	// (receiptStructureHash), so the advance itself never invalidates the
	// receipt — only a real plan edit does.
	const binding = await buildBinding({
		plan,
		phase: getCurrentPhase(plan),
		role: rawRole,
		parentSessionId: input.parentSessionId,
		callId: input.callId,
		taskId: extractPlanTaskId(input.args, plan),
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
			await captureParticipationWorkspace(input.directory),
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
					await captureParticipationWorkspace(input.directory),
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

export async function readPhaseParticipation(
	directory: string,
	plan: Plan,
	phase: number,
	role: string,
): Promise<ParticipationReadResult> {
	const read = readRawStore(directory);
	if (read.status !== 'valid') {
		return { status: read.status, found: false };
	}
	const canonicalRole = stripKnownSwarmPrefix(role);
	const currentWorkspace = await captureParticipationWorkspace(directory);
	// The recorder stamps the receipt's phase from the plan's `current_phase`
	// cursor at dispatch time (see reserveApprovedPhaseParticipation). Since
	// #2532 that cursor advances when a phase's last task completes, so a
	// receipt may be tagged behind (dispatched before the previous phase
	// closed) or exactly at the completing phase; the receipt identity hash is
	// cursor-independent (receiptStructureHash), so cursor movement alone
	// never invalidates it. The cursor-mistag arm only ever accepts a tag
	// BEHIND the completing phase — a receipt tagged with a LATER phase never
	// satisfies an earlier one, and an exact-phase match covers the ordinary
	// sequential flow. Any other phase stays rejected.
	const cursorPhase = getCurrentPhase(plan);
	return {
		status: 'valid',
		found: read.store.receipts.some(
			(receipt) =>
				receipt.role === canonicalRole &&
				samePlanIdentity(receipt, plan) &&
				workspaceIdentityIsFresh(receipt.workspace, currentWorkspace) &&
				(receipt.phase === phase ||
					(receipt.phase === cursorPhase && cursorPhase < phase)),
		),
	};
}

/**
 * Re-stamp receipts that were tagged with the plan's `current_phase` cursor
 * at dispatch time (issue #2702 origin; the cursor is live since #2532) to
 * the phase whose completion is being recorded. Called
 * from the phase_complete success path so a cursor-mistagged receipt, once it
 * has satisfied the completing phase's gate, cannot also satisfy a later
 * phase — per-phase docs participation stays enforced. Idempotent: a second
 * run finds nothing left cursor-tagged.
 *
 * A lock-free pre-read skips the evidence lock when nothing is cursor-tagged —
 * the common completion — so callers never contend the store lock for a no-op.
 * If a writer lands a cursor-tagged receipt between the pre-read and the
 * decision, the receipt simply stays cursor-tagged: the gate's cursor
 * tolerance still matches it at the next completion, which rebinds then.
 */
export async function rebindCursorTaggedReceipts(
	directory: string,
	plan: Plan,
	phase: number,
	role: string,
): Promise<{ rebound: number }> {
	const canonicalRole = stripKnownSwarmPrefix(role);
	const cursorPhase = getCurrentPhase(plan);
	const peek = readRawStore(directory);
	const hasCandidate =
		peek.status === 'valid' &&
		peek.store.receipts.some(
			(receipt) =>
				receipt.role === canonicalRole &&
				samePlanIdentity(receipt, plan) &&
				receipt.phase === cursorPhase &&
				cursorPhase < phase,
		);
	if (!hasCandidate) return { rebound: 0 };
	return withEvidenceLock(
		directory,
		PHASE_PARTICIPATION_FILE,
		'docs',
		'phase-participation',
		async () => {
			const store = await loadWritableStoreUnderLock(directory);
			let rebound = 0;
			for (const receipt of store.receipts) {
				if (
					receipt.role === canonicalRole &&
					samePlanIdentity(receipt, plan) &&
					receipt.phase === cursorPhase &&
					cursorPhase < phase
				) {
					receipt.phase = phase;
					receipt.receiptId = computeReceiptId(receipt);
					rebound += 1;
				}
			}
			if (rebound > 0) {
				// Mirrors addReceipt's dedupe key: keep at most one receipt per
				// (plan identity, structure, phase, role), newest wins.
				const newestByKey = new Map<string, Receipt>();
				for (const receipt of store.receipts
					.slice()
					.sort((left, right) => left.completedAt - right.completedAt)) {
					newestByKey.set(
						`${receipt.planIdentityHash}\u0000${receipt.planStructureHash}\u0000${receipt.phase}\u0000${receipt.role}`,
						receipt,
					);
				}
				store.receipts = [...newestByKey.values()];
				await writeStore(directory, store);
			}
			return { rebound };
		},
	);
}

export function resetPhaseParticipationForTests(): void {
	foregroundReservations.clear();
}
