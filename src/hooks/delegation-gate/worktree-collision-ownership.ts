import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type BackgroundDelegationRecord,
	type BackgroundWorktreeDescriptor,
	scanDelegationFallbacksForRecovery,
	scanDelegationsForRecovery,
} from '../../background/pending-delegations';
import { scanWorktreeMergeFailuresForRecovery } from './worktree-merge-status';
import { scanBackgroundWorktreeOwnershipTagsForRecovery } from './worktree-ownership-tag';
import {
	removeWorktreeProvisioningOwner,
	scanWorktreeProvisioningOwnersForRecovery,
	WORKTREE_PROVISIONING_OWNER_LEASE_MS,
} from './worktree-provisioning-owner';

/** File-operation seam for deterministic fail-closed recovery tests. */
export const _internals = {
	statSync: fs.statSync,
	removeWorktreeProvisioningOwner,
};

export interface StandardWorktreeCollisionIdentity {
	directory: string;
	parentSessionId: string;
	taskId: string;
	branchName: string;
	worktreePath: string;
}

export type StandardWorktreeCollisionOwnership =
	| { status: 'unowned' }
	| {
			status: 'protected';
			ownerKind:
				| 'primary'
				| 'fallback'
				| 'provisioning'
				| 'ownership-tag'
				| 'merge-status';
			lifecycle: 'active' | 'preserved';
			reason: string;
	  }
	| { status: 'uncertain'; reason: string };

function normalizedPath(value: string): string {
	const resolved = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function descriptorCoordinateMatch(
	descriptor: BackgroundWorktreeDescriptor,
	identity: StandardWorktreeCollisionIdentity,
): 'none' | 'exact' | 'uncertain' {
	const branchMatches = descriptor.branchName === identity.branchName;
	const pathMatches =
		normalizedPath(descriptor.worktreePath) ===
		normalizedPath(identity.worktreePath);
	if (!branchMatches && !pathMatches) return 'none';
	if (
		!branchMatches ||
		!pathMatches ||
		descriptor.parentSessionId !== identity.parentSessionId ||
		descriptor.taskId !== identity.taskId
	) {
		return 'uncertain';
	}
	return 'exact';
}

function isProvenSettled(record: BackgroundDelegationRecord): boolean {
	const settlement = record.coderSettlement;
	return (
		settlement?.state === 'settled' &&
		settlement.outcome?.kind === 'standard-worktree' &&
		(settlement.outcome.result === 'merged' ||
			settlement.outcome.result === 'unchanged')
	);
}

function classifyRecord(
	record: BackgroundDelegationRecord,
	identity: StandardWorktreeCollisionIdentity,
	ownerKind: 'primary' | 'fallback',
): StandardWorktreeCollisionOwnership | null {
	if (!record.worktree) return null;
	const coordinates = descriptorCoordinateMatch(record.worktree, identity);
	if (coordinates === 'none') return null;
	if (coordinates === 'uncertain') {
		return {
			status: 'uncertain',
			reason: `${ownerKind} background owner has conflicting identity for branch "${identity.branchName}"`,
		};
	}
	if (isProvenSettled(record)) return null;
	const lifecycle =
		record.coderSettlement?.state === 'preserved' ? 'preserved' : 'active';
	return {
		status: 'protected',
		ownerKind,
		lifecycle,
		reason:
			`${ownerKind} background owner ${record.correlationId} is ${record.status}` +
			(record.coderSettlement
				? ` with coder settlement ${record.coderSettlement.state}`
				: ' without a settled workspace outcome'),
	};
}

/**
 * Strict restart-time ownership classification for one exact same-session
 * collision. Scanner order is part of the safety contract:
 *
 * provisioning -> fallback -> primary -> ownership tag -> merge status
 *
 * Fallback precedes primary because promotion publishes primary before removing
 * fallback; this ordering cannot observe ownership absent from both stores.
 */
export async function inspectStandardWorktreeCollisionOwnership(
	identity: StandardWorktreeCollisionIdentity,
): Promise<StandardWorktreeCollisionOwnership> {
	const provisioning = scanWorktreeProvisioningOwnersForRecovery(
		identity.directory,
	);
	if (provisioning.status === 'uncertain') return provisioning;
	const now = Date.now();
	for (const owner of provisioning.owners) {
		const sameSession =
			owner.parentSessionId === identity.parentSessionId ||
			owner.worktreeSessionId === identity.parentSessionId;
		if (!sameSession) continue;
		if (owner.schemaVersion === 1 || owner.taskId === identity.taskId) {
			const leaseIsLive =
				now - owner.createdAt <= WORKTREE_PROVISIONING_OWNER_LEASE_MS;
			if (!leaseIsLive) {
				try {
					_internals.statSync(identity.worktreePath);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== 'ENOENT' && code !== 'ENOTDIR') {
						return {
							status: 'uncertain',
							reason: `expired provisioning owner ${owner.callID} lane liveness is unreadable: ${
								error instanceof Error ? error.message : String(error)
							}`,
						};
					}
					if (
						!_internals.removeWorktreeProvisioningOwner(
							identity.directory,
							owner.callID,
						)
					) {
						return {
							status: 'uncertain',
							reason: `expired provisioning owner ${owner.callID} could not be removed`,
						};
					}
					continue;
				}
			}
			return {
				status: 'protected',
				ownerKind: 'provisioning',
				lifecycle: 'active',
				reason: !leaseIsLive
					? `provisioning owner ${owner.callID} lease expired, but its exact lane path still exists`
					: owner.schemaVersion === 1
						? `legacy provisioning owner ${owner.callID} cannot disprove ownership of this same-session lane`
						: `provisioning owner ${owner.callID} is active for task ${identity.taskId}`,
			};
		}
	}

	const fallback = await scanDelegationFallbacksForRecovery(identity.directory);
	if (fallback.status === 'uncertain') return fallback;
	for (const artifact of fallback.owners) {
		const classified = classifyRecord(artifact.record, identity, 'fallback');
		if (classified) return classified;
	}

	const primary = scanDelegationsForRecovery(identity.directory);
	if (primary.status === 'uncertain') return primary;
	for (const record of primary.owners) {
		const classified = classifyRecord(record, identity, 'primary');
		if (classified) return classified;
	}

	const tags = await scanBackgroundWorktreeOwnershipTagsForRecovery(
		identity.directory,
	);
	if (tags.status === 'uncertain') return tags;
	for (const owner of tags.owners) {
		if (
			owner.sessionId === identity.parentSessionId &&
			owner.laneId === identity.taskId
		) {
			return {
				status: 'protected',
				ownerKind: 'ownership-tag',
				lifecycle: 'preserved',
				reason: `durable ownership tag ${owner.callDigest} preserves this same-session lane`,
			};
		}
	}

	const mergeStatus = scanWorktreeMergeFailuresForRecovery(identity.directory);
	if (mergeStatus.status === 'uncertain') return mergeStatus;
	for (const [, failure] of mergeStatus.failures) {
		const branchMatches = failure.branch === identity.branchName;
		const pathMatches =
			typeof failure.worktreePath === 'string' &&
			normalizedPath(failure.worktreePath) ===
				normalizedPath(identity.worktreePath);
		if (!branchMatches && !pathMatches) continue;
		if (!branchMatches || !pathMatches) {
			return {
				status: 'uncertain',
				reason: `merge-status owner has conflicting identity for branch "${identity.branchName}"`,
			};
		}
		return {
			status: 'protected',
			ownerKind: 'merge-status',
			lifecycle: 'preserved',
			reason: `merge-status records ${failure.outcome} at stage ${failure.stage}`,
		};
	}

	return { status: 'unowned' };
}
