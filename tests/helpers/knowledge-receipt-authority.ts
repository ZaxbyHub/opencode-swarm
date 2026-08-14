type InjectorInternals =
	typeof import('../../src/hooks/knowledge-injector.js')._internals;
type ReceiptMembershipView =
	import('../../src/hooks/knowledge-receipt-ledger.js').ReceiptMembershipView;

/**
 * Installs an in-memory successful receipt-authority boundary for injector unit
 * tests whose scope is message selection/rendering rather than ledger I/O.
 * Ledger failure, ordering, and persistence branches remain covered by the
 * dedicated receipt-authority injector suites.
 */
export function installKnowledgeReceiptAuthorityStub(
	_internals: InjectorInternals,
): () => void {
	const memberships: ReceiptMembershipView[] = [];
	const original = {
		commitDisplayedMembership: _internals.commitDisplayedMembership,
		commitEmptyRetrieval: _internals.commitEmptyRetrieval,
		queryLiveMemberships: _internals.queryLiveMemberships,
		ensureCohortIdCached: _internals.ensureCohortIdCached,
		readLinkPointer: _internals.readLinkPointer,
		recordKnowledgeEvent: _internals.recordKnowledgeEvent,
		recordKnowledgeShown: _internals.recordKnowledgeShown,
		recordLessonsShown: _internals.recordLessonsShown,
	};
	_internals.commitDisplayedMembership = async (_directory, input) => {
		const committed = input.entries.map((entry) => ({
			trace_id: input.trace_id,
			entry_id: entry.entry_id,
			session_id: input.session_id,
			phase: input.phase,
			task_id: input.task_id,
			agent: input.agent,
			critical: entry.critical,
			rank: entry.rank,
			score: entry.score,
			committed_at: '2024-01-01T00:00:00.000Z',
			membership_event_id: 'test-membership-event',
			grace_days: input.grace_days ?? 7,
			cohort_id: input.cohort_id,
			source_link_id: input.source_link_id,
			exposure_kind: input.exposure_kind ?? 'manual_recall',
			origin: 'v2' as const,
		}));
		memberships.push(...committed);
		return {
			ok: true,
			event_id: 'test-membership-event',
			memberships: committed,
		};
	};
	_internals.commitEmptyRetrieval = async () => ({
		ok: true,
		event_id: 'test-empty-event',
		terminal_event_id: 'test-empty-terminal',
	});
	_internals.queryLiveMemberships = async (_directory, query) => ({
		ok: true,
		memberships: memberships.filter(
			(membership) =>
				(!query.session_id || membership.session_id === query.session_id) &&
				(!query.phase || membership.phase === query.phase) &&
				(!query.trace_id || membership.trace_id === query.trace_id),
		),
		legacy_unverifiable: [],
	});
	_internals.ensureCohortIdCached = async () => undefined;
	_internals.readLinkPointer = () => null;
	_internals.recordKnowledgeEvent = async () => null;
	_internals.recordKnowledgeShown = async () => undefined;
	_internals.recordLessonsShown = async () => undefined;
	return () => {
		_internals.commitDisplayedMembership = original.commitDisplayedMembership;
		_internals.commitEmptyRetrieval = original.commitEmptyRetrieval;
		_internals.queryLiveMemberships = original.queryLiveMemberships;
		_internals.ensureCohortIdCached = original.ensureCohortIdCached;
		_internals.readLinkPointer = original.readLinkPointer;
		_internals.recordKnowledgeEvent = original.recordKnowledgeEvent;
		_internals.recordKnowledgeShown = original.recordKnowledgeShown;
		_internals.recordLessonsShown = original.recordLessonsShown;
	};
}
