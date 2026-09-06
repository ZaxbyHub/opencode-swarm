/**
 * Issue #2037 — /swarm close wiring for the bounded context-map telemetry store.
 * The single-file store (`context-telemetry.jsonl`) must be ARCHIVED as a
 * defined, validated cut (finalizeContextTelemetry folds the tail before
 * archiving) and deliberately NOT cleaned (cross-session state; compaction is
 * the retention mechanism). Both lists live in the close constants module,
 * so this pins them as a source-contract guard: moving
 * the entry to the cleanup list would violate the issue-#2037 close contract.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const constantsSource = readFileSync(
	join(
		import.meta.dir,
		'..',
		'..',
		'..',
		'src',
		'commands',
		'close',
		'constants.ts',
	),
	'utf-8',
);
const archiveStageSource = readFileSync(
	join(
		import.meta.dir,
		'..',
		'..',
		'..',
		'src',
		'commands',
		'close',
		'archive-stage.ts',
	),
	'utf-8',
);

function arrayRegion(name: string): string {
	const start = constantsSource.indexOf(`const ${name} = [`);
	if (start === -1) throw new Error(`${name} not found in close/constants.ts`);
	const end = constantsSource.indexOf('];', start);
	return constantsSource.slice(start, end);
}

const CONTEXT_TELEMETRY_ARTIFACTS = ['context-telemetry.jsonl'];

describe('/swarm close × context-map telemetry store (#2037)', () => {
	it('finalizes then archives the complete context-map telemetry store', () => {
		const archive = arrayRegion('ARCHIVE_ARTIFACTS');
		for (const artifact of CONTEXT_TELEMETRY_ARTIFACTS) {
			expect(archive).toContain(`'${artifact}'`);
		}
		// The finalize-before-archive wiring must EXIST and be ORDERED ahead of
		// the archive loop (fold tail => atomic cut). A refactor that moves the
		// call after the copy, or into a dead branch, must fail here.
		const finalizeIndex = archiveStageSource.indexOf(
			'finalizeContextTelemetry(',
		);
		const archiveLoopIndex = archiveStageSource.indexOf(
			'for (const artifact of ARCHIVE_ARTIFACTS)',
		);
		expect(finalizeIndex).toBeGreaterThan(-1);
		expect(archiveLoopIndex).toBeGreaterThan(-1);
		expect(finalizeIndex).toBeLessThan(archiveLoopIndex);
	});

	it('never cleans the context-map telemetry store (cross-session state survives close)', () => {
		const clean = arrayRegion('ACTIVE_STATE_TO_CLEAN');
		for (const artifact of CONTEXT_TELEMETRY_ARTIFACTS) {
			expect(clean).not.toContain(`'${artifact}'`);
		}
	});
});
