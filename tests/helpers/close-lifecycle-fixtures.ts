import type { CloseLifecycleFacts } from '../../scripts/close-lifecycle-facts';
import type { RetentionRow } from '../../scripts/retention-registry.data';

/**
 * Shared fixtures for the issue #1534 close-lifecycle coherence gate tests
 * (`tests/unit/scripts/check-retention-close-lifecycle*.test.ts`). Kept out of
 * the `*.test.ts` namespace so the describes are not collected twice.
 */

/** Synthetic close.ts facts: two SQLite artifacts, both fully wired. */
export function closeFacts(
	over: Partial<CloseLifecycleFacts> = {},
): CloseLifecycleFacts {
	return {
		archiveArtifacts: ['swarm.db', 'repo-memory.sqlite', 'plan.json'],
		activeStateToClean: ['swarm.db', 'repo-memory.sqlite', 'plan.json'],
		sqliteArchiveDispatch: ['swarm.db', 'repo-memory.sqlite'],
		sqliteCleanHandleClose: ['swarm.db', 'repo-memory.sqlite'],
		parseErrors: [],
		...over,
	};
}

/** A minimal valid registry row, defaulting to the repo-memory shape. */
export function retentionRow(over: Partial<RetentionRow> = {}): RetentionRow {
	return {
		id: 'synthetic',
		category: 7,
		pathGrammar: '.swarm/repo-memory.sqlite',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/x.ts'],
		writerCitations: ['src/x.ts:1'],
		readerCitations: ['src/x.ts:2'],
		schemaVersion: 'v1',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'b', scope: 'global', citation: 'src/x.ts:1' },
		readBound: {
			pattern: 'indexed',
			bound: 'b',
			sync: true,
			citation: 'src/x.ts:2',
		},
		lockModel: 'none',
		crashBehavior: 'none',
		closePolicy: 'archived+cleaned',
		closeArrayMembership: { 'repo-memory.sqlite': 'archive+clean' },
		resetPolicy: 'none',
		legacyCompatibility: 'none',
		healthSignal: 'n/a',
		owner: '#1534',
		disposition: { kind: 'not-a-defect', proof: 'src/x.ts:1' },
		...over,
	};
}

/** Rows declaring every artifact in `closeFacts()`, so the baseline is green. */
export function baselineRows(): RetentionRow[] {
	return [
		retentionRow(),
		retentionRow({
			id: 'db',
			pathGrammar: '.swarm/swarm.db',
			closeArrayMembership: { 'swarm.db': 'archive+clean' },
		}),
		retentionRow({
			id: 'plan',
			pathGrammar: '.swarm/plan.json',
			closeArrayMembership: { 'plan.json': 'archive+clean' },
		}),
	];
}
