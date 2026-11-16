import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/apply-edit.mjs',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

test('asserted edit rejects a wrong cardinality and preserves the original bytes', () => {
	const root = canonicalMkdtemp('asserted-edit-3576-');
	roots.push(root);
	const target = path.join(root, 'source.txt');
	const before = Buffer.from('item[0]\r\nunrelated\r\nitem[0]\r\n');
	fs.writeFileSync(target, before);

	function edit(count: number) {
		return Bun.spawnSync({
			cmd: [
				'node',
				script,
				'--file',
				target,
				'--find',
				'item[0]',
				'--replace',
				'replacement',
				'--count',
				String(count),
			],
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 5_000,
		});
	}

	const mismatch = edit(1);
	const diagnostic = mismatch.stderr.toString();
	expect(mismatch.exitCode, diagnostic).not.toBe(0);
	expect(diagnostic).toMatch(/\b(?:actual|found|observed|matched)\D{0,20}2\b/i);
	expect(fs.readFileSync(target)).toEqual(before);

	const equal = edit(2);
	expect(equal.exitCode, equal.stderr.toString()).toBe(0);
	expect(fs.readFileSync(target)).toEqual(
		Buffer.from('replacement\r\nunrelated\r\nreplacement\r\n'),
	);
});
