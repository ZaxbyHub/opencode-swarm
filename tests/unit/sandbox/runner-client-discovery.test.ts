/**
 * Issue #2475: findRunnerBinary() discovery-path contract.
 *
 * The published plugin is a flat dist/index.js bundle, so the package root —
 * and the binaries/ directory shipped inside it — is exactly ONE directory
 * above the runtime dir. The historical 3-up/4-up candidates only resolved
 * from the TypeScript source tree (src/sandbox/win32/ -> repo root); from an
 * installed package they pointed above the install root and could never find
 * the shipped exe. These tests drive the REAL findRunnerBinary() through the
 * _internals.runtimeDir seam against simulated layouts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/sandbox/win32/runner-client';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realRuntimeDir = _internals.runtimeDir;
const realFindRunnerBinary = _internals.findRunnerBinary;

afterEach(() => {
	_internals.runtimeDir = realRuntimeDir;
	_internals.findRunnerBinary = realFindRunnerBinary;
});

function writeFakeExe(root: string, ...segments: string[]): string {
	const dir = path.join(root, ...segments);
	fs.mkdirSync(dir, { recursive: true });
	const exe = path.join(dir, 'swarm-sandbox-runner.exe');
	fs.writeFileSync(exe, 'fake exe bytes');
	return exe;
}

describe('findRunnerBinary — packaged (dist) layout discovery (#2475)', () => {
	test('resolves the shipped exe one directory above the dist bundle (installed package)', () => {
		const root = canonicalMkdtemp('runner-discovery-dist-');
		try {
			const exe = writeFakeExe(root, 'pkg', 'binaries', 'win32-x64');
			fs.mkdirSync(path.join(root, 'pkg', 'dist'), { recursive: true });

			_internals.runtimeDir = path.join(root, 'pkg', 'dist');
			const found = _internals.findRunnerBinary();
			expect(found).toBe(exe);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('resolves the exe from the source-tree layout (src/sandbox/win32 -> repo root)', () => {
		const root = canonicalMkdtemp('runner-discovery-src-');
		try {
			const exe = writeFakeExe(root, 'binaries', 'win32-x64');
			fs.mkdirSync(path.join(root, 'src', 'sandbox', 'win32'), {
				recursive: true,
			});

			_internals.runtimeDir = path.join(root, 'src', 'sandbox', 'win32');
			const found = _internals.findRunnerBinary();
			expect(found).toBe(exe);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('prefers the packaged-layout candidate over the source-tree candidate', () => {
		const root = canonicalMkdtemp('runner-discovery-priority-');
		try {
			// A layout where BOTH the 1-up and the 3-up candidates exist: the
			// packaged (1-up) candidate must win — it is the layout the
			// installed plugin actually uses.
			const packagedExe = writeFakeExe(root, 'pkg', 'binaries', 'win32-x64');
			writeFakeExe(root, 'pkg', 'x', 'y', 'binaries', 'win32-x64');
			fs.mkdirSync(path.join(root, 'pkg', 'dist'), { recursive: true });

			_internals.runtimeDir = path.join(root, 'pkg', 'dist');
			const found = _internals.findRunnerBinary();
			expect(found).toBe(packagedExe);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('returns null when no candidate exists in an isolated layout', () => {
		const root = canonicalMkdtemp('runner-discovery-none-');
		try {
			fs.mkdirSync(path.join(root, 'pkg', 'dist'), { recursive: true });
			_internals.runtimeDir = path.join(root, 'pkg', 'dist');
			// No binaries anywhere and nothing on PATH (the where/PATH fallback
			// finds nothing for this name in the test environment).
			expect(_internals.findRunnerBinary()).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
