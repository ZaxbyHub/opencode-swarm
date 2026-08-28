import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSwarmFileSync } from '../../utils/atomic-write';
import { validateSwarmPath } from '../utils';

const PROVISIONING_OWNER_DIR = 'worktree-provisioning-owners';
const MAX_PROVISIONING_OWNERS = 512;
const MAX_PROVISIONING_OWNER_BYTES = 16 * 1024;
const PROVISIONING_JOURNAL_PATH = path.join(
	'.swarm',
	'worktree-provisioning-lifecycle.json',
);
const MAX_PROVISIONING_JOURNAL_BYTES = 256 * 1024;
const MAX_PROVISIONING_JOURNAL_ENTRIES = 512;
/**
 * A provisional marker covers the bounded gap before `git worktree add`
 * materializes the exact lane path. Once that path exists, path liveness wins
 * and the marker remains protected regardless of age.
 */
export const WORKTREE_PROVISIONING_OWNER_LEASE_MS = 5 * 60 * 1000;
export const WORKTREE_LIFECYCLE_LOCK_FILE =
	'.swarm/locks/init-orphan-recovery.lock';
export const WORKTREE_PROVISIONING_LIFECYCLE_STATES = [
	'OWNER_PUBLISHED',
	'OWNER_REMOVED',
] as const;

export type WorktreeProvisioningLifecycleState =
	(typeof WORKTREE_PROVISIONING_LIFECYCLE_STATES)[number];

export interface WorktreeProvisioningOwner {
	schemaVersion: 1 | 2 | 3;
	callID: string;
	parentSessionId: string;
	worktreeSessionId: string;
	/** Added in v2 so restart collision checks can identify the exact lane. */
	taskId?: string;
	/** Added in v3 so restart recovery can correlate the exact reservation. */
	reservationId?: string;
	/** Added in v3 so restart recovery can fence same-task retries. */
	generation?: number;
	/** Added in v3 so crash recovery can corroborate the exact lane ref. */
	branchName?: string;
	createdAt: number;
}

export type WorktreeProvisioningOwnerRemovalIdentity = Pick<
	WorktreeProvisioningOwner,
	'reservationId' | 'generation' | 'branchName'
>;

export interface WorktreeProvisioningLifecycleEntry {
	schemaVersion: 1;
	state: WorktreeProvisioningLifecycleState;
	callID: string;
	parentSessionId: string;
	worktreeSessionId: string;
	taskId?: string;
	reservationId?: string;
	generation?: number;
	branchName?: string;
	recordedAt: number;
}

interface WorktreeProvisioningLifecycleJournal {
	schemaVersion: 1;
	entries: WorktreeProvisioningLifecycleEntry[];
}

export type WorktreeProvisioningOwnerScan =
	| { status: 'ok'; owners: WorktreeProvisioningOwner[] }
	| { status: 'uncertain'; reason: string };

export type WorktreeProvisioningLifecycleJournalScan =
	| { status: 'ok'; entries: WorktreeProvisioningLifecycleEntry[] }
	| { status: 'uncertain'; reason: string };

function ownerDirectory(directory: string): string {
	return path.dirname(
		validateSwarmPath(
			directory,
			path.join(PROVISIONING_OWNER_DIR, '.containment-anchor'),
		),
	);
}

function ownerPath(directory: string, callID: string): string {
	const digest = createHash('sha256').update(callID).digest('hex');
	return validateSwarmPath(
		directory,
		path.join(PROVISIONING_OWNER_DIR, `${digest}.json`),
	);
}

function journalPath(directory: string): string {
	return validateSwarmPath(directory, PROVISIONING_JOURNAL_PATH);
}

