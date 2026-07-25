/**
 * Cross-producer recommendation dedup ledger (issue #1821 AC21) — bounds,
 * eviction, concurrency, and every fail-open path.
 *
 * Identity and check/record semantics live in `recommendation-ledger.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	checkRecommendations,
	computeCrossProducerKey,
	computeRecommendationIdentity,
	MAX_ENTRY_BYTES,
	MAX_RECOMMENDATION_LEDGER_ENTRIES,
	type RecommendationCandidate,
	type RecommendationLedgerEntry,
	readRecommendationLedger,
	recordEmittedRecommendations,
	resolveRecommendationLedgerPath,
} from '../../../src/services/recommendation-ledger.js';

const PRODUCED_AT = '2026-07-25T12:00:00.000Z';

function candidate(
	overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
	return {
		kind: 'curator',
		target: 'entry-1',
		statement: 'Prefer dependency injection over mock.module',
		scopeKeys: [],
		...overrides,
	};
}

let dir: string;
const realNow = _internals.now;
const realTransactFile = _internals.transactFile;
const realReadLedgerStrict = _internals.readLedgerStrict;
const realResolvePath = _internals.resolveRecommendationLedgerPath;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-ledger-bounds-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.now = realNow;
	_internals.transactFile = realTransactFile;
	_internals.readLedgerStrict = realReadLedgerStrict;
	_internals.resolveRecommendationLedgerPath = realResolvePath;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('ledger bounds', () => {
	it('pins the documented caps', () => {
		expect(MAX_RECOMMENDATION_LEDGER_ENTRIES).toBe(500);
		expect(MAX_ENTRY_BYTES).toBe(4096);
	});

	it('FIFO-evicts the oldest entries once the cap is exceeded', async () => {
		const overflow = 10;
		const total = MAX_RECOMMENDATION_LEDGER_ENTRIES + overflow;
		const candidates = Array.from({ length: total }, (_unused, index) =>
			candidate({ statement: `Recommendation number ${index}` }),
		);

		const result = await recordEmittedRecommendations(dir, candidates);
		expect(result.recorded).toBe(total);
		expect(result.evicted).toBe(overflow);

		const entries = await readRecommendationLedger(dir);
		expect(entries).toHaveLength(MAX_RECOMMENDATION_LEDGER_ENTRIES);
		const keys = new Set(entries.map((entry) => entry.crossKey));
		expect(
			keys.has(
				computeCrossProducerKey({
					statement: `Recommendation number ${overflow}`,
				}),
			),
		).toBe(true);
		expect(
			keys.has(
				computeCrossProducerKey({ statement: 'Recommendation number 0' }),
			),
		).toBe(false);

		// Eviction is the documented trade: an evicted recommendation may surface
		// again rather than being suppressed forever.
		const reChecked = await checkRecommendations(dir, [
			candidate({ statement: 'Recommendation number 0' }),
		]);
		expect(reChecked.accepted).toBe(1);
	});

	it('drops provenance rather than let one entry blow its byte budget', async () => {
		// 20 refs x ~500 chars is far past MAX_ENTRY_BYTES once serialized.
		const fatRefs = Array.from(
			{ length: 20 },
			(_unused, index) => `${String(index).padStart(3, '0')}${'r'.repeat(500)}`,
		);
		await recordEmittedRecommendations(dir, [
			candidate({
				provenance: {
					mechanism: 'curator_sweep',
					sourceEvidenceRefs: fatRefs,
				},
			}),
		]);

		const [entry] = await readRecommendationLedger(dir);
		expect(entry).toBeDefined();
		// The identity survives — dedup is the contract, provenance is the bonus.
		expect(entry?.crossKey).toBe(
			computeRecommendationIdentity(candidate()).crossKey,
		);
		expect(entry?.provenance).toBeUndefined();
		expect(JSON.stringify(entry).length).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
	});

	it('keeps a batch deduping when one candidate has an unstampable provenance ref', async () => {
		// `ReferenceSchema` rejects a ref over 512 chars by throwing. That throw
		// used to escape the mutate callback and fail the WHOLE batch open, so a
		// single malformed ref silently disabled dedup for every sibling.
		const result = await recordEmittedRecommendations(dir, [
			candidate({
				statement: 'A lesson with a pathological evidence ref',
				provenance: {
					mechanism: 'curator_sweep',
					sourceEvidenceRefs: ['x'.repeat(600)],
				},
			}),
			candidate({ statement: 'A perfectly ordinary sibling lesson' }),
		]);

		expect(result.degraded).toBe(false);
		expect(result.recorded).toBe(2);
		const entries = await readRecommendationLedger(dir);
		expect(entries).toHaveLength(2);
		// The over-long ref is dropped; the stamp itself still lands.
		expect(entries[0]?.provenance?.sourceEvidenceRefs).toEqual([]);
	});

	it('truncates an over-long target', async () => {
		await recordEmittedRecommendations(dir, [
			candidate({ target: 'e'.repeat(1000) }),
		]);
		const [entry] = await readRecommendationLedger(dir);
		expect(entry?.target.length).toBe(256);
	});
});

describe('ledger concurrency', () => {
	it('records one entry when two producers race on the same key', async () => {
		// The module's central claim: the record half re-checks under the lock, so
		// two concurrent producers cannot both append the same cross key.
		const statement = 'Concurrently discovered lesson';
		const [left, right] = await Promise.all([
			recordEmittedRecommendations(dir, [
				candidate({ kind: 'curator', statement }),
			]),
			recordEmittedRecommendations(dir, [
				candidate({ kind: 'improver', statement, target: 'motif-x' }),
			]),
		]);

		expect(left.degraded).toBe(false);
		expect(right.degraded).toBe(false);
		expect(left.recorded + right.recorded).toBe(1);
		expect(left.suppressed + right.suppressed).toBe(1);
		expect(await readRecommendationLedger(dir)).toHaveLength(1);
	});
});

describe('ledger resilience', () => {
	it('skips corrupt and blank ledger lines instead of failing', async () => {
		const ledgerPath = resolveRecommendationLedgerPath(dir);
		fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
		const good: RecommendationLedgerEntry = {
			v: 1,
			...computeRecommendationIdentity(candidate()),
			kind: 'curator',
			target: 'entry-1',
			emittedAt: PRODUCED_AT,
		};
		fs.writeFileSync(
			ledgerPath,
			[
				'{ not json',
				'',
				'   ',
				'{"v":1}',
				'{"fingerprint":"lrec_0000000000000000","crossKey":"not-a-cross-key"}',
				JSON.stringify(good),
				'',
			].join('\n'),
			'utf-8',
		);

		// The one well-formed line is still honoured…
		const repeat = await checkRecommendations(dir, [candidate()]);
		expect(repeat.suppressed).toBe(1);
		expect(repeat.degraded).toBe(false);

		// …and the corrupt lines are dropped from the rewritten ledger.
		await recordEmittedRecommendations(dir, [
			candidate({ statement: 'A brand new lesson worth keeping' }),
		]);
		expect(await readRecommendationLedger(dir)).toHaveLength(2);
	});

	it('aborts the transaction on a non-ENOENT read error instead of clobbering', async () => {
		// The write-back half of `transactFile` would otherwise persist ONLY the
		// new entries, silently destroying an existing ledger it could not read.
		await recordEmittedRecommendations(dir, [
			candidate({ statement: 'An existing lesson that must survive' }),
		]);
		const ledgerPath = resolveRecommendationLedgerPath(dir);
		const before = fs.readFileSync(ledgerPath, 'utf-8');

		// A directory in place of the file makes readFile fail with EISDIR.
		fs.rmSync(ledgerPath);
		fs.mkdirSync(ledgerPath);
		const result = await recordEmittedRecommendations(dir, [
			candidate({ statement: 'A replacement lesson' }),
		]);
		expect(result.degraded).toBe(true);
		expect(result.recorded).toBe(0);

		fs.rmSync(ledgerPath, { recursive: true });
		fs.writeFileSync(ledgerPath, before, 'utf-8');
		expect(await readRecommendationLedger(dir)).toHaveLength(1);
	});

	it('fails open when the ledger transaction throws', async () => {
		_internals.transactFile = async () => {
			throw new Error('lock timeout');
		};
		const result = await recordEmittedRecommendations(dir, [candidate()]);
		expect(result.degraded).toBe(true);
		expect(result.recorded).toBe(0);
	});

	it('fails open when the transaction never reaches the mutate callback', async () => {
		// `transactFile` returns false without running `mutate` when its own mkdir
		// fails, so nothing was appended AND nothing was compared.
		_internals.transactFile = async () => false;
		const result = await recordEmittedRecommendations(dir, [candidate()]);
		expect(result.degraded).toBe(true);
	});

	it('fails open — and emits everything — when the check cannot read the ledger', async () => {
		// A REAL unreadable ledger, not a stubbed reader: a directory where the
		// file belongs makes readFile fail with EISDIR. This is what makes
		// `degraded` reachable in production — the check must not mistake an
		// unreadable ledger for an empty one and then claim it deduped.
		const ledgerPath = resolveRecommendationLedgerPath(dir);
		fs.mkdirSync(ledgerPath, { recursive: true });

		const result = await checkRecommendations(dir, [candidate(), candidate()]);
		expect(result.degraded).toBe(true);
		expect(result.accepted).toBe(2);
		expect(result.decisions.every((decision) => decision.emit)).toBe(true);

		// The inspection entry point stays fail-open and quiet.
		expect(await readRecommendationLedger(dir)).toEqual([]);
	});

	it('reports a real no-op batch as healthy, not degraded', async () => {
		// Every candidate lacking an identity is a genuine no-op; it must not look
		// like a broken transaction to the caller.
		const result = await recordEmittedRecommendations(dir, [
			candidate({ statement: '   ' }),
		]);
		expect(result).toEqual({
			recorded: 0,
			suppressed: 0,
			evicted: 0,
			degraded: false,
		});
	});

	it('returns an empty list when the ledger is absent or unreadable', async () => {
		expect(await readRecommendationLedger(dir)).toEqual([]);
		_internals.resolveRecommendationLedgerPath = () => {
			throw new Error('Invalid filename: path escapes .swarm directory');
		};
		expect(await readRecommendationLedger(dir)).toEqual([]);
	});
});
