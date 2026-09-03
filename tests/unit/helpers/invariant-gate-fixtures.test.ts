import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../../scripts/gate-utils';
import { seedInvariantGateDependencies } from '../../helpers/invariant-gate-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let fixtureDir: string | undefined;

afterEach(() => {
	if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
	fixtureDir = undefined;
});

describe('seedInvariantGateDependencies', () => {
	test('keeps the dependency junction out of temporary Git repositories', async () => {
		fixtureDir = canonicalMkdtemp('invariant-gate-dependencies-git-');
		const init = await runGit(['init', '-q'], fixtureDir, 10_000);
		expect(init.exitCode, init.stderr).toBe(0);

		seedInvariantGateDependencies(fixtureDir);

		const excludeEntries = fs
			.readFileSync(path.join(fixtureDir, '.git', 'info', 'exclude'), 'utf8')
			.split(/\r?\n/u);
		expect(excludeEntries).toContain('node_modules/');
		const ignoredDependency = await runGit(
			['check-ignore', 'node_modules'],
			fixtureDir,
			10_000,
		);
		expect(ignoredDependency.exitCode, ignoredDependency.stderr).toBe(0);

		const add = await runGit(['add', '-A'], fixtureDir, 10_000);
		expect(add.exitCode, add.stderr).toBe(0);
	});

	test('does not create Git metadata for a non-Git fixture', () => {
		fixtureDir = canonicalMkdtemp('invariant-gate-dependencies-plain-');

		seedInvariantGateDependencies(fixtureDir);

		expect(fs.existsSync(path.join(fixtureDir, '.git'))).toBe(false);
		expect(fs.existsSync(path.join(fixtureDir, 'node_modules'))).toBe(true);
	});
});
