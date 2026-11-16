import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const createdDirs: string[] = [];

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a compound scripts without provenance (AC6)', () => {
	/**
	 * AC6 — PRESERVING: green at base and head.
	 *
	 * Without merge-base provenance there is no immutable base revision that
	 * could vouch for a compound category-named package script, so discovery
	 * must keep throwing the `Stage A opaque package script` BLOCKED error.
	 * Nothing is stubbed: discovery is called with a single argument and no
	 * base read can happen.
	 */
	test('compound build script with no provenance still throws the opaque-script BLOCKED error', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-noprov-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify(
				{ scripts: { build: 'bun run clean && bun run build:ts' } },
				null,
				'\t',
			)}\n`,
		);

		expect(() =>
			_internals.discoverApplicableStageAObligations(directory),
		).toThrow('Stage A opaque package script');
	});
});
