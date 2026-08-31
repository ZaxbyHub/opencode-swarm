import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import { detectTypecheckCommand } from './incremental-verify';

describe('incremental verify local TypeScript resolution (#2303)', () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('uses the repository-local tsc binary without a package downloader', () => {
		tempDir = canonicalMkdtemp('incremental-verify-2303-');
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ dependencies: { typescript: '5.7.3' } }),
		);
		fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
		const binDir = path.join(tempDir, 'node_modules', '.bin');
		fs.mkdirSync(binDir, { recursive: true });
		const tscName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
		fs.writeFileSync(path.join(binDir, tscName), '');

		expect(detectTypecheckCommand(tempDir)).toEqual({
			command: [path.join(binDir, tscName), '--noEmit'],
			language: 'typescript',
		});
	});
});
