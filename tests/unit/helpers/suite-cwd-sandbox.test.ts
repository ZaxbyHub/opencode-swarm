import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { useSuiteCwdSandbox } from '../../helpers/suite-cwd-sandbox';

const cwdBefore = process.cwd();
let cwdAtCollection = '';
let enteredCwd = '';
let handle: { readonly cwd: string } | undefined;

describe('useSuiteCwdSandbox', () => {
	handle = useSuiteCwdSandbox('suite-cwd-sandbox-');
	// Collection time: the sandbox must not have been entered yet.
	cwdAtCollection = process.cwd();

	test('enters the sandbox in beforeAll, not at collection time', () => {
		expect(cwdAtCollection).toBe(cwdBefore);
		expect(process.cwd()).toBe(handle?.cwd);
		expect(handle?.cwd).not.toBe(cwdBefore);
		enteredCwd = handle?.cwd ?? '';
	});
});

// A file-level afterAll runs after the suite's own afterAll, so it observes the
// state the suite leaves behind.
afterAll(() => {
	if (enteredCwd === '') return; // the suite's test was filtered out
	expect(process.cwd()).toBe(cwdBefore);
	expect(fs.existsSync(enteredCwd)).toBe(false);
	expect(() => handle?.cwd).toThrow('outside the suite');
});
