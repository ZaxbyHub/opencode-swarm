import { computeConfidence, findNearDuplicate } from './knowledge-store.js';
import type {
	PhaseConfirmationRecord,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';

export type ReinforcementReason =
	| 'reinforced'
	| 'already_confirmed_phase'
	| 'inactive';

export interface ReinforcementResult {
	entryId: string;
	reinforced: boolean;
	reason: ReinforcementReason;
}

const INACTIVE_STATUSES = new Set([
	'archived',
	'quarantined',
	'quarantined_unactionable',
]);

export function isActiveSwarmKnowledgeEntry(
	entry: SwarmKnowledgeEntry,
): boolean {
	return !INACTIVE_STATUSES.has(entry.status);
}

export function findActiveSwarmNearDuplicate(
	lesson: string,
	entries: SwarmKnowledgeEntry[],
	threshold: number,
): SwarmKnowledgeEntry | undefined {
	return findNearDuplicate(
		lesson,
		entries.filter(isActiveSwarmKnowledgeEntry),
		threshold,
	);
}

function distinctPhaseCount(
	records: PhaseConfirmationRecord[] | undefined,
): number {
	const phases = new Set<number>();
	for (const record of records ?? []) {
		if (Number.isInteger(record.phase_number)) {
			phases.add(record.phase_number);
		}
	}
	return phases.size;
}

export function reinforceSwarmKnowledgeEntry(
	entry: SwarmKnowledgeEntry,
	confirmation: PhaseConfirmationRecord,
): ReinforcementResult {
	if (!isActiveSwarmKnowledgeEntry(entry)) {
		return { entryId: entry.id, reinforced: false, reason: 'inactive' };
	}

	if (
		(entry.confirmed_by ?? []).some(
			(record) => record.phase_number === confirmation.phase_number,
		)
	) {
		return {
			entryId: entry.id,
			reinforced: false,
			reason: 'already_confirmed_phase',
		};
	}

	entry.confirmed_by = [...(entry.confirmed_by ?? []), confirmation];
	entry.updated_at = confirmation.confirmed_at;
	entry.phases_alive = 0;
	entry.confidence = computeConfidence(
		distinctPhaseCount(entry.confirmed_by),
		entry.auto_generated ?? false,
	);

	return { entryId: entry.id, reinforced: true, reason: 'reinforced' };
}
