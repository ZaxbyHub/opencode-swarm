/**
 * Issue #2037 — /swarm close wiring for the bounded context-map telemetry store.
 * The single-file store (`context-telemetry.jsonl`) must be ARCHIVED as a
 * defined, validated cut (finalizeContextTelemetry folds the tail before
 * archiving) and deliberately NOT cleaned (cross-session state; compaction is
 * the retention mechanism). Both lists are module-private in
 * src/commands/close.ts, so this pins them as a source-contract guard: moving
 * the entry to the cleanup list would violate the issue-#2037 close contract.
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

const CONTEXT_TELEMETRY_ARTIFACTS = ['context-telemetry.jsonl'];

describe('/swarm close × context-map telemetry store (#2037)', () => {
	it('finalizes then archives the complete context-map telemetry store', () => {
		const archive = arrayRegion('ARCHIVE_ARTIFACTS');
		for (const artifact of CONTEXT_TELEMETRY_ARTIFACTS) {
			expect(archive).toContain(`'${artifact}'`);
		}
		// The finalize-before-archive wiring must exist (fold tail => atomic cut).
		expect(closeSource).toContain('finalizeContextTelemetry(');
	});

	it('never cleans the context-map telemetry store (cross-session state survives close)', () => {
		const clean = arrayRegion('ACTIVE_STATE_TO_CLEAN');
		for (const artifact of CONTEXT_TELEMETRY_ARTIFACTS) {
			expect(clean).not.toContain(`'${artifact}'`);
		}
	});
});
