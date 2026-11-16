// #2969 rename dedup: the PRR-003 pinned contract (one retryable EPERM is
// retried; a non-retryable code fails fast), relocated from
// core-events-store.test.ts (FR-006: the parent sat at 499 lines; the seam
// retarget from core-events' own mirror to atomic-write's `_internals`
// pushed it over the 500-line cap). Assertion shapes unchanged.
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	appendCoreEventSync,
	CORE_EVENT_LIMITS,
	type CoreEventLimits,
} from '../../../src/events/core-events';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function eventsFile(dir: string): string {
	return path.join(dir, '.swarm', 'events.jsonl');
}

function rawLines(dir: string): string[] {
	return fs
		.readFileSync(eventsFile(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim() !== '');
}

function tinyLimits(over: Partial<CoreEventLimits> = {}): CoreEventLimits {
	return {
		...CORE_EVENT_LIMITS,
		ageMaxMs: Number.MAX_SAFE_INTEGER,
		checkInterval: 1_000_000,
		...over,
	};
}

function opEvent(seq: number, pad = 80): Record<string, unknown> {
	return {
		type: 'op',
		seq,
		pad: 'x'.repeat(pad),
	};
}

describe('core event store rename retry (PRR-003, #2969)', () => {
	test('transient EPERM on the atomic rename is retried; non-retryable fails fast', () => {
		const dir = canonicalMkdtemp('ce-rename-2969-');
		_internals.limits = tinyLimits();
		const realLimits = _internals.limits;
		// The tmp→final rename routes through the ONE shared helper in
		// src/utils/atomic-write.ts, whose DI seam (`_internals.renameSync`
		// THERE, not core-events' own mirror) is where failure injection
		// lands.
		const realRename = atomicWriteInternals.renameSync;
		type Seam = { renameSync: typeof fs.renameSync };
		let calls = 0;
		(atomicWriteInternals as Seam).renameSync = ((
			from: fs.PathLike,
			to: fs.PathLike,
		) => {
			calls += 1;
			if (calls === 1) {
				throw Object.assign(new Error('EPERM: AV scan lock'), {
					code: 'EPERM',
				});
			}
			return realRename(from, to);
		}) as typeof fs.renameSync;
		try {
			// Seed the store (manifest + first event), then an append takes
			// the atomicReplace path (tmp + rename).
			fs.mkdirSync(path.dirname(eventsFile(dir)), { recursive: true });
			appendCoreEventSync(dir, opEvent(0));
			expect(() => appendCoreEventSync(dir, opEvent(1))).not.toThrow();
			expect(calls).toBeGreaterThanOrEqual(2); // failed attempt + success
			// manifest + seed event + retried event
			expect(rawLines(dir).length).toBe(3);
			// Non-retryable codes fail immediately. Remove the store so the
			// next append recreates it (existing-file appends skip rename).
			fs.rmSync(eventsFile(dir));
			let ncalls = 0;
			(atomicWriteInternals as Seam).renameSync = (() => {
				ncalls += 1;
				throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
			}) as typeof fs.renameSync;
			expect(() => appendCoreEventSync(dir, opEvent(2))).toThrow();
			expect(ncalls).toBe(1);
		} finally {
			(atomicWriteInternals as Seam).renameSync = realRename;
			_internals.limits = realLimits;
		}
	});
});
