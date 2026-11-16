import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const BASE_SHA = '2b1f4e888d3a5f6c2d8a4c7f1b0e3d5c6a4b7e8f';
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const createdDirs: string[] = [];

/**
 * The verbatim opencode-swarm repository `build` script (package.json#build at
 * HEAD). Any compound-script trust rule that Stage A ships must accept this
 * exact text when the base revision carries the same text; the repo's own build
 * must never be gated behind a hand-written `.pr-validation.json` validator.
 */
const REPO_BUILD_SCRIPT =
	'bun run clean && bun run scripts/generate-config-schema.ts && bun run scripts/copy-grammars.ts && bun build src/index.ts --outdir dist --target node --format esm --external web-tree-sitter --minify-whitespace --minify-syntax && bun build src/cli/index.ts --outdir dist/cli --target bun --format esm --external bash-parser --splitting && bun run scripts/copy-grammars.ts --to-dist && tsc --emitDeclarationOnly';

afterEach(() => {
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a trusted base-identical repo build script (AC2)', () => {
	/**
	 * AC2 — RED at base, GREEN after the fix.
	 *
	 * The working tree declares the real opencode-swarm `build` script (a long
	 * `&&` chain, opaque to simple-command parsing), and the stubbed base
	 * revision returns the identical manifest text. With merge-base provenance
	 * supplied, discovery must return the normal build obligation for the root
	 * workspace instead of throwing the opaque-script BLOCKED error. The stub
	 * answers ONLY for (BASE_SHA, 'package.json') and mirrors the real
	 * readGitTextAtRevision(directory, revision, relativePath) signature.
	 */
	test('the verbatim repo build script is trusted when base-identical', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-repo-build-');
		createdDirs.push(directory);
		const packageText = `${JSON.stringify(
			{ scripts: { build: REPO_BUILD_SCRIPT } },
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

		expect(obligations).toEqual([
			{
				id: 'build:.:package.json#build',
				category: 'build',
				workingDirectory: '.',
				source: 'package.json#build',
			},
		]);
	});
});
