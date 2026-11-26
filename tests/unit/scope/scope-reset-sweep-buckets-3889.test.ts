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
	type RawSweepRow,
	readRowUnseamed,
	resetText,
	restoreSweepFixtures,
	rewriteListedRow,
	rewriteRowPayload,
	seedVictimRow,
	survivingKeys,
	UNCLAIMABLE_PAYLOAD,
	writeRow,
} from '../../helpers/reset-sweep-fixtures-3889';
import { freezeClock, type Restore } from '../../helpers/test-clock';

// A row is reported once, by the sweep's latest word on it (#3889). Whatever
// the sweep observes next about a row replaces what it established before, so
// no interleaving of pages, concurrent writers and a failing final read can
// describe one row two ways — as left in place and as possibly gone, or as
// cleared and as not confirmed. Each leg asserts that no row is described
// two ways: at most one bucket names a row.

const NOTHING_UNRESOLVED = {
	failed: 0,
	unidentifiable: 0,
	unchecked: 0,
	unconfirmedRelinquished: 0,
};
const SWEPT = { unreadable: false, truncated: false };
const RELINQUISHED_LINE =
	"ℹ️ 1 durable scope binding row(s) that the sweep listed as the reset session(s)' are gone or are no longer the reset session(s)' after a retirement attempt this sweep could not confirm; whether this sweep or another process removed or replaced them is not known.";

/** Two victim rows: exactly one page at the sweep's capacity. */
function seedOneFullPage(root: string): void {
	_scopePersistenceInternals.bindingFileScanCapacity = 2;
	seedVictimRow(root, RACED);
	seedVictimRow(root, OTHER);
}

/** A concurrent writer acting each time a page has been listed and before
 * the sweep acts on THAT page: the sweep then acts on a snapshot that is
 * already stale. Returns the number of listings so far. */
function armListings(
	onListing: (
		listing: number,
		root: string,
		page: readonly RawSweepRow[],
	) => void,
): () => number {
	let listings = 0;
	_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
		listings += 1;
		const page = listRowsUnseamed(directory);
		onListing(listings, directory, page);
		return page;
	};
	return () => listings;
}

/** Page 1 retires both rows (the caller seeds them). Before page 2 is listed
 * another process re-inserts the raced row with `payload`; once page 2 is
 * listed, `beforeSweepActs` runs before the sweep acts on that page. Returns
 * the number of listings so far. */
function armReinserted(
	root: string,
	payload: string,
	beforeSweepActs?: (root: string, page: readonly RawSweepRow[]) => void,
): () => number {
	let listings = 0;
	_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
		listings += 1;
		if (listings === 2) writeRow(directory, RACED, payload);
		const page = listRowsUnseamed(directory);
		if (listings === 2) beforeSweepActs?.(directory, page);
		return page;
	};
	return () => listings;
}

/** A well-formed binding payload for the raced row, as the fixtures write it. */
function intactPayloadOf(root: string): string {
	seedOneFullPage(root);
	const intact = readRowUnseamed(root, RACED)?.payload;
	if (!intact) throw new Error('fixture: the raced row is not listed');
	return intact;
}

/** The raced row starts with no session id; returns its well-formed payload. */
function stripAttribution(root: string): string {
	const intact = readRowUnseamed(root, RACED)?.payload;
	if (!intact) throw new Error('fixture: the raced row is not listed');
	rewriteRowPayload(root, RACED, UNCLAIMABLE_PAYLOAD);
	return intact;
}

