import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const BASE_SHA = '1f0e3d999c2b6e7b1c9b4b8e0a1d2c3b4a5f6e7d';
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const createdDirs: string[] = [];

afterEach(() => {
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a trusted base-identical compound script discovery (AC1)', () => {
	/**
	 * AC1 — RED at base, GREEN after the fix.
	 *
	 * A package.json script whose NAME matches a Stage A category (build/lint)
	 * and whose TEXT is compound (`&&`) is opaque to simple-command parsing.
	 * When the caller supplies merge-base provenance and the base revision's
	 * package.json carries the byte-identical script text, discovery must
	 * return normal obligations for those scripts instead of throwing
	 * `BLOCKED: Stage A opaque package script ...`. The stub answers ONLY for
	 * (BASE_SHA, 'package.json') and mirrors the real
	 * readGitTextAtRevision(directory, revision, relativePath) signature.
	 */
	test('base-identical compound build and lint scripts produce normal obligations with no validatorContract', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-discovery-');
		createdDirs.push(directory);
		const packageText = `${JSON.stringify(
			{
				scripts: {
					build: 'bun run clean && bun run build:ts',
					lint: 'eslint . && prettier --check .',
				},
			},
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

		const obligations = _internals.discoverApplicableStageAObligations(
			directory,
			{ baseRef: 'origin/main', baseSha: BASE_SHA },
		);

		expect([...obligations].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
			{
				id: 'build:.:package.json#build',
				category: 'build',
				workingDirectory: '.',
				source: 'package.json#build',
			},
			{
				id: 'lint:.:package.json#lint',
				category: 'lint',
				workingDirectory: '.',
				source: 'package.json#lint',
			},
		]);
	});

	/**
	 * Round-2 review (absent-key mutant): the base manifest PARSES but its
	 * scripts object omits the key the working tree adds — the actual
	 * "PR-added script" shape. The guard must treat a missing base key as
	 * not-base-identical (opaque/BLOCKED), not as a trust pass; the mutant
	 * `baseScript === undefined || (...)` survived every fixture that only
	 * covered the differing-text shape.
	 */
	test('a base manifest that parses but omits the script key stays BLOCKED', () => {
		const directory = canonicalMkdtemp('stage-a-absent-key-');
		createdDirs.push(directory);
		const workingText = `${JSON.stringify(
			{ scripts: { build: 'bun run clean && bun run build:ts' } },
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(directory, 'package.json'), workingText);
		const baseText = `${JSON.stringify(
			{ scripts: { test: 'bun test' } },
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
		).toThrow(
			'Stage A opaque package script ./package.json#build requires a trusted base-identical contract validator for build',
		);
	});
});
