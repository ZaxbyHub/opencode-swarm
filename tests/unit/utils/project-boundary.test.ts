import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	hasExplicitProjectBoundary,
	isStrictPathDescendant,
} from '../../../src/utils/project-boundary';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;
let originalLstatSync: typeof fs.lstatSync;

beforeEach(() => {
	root = canonicalMkdtemp('project-boundary-');
	originalLstatSync = _internals.lstatSync;
});

afterEach(() => {
	_internals.lstatSync = originalLstatSync;
	safeRmRecursive(root);
});

describe('hasExplicitProjectBoundary — regression: nested roots rejected (#2127)', () => {
	it('accepts direct Git directory, gitfile, and OpenCode directory declarations', () => {
		const gitDir = path.join(root, 'git-dir');
		const gitFile = path.join(root, 'git-file');
		const opencode = path.join(root, 'opencode');
		for (const directory of [gitDir, gitFile, opencode]) {
			fs.mkdirSync(directory);
		}
		fs.mkdirSync(path.join(gitDir, '.git'));
		fs.writeFileSync(path.join(gitFile, '.git'), 'malformed is still explicit');
		fs.mkdirSync(path.join(opencode, '.opencode'));

		expect(hasExplicitProjectBoundary(gitDir)).toBe(true);
		expect(hasExplicitProjectBoundary(gitFile)).toBe(true);
		expect(hasExplicitProjectBoundary(opencode)).toBe(true);
	});

	it('rejects ordinary children, .swarm alone, and an .opencode regular file', () => {
		const ordinary = path.join(root, 'ordinary');
		fs.mkdirSync(path.join(ordinary, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(ordinary, '.opencode'), 'not a directory');

		expect(hasExplicitProjectBoundary(ordinary)).toBe(false);
	});

	it('does not let one missing marker suppress a valid second marker', () => {
		const directory = path.join(root, 'second-marker');
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		expect(hasExplicitProjectBoundary(directory)).toBe(true);
	});

	it('rejects marker directory symlinks or junctions', () => {
		const directory = path.join(root, 'linked-marker');
		const target = path.join(root, 'marker-target');
		fs.mkdirSync(directory);
		fs.mkdirSync(target);
		fs.symlinkSync(
			target,
			path.join(directory, '.opencode'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		expect(hasExplicitProjectBoundary(directory)).toBe(false);
	});

	it('fails closed on marker probe errors but still checks the second marker', () => {
		const directory = path.join(root, 'probe-error');
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		_internals.lstatSync = ((candidate: fs.PathLike) => {
			if (String(candidate).endsWith(`${path.sep}.git`)) {
				const error = new Error(
					'synthetic access denial',
				) as NodeJS.ErrnoException;
				error.code = 'EPERM';
				throw error;
			}
			return originalLstatSync(candidate);
		}) as typeof fs.lstatSync;

		expect(hasExplicitProjectBoundary(directory)).toBe(true);
	});

	it('rejects invalid inputs without probing the filesystem', () => {
		let probes = 0;
		_internals.lstatSync = (() => {
			probes++;
			throw new Error('must not probe');
		}) as typeof fs.lstatSync;

		for (const value of [null, undefined, 42, '', '   ', 'relative/path']) {
			expect(hasExplicitProjectBoundary(value)).toBe(false);
		}
		expect(probes).toBe(0);
	});
});

describe('isStrictPathDescendant', () => {
	it('recognizes a strict descendant but not the root, sibling prefix, or outside path', () => {
		const child = path.join(root, 'child');
		const siblingPrefix = `${root}-sibling`;
		expect(isStrictPathDescendant(child, root)).toBe(true);
		expect(isStrictPathDescendant(root, root)).toBe(false);
		expect(isStrictPathDescendant(siblingPrefix, root)).toBe(false);
		expect(isStrictPathDescendant(path.dirname(root), root)).toBe(false);
	});

	it('rejects invalid and relative inputs', () => {
		expect(isStrictPathDescendant('', root)).toBe(false);
		expect(isStrictPathDescendant('relative', root)).toBe(false);
		expect(isStrictPathDescendant(root, 'relative')).toBe(false);
		expect(isStrictPathDescendant(null, root)).toBe(false);
	});

	it.skipIf(process.platform !== 'win32')(
		'treats case-different Windows root spelling as the same anchor',
		() => {
			const child = path.join(root, 'CaseChild');
			const caseChangedRoot = root.toUpperCase();
			expect(isStrictPathDescendant(child, caseChangedRoot)).toBe(true);
		},
	);
});
