import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../../src/db';
import {
	clearScopeBindings,
	createScopeBinding,
	getScopeBinding,
	registerScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	clearSessionScopeBindingsFromDisk,
} from '../../../src/scope/scope-persistence';
import { formatScopeResolutionDiagnostic } from '../../../src/scope/scope-resolution-diagnostic';
import { resetSwarmState } from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

// Reset-sweep reporting and recovery-text accuracy for #3889 (final-critic
// round-2 N1/N2 plus the false-location recovery text): the authoritative
// rows live in the project coordination DB, a store that cannot be enumerated
// is never reported as a successful zero, and the sweep pages past the scan
// capacity while rows are being removed.
const plan: Plan = {
	schema_version: '1.0.0',
	title: 'sweep-reporting',
	swarm: 'test',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'P',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'd',
					depends: [],
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

const roots: string[] = [];
let restoreClock: Restore | undefined;
const originalListRows = _scopePersistenceInternals.listResetSweepRows;
const originalScanCapacity = _scopePersistenceInternals.bindingFileScanCapacity;

function fixture(): string {
	const root = canonicalMkdtemp('sweep-reporting-');
	roots.push(root);
	return root;
}

function decl(root: string, owner: string, message: string): ScopeBinding {
	const value = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: owner,
		ownerMessageId: message,
		source: 'declare_scope',
	});
	if (!value) throw new Error('fixture failed');
	return value;
}

/** Seed one authoritative row under a chosen entity key (the raw list is
 * ordered by entity_key, so the key places the row on a page). */
function seedKeyedRow(
	root: string,
	owner: string,
	generationId: string,
): string {
	const seeded = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: generationId,
		generation: 1,
		status: 'live',
		payload: JSON.stringify({
			...decl(root, owner, `msg-${generationId}`),
			generationId,
		}),
	});
	if (seeded.outcome !== 'applied') throw new Error('seed failed');
	return generationId;
}

/** Rows sorting before every victim key. */
function seedUnrelatedRows(root: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) =>
		seedKeyedRow(
			root,
			`stranger-${index}`,
			`0000000${index}-0000-4000-a000-00000000000${index}`,
		),
	);
}

/** Rows sorting after every unrelated key. */
function seedVictimRows(root: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) =>
		seedKeyedRow(
			root,
			'victim',
			`fffffff${index}-0000-4000-a000-00000000000${index}`,
		),
	);
}

function survivingKeys(root: string): string[] {
	return listCoordinationStateRowsRaw(root, 'scope-binding', 50).map(
		(row) => row.entityKey,
	);
}

function faultEnumeration(): () => void {
	_scopePersistenceInternals.listResetSweepRows = () => {
		throw new Error('injected enumeration failure');
	};
	return () => {
		_scopePersistenceInternals.listResetSweepRows = originalListRows;
	};
}

async function resetText(root: string): Promise<string> {
	const results = await handleResetSessionCommand(root, [], 'victim');
	return Array.isArray(results) ? results.join('\n') : String(results);
}

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	_scopePersistenceInternals.listResetSweepRows = originalListRows;
	_scopePersistenceInternals.bindingFileScanCapacity = originalScanCapacity;
	resetSwarmState();
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe('recovery text names the real store (#3889)', () => {
	test('the store-unreadable diagnostic points at the coordination DB, not the v1 scopes dir', () => {
		const rendered = formatScopeResolutionDiagnostic({
			resolution: { status: 'store_unreadable' },
			taskId: '1.1',
			sessionId: 'architect',
		});
		expect(rendered).toContain('SCOPE_BINDING_STORE_UNREADABLE');
		// .swarm/scopes only holds the non-authorizing legacy v1 projection:
		// sending the operator there recovers nothing.
		expect(rendered).not.toContain('.swarm/scopes');
		expect(rendered).toContain('.swarm/swarm.db');
		expect(rendered).toContain('/swarm reset-session');
	});

	test('the unidentifiable-row warning fires for a realistic corrupt row and points at the coordination DB', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// The realistic corruption: a payload that is valid JSON and an
		// object, but carries no session attribution (the row shape the
		// frozen C4 probe uses for its malformed-row leg). The store writer
		// validates payloads as JSON, so syntactically-invalid rows are not
		// the case an operator actually meets.
		const corruptKey = 'aaaaaaaa-0000-4000-a000-000000000001';
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: corruptKey,
			generation: 1,
			status: 'live',
			payload: '{"malformed":true}',
		});
		// Control: another session's well-formed row is attributable, just
		// not the reset target — it must not be counted as unidentifiable.
		const strangerKey = seedKeyedRow(
			root,
			'stranger',
			'00000000-0000-4000-a000-000000000000',
		);
		const text = await resetText(root);
		expect(text).toContain('⚠️ 1 unidentifiable scope binding row(s)');
		// .swarm/scopes only holds the non-authorizing legacy v1 projection:
		// sending the operator there recovers nothing.
		expect(text).not.toContain('.swarm/scopes');
		expect(text).toContain('.swarm/swarm.db');
		// Neither row is removed on a guess.
		expect(survivingKeys(root)).toEqual([strangerKey, corruptKey]);
	}, 60_000);
});

