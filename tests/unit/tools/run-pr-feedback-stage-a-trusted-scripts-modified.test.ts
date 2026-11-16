import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const BASE_SHA = '3c2f5d997e4b6a7d3e9b5d8a2c1f4e6d7b5c8f9a';
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const createdDirs: string[] = [];

afterEach(() => {
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a base-identity requirement for compound scripts (AC5)', () => {
	/**
	 * AC5 — PRESERVING: green at base and head.
	 *
	 * Base-identical text is the ONLY thing that can trust a compound
	 * category-named package script. This file pins the two fail-closed legs:
	 * (a) the PR MODIFIED the compound script (base text differs from the
	 * working tree), and (b) the base revision has NO package.json at all.
	 * Both must throw the `Stage A opaque package script` BLOCKED error even
	 * when merge-base provenance is supplied. The stub answers ONLY for
	 * (BASE_SHA, 'package.json') and mirrors the real
	 * readGitTextAtRevision(directory, revision, relativePath) signature.
	 */
	test('PR-modified compound script with provenance still throws the opaque-script BLOCKED error', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-modified-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify(
				{ scripts: { build: 'echo one && echo two' } },
				null,
				'\t',
			)}\n`,
		);
		const baseText = `${JSON.stringify(
			{ scripts: { build: 'echo old && echo two' } },
			null,
			'\t',
		)}\n`;
		_internals.readGitTextAtRevision = (
			_directory: string,
			revision: string,
			relativePath: string,
		): string | null =>
			revision === BASE_SHA && relativePath === './package.json'
				? baseText
				: null;

		expect(() =>
			_internals.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE_SHA,
			}),
		).toThrow('Stage A opaque package script');
	});

	/**
	 * AC5 — PRESERVING: green at base and head.
	 *
	 * Base-absent leg: the stub reports that the base revision has no
	 * package.json (readGitTextAtRevision returns null), so no base text can
	 * vouch for the working-tree compound script. Discovery with provenance
	 * must throw the same opaque-script BLOCKED shape.
	 */
	test('base revision without package.json still throws the opaque-script BLOCKED error', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-base-absent-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify(
				{ scripts: { build: 'echo one && echo two' } },
				null,
				'\t',
			)}\n`,
		);
		_internals.readGitTextAtRevision = (): string | null => null;

		expect(() =>
			_internals.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE_SHA,
			}),
		).toThrow('Stage A opaque package script');
	});
});
