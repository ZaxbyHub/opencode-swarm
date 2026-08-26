/**
 * #2039 store contract for steering-consumed: `recordSteeringConsumed`
 * writes through the core event seam, which CREATES `.swarm/` and durably
 * records the event. The pre-#2039 behavior (silent swallow on a missing
 * `.swarm/`) dropped consumption records — the exact bug the seam fixes.
 * The parent suite (`tests/unit/hooks/steering-consumed.test.ts`) keeps a
 * minimal not-throw assertion; the durable-recording contract lives here so
 * that over-cap file does not grow (FR-006).
 */

import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordSteeringConsumed } from '../../../src/hooks/steering-consumed.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

test('recordSteeringConsumed creates .swarm and durably records the event', () => {
	const dir = canonicalMkdtemp('steering-store-contract-');
	expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);

	expect(() => recordSteeringConsumed(dir, 'dir-456')).not.toThrow();

	const eventsPath = path.join(dir, '.swarm', 'events.jsonl');
	const eventLines = fs
		.readFileSync(eventsPath, 'utf-8')
		.trim()
		.split('\n')
		.filter((l) => !l.includes('swarm-events-manifest'));
	expect(eventLines).toHaveLength(1);
	const event = JSON.parse(eventLines[0]!) as {
		type: string;
		directiveId: string;
	};
	expect(event.type).toBe('steering-consumed');
	expect(event.directiveId).toBe('dir-456');
});
