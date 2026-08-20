/**
 * Issue #2034 — /swarm close wiring for the background-delegation store.
 * The delegation ledger, checkpoint, manifest, and health artifact must be
 * ARCHIVED as a set (forensic completeness) and deliberately NOT cleaned
 * (cross-session state; compaction is the retention mechanism). Both lists
 * are module-private in src/commands/close.ts, so this pins them as a
 * source-contract guard (same pattern as the swarm-write-cache scan guards):
 * removing the entries or moving them to the cleanup list fails this test.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const closeSource = readFileSync(
	join(import.meta.dir, '..', '..', '..', 'src', 'commands', 'close.ts'),
	'utf-8',
);

function arrayRegion(name: string): string {
	const start = closeSource.indexOf(`const ${name} = [`);
	if (start === -1) throw new Error(`${name} not found in close.ts`);
	const end = closeSource.indexOf('];', start);
	return closeSource.slice(start, end);
}

const DELEGATION_ARTIFACTS = [
	'background-delegations.jsonl',
	'background-delegations.checkpoint.json',
	'background-delegations.manifest.json',
	'background-delegations-health.json',
];

describe('/swarm close × background-delegation store (#2034)', () => {
	it('archives the complete delegation store set', () => {
		const archive = arrayRegion('ARCHIVE_ARTIFACTS');
		for (const artifact of DELEGATION_ARTIFACTS) {
			expect(archive).toContain(`'${artifact}'`);
		}
	});

	it('never cleans the delegation store (cross-session state survives close)', () => {
		const clean = arrayRegion('ACTIVE_STATE_TO_CLEAN');
		for (const artifact of DELEGATION_ARTIFACTS) {
			expect(clean).not.toContain(`'${artifact}'`);
		}
	});
});
