import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, validateProjectRoot } from '../../../src/evidence/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;
let parent: string;
let child: string;
let originalStatSync: typeof fs.statSync;
let originalRealpathSync: typeof fs.realpathSync;

beforeEach(() => {
	root = canonicalMkdtemp('project-root-errors-');
	parent = path.join(root, 'parent');
	child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(child);
	originalStatSync = _internals.statSync;
	originalRealpathSync = _internals.realpathSync;
});

afterEach(() => {
	_internals.statSync = originalStatSync;
	_internals.realpathSync = originalRealpathSync;
	fs.rmSync(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(`synthetic ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe('validateProjectRoot ambiguous ancestor state', () => {
	it('fails closed when an ancestor .swarm probe is inaccessible', () => {
		const parentSwarm = path.join(parent, '.swarm');
		_internals.statSync = ((candidate: fs.PathLike) => {
			if (path.resolve(String(candidate)) === path.resolve(parentSwarm)) {
				throw errno('EPERM');
			}
			return originalStatSync(candidate);
		}) as typeof fs.statSync;

		expect(() => validateProjectRoot(child)).toThrow(
			'Cannot verify project root',
		);
	});

	it('treats an inaccessible ancestor indicator as present and rejects the child', () => {
		const packageJson = path.join(parent, 'package.json');
		_internals.statSync = ((candidate: fs.PathLike) => {
			if (path.resolve(String(candidate)) === path.resolve(packageJson)) {
				throw errno('EACCES');
			}
			return originalStatSync(candidate);
		}) as typeof fs.statSync;

		expect(() => validateProjectRoot(child)).toThrow('Cannot write evidence');
	});

	it('continues past ENOENT and ENOTDIR ancestor probes', () => {
		fs.rmSync(path.join(parent, '.swarm'), { recursive: true });
		_internals.statSync = ((candidate: fs.PathLike) => {
			const value = String(candidate);
			if (value.endsWith(`${path.sep}.swarm`)) throw errno('ENOENT');
			if (value.endsWith(`${path.sep}package.json`)) throw errno('ENOTDIR');
			return originalStatSync(candidate);
		}) as typeof fs.statSync;

		expect(() => validateProjectRoot(child)).not.toThrow();
	});

	it('fails closed when target canonicalization is inaccessible', () => {
		_internals.realpathSync = (() => {
			throw errno('EBUSY');
		}) as typeof fs.realpathSync;

		expect(() => validateProjectRoot(child)).toThrow(
			'Cannot verify project root',
		);
	});
});
