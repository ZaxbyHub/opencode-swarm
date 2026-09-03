import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleRecoverCommand } from '../../../src/commands/recover.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _snapshotCoordinationInternals } from '../../../src/session/snapshot-coordination-init.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('/swarm recover --coordination (#2481)', () => {
	let directory = '';
	const originalInitialize = _snapshotCoordinationInternals.initialize;

	beforeEach(() => {
		directory = canonicalMkdtemp('recover-coordination-');
		_snapshotCoordinationInternals.entries.clear();
	});

	afterEach(() => {
		_snapshotCoordinationInternals.initialize = originalInitialize;
		_snapshotCoordinationInternals.entries.clear();
		closeAllProjectDbs();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('runs a fresh bounded coordination initialization attempt', async () => {
		let calls = 0;
		_snapshotCoordinationInternals.initialize = async () => {
			calls += 1;
		};

		const output = await handleRecoverCommand(directory, ['--coordination']);

		expect(calls).toBe(1);
		expect(output).toContain('SQLite Coordination Recovery');
		expect(output).toContain('completed successfully');
	});

	test('reports a failed recovery without falling through to WAL repair', async () => {
		_snapshotCoordinationInternals.initialize = async () => {
			throw new Error('import corrupt');
		};

		const output = await handleRecoverCommand(directory, ['--coordination']);

		expect(output).toContain('Recovery refused or failed');
		expect(output).toContain('import corrupt');
		expect(output).not.toContain('Coder Settlement Recovery');
	});
});
