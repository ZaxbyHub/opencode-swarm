import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeAllProjectDbs, deleteCoordinationState } from '../../../src/db';
import { clearScopeBindings } from '../../../src/scope/scope-binding';
import {
	_scopePersistenceInternals,
	clearSessionScopeBindingsFromDisk,
} from '../../../src/scope/scope-persistence';
import { resetSwarmState } from '../../../src/state';
import {
	corruptDenyLedger,
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
} from '../../helpers/reset-sweep-fixtures-3889';
import { freezeClock, type Restore } from '../../helpers/test-clock';

// Exit-time reconciliation of the reset sweep (#3889). A retirement attempt
// that throws says nothing about whether the retirement committed: the
// transaction wrapper restores a pragma after COMMIT and lets that error
// propagate. So before the sweep reports such a row it reads the row again and
// states only what that established — still theirs, unchecked (the store
// refused the read), corrupt, or gone / no longer theirs. None of these rows
// is dropped, and the sweep never says a row could not have been retired.

/** Two victim rows at capacity 2. A concurrent writer moves one row's
 * revision after page 1 is listed, so its retirement misses while the other
 * row is removed; page 2 is listed. `betweenPages` is that writer acting on
 * page 2 before the sweep reads it. Returns the listings so far. */
function armRaceThen(
	root: string,
	betweenPages: (root: string, page: readonly RawSweepRow[]) => void = () => {},
): () => number {
	_scopePersistenceInternals.bindingFileScanCapacity = 2;
	seedVictimRow(root, RACED);
	seedVictimRow(root, OTHER);
	let listings = 0;
	_scopePersistenceInternals.listResetSweepRows = (directory: string) => {
		listings += 1;
		const page = listRowsUnseamed(directory);
		if (listings === 1) rewriteListedRow(directory, page, RACED);
		if (listings === 2) betweenPages(directory, page);
		return page;
	};
	return () => listings;
}

const NOTHING_UNRESOLVED = {
	failed: 0,
	unchecked: 0,
	unidentifiable: 0,
	unconfirmedRelinquished: 0,
	unreadable: false,
	truncated: false,
};
const RELINQUISHED_LINE =
	"ℹ️ 1 durable scope binding row(s) that the sweep listed as the reset session(s)' are gone or are no longer the reset session(s)' after a retirement attempt this sweep could not confirm; whether this sweep or another process removed or replaced them is not known.";

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

