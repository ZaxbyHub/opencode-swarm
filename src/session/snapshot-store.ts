/** SQLite row mapping for durable session snapshots (#2481). */

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

interface SessionRowPayload {
	session: SnapshotData['agentSessions'][string];
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
			if (
				getCoordinationState(directory, SESSION_NAMESPACE, sessionId)
					?.status === 'deleted'
			)
				continue;
			const payload: SessionRowPayload = { session };
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
		const parsedMeta = JSON.parse(meta.payload) as Pick<
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
			snapshot.toolAggregates[row.entityKey] = JSON.parse(row.payload);
		}
		for (const row of listCoordinationStates(
			directory,
			ACTIVE_AGENT_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			snapshot.activeAgent[row.entityKey] = JSON.parse(row.payload);
		}
		for (const row of listCoordinationStates(
			directory,
			DELEGATION_CHAIN_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			snapshot.delegationChains[row.entityKey] = JSON.parse(row.payload);
		}
		for (const row of listCoordinationStates(
			directory,
			SESSION_NAMESPACE,
			MAX_COORDINATION_STATE_LIST_ROWS,
		)) {
			if (row.status === 'deleted') continue;
			const payload = JSON.parse(row.payload) as SessionRowPayload;
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
): number {
	if (!projectDbExists(directory) || !sessionId) return 0;
	let removed = 0;
	withCoordinationTransaction(directory, () => {
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
				payload: 'null',
			}).outcome;
			if (outcome === 'applied') {
				removed += 1;
			}
		}
	});
	return removed;
}
