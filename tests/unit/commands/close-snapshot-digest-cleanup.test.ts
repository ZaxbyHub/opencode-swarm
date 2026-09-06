/**
 * PR #2588 PRR-015 — /swarm close wiring for the workspace-snapshot digest
 * marker. `workspace-snapshot.digest` (SNAPSHOT_DIGEST_MARKER_FILENAME,
 * src/background/workspace-snapshot.ts) is the content-digest skip marker
 * written by `captureWorkspaceSnapshotAsync`. It is session-generated derived
 * state: `/swarm close` must archive it and then REMOVE it, so a stale digest
 * from the closed session can never influence the next session's
 * `shouldSkipSnapshot` decision. Both lists are module-private in
 * src/commands/close.ts, so this pins the wiring as a source-contract guard
 * (same pattern as close-delegation-archive.test.ts): dropping either entry,
 * or removing only one half of the archive+clean pair (which the archive-first
 * guard would silently never delete), fails this test. The lists now live in
 * the extracted close constants module.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const closeSource = readFileSync(
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

function arrayRegion(name: string): string {
	const start = closeSource.indexOf(`const ${name} = [`);
	if (start === -1) throw new Error(`${name} not found in close/constants.ts`);
	const end = closeSource.indexOf('];', start);
	return closeSource.slice(start, end);
}

describe('/swarm close × workspace-snapshot digest marker (PRR-015)', () => {
	it('archives workspace-snapshot.digest (forensic copy, enables the archive-first delete)', () => {
		expect(arrayRegion('ARCHIVE_ARTIFACTS')).toContain(
			"'workspace-snapshot.digest'",
		);
	});

	it('cleans workspace-snapshot.digest (stale skip marker must not survive close)', () => {
		expect(arrayRegion('ACTIVE_STATE_TO_CLEAN')).toContain(
			"'workspace-snapshot.digest'",
		);
	});
});
