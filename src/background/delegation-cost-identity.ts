/**
 * Delegation cost-record identity construction (issue #2482).
 *
 * Leaf module — imports only from `node:crypto` and the cost-accounting
 * types — so BOTH `delegation-lifecycle.ts` and `pending-delegations.ts`
 * (which `delegation-lifecycle` imports from; a reverse import would cycle)
 * can construct the exact same canonical cost-record identity material for a
 * delegation terminal.
 */

import { createHash } from 'node:crypto';
import type { DelegationCostFields } from '../services/cost-accounting.js';

/** Record fields the identity material is derived from — never agent names. */
export interface DelegationCostIdentityRecord {
	parentSessionId: string;
	callID: string;
	laneId?: string;
}

/**
 * Canonical cost-record identity material. Records WITH a `laneId` (lane
 * records) use the `lane:` discriminator; records WITHOUT one (Task-tool
 * delegations, foreground or background) use the pre-documented Task shape
 * `${sessionId}\0${callID}` — the same material the foreground Task handoff
 * hashes. Hash inputs stay distinct, so lane and Task ids never collide even
 * for a shared (sessionId, callID).
 */
export function delegationCostRecordMaterial(
	record: DelegationCostIdentityRecord,
): string {
	if (!record.laneId) {
		return `${record.parentSessionId}\0${record.callID}`;
	}
	return `${record.parentSessionId}\0${record.callID}\0lane:${record.laneId}`;
}

export interface DelegationTerminalIdentityInput {
	record: DelegationCostIdentityRecord & {
		swarmPrefixedAgent: string;
		subagentSessionId: string;
	};
	/** Model name for the identity fingerprint ('' when unknown). */
	model?: string;
	/** Marks a recovered eventless-terminal end (#2482). */
	recovered?: boolean;
}

/**
 * Build the canonical cost-record identity fields (`record_id`,
 * `identity_fingerprint`, digests, version, and the `recovered` marker) for a
 * delegation terminal emission. Token/cost fields are the caller's to add.
 */
export function buildDelegationTerminalIdentityFields(
	input: DelegationTerminalIdentityInput,
): Pick<
	DelegationCostFields,
	| 'record_id'
	| 'identity_fingerprint'
	| 'version'
	| 'parent_session_digest'
	| 'child_session_digest'
	| 'recovered'
> {
	const material = delegationCostRecordMaterial(input.record);
	return {
		record_id: createHash('sha256')
			.update(`delegation-cost-id-v1\0${material}`)
			.digest('hex')
			.slice(0, 32),
		identity_fingerprint: createHash('sha256')
			.update(
				`delegation-cost-identity-v1\0${material}\0${input.record.swarmPrefixedAgent}\0${input.model ?? ''}`,
			)
			.digest('hex')
			.slice(0, 32),
		version: 1,
		parent_session_digest: createHash('sha256')
			.update(`delegation-cost-parent-v1\0${input.record.parentSessionId}`)
			.digest('hex')
			.slice(0, 32),
		child_session_digest: createHash('sha256')
			.update(`delegation-cost-child-v1\0${input.record.subagentSessionId}`)
			.digest('hex')
			.slice(0, 32),
		...(input.recovered ? { recovered: true } : {}),
	};
}
