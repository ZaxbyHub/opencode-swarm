import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	compactBackgroundDelegations,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-authority-');

beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	closeAllProjectDbs();
	cleanup();
});

describe('pending-delegations SQLite authority boundary', () => {
	test('refuses compaction when a present authority row is unreadable', async () => {
		const ledgerPath = path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
		fs.writeFileSync(ledgerPath, 'legacy-data-that-must-not-be-used\n');
		// Bypass the transition validator to model on-disk corruption discovered
		// during a read; normal writes reject malformed JSON before it reaches SQL.
		getProjectDb(dir).run(
			`INSERT INTO coordination_state
				(namespace, entity_key, revision, generation, status, payload, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				'background.pending-delegation',
				'damaged',
				1,
				1,
				'completed',
				'not-json',
				new Date().toISOString(),
			],
		);

		const result = await compactBackgroundDelegations(dir, { force: true });

		expect(result.status).toBe('uncertain');
		expect(result.reason).toContain('refusing legacy compaction fallback');
		expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(
			'legacy-data-that-must-not-be-used\n',
		);
	});
});
