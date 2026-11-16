import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Pin-helper contract for the dependency-bump channel (trace
 * 3501-3285-3527, plan Change 2 step 6 / Change 4). The helper runs as a
 * subprocess with a temp REPO_ROOT-equivalent: the script resolves its repo
 * root relative to its own location, so each fixture gets a COPY of the
 * script under <root>/scripts/ plus a minimal tracked file set.
 */
const SCRIPT_SOURCE = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'scripts',
	'apply-dep-bump-pins.mjs',
);

interface Fixture {
	root: string;
	run(
		specs: unknown,
		env?: Record<string, string>,
	): { exit: number; stdout: string; stderr: string };
}

function buildFixture(): Fixture {
	const root = canonicalMkdtemp('dep-bump-pins-');
	mkdirSync(join(root, 'scripts'), { recursive: true });
	mkdirSync(join(root, 'tests'), { recursive: true });
	writeFileSync(
		join(root, 'scripts', 'apply-dep-bump-pins.mjs'),
		readFileSync(SCRIPT_SOURCE),
	);
	// Minimal tracked set: the script checks git ls-files, so give the
	// fixture a real git repo.
	spawnSync('git', ['init', '-q'], { cwd: root });
	writeFileSync(
		join(root, 'tests', 'pins-target.txt'),
		'version one\nversion one\n',
	);
	writeFileSync(
		join(root, 'tests', 'crlf-target.md'),
		'line one\r\nversion one\r\n',
	);
	spawnSync('git', ['add', '.'], { cwd: root });
	spawnSync(
		'git',
		['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'],
		{ cwd: root },
	);
	const run = (specs: unknown, env: Record<string, string> = {}) => {
		const proc = spawnSync(
			process.execPath.includes('bun') ? process.execPath : 'bun',
			[join(root, 'scripts', 'apply-dep-bump-pins.mjs')],
			{
				cwd: root,
				env: {
					...process.env,
					...env,
					PIN_SPECS: typeof specs === 'string' ? specs : JSON.stringify(specs),
				},
				encoding: 'utf8',
				timeout: 30_000,
			},
		);
		return {
			exit: proc.status ?? 1,
			stdout: proc.stdout ?? '',
			stderr: proc.stderr ?? '',
		};
	};
	return { root, run };
}

