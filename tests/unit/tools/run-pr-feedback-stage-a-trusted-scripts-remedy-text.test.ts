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

describe('run-pr-feedback-stage-a opaque-script BLOCKED remedy text (AC4)', () => {
	/**
	 * AC4 — RED at base, GREEN after the fix.
	 *
	 * A compound category-named package script with NO merge-base provenance
	 * (discovery called with a single argument) must stay BLOCKED, and the
	 * thrown message must tell the user the way out: it must name the
	 * `.pr-validation.json` contract remedy in addition to the opaque-script
	 * diagnosis. Nothing is stubbed — no provenance means no base read.
	 */
	test('BLOCKED message names the .pr-validation.json remedy alongside the opaque-script diagnosis', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-remedy-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify(
				{ scripts: { build: 'echo one && echo two' } },
				null,
				'\t',
			)}\n`,
		);

		let message = '';
		try {
			_internals.discoverApplicableStageAObligations(directory);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('Stage A opaque package script');
		expect(message).toContain('.pr-validation.json');
	});
});