/** Hand the raced row to another session, at its current revision. */
function handToAnotherSession(root: string): void {
	const current = readRowUnseamed(root, RACED)?.payload;
	if (!current) throw new Error('fixture: the raced row is not in the store');
	rewriteRowPayload(
		root,
		RACED,
		JSON.stringify({
			...(JSON.parse(current) as Record<string, unknown>),
			ownerSessionId: 'someone-else',
		}),
	);
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

describe('a row is reported once, by the sweep’s latest word on it (#3889)', () => {
	test('a row that was unidentifiable and is attributable again is swept, not reported', async () => {
		const root = newSweepRoot();
		seedOneFullPage(root);
		const intact = stripAttribution(root);
		// Page 1 lists the unidentifiable row and the other; before the sweep
		// acts on it a concurrent writer restores the attribution. Page 1 acts
		// on its stale snapshot, so it leaves the row; page 2 sees it
		// attributable and retires it.
		const listings = armListings((listing, directory) => {
			if (listing === 1) rewriteRowPayload(directory, RACED, intact);
		});
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 2,
		});
		expect(survivingKeys(root)).toEqual([]);
	}, 60_000);

	test('a row that failed and is then seen corrupt is reported once, as unidentifiable, whatever the store does afterwards', async () => {
		// The store refuses every read after the pages, which must give nothing
		// a second way to be reported.
		let reads = 0;
		_scopePersistenceInternals.readResetSweepRow = () => {
			reads += 1;
			throw new Error('injected read failure');
		};
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			const listings = armListings((listing, directory, page) => {
				// Page 1 lists both rows; before the sweep acts on it a
				// concurrent writer moves the raced row and then corrupts it.
				// Page 1 acts on its stale snapshot: the raced row's retirement
				// misses and the other is retired. Page 2 sees the raced row
				// corrupt.
				if (listing !== 1) return;
				rewriteListedRow(directory, page, RACED);
				rewriteRowPayload(directory, RACED, UNCLAIMABLE_PAYLOAD);
			});
			return { root, listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(reads).toBe(0);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			unidentifiable: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
		// The same interleaving through the command.
		const text = await resetText(arm().root);
		expect(text).toContain(
			'⚠️ 1 unidentifiable scope binding row(s) were seen in the scope binding store',
		);
		expect(text).not.toContain('could not confirm');
	}, 60_000);

	test('a row that was unidentifiable, is attributable again and then cannot be retired is reported once, as not confirmed', async () => {
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			const intact = stripAttribution(root);
			const listings = armListings((listing, directory, page) => {
				// Before the sweep acts on page 1 a concurrent writer restores
				// the raced row's attribution; page 1 acts on its stale
				// snapshot, so it leaves the row and retires the other. Page 2
				// lists it; before the sweep acts on page 2 the writer moves it
				// again, so that retirement misses.
				if (listing === 1) rewriteRowPayload(directory, RACED, intact);
				if (listing === 2) rewriteListedRow(directory, page, RACED);
			});
			return { root, listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		// Still the reset sessions' and still there: not confirmed retired. It
		// is no longer reported as unidentifiable.
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			failed: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
		// The same interleaving through the command.
		const text = await resetText(arm().root);
		expect(text).toContain(
			'⚠️ This sweep could not confirm retiring 1 durable scope binding row(s) of the reset session(s): they were read again and found still in place',
		);
		expect(text).not.toContain('unidentifiable scope binding row(s)');
	}, 60_000);

	test('a row seen unidentifiable is still reported when the store becomes unreadable on a later page', async () => {
		const arm = (): string => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			stripAttribution(root);
			armListings((listing) => {
				if (listing === 2) throw new Error('injected enumeration failure');
			});
			return root;
		};
		const outcome = await clearSessionScopeBindingsFromDisk(arm(), ['victim']);
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 1,
			unidentifiable: 1,
			unreadable: true,
			truncated: false,
		});
		const text = await resetText(arm());
		expect(text).toContain('could not read the scope binding store');
		// Reported as seen, which is what the sweep established.
		expect(text).toContain(
			'⚠️ 1 unidentifiable scope binding row(s) were seen in the scope binding store',
		);
	}, 60_000);

	test('a row that was unidentifiable and is attributable to another session is not reported', async () => {
		const root = newSweepRoot();
		seedOneFullPage(root);
		stripAttribution(root);
		// Before the sweep acts on page 1 a concurrent writer hands the row to
		// another session; page 1 acts on its stale snapshot.
		armListings((listing, directory) => {
			if (listing === 1) handToAnotherSession(directory);
		});
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
	}, 60_000);

	test('a row that another process re-inserts and a later page retires again is counted once', async () => {
		const root = newSweepRoot();
		const intact = intactPayloadOf(root);
		const listings = armReinserted(root, intact);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		// Two rows were cleared, not three retirements.
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 2,
		});
		expect(survivingKeys(root)).toEqual([]);
	}, 60_000);

	test('a row retired and then re-inserted corrupt is reported once, as unidentifiable', async () => {
		// Page 2 sees the re-inserted row corrupt: the sweep's latest word on
		// the key is no longer "cleared".
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			const listings = armReinserted(root, UNCLAIMABLE_PAYLOAD);
			return { root, listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			unidentifiable: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
		// The same interleaving through the command.
		const text = await resetText(arm().root);
		expect(text).toContain('✅ Cleared 1 durable scope binding row(s)');
		expect(text).toContain(
			'⚠️ 1 unidentifiable scope binding row(s) were seen in the scope binding store',
		);
	}, 60_000);

	test('a row retired and then re-inserted whose second retirement cannot be confirmed is reported once, as not confirmed', async () => {
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			const intact = intactPayloadOf(root);
			// After page 2 is listed, and before the sweep acts on it, the
			// other process moves the re-inserted row again: that retirement
			// misses.
			const listings = armReinserted(root, intact, (directory, page) => {
				rewriteListedRow(directory, page, RACED);
			});
			return { root, listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		// The row is back and still the reset sessions': it was not left
		// cleared, and it is not counted as cleared in the report.
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			failed: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
		// The same interleaving through the command: one description of the row.
		const text = await resetText(arm().root);
		expect(text).toContain('✅ Cleared 1 durable scope binding row(s)');
		expect(text).not.toContain('Cleared 2');
		expect(text).toContain(
			'⚠️ This sweep could not confirm retiring 1 durable scope binding row(s) of the reset session(s): they were read again and found still in place',
		);
	}, 60_000);

	test('a row retired and then re-inserted by another session is still counted as cleared, and not reported', async () => {
		const root = newSweepRoot();
		const intact = intactPayloadOf(root);
		// Page 2 sees the re-inserted row as another session's. Nothing of the
		// reset sessions' is left unresolved, so their earlier clearing stands
		// and the row is not reported at all.
		const foreign = JSON.stringify({
			...(JSON.parse(intact) as Record<string, unknown>),
			ownerSessionId: 'someone-else',
		});
		const listings = armReinserted(root, foreign);
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 2,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
	}, 60_000);

	test('a row that failed, changed hands and is listed again as another session’s is not read again, and is reported as relinquished', async () => {
		const arm = (later: (directory: string) => void): string => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			armListings((listing, directory, page) => {
				// Before the sweep acts on page 1 a concurrent writer moves the
				// raced row (its retirement misses) and hands it to another
				// session. Page 2 lists it as that session's; `later` is that
				// session acting before the sweep acts on page 2.
				if (listing === 1) {
					rewriteListedRow(directory, page, RACED);
					handToAnotherSession(directory);
				}
				if (listing === 2) later(directory);
			});
			return root;
		};
		let reads = 0;
		_scopePersistenceInternals.readResetSweepRow = () => {
			reads += 1;
			throw new Error('injected read failure');
		};
		const outcomeRoot = arm(() => {});
		const outcome = await clearSessionScopeBindingsFromDisk(outcomeRoot, [
			'victim',
		]);
		// The sweep's LAST listing showed the row as another session's, so
		// there is nothing to read again. The attempt it could not confirm is
		// not dropped: the row is reported as no longer theirs.
		expect(reads).toBe(0);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
		});
		expect(survivingKeys(outcomeRoot)).toEqual([RACED]);
		const text = await resetText(arm(() => {}));
		expect(reads).toBe(0);
		expect(text).toContain('✅ Cleared 1 durable scope binding row(s)');
		expect(text).toContain(RELINQUISHED_LINE);
		expect(text).not.toContain('⚠️ This sweep could not confirm retiring');
		// Nor when that session then deletes the row.
		await resetText(
			arm((directory) => {
				deleteCoordinationState(directory, 'scope-binding', RACED);
			}),
		);
		expect(reads).toBe(0);
	}, 60_000);

	test('a row that failed, changed hands and was then deleted is reported as relinquished', async () => {
		const arm = (): string => {
			const root = newSweepRoot();
			seedOneFullPage(root);
			armListings((listing, directory, page) => {
				// Before the sweep acts on page 1 a concurrent writer moves the
				// raced row, hands it to another session and deletes it. The
				// sweep acts on its stale page, so the retirement misses; the
				// final read then finds the row gone.
				if (listing !== 1) return;
				rewriteListedRow(directory, page, RACED);
				handToAnotherSession(directory);
				deleteCoordinationState(directory, 'scope-binding', RACED);
			});
			return root;
		};
		const root = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			...SWEPT,
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
		});
		expect(survivingKeys(root)).toEqual([]);
		const text = await resetText(arm());
		expect(text).toContain('✅ Cleared 1 durable scope binding row(s)');
		expect(text).toContain(RELINQUISHED_LINE);
		expect(text).not.toContain('⚠️ This sweep could not confirm retiring');
	}, 60_000);
});