describe('a row whose retirement attempt threw is read again before it is reported (#3889)', () => {
	test('a row a concurrent writer removed is reported as gone, not as left in place', async () => {
		// Page 1: the raced row fails against a stale revision and the other is
		// removed. Before page 2 a concurrent writer deletes the raced row.
		const removeRaced = (directory: string): void => {
			deleteCoordinationState(directory, 'scope-binding', RACED);
		};
		const outcomeRoot = newSweepRoot();
		const listings = armRaceThen(outcomeRoot, removeRaced);
		const outcome = await clearSessionScopeBindingsFromDisk(outcomeRoot, [
			'victim',
		]);
		expect(listings()).toBe(2);
		// Not cleared by this sweep, so not counted as cleared; not left in
		// place; and not dropped from the report.
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
		});
		expect(survivingKeys(outcomeRoot)).toEqual([]);
		const commandRoot = newSweepRoot();
		armRaceThen(commandRoot, removeRaced);
		const text = await resetText(commandRoot);
		expect(text).toContain('✅ Cleared 1 durable scope binding row(s)');
		expect(text).toContain(RELINQUISHED_LINE);
		expect(text).not.toContain('This sweep could not confirm retiring');
	}, 60_000);

	test('a row a concurrent writer re-attributed is reported as no longer theirs, not as left in place', async () => {
		const arm = (): { root: string; listings: () => number } => {
			const root = newSweepRoot();
			// Page 2: the row is handed to another session (which bumps its
			// revision again, so the stale page's second attempt misses too).
			const listings = armRaceThen(root, (directory, page) => {
				rewriteListedRow(directory, page, RACED, {
					ownerSessionId: 'someone-else',
				});
			});
			return { root, listings };
		};
		const { root, listings } = arm();
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(listings()).toBe(2);
		// The row is still durable, but no longer the reset sessions'. The
		// sweep cannot say it cleared it, and does not drop it.
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 1,
			unconfirmedRelinquished: 1,
		});
		expect(survivingKeys(root)).toEqual([RACED]);
		const text = await resetText(arm().root);
		expect(text).toContain(RELINQUISHED_LINE);
		expect(text).not.toContain('found still in place');
	}, 60_000);

	test('a row the store refuses to read again is reported as unchecked, not as left in place', async () => {
		const root = newSweepRoot();
		// Every retirement throws (the ledger cannot be updated), and the
		// store then refuses the final read of each such row.
		corruptDenyLedger(root);
		seedVictimRow(root, RACED);
		seedVictimRow(root, OTHER);
		_scopePersistenceInternals.readResetSweepRow = () => {
			throw new Error('injected read failure');
		};
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 0,
			unchecked: 2,
		});
		expect(survivingKeys(root)).toEqual([RACED, OTHER]);
		const text = await resetText(root);
		expect(text).toContain(
			"⚠️ This sweep could not confirm retiring 2 durable scope binding row(s) that were the reset session(s)' when the sweep last listed them, and could not check afterwards whether they remain in the scope binding store (.swarm/swarm.db, namespace scope-binding).",
		);
		// Presence is exactly what could not be established; non-retirement is
		// exactly what a throw does not prove.
		expect(text).not.toContain('found still in place');
		expect(text).not.toContain('could not be retired');
	}, 60_000);

	test('a row read again and found still there is reported apart from one the store refuses to read', async () => {
		const root = newSweepRoot();
		corruptDenyLedger(root);
		seedVictimRow(root, RACED);
		seedVictimRow(root, OTHER);
		_scopePersistenceInternals.readResetSweepRow = (
			directory,
			generationId,
		) => {
			if (generationId === RACED) throw new Error('injected read failure');
			return readRowUnseamed(directory, generationId);
		};
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		expect(outcome).toMatchObject({
			removed: 0,
			failed: 1,
			unchecked: 1,
			unconfirmedRelinquished: 0,
			unidentifiable: 0,
		});
		const text = await resetText(root);
		expect(text).toContain(
			'⚠️ This sweep could not confirm retiring 1 durable scope binding row(s) of the reset session(s): they were read again and found still in place in the scope binding store (.swarm/swarm.db, namespace scope-binding).',
		);
		expect(text).toContain(
			"⚠️ This sweep could not confirm retiring 1 durable scope binding row(s) that were the reset session(s)' when the sweep last listed them, and could not check afterwards whether they remain",
		);
	}, 60_000);

	test('a row retired on a later page is not reported at all when the store then refuses every read', async () => {
		const outcomeRoot = newSweepRoot();
		// The raced row fails on page 1 and is retired on page 2. A failed
		// earlier attempt must not come back as a row this sweep could not
		// confirm retiring.
		const listings = armRaceThen(outcomeRoot);
		_scopePersistenceInternals.readResetSweepRow = () => {
			throw new Error('injected read failure');
		};
		const outcome = await clearSessionScopeBindingsFromDisk(outcomeRoot, [
			'victim',
		]);
		expect(listings()).toBe(2);
		expect(outcome).toMatchObject({
			...NOTHING_UNRESOLVED,
			removed: 2,
		});
		expect(survivingKeys(outcomeRoot)).toEqual([]);
		const commandRoot = newSweepRoot();
		armRaceThen(commandRoot);
		const text = await resetText(commandRoot);
		expect(text).toContain('✅ Cleared 2 durable scope binding row(s)');
		expect(text).not.toContain('could not confirm');
	}, 60_000);

	test('a row found corrupt when it is read again is reported as unidentifiable, not dropped', async () => {
		const root = newSweepRoot();
		// Every retirement throws (the ledger cannot be updated). Before the
		// final read a concurrent writer strips one row's session attribution
		// — the realistic corruption. The page loop reports that observation;
		// the final read must not drop it.
		corruptDenyLedger(root);
		seedVictimRow(root, RACED);
		seedVictimRow(root, OTHER);
		_scopePersistenceInternals.readResetSweepRow = (
			directory,
			generationId,
		) => {
			if (generationId === RACED)
				rewriteRowPayload(directory, RACED, '{"corrupt":true}');
			return readRowUnseamed(directory, generationId);
		};
		const outcome = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		// One row is still the reset sessions'; one is corrupt. Each is
		// reported once.
		expect(outcome).toMatchObject({
			removed: 0,
			failed: 1,
			unidentifiable: 1,
			unchecked: 0,
			unconfirmedRelinquished: 0,
			unreadable: false,
			truncated: false,
		});
		expect(survivingKeys(root)).toEqual([RACED, OTHER]);
		const text = await resetText(root);
		expect(text).toContain(
			'⚠️ 1 unidentifiable scope binding row(s) were seen in the scope binding store',
		);
		expect(text).toContain(
			'⚠️ This sweep could not confirm retiring 1 durable scope binding row(s) of the reset session(s): they were read again and found still in place',
		);
	}, 60_000);
});
