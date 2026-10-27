import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { LeanTurboConfigSchema } from '../../../../src/config/schema';
import {
	getValidatedFiles,
	type PlanTask,
	runPartitionPreflight,
} from '../../../../src/turbo/lean/partition-common';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

describe('getValidatedFiles', () => {
	test('keeps scopes relative when the macOS workspace lives below /private', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(getValidatedFiles(['src/a.ts'], workspace)).toEqual([
			['src/a.ts'],
			0,
		]);
	});

	test('normalizes an absolute scope inside the workspace to its relative path', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(
			getValidatedFiles(
				['/private/var/folders/test/opencode-swarm/src/a.ts'],
				workspace,
			),
		).toEqual([['src/a.ts'], 0]);
	});

	test('rejects an absolute scope outside the workspace', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(
			getValidatedFiles(['/private/var/folders/test/other/a.ts'], workspace),
		).toEqual([[], 1]);
	});
});

describe('runPartitionPreflight declared-scope lookup', () => {
	const tempDir = canonicalMkdtemp('partition-common-');
	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const config = LeanTurboConfigSchema.parse({
		require_declared_scope: false,
	});
	const makeTask = (id: string): PlanTask => ({
		id,
		description: 'task',
		status: 'pending',
		files_touched: ['src/a.ts'],
	});

	test('a task id matching an inherited Object.prototype key is not treated as a declared scope', () => {
		const { taskMap } = runPartitionPreflight(
			tempDir,
			[makeTask('constructor')],
			config,
			{},
		);

		const classified = taskMap.get('constructor');
		expect(classified?.hasDeclaredScope).toBe(false);
		expect(classified?.files).toEqual(['src/a.ts']);
	});

	test('a task id that is an own key of scopes still uses the declared scope', () => {
		const scopes: Record<string, string[]> = { constructor: ['src/b.ts'] };
		const { taskMap } = runPartitionPreflight(
			tempDir,
			[makeTask('constructor')],
			config,
			scopes,
		);

		const classified = taskMap.get('constructor');
		expect(classified?.hasDeclaredScope).toBe(true);
		expect(classified?.files).toEqual(['src/b.ts']);
	});
});