describe('unreadable store is reported, never a silent zero (#3889)', () => {
	test('sweep reports unreadable and still clears the in-memory lineage', async () => {
		const root = fixture();
		const live = decl(root, 'victim', 'declare');
		expect(registerScopeBinding(live).ok).toBe(true);
		const lookup = {
			directory: root,
			plan,
			taskId: '1.1',
			ownerSessionId: 'victim',
		} as const;
		// Engaged proof: the in-memory authority exists before the sweep.
		expect(getScopeBinding(lookup)).not.toBeNull();
		const restore = faultEnumeration();
		try {
			const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
			expect(outcome).toMatchObject({
				removed: 0,
				unidentifiable: 0,
				unreadable: true,
				truncated: false,
			});
		} finally {
			restore();
		}
		// The reset must not resurrect authority through the memory fallback,
		// whatever the durable sweep could read.
		expect(getScopeBinding(lookup)).toBeNull();
	}, 60_000);

	test('reset-session warns instead of reporting a successful Cleared 0', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		const restore = faultEnumeration();
		let text: string;
		try {
			text = await resetText(root);
		} finally {
			restore();
		}
		expect(text).toContain('could not read the scope binding store');
		expect(text).not.toContain(
			'durable scope binding row(s) for the reset session(s)',
		);
	}, 60_000);
});

describe('reset sweep pages past the scan capacity (#3889)', () => {
	test('rows beyond the first page are swept while pages keep making progress', async () => {
		const root = fixture();
		// Page 1 = 3 unrelated + 1 victim (removes 1), page 2 pulls in the
		// next victim, page 3 the last; a single pass would remove only 1.
		_scopePersistenceInternals.bindingFileScanCapacity = 4;
		seedUnrelatedRows(root, 3);
		const victims = seedVictimRows(root, 3);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			removed: 3,
			unidentifiable: 0,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toHaveLength(3);
		for (const generationId of victims)
			expect(survivingKeys(root)).not.toContain(generationId);
	}, 60_000);

	test('a full page with no attributable row is reported as truncated', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// Page 1 = 2 unrelated rows: full, zero progress — the victim row
		// sorts past the capacity and cannot be reached by paging.
		_scopePersistenceInternals.bindingFileScanCapacity = 2;
		seedUnrelatedRows(root, 2);
		const [victim] = seedVictimRows(root, 1);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			removed: 0,
			unreadable: false,
			truncated: true,
		});
		expect(survivingKeys(root)).toContain(victim ?? '');
		const text = await resetText(root);
		expect(text).toContain(
			'before it could confirm the scope binding store was seen in full',
		);
		// This warning names the store like every other one does.
		expect(text).toContain(
			'may remain unswept in the scope binding store (.swarm/swarm.db, namespace scope-binding).',
		);
	}, 60_000);

	test('a store of exactly one full page is not said to have gone unseen', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// Capacity 2 and exactly 2 unrelated rows: the page is full and
		// removes nothing, although it holds the whole store. The sweep
		// cannot tell, so it hedges — and must not assert the store was
		// left unseen.
		_scopePersistenceInternals.bindingFileScanCapacity = 2;
		seedUnrelatedRows(root, 2);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({ removed: 0, truncated: true });
		const text = await resetText(root);
		expect(text).toContain('before it could confirm');
		expect(text).not.toContain('whole scope binding store was seen');
		// The plausible wrong report: that the store WAS left unseen.
		expect(text).not.toContain('store was not seen in full');
	}, 60_000);

	test('a sweep stopped by the pass limit says so while rows were being removed', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// Capacity 1: every page is a full page that removes one row, so the
		// sweep runs to the pass limit (32) with rows still left behind.
		_scopePersistenceInternals.bindingFileScanCapacity = 1;
		const batch = (offset: number, count: number): string[] =>
			Array.from({ length: count }, (_, index) => {
				const generationId = `ffffff${(offset + index).toString(16).padStart(2, '0')}-0000-4000-a000-000000000000`;
				seedKeyedRow(root, 'victim', generationId);
				return generationId;
			});
		const first = batch(0, 33);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			removed: 32,
			failed: 0,
			unreadable: false,
			truncated: true,
		});
		expect(survivingKeys(root)).toEqual([first[32]]);
		// Through the command the same stop is reported, without claiming
		// that nothing was removed.
		const second = batch(33, 32);
		const text = await resetText(root);
		expect(text).toContain('✅ Cleared 32 durable scope binding row(s)');
		expect(text).toContain('reached its pass limit');
		expect(text).not.toContain('without removing any row');
		expect(survivingKeys(root)).toEqual([second[31]]);
	}, 60_000);
});

