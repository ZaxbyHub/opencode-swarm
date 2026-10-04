import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enterCwdSandbox } from '../../helpers/cwd-sandbox';

describe('enterCwdSandbox', () => {
	test('relative targets up to three levels above the cwd stay inside the sandbox', () => {
		const before = process.cwd();
		const sandbox = enterCwdSandbox('cwd-sandbox-');
		try {
			expect(process.cwd()).toBe(sandbox.cwd);
			for (const target of [
				'',
				'..',
				'../../etc',
				'../../../etc',
				'x/../../../y',
			]) {
				expect(path.resolve(target).startsWith(sandbox.root + path.sep)).toBe(
					true,
				);
			}
		} finally {
			sandbox.restore();
		}
		expect(process.cwd()).toBe(before);
		expect(fs.existsSync(sandbox.root)).toBe(false);
	});
});
