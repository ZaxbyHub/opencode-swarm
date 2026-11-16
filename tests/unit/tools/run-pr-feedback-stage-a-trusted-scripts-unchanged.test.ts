import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const BASE_SHA = '4d3f6e886f5c7b8e4fac6e9b3d2a5f7e8c6d9af0';
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const createdDirs: string[] = [];

afterEach(() => {
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a non-opaque script behaviors stay unchanged (AC8)', () => {
	/**
	 * AC8 — PRESERVING: green at base and head.
	 *
	 * Leg (a): a SIMPLE category-named script (`vite build`) is not opaque, so
	 * discovery must keep returning the concrete obligation it returns at the
	 * current tree (pinned exactly below; the plausible-build-command path adds
	 * `build:.:package.json#build` and nothing else for this fixture).
	 */
	test('simple build script keeps returning its current single obligation', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-unchanged-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify({ scripts: { build: 'vite build' } }, null, '\t')}\n`,
		);

		expect(_internals.discoverApplicableStageAObligations(directory)).toEqual([
			{
				id: 'build:.:package.json#build',
				category: 'build',
				workingDirectory: '.',
				source: 'package.json#build',
			},
		]);
	});

	/**
	 * AC8 — PRESERVING: green at base and head.
	 *
	 * Leg (b): a compound script whose NAME matches no Stage A category
	 * (`deploy`) never enters the category loop, so it must stay non-throwing
	 * and establish no obligations.
	 */
	test('compound script with a non-matching name does not throw and yields no obligations', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-deploy-');
		createdDirs.push(directory);
		fs.writeFileSync(
			path.join(directory, 'package.json'),
			`${JSON.stringify(
				{ scripts: { deploy: 'echo a && echo b' } },
				null,
				'\t',
			)}\n`,
		);

		expect(_internals.discoverApplicableStageAObligations(directory)).toEqual(
			[],
		);
	});

	/**
	 * AC8 — PRESERVING: green at base and head.
	 *
	 * Leg (c): for a simple script, supplying merge-base provenance (with a
	 * stubbed base revision that returns the identical manifest text) must not
	 * change discovery output — the trust path only concerns opaque scripts.
	 * The stub answers ONLY for (BASE_SHA, 'package.json') and mirrors the real
	 * readGitTextAtRevision(directory, revision, relativePath) signature.
	 */
	test('simple script returns the same obligations with identical-base provenance as without it', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-simple-prov-');
		createdDirs.push(directory);
		const packageText = `${JSON.stringify(
			{ scripts: { build: 'vite build' } },
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(directory, 'package.json'), packageText);
		_internals.readGitTextAtRevision = (
			_directory: string,
			revision: string,
			relativePath: string,
		): string | null =>
			revision === BASE_SHA && relativePath === './package.json'
				? packageText
				: null;

		const withoutProvenance =
			_internals.discoverApplicableStageAObligations(directory);
		const withProvenance = _internals.discoverApplicableStageAObligations(
			directory,
			{ baseRef: 'origin/main', baseSha: BASE_SHA },
		);

		expect(withProvenance).toEqual(withoutProvenance);
	});
});
