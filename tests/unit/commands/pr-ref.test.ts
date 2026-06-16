import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	detectGitRemote,
	looksLikePrRef,
	parsePrRef,
	resolvePrCommandInput,
} from '../../../src/commands/pr-ref';

const realSpawnSync = _internals.spawnSync;

afterEach(() => {
	_internals.spawnSync = realSpawnSync;
});

function makeSpawnSyncReturn(stdout: string) {
	const fn = () => ({
		status: 0,
		stdout,
		error: undefined,
	});
	return fn as typeof _internals.spawnSync;
}

describe('detectGitRemote — working directory (invariant #3)', () => {
	test('threads the provided cwd into the subprocess call', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/owner/repo.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const url = detectGitRemote('/project/root');

		expect(url).toBe('https://github.com/owner/repo.git');
		expect(seenOpts?.cwd).toBe('/project/root');
		// Bounded, non-interactive subprocess invariants stay intact.
		expect(seenOpts?.timeout).toBe(5000);
		expect(seenOpts?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
	});

	test('omits cwd when none is provided (process.cwd fallback)', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'git@github.com:owner/repo.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		detectGitRemote();

		expect('cwd' in (seenOpts ?? {})).toBe(false);
	});

	test('returns null when the subprocess throws (no origin / not a repo)', () => {
		const thrower = () => {
			throw new Error('fatal: no such remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

		expect(detectGitRemote('/nowhere')).toBeNull();
	});
});

describe('parsePrRef — cwd reaches bare-number resolution', () => {
	test('resolves a bare number against the origin remote in cwd', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/acme/widgets.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const parsed = parsePrRef('155', '/repo/here');

		expect(parsed).toEqual({ owner: 'acme', repo: 'widgets', number: 155 });
		expect(seenOpts?.cwd).toBe('/repo/here');
	});

	test('returns null for a bare number when the remote is unavailable', () => {
		const thrower = () => {
			throw new Error('no remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

		expect(parsePrRef('155', '/repo/here')).toBeNull();
	});
});

describe('resolvePrCommandInput — cwd threading', () => {
	test('passes cwd through to the bare-number remote lookup', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/acme/widgets.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const result = resolvePrCommandInput(['42'], '/work/dir');

		expect(result).toEqual({
			prUrl: 'https://github.com/acme/widgets/pull/42',
			instructions: '',
		});
		expect(seenOpts?.cwd).toBe('/work/dir');
	});

	test('returns an error for a bare number when remote resolution fails', () => {
		const thrower = () => {
			throw new Error('no remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

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