function isOwner(value: unknown): value is WorktreeProvisioningOwner {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const schemaVersion = candidate.schemaVersion;
	const validTaskIdentity =
		schemaVersion === 1
			? candidate.taskId === undefined &&
				candidate.reservationId === undefined &&
				candidate.generation === undefined &&
				candidate.branchName === undefined
			: schemaVersion === 2 &&
				typeof candidate.taskId === 'string' &&
				candidate.taskId.length > 0 &&
				candidate.taskId.length <= 512 &&
				candidate.reservationId === undefined &&
				candidate.generation === undefined &&
				candidate.branchName === undefined;
	const validV3Identity =
		schemaVersion === 3 &&
		typeof candidate.taskId === 'string' &&
		candidate.taskId.length > 0 &&
		candidate.taskId.length <= 512 &&
		typeof candidate.reservationId === 'string' &&
		candidate.reservationId.length > 0 &&
		candidate.reservationId.length <= 512 &&
		typeof candidate.generation === 'number' &&
		Number.isInteger(candidate.generation) &&
		candidate.generation > 0 &&
		typeof candidate.branchName === 'string' &&
		candidate.branchName.length > 0 &&
		candidate.branchName.length <= 1024;
	return (
		(schemaVersion === 1 || schemaVersion === 2 || schemaVersion === 3) &&
		(validTaskIdentity || validV3Identity) &&
		typeof candidate.callID === 'string' &&
		candidate.callID.length > 0 &&
		candidate.callID.length <= 512 &&
		typeof candidate.parentSessionId === 'string' &&
		candidate.parentSessionId.length > 0 &&
		candidate.parentSessionId.length <= 512 &&
		typeof candidate.worktreeSessionId === 'string' &&
		candidate.worktreeSessionId.length > 0 &&
		candidate.worktreeSessionId.length <= 512 &&
		typeof candidate.createdAt === 'number' &&
		Number.isFinite(candidate.createdAt) &&
		candidate.createdAt >= 0
	);
}

function isLifecycleEntry(
	value: unknown,
): value is WorktreeProvisioningLifecycleEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const validState = WORKTREE_PROVISIONING_LIFECYCLE_STATES.includes(
		candidate.state as WorktreeProvisioningLifecycleState,
	);
	return (
		candidate.schemaVersion === 1 &&
		validState &&
		typeof candidate.callID === 'string' &&
		candidate.callID.length > 0 &&
		candidate.callID.length <= 512 &&
		typeof candidate.parentSessionId === 'string' &&
		candidate.parentSessionId.length > 0 &&
		candidate.parentSessionId.length <= 512 &&
		typeof candidate.worktreeSessionId === 'string' &&
		candidate.worktreeSessionId.length > 0 &&
		candidate.worktreeSessionId.length <= 512 &&
		(candidate.taskId === undefined ||
			(typeof candidate.taskId === 'string' &&
				candidate.taskId.length > 0 &&
				candidate.taskId.length <= 512)) &&
		(candidate.reservationId === undefined ||
			(typeof candidate.reservationId === 'string' &&
				candidate.reservationId.length > 0 &&
				candidate.reservationId.length <= 512)) &&
		(candidate.generation === undefined ||
			(typeof candidate.generation === 'number' &&
				Number.isInteger(candidate.generation) &&
				candidate.generation > 0)) &&
		(candidate.branchName === undefined ||
			(typeof candidate.branchName === 'string' &&
				candidate.branchName.length > 0 &&
				candidate.branchName.length <= 1024)) &&
		typeof candidate.recordedAt === 'number' &&
		Number.isFinite(candidate.recordedAt) &&
		candidate.recordedAt >= 0
	);
}

