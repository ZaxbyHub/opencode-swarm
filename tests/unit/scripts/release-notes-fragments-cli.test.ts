import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import { validateHistoricalReplayProof } from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('release note historical batch CLI', () => {
	test('emits reusable JSON on stdout and diagnostics only on stderr', () => {
		const root = canonicalMkdtemp('swarm-release-cli-');
		roots.push(root);
		mkdirSync(path.join(root, 'scripts'), { recursive: true });
		mkdirSync(path.join(root, '.release-fragment-cleanup'), {
			recursive: true,
		});
		copyFileSync(
			path.resolve(
				import.meta.dir,
				'../../../scripts/release-notes-fragments.mjs',
			),
			path.join(root, 'scripts/release-notes-fragments.mjs'),
		);
		writeFileSync(
			path.join(root, '.release-fragment-cleanup/tags.json'),
			JSON.stringify({ schemaVersion: 1, tags: ['v1.0.0', 'v1.1.0'] }),
		);

		const result = spawnSync(
			process.execPath,
			[
				path.join(root, 'scripts/release-notes-fragments.mjs'),
				'prepare-historical-batch',
				'--tags-file',
				'.release-fragment-cleanup/tags.json',
				'--batch-size',
				'1',
			],
			{
				cwd: root,
				encoding: 'utf8',
				maxBuffer: 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(0);
		const batch = JSON.parse(result.stdout);
		expect(validateHistoricalReplayProof(batch, 'v1.0.0')?.hasMoreWork).toBe(
			true,
		);
		expect(result.stderr).toContain('prepared historical batch');
		expect(result.stdout).not.toContain('prepared historical batch');
	});
});
