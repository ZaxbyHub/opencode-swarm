/**
 * Issue #2349 (Phase 4.2 rung 3) — tests for
 * scripts/check-error-channel-discard.ts.
 *
 * Tier 0 (fixture-string) tests drive `scanSourceForErrorChannelDiscard`
 * directly — deterministic, never read `src/`. Filesystem-backed tests
 * (allowlist suppression, `main()` exit codes) use a fixture tree under a
 * canonical temp directory (tests/helpers/tmpdir.ts), never the live repo.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	allowlistKey,
	collectErrorChannelDiscardErrors,
	FLAGGED_PROPS,
	loadAllowlist,
	main,
	resolveEnforce,
	scanSourceForErrorChannelDiscard,
} from '../../../scripts/check-error-channel-discard';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('check-error-channel-discard — constants', () => {
	test('FLAGGED_PROPS matches the documented error-channel property set', () => {
		expect([...FLAGGED_PROPS].sort()).toEqual(
			['error', 'errors', 'failure'].sort(),
		);
	});
});

describe('resolveEnforce', () => {
	test('unset -> enforce (true)', () => {
		expect(resolveEnforce(undefined)).toBe(true);
	});
	test.each([
		'0',
		'false',
		'no',
		'off',
		'OFF',
	])('%s -> soft-warn (false)', (v) => {
		expect(resolveEnforce(v)).toBe(false);
	});
	test('any other value -> enforce (true)', () => {
		expect(resolveEnforce('1')).toBe(true);
		expect(resolveEnforce('true')).toBe(true);
	});
});

describe('scanSourceForErrorChannelDiscard — positive fixtures (must be CAUGHT)', () => {
	test('=== undefined boolean-only read is flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(output) {\n\tconst failed = output.error !== undefined;\n\treturn failed;\n}',
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ chainText: 'output.error', line: 2 });
	});

	test('== null boolean-only read is flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(result) {\n\tif (result.error == null) return true;\n\treturn false;\n}',
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.chainText).toBe('result.error');
	});

	test('Boolean(...) boolean-only read is flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(r) {\n\treturn Boolean(r.errors);\n}',
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.chainText).toBe('r.errors');
	});

	test('double-negation (!!) boolean-only read is flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(output) {\n\tconst explicitFailure = !!output.failure;\n\treturn explicitFailure;\n}',
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.chainText).toBe('output.failure');
	});

	test('top-level (no enclosing function) boolean-only read is flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'const failed = output.error !== undefined;',
		);
		expect(v).toHaveLength(1);
	});
});

describe('scanSourceForErrorChannelDiscard — negative fixture (value IS forwarded, must be IGNORED)', () => {
	test('value forwarded elsewhere in the same function is NOT flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			[
				'function f(output) {',
				'\tif (output.error !== undefined) {',
				'\t\tlogFailure(output.error);',
				'\t}',
				'}',
			].join('\n'),
		);
		expect(v).toEqual([]);
	});

	test('optional-chained guard forwarding the non-optional read is NOT flagged (normalization)', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			[
				'function f(result) {',
				'\tif (result?.error != null) {',
				'\t\tthrow new Error(String(result.error));',
				'\t}',
				'}',
			].join('\n'),
		);
		expect(v).toEqual([]);
	});

	test('a non-flagged property name (e.g. .status) is never flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(r) {\n\treturn r.status !== undefined;\n}',
		);
		expect(v).toEqual([]);
	});

	test('a member access outside boolean position is not flagged', () => {
		const v = scanSourceForErrorChannelDiscard(
			'x.ts',
			'function f(r) {\n\treturn r.error;\n}',
		);
		expect(v).toEqual([]);
	});
});

describe('allowlistKey', () => {
	test('normalizes backslashes to forward slashes', () => {
		expect(allowlistKey('src\\hooks\\x.ts', 'output.error')).toBe(
			'src/hooks/x.ts:output.error',
		);
	});
});

describe('loadAllowlist', () => {
	test('returns empty set when the file does not exist', () => {
		expect(loadAllowlist('/nonexistent/path/allowlist.txt')).toEqual(new Set());
	});

	test('ignores blank lines and # comments, keeps trimmed entries', () => {
		const dir = canonicalMkdtemp('error-channel-discard-allowlist-');
		const file = path.join(dir, 'allowlist.txt');
		fs.writeFileSync(
			file,
			[
				'# a comment',
				'',
				'  src/hooks/x.ts:output.error  ',
				'# APPROVED-NEW: src/hooks/y.ts:r.error',
				'src/hooks/y.ts:r.error',
			].join('\n'),
			'utf-8',
		);
		const allowlist = loadAllowlist(file);
		expect(allowlist).toEqual(
			new Set(['src/hooks/x.ts:output.error', 'src/hooks/y.ts:r.error']),
		);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('collectErrorChannelDiscardErrors — filesystem-backed, allowlist suppression', () => {
	function writeFixture(root: string, relPath: string, body: string): void {
		const full = path.join(root, relPath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body, 'utf-8');
	}

	test('flags a violation not present in the allowlist', () => {
		const root = canonicalMkdtemp('error-channel-discard-fixture-');
		writeFixture(
			root,
			'src/hooks/discard.ts',
			'export function f(output: { error?: unknown }) {\n\treturn output.error !== undefined;\n}\n',
		);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'',
			'utf-8',
		);

		const result = collectErrorChannelDiscardErrors(root);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('src/hooks/discard.ts:2');
		expect(result.allowlistedSkipped).toBe(0);

		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an allowlisted violation is skipped, not reported', () => {
		const root = canonicalMkdtemp('error-channel-discard-fixture-');
		writeFixture(
			root,
			'src/hooks/discard.ts',
			'export function f(output: { error?: unknown }) {\n\treturn output.error !== undefined;\n}\n',
		);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'# pre-existing, out of scope\nsrc/hooks/discard.ts:output.error\n',
			'utf-8',
		);

		const result = collectErrorChannelDiscardErrors(root);
		expect(result.errors).toEqual([]);
		expect(result.allowlistedSkipped).toBe(1);

		fs.rmSync(root, { recursive: true, force: true });
	});

	test('*.test.ts files are excluded from the scan', () => {
		const root = canonicalMkdtemp('error-channel-discard-fixture-');
		writeFixture(
			root,
			'src/hooks/discard.test.ts',
			'export function f(output: { error?: unknown }) {\n\treturn output.error !== undefined;\n}\n',
		);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'',
			'utf-8',
		);

		const result = collectErrorChannelDiscardErrors(root);
		expect(result.errors).toEqual([]);

		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe('main() exit codes', () => {
	function makeFixtureRoot(): string {
		const root = canonicalMkdtemp('error-channel-discard-main-');
		fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'hooks', 'discard.ts'),
			'export function f(output: { error?: unknown }) {\n\treturn output.error !== undefined;\n}\n',
			'utf-8',
		);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		return root;
	}

	test('returns 1 (hard fail) when ERROR_CHANNEL_DISCARD_ENFORCE is unset and a violation exists', () => {
		const root = makeFixtureRoot();
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'',
			'utf-8',
		);
		const prev = process.env.ERROR_CHANNEL_DISCARD_ENFORCE;
		delete process.env.ERROR_CHANNEL_DISCARD_ENFORCE;
		try {
			expect(main(root)).toBe(1);
		} finally {
			if (prev === undefined) delete process.env.ERROR_CHANNEL_DISCARD_ENFORCE;
			else process.env.ERROR_CHANNEL_DISCARD_ENFORCE = prev;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('returns 0 (soft-warn) when ERROR_CHANNEL_DISCARD_ENFORCE=0 and a violation exists', () => {
		const root = makeFixtureRoot();
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'',
			'utf-8',
		);
		const prev = process.env.ERROR_CHANNEL_DISCARD_ENFORCE;
		process.env.ERROR_CHANNEL_DISCARD_ENFORCE = '0';
		try {
			expect(main(root)).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.ERROR_CHANNEL_DISCARD_ENFORCE;
			else process.env.ERROR_CHANNEL_DISCARD_ENFORCE = prev;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('returns 0 when no violations are found', () => {
		const root = canonicalMkdtemp('error-channel-discard-main-clean-');
		fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'hooks', 'clean.ts'),
			'export function f(output: { error?: unknown }) {\n\tif (output.error !== undefined) {\n\t\tlogFailure(output.error);\n\t}\n}\n',
			'utf-8',
		);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
			'',
			'utf-8',
		);
		expect(main(root)).toBe(0);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe('check-error-channel-discard — real-tree smoke', () => {
	test('the live repo passes with the seeded allowlist', () => {
		const result = collectErrorChannelDiscardErrors();
		expect(result.errors).toEqual([]);
	});
});
