import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	resolveLocalCommand,
	resolveLocalNodeTool,
} from '../../../src/build/command-resolution';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GENERATED_COMMAND_SOURCES = [
	'src/lang/profiles.ts',
	'src/lang/default-backend.ts',
	'src/hooks/incremental-verify.ts',
	'src/tools/test-runner.ts',
];

describe('local-only command resolution (#2303)', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture(platform: NodeJS.Platform, tool = 'tsc') {
		const dir = canonicalMkdtemp('resolver space 2303-');
		dirs.push(dir);
		const binDir = path.join(dir, 'node_modules', '.bin');
		fs.mkdirSync(binDir, { recursive: true });
		const executable = platform === 'win32' ? `${tool}.cmd` : tool;
		fs.writeFileSync(path.join(binDir, executable), '');
		return { dir, executable };
	}

	test('rejects implicit-download wrappers', () => {
		expect(resolveLocalCommand('npx tsc --noEmit', '.', () => true)).toBeNull();
	});

	test('emits a cwd-relative POSIX shell command and absolute argv', () => {
		const { dir } = fixture('linux');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node',
			'linux',
		);
		expect(result).toEqual({
			argv: [path.join(dir, 'node_modules', '.bin', 'tsc'), '--noEmit'],
			shellCommand: './node_modules/.bin/tsc --noEmit',
		});
	});

	test('prefers the repository-local binary over a global installation', () => {
		const { dir } = fixture('linux');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node' || binary === 'tsc',
			'linux',
		);

		expect(result?.argv[0]).toBe(path.join(dir, 'node_modules', '.bin', 'tsc'));
		expect(result?.shellCommand).toBe('./node_modules/.bin/tsc --noEmit');
	});

	test('emits the Windows cmd shim without embedding the absolute cwd', () => {
		const { dir } = fixture('win32');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node',
			'win32',
		);
		expect(result?.shellCommand).toBe('node_modules\\.bin\\tsc.cmd --noEmit');
		expect(result?.shellCommand).not.toContain(dir);
	});

	test('returns null when the local binary is absent', () => {
		const dir = canonicalMkdtemp('resolver-2303-');
		dirs.push(dir);
		expect(resolveLocalNodeTool('vitest', ['run'], dir)).toBeNull();
	});

	test('production-generated verification commands contain no implicit-download wrappers', () => {
		const root = path.resolve(import.meta.dir, '../../..');
		const violations: string[] = [];
		for (const relative of GENERATED_COMMAND_SOURCES) {
			const source = fs.readFileSync(path.join(root, relative), 'utf8');
			if (/cmd:\s*['"](?:npx|bunx|pnpx)\b/.test(source))
				violations.push(relative);
			if (/\[\s*['"](?:npx|bunx|pnpx)['"]\s*,/.test(source))
				violations.push(relative);
		}
		expect(violations).toEqual([]);
	});
});
