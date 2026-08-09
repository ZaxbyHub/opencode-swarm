import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../utils';

const PROVISIONING_OWNER_DIR = 'worktree-provisioning-owners';
const MAX_PROVISIONING_OWNERS = 512;
const MAX_PROVISIONING_OWNER_BYTES = 16 * 1024;
export const WORKTREE_LIFECYCLE_LOCK_FILE =
	'.swarm/locks/init-orphan-recovery.lock';

export interface WorktreeProvisioningOwner {
	schemaVersion: 1 | 2;
	callID: string;
	parentSessionId: string;
	worktreeSessionId: string;
	/** Added in v2 so restart collision checks can identify the exact lane. */
	taskId?: string;
	createdAt: number;
}

export type WorktreeProvisioningOwnerScan =
	| { status: 'ok'; owners: WorktreeProvisioningOwner[] }
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

function isOwner(value: unknown): value is WorktreeProvisioningOwner {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const schemaVersion = candidate.schemaVersion;
	const validTaskIdentity =
		schemaVersion === 1
			? candidate.taskId === undefined
			: schemaVersion === 2 &&
				typeof candidate.taskId === 'string' &&
				candidate.taskId.length > 0 &&
				candidate.taskId.length <= 512;
	return (
		(schemaVersion === 1 || schemaVersion === 2) &&
		validTaskIdentity &&
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

/**
 * Publish a provisional owner before a standard worktree can be created.
 * Callers hold the shared orphan-recovery lifecycle lock during this atomic
 * write, closing the gap between recovery's owner snapshot and provisioning.
 */
export function recordWorktreeProvisioningOwner(
	directory: string,
	input: Omit<WorktreeProvisioningOwner, 'schemaVersion' | 'createdAt'>,
): WorktreeProvisioningOwner {
	const owner: WorktreeProvisioningOwner = {
		schemaVersion: input.taskId ? 2 : 1,
		callID: input.callID,
		parentSessionId: input.parentSessionId,
		worktreeSessionId: input.worktreeSessionId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		createdAt: Date.now(),
	};
	if (!isOwner(owner)) {
		throw new Error('invalid worktree provisioning owner');
	}
	const absolutePath = ownerPath(directory, input.callID);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	const tempPath = `${absolutePath}.tmp-${randomBytes(8).toString('hex')}`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(owner)}\n`, {
			encoding: 'utf8',
			flag: 'wx',
		});
		fs.renameSync(tempPath, absolutePath);
	} catch (error) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// best-effort
		}
		throw error;
	}
	return owner;
}

/** Remove a provisional owner only after durable ownership or cleanup exists. */
export function removeWorktreeProvisioningOwner(
	directory: string,
	callID: string,
): boolean {
	try {
		fs.unlinkSync(ownerPath(directory, callID));
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
