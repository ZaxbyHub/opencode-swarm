import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	detectGitRemote,
	looksLikePrRef,
	parsePrRef,
	resolvePrCommandInput,
} from '../../../src/commands/pr-ref';

const realExecSync = _internals.execSync;

afterEach(() => {
	// Restore the real subprocess after any seam override (no mock.module).
	_internals.execSync = realExecSync;
});

describe('detectGitRemote — working directory (invariant #3)', () => {
	test('threads the provided cwd into the subprocess call', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.execSync = ((_cmd: string, opts: Record<string, unknown>) => {
			seenOpts = opts;
			return 'https://github.com/owner/repo.git\n';
		}) as typeof _internals.execSync;

		const url = detectGitRemote('/project/root');

		expect(url).toBe('https://github.com/owner/repo.git');
		expect(seenOpts?.cwd).toBe('/project/root');
		// Bounded, non-interactive subprocess invariants stay intact.
		expect(seenOpts?.timeout).toBe(5000);
		expect(seenOpts?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
	});

	test('omits cwd when none is provided (process.cwd fallback)', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.execSync = ((_cmd: string, opts: Record<string, unknown>) => {
			seenOpts = opts;
			return 'git@github.com:owner/repo.git\n';
		}) as typeof _internals.execSync;

		detectGitRemote();

		expect('cwd' in (seenOpts ?? {})).toBe(false);
	});

	test('returns null when the subprocess throws (no origin / not a repo)', () => {
		_internals.execSync = (() => {
			throw new Error('fatal: no such remote');
		}) as typeof _internals.execSync;

		expect(detectGitRemote('/nowhere')).toBeNull();
	});
});

describe('parsePrRef — cwd reaches bare-number resolution', () => {
	test('resolves a bare number against the origin remote in cwd', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.execSync = ((_cmd: string, opts: Record<string, unknown>) => {
			seenOpts = opts;
			return 'https://github.com/acme/widgets.git\n';
		}) as typeof _internals.execSync;

		const parsed = parsePrRef('155', '/repo/here');

		expect(parsed).toEqual({ owner: 'acme', repo: 'widgets', number: 155 });
		expect(seenOpts?.cwd).toBe('/repo/here');
	});

	test('returns null for a bare number when the remote is unavailable', () => {
		_internals.execSync = (() => {
			throw new Error('no remote');
		}) as typeof _internals.execSync;

		expect(parsePrRef('155', '/repo/here')).toBeNull();
	});
});

describe('resolvePrCommandInput — cwd threading', () => {
	test('passes cwd through to the bare-number remote lookup', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.execSync = ((_cmd: string, opts: Record<string, unknown>) => {
			seenOpts = opts;
			return 'https://github.com/acme/widgets.git\n';
		}) as typeof _internals.execSync;

		const result = resolvePrCommandInput(['42'], '/work/dir');

		expect(result).toEqual({
			prUrl: 'https://github.com/acme/widgets/pull/42',
			instructions: '',
		});
		expect(seenOpts?.cwd).toBe('/work/dir');
	});

	test('returns an error for a bare number when remote resolution fails', () => {
		_internals.execSync = (() => {
			throw new Error('no remote');
		}) as typeof _internals.execSync;

		const result = resolvePrCommandInput(['42'], '/work/dir');

		expect(result && 'error' in result).toBe(true);
	});
});

describe('looksLikePrRef', () => {
	test('true for the three PR-reference shapes', () => {
		expect(looksLikePrRef('https://github.com/owner/repo/pull/1')).toBe(true);
		expect(looksLikePrRef('http://example.com/x')).toBe(true);
		expect(looksLikePrRef('owner/repo#155')).toBe(true);
		expect(looksLikePrRef('155')).toBe(true);
	});

	test('false for free-text and malformed references', () => {
		expect(looksLikePrRef('address')).toBe(false);
		expect(looksLikePrRef('fix-123')).toBe(false);
		expect(looksLikePrRef('owner/repo#abc')).toBe(false);
		expect(looksLikePrRef('[MODE:')).toBe(false);
		expect(looksLikePrRef('12.5')).toBe(false);
	});
});