describe('a row the sweep could not retire is reported (#3889)', () => {
	test('rows whose retirement fails are counted, left durable, and warned about', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// A deny ledger the sink cannot update makes every retirement fail
		// inside its own transaction — the realistic way a wanted row outlives
		// the sweep (valid JSON, wrong ledger shape: unreadable to its reader).
		transitionCoordinationState(root, {
			namespace: 'scope-binding-deny',
			entityKey: 'deny-ledger',
			generation: 1,
			status: 'active',
			payload: '{"version":2,"entries":{}}',
		});
		const victims = seedVictimRows(root, 2);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		// Nothing was swept, and that is what the outcome says.
		expect(outcome).toMatchObject({
			removed: 0,
			failed: 2,
			unidentifiable: 0,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toEqual(victims);
		const text = await resetText(root);
		// The warning states what the sweep could not confirm and what reading
		// the rows again showed. A throw does not say whether a retirement
		// committed, so it claims neither non-retirement nor anything about
		// whether the rows still deny writes.
		expect(text).toContain(
			'⚠️ This sweep could not confirm retiring 2 durable scope binding row(s) of the reset session(s): they were read again and found still in place in the scope binding store (.swarm/swarm.db, namespace scope-binding). Run reset-session again.',
		);
		expect(text).not.toContain('could not be retired');
		expect(text).not.toContain('did not revoke');
		expect(text).not.toContain('deny writes');
	}, 60_000);

	test('a row that fails on one page and is retired on the next is not reported as failed', async () => {
		const root = fixture();
		// Page 1 is full (capacity 2) and holds both victim rows.
		_scopePersistenceInternals.bindingFileScanCapacity = 2;
		const [raced] = seedVictimRows(root, 2) as [string, string];
		// A concurrent writer rewrites one listed row right after the sweep has
		// read the page. The sweep then retires against a stale revision, the
		// exact-row delete does not match, and that row fails on page 1 while
		// the other is removed. Page 2 lists it again and retires it.
		let listings = 0;
		_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
			const rows = originalListRows(directory);
			listings += 1;
			if (listings === 1) {
				const stale = rows.find((row) => row.entityKey === raced);
				if (!stale) throw new Error('fixture: the raced row is not listed');
				transitionCoordinationState(directory, {
					namespace: 'scope-binding',
					entityKey: raced,
					expectedRevision: stale.revision,
					generation: 1,
					status: 'live',
					payload: JSON.stringify({
						...(JSON.parse(stale.payload) as Record<string, unknown>),
						revision: stale.revision + 1,
					}),
				});
			}
			return rows;
		};
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		// Two pages ran, both rows are gone, and nothing is left to report.
		expect(listings).toBe(2);
		expect(outcome).toMatchObject({
			removed: 2,
			failed: 0,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toEqual([]);
	}, 60_000);

	test('an unreadable store reports the rows swept before the read failed', async () => {
		const root = fixture();
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		// Page 1 (capacity 2) = 1 stranger + 1 victim: full, one row removed.
		_scopePersistenceInternals.bindingFileScanCapacity = 2;
		const [stranger] = seedUnrelatedRows(root, 1) as [string];
		seedVictimRows(root, 1);
		// The store becomes unreadable before page 2 is listed.
		let listings = 0;
		_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
			listings += 1;
			if (listings >= 2) throw new Error('injected enumeration failure');
			return originalListRows(directory);
		};
		const text = await resetText(root);
		expect(text).toContain('could not read the scope binding store');
		// One row WAS swept: a hardcoded zero would be a false report. The
		// count is a floor, never presented as the whole story — a retirement
		// can commit and still report failure.
		expect(text).toContain(
			'1 row(s) swept before that; the rest was not checked',
		);
		expect(text).not.toContain('0 row(s) swept');
		expect(text).not.toContain('in total');
		expect(text).not.toContain('nothing else was swept');
		expect(survivingKeys(root)).toEqual([stranger]);
	}, 60_000);
});