describe('apply-dep-bump-pins (dependency-bump channel helper)', () => {
	test('applies a literal replacement and reports the count', () => {
		const fixture = buildFixture();
		try {
			const result = fixture.run([
				{
					file: 'tests/pins-target.txt',
					from: 'version one',
					to: 'version two',
				},
			]);
			expect(result.exit).toBe(0);
			expect(result.stdout).toContain('2 replacement(s)');
			expect(
				readFileSync(join(fixture.root, 'tests', 'pins-target.txt'), 'utf8'),
			).toBe('version two\nversion two\n');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('ordered same-file specs run in array order', () => {
		const fixture = buildFixture();
		try {
			const result = fixture.run([
				{
					file: 'tests/pins-target.txt',
					from: 'version one',
					to: 'version UNO',
				},
				{
					file: 'tests/pins-target.txt',
					from: 'version UNO',
					to: 'version two',
				},
			]);
			expect(result.exit).toBe(0);
			expect(
				readFileSync(join(fixture.root, 'tests', 'pins-target.txt'), 'utf8'),
			).toBe('version two\nversion two\n');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('preserves CRLF line endings', () => {
		const fixture = buildFixture();
		try {
			const result = fixture.run([
				{ file: 'tests/crlf-target.md', from: 'version one', to: 'x' },
			]);
			expect(result.exit).toBe(0);
			expect(
				readFileSync(join(fixture.root, 'tests', 'crlf-target.md'), 'utf8'),
			).toBe('line one\r\nx\r\n');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('zero matches fail closed', () => {
		const fixture = buildFixture();
		try {
			const result = fixture.run([
				{ file: 'tests/pins-target.txt', from: 'absent needle', to: 'x' },
			]);
			expect(result.exit).toBe(1);
			expect(result.stderr).toContain('zero matches');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('untracked, symlinked, traversal, and out-of-tree targets are rejected', () => {
		const fixture = buildFixture();
		try {
			writeFileSync(
				join(fixture.root, 'tests', 'untracked.txt'),
				'version one\n',
			);
			const untracked = fixture.run([
				{ file: 'tests/untracked.txt', from: 'version one', to: 'x' },
			]);
			expect(untracked.exit).toBe(1);
			expect(untracked.stderr).toContain('not tracked');
			// Symlink rejection is proven only where the platform lets the
			// fixture create a symlink at all (Windows needs privileges).
			let linked = false;
			try {
				symlinkSync(
					join(fixture.root, 'tests', 'pins-target.txt'),
					join(fixture.root, 'tests', 'link.txt'),
				);
				spawnSync('git', ['add', 'tests/link.txt'], { cwd: fixture.root });
				linked = true;
			} catch {
				linked = false;
			}
			if (linked) {
				const linkResult = fixture.run([
					{ file: 'tests/link.txt', from: 'version one', to: 'x' },
				]);
				expect(linkResult.exit).toBe(1);
				expect(linkResult.stderr).toContain('symlink');
			}
			const traversal = fixture.run([
				{ file: 'tests/../tests/crlf-target.md', from: 'version one', to: 'x' },
			]);
			expect(traversal.exit).toBe(1);
			// C4: the out-of-tree target must be TRACKED so the denial comes
			// from the allowlist regex (not the tracked check) — assert the
			// message so a PIN_FILE_RE widening mutant dies.
			writeFileSync(
				join(fixture.root, 'package.json'),
				'{"name": "fixture"}\n',
			);
			spawnSync('git', ['add', 'package.json'], { cwd: fixture.root });
			const outside = fixture.run([
				{ file: 'package.json', from: 'fixture', to: 'x' },
			]);
			expect(outside.exit).toBe(1);
			expect(outside.stderr).toContain('pin spec file rejected');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('PIN_SPECS format family fails closed', () => {
		const fixture = buildFixture();
		try {
			expect(fixture.run('not json').exit).toBe(1);
			expect(fixture.run('{"file":"x"}').exit).toBe(1);
			expect(fixture.run([]).exit).toBe(1);
			// C5: the 7-entry leg uses MATCHING needles so the count bound (not
			// the zero-match check) is what denies.
			expect(
				fixture.run(
					Array.from({ length: 7 }, () => ({
						file: 'tests/pins-target.txt',
						from: 'version one',
						to: 'x',
					})),
				).exit,
			).toBe(1);
			expect(
				fixture.run(
					Array.from({ length: 7 }, () => ({
						file: 'tests/pins-target.txt',
						from: 'version one',
						to: 'x',
					})),
				).stderr,
			).toContain('must be an array of 1..');
			expect(
				fixture.run([{ file: 'tests/pins-target.txt', from: '', to: 'b' }])
					.exit,
			).toBe(1);
			expect(
				fixture.run([{ file: 'tests/pins-target.txt', from: 'a', to: 1 }]).exit,
			).toBe(1);
			expect(fixture.run([{ from: 'a', to: 'b' }]).exit).toBe(1);
			const oversized = 'x'.repeat(8193);
			expect(
				fixture.run([
					{ file: 'tests/pins-target.txt', from: oversized, to: 'b' },
				]).exit,
			).toBe(1);
			// C5: byte-bound leg with a MATCHING needle so the 8 KiB bound
			// denies before the zero-match check would.
			const padded = fixture.run([
				{
					file: 'tests/pins-target.txt',
					from: 'version one',
					to: `x${'y'.repeat(8300)}`,
				},
			]);
			expect(padded.exit).toBe(1);
			expect(padded.stderr).toContain('8 KiB bound');
			// Guard sources are not channel-pinnable (PRR-005).
			const guardSource = fixture.run([
				{
					file: 'scripts/check-required-check-contract.ts',
					from: 'a',
					to: 'b',
				},
			]);
			expect(guardSource.exit).toBe(1);
			expect(guardSource.stderr).toContain('not channel-pinnable');
			// CR/LF in from/to is rejected (would mix EOL styles in the target).
			const crlfFrom = fixture.run([
				{ file: 'tests/pins-target.txt', from: 'version one\nsecond', to: 'x' },
			]);
			expect(crlfFrom.exit).toBe(1);
			expect(crlfFrom.stderr).toContain('must not contain CR/LF');
			const crlfTo = fixture.run([
				{ file: 'tests/pins-target.txt', from: 'version one', to: 'x\nsecond' },
			]);
			expect(crlfTo.exit).toBe(1);
			expect(crlfTo.stderr).toContain('must not contain CR/LF');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 60_000);
});

function rootOf(fixture: Fixture): string {
	return fixture.root;
}
