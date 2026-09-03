/** SQLite row mapping for durable session snapshots (#2481). */

import { randomUUID } from 'node:crypto';
import {
	deleteCoordinationImports,
	deleteCoordinationState,
	getCoordinationState,
	importCoordinationOnce,
	listCoordinationStates,
	MAX_COORDINATION_STATE_LIST_ROWS,
	transitionCoordinationState,
	withCoordinationTransaction,
} from '../db/coordination-store.js';
import { projectDbExists } from '../db/project-db.js';
import type { SnapshotData } from './snapshot-writer.js';

const META_NAMESPACE = 'session.snapshot.meta';
const SESSION_NAMESPACE = 'session.snapshot.agent';
const TOOL_NAMESPACE = 'session.snapshot.tool';
const ACTIVE_AGENT_NAMESPACE = 'session.snapshot.active-agent';
const DELEGATION_CHAIN_NAMESPACE = 'session.snapshot.delegation-chain';
const SNAPSHOT_PROJECTION_SOURCE = 'session/state.sqlite-projection.json';
const SNAPSHOT_NAMESPACES = [
	META_NAMESPACE,
	SESSION_NAMESPACE,
	TOOL_NAMESPACE,
	ACTIVE_AGENT_NAMESPACE,
	DELEGATION_CHAIN_NAMESPACE,
] as const;

/** Test-only seam for interleaving a foreign writer after the first snapshot read. */
export const _snapshotStoreInternals: {
	afterSnapshotMetaRead: () => void;
} = {
	afterSnapshotMetaRead: () => {},
};

interface LocalSessionOwnership {
	token: string;
	/** Set only by a real host invocation resuming this exact session. */
	canTakeOver: boolean;
}
const localSessionOwners = new Map<string, LocalSessionOwnership>();

interface SessionRowPayload {
	session: SnapshotData['agentSessions'][string];
	ownerToken?: string;
}

interface DeletedSessionRowPayload {
	ownerToken?: string;
	reason: 'ended' | 'stale';
}