function readBoundedJsonFile<T>(
	filePath: string,
	maxBytes: number,
): { ok: true; value: T | undefined } | { ok: false; reason: string } {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > maxBytes) {
			return {
				ok: false,
				reason: `${path.basename(filePath)} exceeds the ${maxBytes}-byte safety bound`,
			};
		}
		const raw = fs.readFileSync(filePath, 'utf8');
		if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
			return {
				ok: false,
				reason: `${path.basename(filePath)} changed beyond the ${maxBytes}-byte safety bound`,
			};
		}
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { ok: true, value: undefined };
		}
		return {
			ok: false,
			reason: `${path.basename(filePath)} is unreadable or malformed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function readOwner(
	directory: string,
	callID: string,
): WorktreeProvisioningOwner | null {
	const absolutePath = ownerPath(directory, callID);
	const loaded = readBoundedJsonFile<unknown>(
		absolutePath,
		MAX_PROVISIONING_OWNER_BYTES,
	);
	if (!loaded.ok || loaded.value === undefined) return null;
	return isOwner(loaded.value) ? loaded.value : null;
}

function loadLifecycleJournal(
	directory: string,
): WorktreeProvisioningLifecycleJournalScan {
	const loaded = readBoundedJsonFile<unknown>(
		journalPath(directory),
		MAX_PROVISIONING_JOURNAL_BYTES,
	);
	if (!loaded.ok) return { status: 'uncertain', reason: loaded.reason };
	if (loaded.value === undefined) return { status: 'ok', entries: [] };
	const parsed = loaded.value as Record<string, unknown>;
	if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
		return {
			status: 'uncertain',
			reason: 'worktree provisioning lifecycle journal is malformed',
		};
	}
	if (parsed.entries.length > MAX_PROVISIONING_JOURNAL_ENTRIES) {
		return {
			status: 'uncertain',
			reason: `worktree provisioning lifecycle journal exceeds the ${MAX_PROVISIONING_JOURNAL_ENTRIES}-entry safety bound`,
		};
	}
	const entries: WorktreeProvisioningLifecycleEntry[] = [];
	for (const entry of parsed.entries) {
		if (!isLifecycleEntry(entry)) {
			return {
				status: 'uncertain',
				reason:
					'worktree provisioning lifecycle journal contains an invalid entry',
			};
		}
		entries.push(entry);
	}
	return { status: 'ok', entries };
}

function appendLifecycleEntry(
	directory: string,
	owner: WorktreeProvisioningOwner,
	state: WorktreeProvisioningLifecycleState,
): void {
	const loaded = loadLifecycleJournal(directory);
	if (loaded.status === 'uncertain') {
		throw new Error(loaded.reason);
	}
	const entries = [
		...loaded.entries,
		{
			schemaVersion: 1,
			state,
			callID: owner.callID,
			parentSessionId: owner.parentSessionId,
			worktreeSessionId: owner.worktreeSessionId,
			...(owner.taskId ? { taskId: owner.taskId } : {}),
			...(owner.reservationId ? { reservationId: owner.reservationId } : {}),
			...(owner.generation !== undefined
				? { generation: owner.generation }
				: {}),
			...(owner.branchName ? { branchName: owner.branchName } : {}),
			recordedAt: Date.now(),
		} satisfies WorktreeProvisioningLifecycleEntry,
	];
	const journal: WorktreeProvisioningLifecycleJournal = {
		schemaVersion: 1,
		entries: entries.slice(-MAX_PROVISIONING_JOURNAL_ENTRIES),
	};
	atomicWriteSwarmFileSync(
		journalPath(directory),
		JSON.stringify(journal, null, 2),
	);
}

/**
 * Publish a provisional owner before a standard worktree can be created.
 * Callers hold the shared orphan-recovery lifecycle lock during this atomic
 * write, closing the gap between recovery's owner snapshot and provisioning.
 */
export function recordWorktreeProvisioningOwner(
	directory: string,
	input: Omit<WorktreeProvisioningOwner, 'schemaVersion' | 'createdAt'>,
): WorktreeProvisioningOwner {
	const wantsV3 =
		input.reservationId !== undefined ||
		input.generation !== undefined ||
		input.branchName !== undefined;
	if (
		wantsV3 &&
		(!input.taskId ||
			!input.reservationId ||
			input.generation === undefined ||
			!input.branchName)
	) {
		throw new Error(
			'worktree provisioning owner v3 requires taskId, reservationId, generation, and branchName',
		);
	}
	const owner: WorktreeProvisioningOwner = {
		schemaVersion: wantsV3 ? 3 : input.taskId ? 2 : 1,
		callID: input.callID,
		parentSessionId: input.parentSessionId,
		worktreeSessionId: input.worktreeSessionId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.reservationId ? { reservationId: input.reservationId } : {}),
		...(input.generation !== undefined ? { generation: input.generation } : {}),
		...(input.branchName ? { branchName: input.branchName } : {}),
		createdAt: Date.now(),
	};
	if (!isOwner(owner)) {
		throw new Error('invalid worktree provisioning owner');
	}
	const absolutePath = ownerPath(directory, input.callID);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	atomicWriteSwarmFileSync(absolutePath, `${JSON.stringify(owner)}\n`);
	appendLifecycleEntry(directory, owner, 'OWNER_PUBLISHED');
	return owner;
}

/** Remove a provisional owner only after durable ownership or cleanup exists. */
export function removeWorktreeProvisioningOwner(
	directory: string,
	callID: string,
	expected?: WorktreeProvisioningOwnerRemovalIdentity,
): boolean {
	try {
		const owner = readOwner(directory, callID);
		if (
			owner?.schemaVersion === 3 &&
			(!expected ||
				expected.reservationId !== owner.reservationId ||
				expected.generation !== owner.generation ||
				expected.branchName !== owner.branchName)
		) {
			return false;
		}
		fs.unlinkSync(ownerPath(directory, callID));
		if (owner) appendLifecycleEntry(directory, owner, 'OWNER_REMOVED');
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT';
	}
}

/**
 * Strict recovery scan. Anything except ENOENT is uncertainty because omitting
 * one marker could allow destructive cleanup to race a live worktree.
 */
export function scanWorktreeProvisioningOwnersForRecovery(
	directory: string,
): WorktreeProvisioningOwnerScan {
	let directoryPath: string;
	let entries: fs.Dirent[];
	try {
		directoryPath = ownerDirectory(directory);
		entries = fs
			.readdirSync(directoryPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'ok', owners: [] };
		}
		return {
			status: 'uncertain',
			reason: `worktree provisioning-owner directory is unreadable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (entries.length > MAX_PROVISIONING_OWNERS) {
		return {
			status: 'uncertain',
			reason: `worktree provisioning-owner count exceeds the ${MAX_PROVISIONING_OWNERS}-marker safety bound`,
		};
	}

	const owners: WorktreeProvisioningOwner[] = [];
	for (const entry of entries) {
		const absolutePath = path.join(directoryPath, entry.name);
		try {
			const stat = fs.statSync(absolutePath);
			if (stat.size > MAX_PROVISIONING_OWNER_BYTES) {
				return {
					status: 'uncertain',
					reason: `worktree provisioning owner "${entry.name}" exceeds the recovery size bound`,
				};
			}
			const raw = fs.readFileSync(absolutePath, 'utf8');
			if (Buffer.byteLength(raw, 'utf8') > MAX_PROVISIONING_OWNER_BYTES) {
				return {
					status: 'uncertain',
					reason: `worktree provisioning owner "${entry.name}" changed beyond the recovery size bound`,
				};
			}
			const parsed: unknown = JSON.parse(raw);
			if (!isOwner(parsed)) {
				return {
					status: 'uncertain',
					reason: `worktree provisioning owner "${entry.name}" is invalid`,
				};
			}
			owners.push(parsed);
		} catch (error) {
			return {
				status: 'uncertain',
				reason: `worktree provisioning owner "${entry.name}" is unreadable or malformed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}
	return { status: 'ok', owners };
}

export function scanWorktreeProvisioningLifecycleJournalForRecovery(
	directory: string,
): WorktreeProvisioningLifecycleJournalScan {
	return loadLifecycleJournal(directory);
}

export const _internals = {
	getOwnerPath: ownerPath,
	getJournalPath: journalPath,
	readOwner,
};
