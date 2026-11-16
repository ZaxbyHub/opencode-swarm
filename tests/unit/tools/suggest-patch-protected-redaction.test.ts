/**
 * suggest_patch is auto-allowed by Full-Auto without a critic, so a failed
 * oldContent match must not echo the real lines of a protected file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suggestPatch } from '../../../src/tools/suggest-patch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('suggest-patch-redact-');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function mismatch(file: string): Promise<string> {
	const raw = await suggestPatch.execute(
		{
			targetFiles: [file],
			changes: [
				{
					file,
					contextBefore: ['first'],
					contextAfter: ['last'],
					// Longer than the anchored gap, so the mismatch window reaches lines the
					// caller never supplied.
					oldContent: ['g1', 'g2', 'g3', 'g4'].join('\n'),
					newContent: 'replacement',
				},
			],
		},
		{ directory: dir } as never,
	);
	return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function write(file: string): void {
	fs.writeFileSync(
		path.join(dir, file),
		'first\nlast\nSECRET_TOKEN=hunter2\nmore\n',
		'utf-8',
	);
}

describe('suggest_patch oldContent mismatch disclosure', () => {
	test('redacts when a directory link points into a protected path', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		write('.swarm/notes.txt');
		fs.symlinkSync(path.join(dir, '.swarm'), path.join(dir, 'pub'), 'junction');
		const out = await mismatch('pub/notes.txt');
		expect(out).toContain('[redacted: protected path]');
		expect(out).not.toContain('hunter2');
	});

	test('does not redact look-alike names', async () => {
		write('environment.ts');
		const out = await mismatch('environment.ts');
		expect(out).toContain('hunter2');
	});

	test('echoes actual lines for an ordinary source file', async () => {
		write('notes.txt');
		const out = await mismatch('notes.txt');
		expect(out).toContain('context-mismatch');
		expect(out).toContain('SECRET_TOKEN=hunter2');
	});

	test.each([
		'.env',
		'.env.local',
		'.env.production',
		'config/.env',
		'.swarm/notes.txt',
		'.git/config',
		'.GIT/config',
		'.Swarm/notes.txt',
	])('redacts actual lines for protected path %s', async (file) => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		write(file);
		const out = await mismatch(file);
		expect(out).toContain('context-mismatch');
		expect(out).toContain('[redacted: protected path]');
		expect(out).not.toContain('hunter2');
	});
});
