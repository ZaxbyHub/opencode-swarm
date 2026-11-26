import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeAllProjectDbs, deleteCoordinationState } from '../../../src/db';
import { clearScopeBindings } from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	clearSessionScopeBindingsFromDisk,
} from '../../../src/scope/scope-persistence';
import { resetSwarmState } from '../../../src/state';
import {
	listRowsUnseamed,
	newSweepRoot,
	OTHER,
	RACED,
	readRowUnseamed,
	resetText,
	restoreSweepFixtures,
	rewriteListedRow,
	rewriteRowPayload,
	seedVictimRow,
	survivingKeys,
	writeRow,
} from '../../helpers/reset-sweep-fixtures-3889';
import { freezeClock, type Restore } from '../../helpers/test-clock';

// The reset sweep retires a row only when the store still holds exactly the
// content it listed (#3889). It reads a page and then acts on it; between
// the two another process can delete the row and store something else under
// the same key. A fresh insert has revision 1 again — the revision the listed
// row had — so a delete by key and revision alone would match the
// replacement. Generation ids are random and the writer refuses a colliding
// identity while the row exists, so no production writer creates such a row;
// these legs pin the fail-closed backstop, and the sweep's bookkeeping when a
// row it had given up on is listed as the reset sessions' again.

const THIRD = 'fffffff2-0000-4000-a000-000000000002';
const OTHER_BINDING = '00000000-0000-4000-a000-000000000000';
const NOTHING_UNRESOLVED = {
	failed: 0,
	unidentifiable: 0,
	unchecked: 0,
	unconfirmedRelinquished: 0,
};

/** Before the sweep acts on page 1, another process deletes the raced row
 * and stores `replacement(listed payload)` under the same key. Returns the
 * listings so far. */
function armReplacement(
	root: string,
	replacement: (listed: Record<string, unknown>) => Record<string, unknown>,
): () => number {
	_scopePersistenceInternals.bindingFileScanCapacity = 2;
	seedVictimRow(root, RACED);
	seedVictimRow(root, OTHER);
	let listings = 0;
	_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
		listings += 1;
		const page = listRowsUnseamed(directory);
		if (listings === 1) {
			const listed = page.find((row) => row.entityKey === RACED);
			if (!listed) throw new Error('fixture: the raced row is not listed');
			deleteCoordinationState(directory, 'scope-binding', RACED);
			const replacementRow = replacement(
				JSON.parse(listed.payload) as Record<string, unknown>,
			);
			writeRow(directory, RACED, JSON.stringify(replacementRow));
		}
		return page;
	};
	return () => listings;
}

function handTo(root: string, ownerSessionId: string): void {
	const current = readRowUnseamed(root, RACED)?.payload;
	if (!current) throw new Error('fixture: the raced row is not in the store');
	rewriteRowPayload(
		root,
		RACED,
		JSON.stringify({
			...(JSON.parse(current) as Record<string, unknown>),
			ownerSessionId,
		}),
	);
}

function storedPayload(root: string): Record<string, unknown> {
	const rows = listRowsUnseamed(root);
	expect(rows.map((row) => row.entityKey)).toEqual([RACED]);
	return JSON.parse(rows[0].payload) as Record<string, unknown>;
}

let restoreClock: Restore | undefined;

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	restoreSweepFixtures();
	resetSwarmState();
	clearScopeBindings();
	closeAllProjectDbs();
});

describe('the sweep retires only the content it listed (#3889)', () => {
	test('a replacement that names a different binding is neither cleared nor deleted', async () => {
		const root = newSweepRoot();
		const listings = armReplacement(root, (listed) => ({
			...listed,
			bindingId: OTHER_BINDING,
			ownerSessionId: 'someone-else',
		}));
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		// The retirement of the listed row was refused. The replacement is
		// another session's, and is reported as what the sweep established:
		// an attempt it could not confirm, on a row no longer theirs.
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
			unreadable: false,
			truncated: false,
		});
		expect(storedPayload(root)).toMatchObject({
			bindingId: OTHER_BINDING,
			ownerSessionId: 'someone-else',
		});
	}, 60_000);

	test('a replacement that carries no binding id is refused by its content', async () => {
		const root = newSweepRoot();
		// No binding id to compare: only the content the sweep listed can tell
		// this row from the one it tried to retire.
		const listings = armReplacement(root, (listed) => {
			const { bindingId: _dropped, ...rest } = listed;
			return {
				...rest,
				ownerSessionId: 'someone-else',
				files: ['src/other.ts'],
			};
		});
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
			unreadable: false,
			truncated: false,
		});
		expect(storedPayload(root)).toMatchObject({
			ownerSessionId: 'someone-else',
			files: ['src/other.ts'],
		});
		expect(storedPayload(root)).not.toHaveProperty('bindingId');
	}, 60_000);

	test('the same content stored again under the key is retired', async () => {
		const root = newSweepRoot();
		// A stale runtime wrote the listed binding back after it was deleted.
		const listings = armReplacement(root, (listed) => ({ ...listed }));
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 2,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toEqual([]);
	}, 60_000);

	test('a row given up on and then listed as theirs again is reported by its latest word', async () => {
		// Page 1 lists the raced row and another; a writer moves the raced row
		// (its retirement misses) and hands it to another session. Page 2 lists
		// it as that session's, and a third row of the reset sessions'; before
		// the sweep acts on page 2 the row is handed back. Page 3 lists it as
		// the reset sessions' again.
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			_scopePersistenceInternals.bindingFileScanCapacity = 2;
			seedVictimRow(root, RACED);
			seedVictimRow(root, OTHER);
			seedVictimRow(root, THIRD);
			let listings = 0;
			_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
				listings += 1;
				const page = listRowsUnseamed(directory);
				if (listings === 1) {
					rewriteListedRow(directory, page, RACED);
					handTo(directory, 'someone-else');
				}
				if (listings === 2) handTo(directory, 'victim');
				return page;
			};
			return { root, listings: () => listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(3);
		// All three rows were retired by a retirement the sweep confirmed. The
		// earlier "no longer theirs" report does not survive that.
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 3,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toEqual([]);
		const text = await resetText(arm().root);
		expect(text).toContain('✅ Cleared 3 durable scope binding row(s)');
		expect(text).not.toContain(
			'are gone or are no longer the reset session(s)',
		);
	}, 60_000);
});