function parseRecordPayload(
	payload: string,
	label: string,
): Record<string, unknown> {
	const parsed: unknown = JSON.parse(payload);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Invalid SQLite snapshot ${label} payload`);
	}
	return parsed as Record<string, unknown>;
}

export interface SnapshotWriteOptions {
	/** Do not let rehydrated foreign sessions overwrite their durable owners. */
	onlyLocallyOwnedSessions?: boolean;
}

/**
 * Mark a session as local for snapshot writes and reaping. Rehydration never
 * calls this. Only a host invocation for the exact session may opt into
 * takeover, which lets a restarted host resume its own session without letting
 * a passive foreign rehydration overwrite a live peer.
 */
export function claimSnapshotSessionOwnership(
	sessionId: string,
	canTakeOver = false,
): string {
	const existing = localSessionOwners.get(sessionId);
	if (existing) {
		if (canTakeOver) existing.canTakeOver = true;
		return existing.token;
	}
	const token = randomUUID();
	// Ownership is session-lifecycle state, not an LRU cache: end, stale sweep,
	// and reset-session all release it. Evicting a still-live owner would make a
	// later snapshot silently stop persisting that session.
	localSessionOwners.set(sessionId, { token, canTakeOver });
	return token;
}

export function isSnapshotSessionOwnedLocally(sessionId: string): boolean {
	return localSessionOwners.has(sessionId);
}

export function releaseSnapshotSessionOwnership(sessionId: string): void {
	localSessionOwners.delete(sessionId);
}

export function clearSnapshotSessionOwnerships(): void {
	localSessionOwners.clear();
}

function nextGeneration(
	directory: string,
	namespace: string,
	entityKey: string,
): number {
	return (
		(getCoordinationState(directory, namespace, entityKey)?.generation ?? 0) + 1
	);
}

export function writeSnapshotRows(
	directory: string,
	snapshot: SnapshotData,
	options: SnapshotWriteOptions = {},
): void {
	withCoordinationTransaction(directory, () => {
		transitionCoordinationState(directory, {
			namespace: META_NAMESPACE,
			entityKey: 'project',
			generation: nextGeneration(directory, META_NAMESPACE, 'project'),
			status: 'active',
			payload: JSON.stringify({
				version: snapshot.version,
				writtenAt: snapshot.writtenAt,
				workflowSchema: snapshot.workflowSchema,
			}),
		});
		for (const [key, aggregate] of Object.entries(snapshot.toolAggregates)) {
			transitionCoordinationState(directory, {
				namespace: TOOL_NAMESPACE,
				entityKey: key,
				generation: nextGeneration(directory, TOOL_NAMESPACE, key),
				status: 'active',
				payload: JSON.stringify(aggregate),
			});
		}
		for (const [sessionId, agentName] of Object.entries(snapshot.activeAgent)) {
			if (
				options.onlyLocallyOwnedSessions &&
				!isSnapshotSessionOwnedLocally(sessionId)
			)
				continue;
			if (
				getCoordinationState(directory, ACTIVE_AGENT_NAMESPACE, sessionId)
					?.status === 'deleted'
			)
				continue;
			transitionCoordinationState(directory, {
				namespace: ACTIVE_AGENT_NAMESPACE,
				entityKey: sessionId,
				generation: nextGeneration(
					directory,
					ACTIVE_AGENT_NAMESPACE,
					sessionId,
				),
				status: 'active',
				payload: JSON.stringify(agentName),
			});
		}
		for (const [sessionId, chain] of Object.entries(
			snapshot.delegationChains,
		)) {
			if (
				options.onlyLocallyOwnedSessions &&
				!isSnapshotSessionOwnedLocally(sessionId)
			)
				continue;
			if (
				getCoordinationState(directory, DELEGATION_CHAIN_NAMESPACE, sessionId)
					?.status === 'deleted'
			)
				continue;
			transitionCoordinationState(directory, {
				namespace: DELEGATION_CHAIN_NAMESPACE,
				entityKey: sessionId,
				generation: nextGeneration(
					directory,
					DELEGATION_CHAIN_NAMESPACE,
					sessionId,
				),
				status: 'active',
				payload: JSON.stringify(chain),
			});
		}
		for (const [sessionId, session] of Object.entries(snapshot.agentSessions)) {
			const localOwner = localSessionOwners.get(sessionId);
			const ownerToken = localOwner?.token;
			if (options.onlyLocallyOwnedSessions && !localOwner) continue;
			const current = getCoordinationState(
				directory,
				SESSION_NAMESPACE,
				sessionId,
			);
			let currentOwner: string | undefined;
			let deleted: DeletedSessionRowPayload | null = null;
			try {
				if (current?.status === 'deleted') {
					deleted = JSON.parse(current.payload) as DeletedSessionRowPayload;
				} else if (current) {
					currentOwner = (JSON.parse(current.payload) as SessionRowPayload)
						.ownerToken;
				}
			} catch {
				continue;
			}
			if (
				options.onlyLocallyOwnedSessions &&
				currentOwner &&
				currentOwner !== ownerToken &&
				!localOwner?.canTakeOver
			)
				continue;
			if (
				deleted &&
				(!ownerToken ||
					deleted.reason !== 'stale' ||
					deleted.ownerToken !== ownerToken)
			)
				continue;
			const payload: SessionRowPayload = {
				session,
				...(ownerToken ? { ownerToken } : {}),
			};
			transitionCoordinationState(directory, {
				namespace: SESSION_NAMESPACE,
				entityKey: sessionId,
				generation: nextGeneration(directory, SESSION_NAMESPACE, sessionId),
				status: 'active',
				payload: JSON.stringify(payload),
			});
		}
	});
}

export function importSnapshotRowsOnce(
	directory: string,
	snapshot: SnapshotData,
	sourceDigest: string,
	source = 'session/state.json',
): 'imported' | 'already_imported' | 'state_exists' {
	return importCoordinationOnce(
		directory,
		{
			source,
			sourceDigest,
			rowCount: Object.keys(snapshot.agentSessions).length,
			emptyNamespace: META_NAMESPACE,
		},
		() => writeSnapshotRows(directory, snapshot),
	);
}

export function readSnapshotRows(directory: string): SnapshotData | null {
	if (!projectDbExists(directory)) return null;
	// A logical snapshot spans five namespaces. Keep every SELECT in one SQLite
	// snapshot so a concurrent writer cannot combine rows from different commits.
	return withCoordinationTransaction(directory, () => {
		const meta = listCoordinationStates(directory, META_NAMESPACE, 1)[0];
		if (!meta) return null;
		_snapshotStoreInternals.afterSnapshotMetaRead();
		const parsedMeta = parseRecordPayload(meta.payload, 'metadata') as Pick<
			SnapshotData,
			'version' | 'writtenAt' | 'workflowSchema'
		>;
		if (
			parsedMeta.version !== 1 &&
			parsedMeta.version !== 2 &&
			parsedMeta.version !== 3
		) {
			throw new Error('Unsupported SQLite snapshot version');
		}
		if (!Number.isFinite(parsedMeta.writtenAt)) {
			throw new Error('Invalid SQLite snapshot metadata writtenAt');
		}
		if (
			parsedMeta.workflowSchema !== undefined &&
			typeof parsedMeta.workflowSchema !== 'string'
		) {
			throw new Error('Invalid SQLite snapshot metadata workflowSchema');
		}
		const snapshot: SnapshotData = {
			version: parsedMeta.version,
			writtenAt: parsedMeta.writtenAt,
			...(parsedMeta.workflowSchema !== undefined && {
				workflowSchema: parsedMeta.workflowSchema,
			}),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};
		for (const row of listCoordinationStates(
			directory,
			TOOL_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			snapshot.toolAggregates[row.entityKey] = parseRecordPayload(
				row.payload,
				'tool aggregate',
			) as unknown as SnapshotData['toolAggregates'][string];
		}
		for (const row of listCoordinationStates(
			directory,
			ACTIVE_AGENT_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			const agentName: unknown = JSON.parse(row.payload);
			if (typeof agentName !== 'string') {
				throw new Error('Invalid SQLite snapshot active-agent payload');
			}
			snapshot.activeAgent[row.entityKey] = agentName;
		}
		for (const row of listCoordinationStates(
			directory,
			DELEGATION_CHAIN_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			const chain: unknown = JSON.parse(row.payload);
			if (!Array.isArray(chain)) {
				throw new Error('Invalid SQLite snapshot delegation-chain payload');
			}
			snapshot.delegationChains[row.entityKey] =
				chain as SnapshotData['delegationChains'][string];
		}
		for (const row of listCoordinationStates(
			directory,
			SESSION_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			const payload = parseRecordPayload(
				row.payload,
				'agent-session',
			) as unknown as SessionRowPayload;
			if (
				!payload.session ||
				typeof payload.session !== 'object' ||
				Array.isArray(payload.session) ||
				(payload.ownerToken !== undefined &&
					typeof payload.ownerToken !== 'string')
			) {
				throw new Error('Invalid SQLite snapshot agent-session payload');
			}
			snapshot.agentSessions[row.entityKey] = payload.session;
		}
		return snapshot;
	});
}

/** Remove the complete authoritative snapshot as one FULL transaction. */
export function clearSnapshotRows(directory: string): number {
	if (!projectDbExists(directory)) return 0;
	let removed = 0;
	withCoordinationTransaction(directory, () => {
		for (const namespace of SNAPSHOT_NAMESPACES) {
			for (const row of listCoordinationStates(
				directory,
				namespace,
				MAX_COORDINATION_STATE_LIST_ROWS,
			)) {
				if (
					deleteCoordinationState(
						directory,
						namespace,
						row.entityKey,
						row.revision,
					)
				) {
					removed += 1;
				}
			}
		}
		deleteCoordinationImports(directory, [
			'session/state.json',
			SNAPSHOT_PROJECTION_SOURCE,
		]);
	});
	return removed;
}

/** Tombstone the session-keyed rows removed by a host lifecycle event. */
export function deleteSnapshotSessionRows(
	directory: string,
	sessionId: string,
	reason: DeletedSessionRowPayload['reason'] = 'ended',
): number {
	if (!projectDbExists(directory) || !sessionId) return 0;
	let removed = 0;
	withCoordinationTransaction(directory, () => {
		const ownerToken = localSessionOwners.get(sessionId)?.token;
		const sessionRow = getCoordinationState(
			directory,
			SESSION_NAMESPACE,
			sessionId,
		);
		if (reason === 'stale' && !ownerToken) return;
		if (sessionRow && sessionRow.status !== 'deleted') {
			try {
				const persistedOwner = (
					JSON.parse(sessionRow.payload) as SessionRowPayload
				).ownerToken;
				if (persistedOwner && persistedOwner !== ownerToken) return;
			} catch {
				return;
			}
		}
		for (const namespace of [
			SESSION_NAMESPACE,
			ACTIVE_AGENT_NAMESPACE,
			DELEGATION_CHAIN_NAMESPACE,
		] as const) {
			const row = getCoordinationState(directory, namespace, sessionId);
			if (!row || row.status === 'deleted') continue;
			const outcome = transitionCoordinationState(directory, {
				namespace,
				entityKey: sessionId,
				expectedRevision: row.revision,
				generation: row.generation + 1,
				status: 'deleted',
				payload: JSON.stringify({
					reason,
					...(ownerToken ? { ownerToken } : {}),
				} satisfies DeletedSessionRowPayload),
			}).outcome;
			if (outcome === 'applied') {
				removed += 1;
			}
		}
	});
	return removed;
}
