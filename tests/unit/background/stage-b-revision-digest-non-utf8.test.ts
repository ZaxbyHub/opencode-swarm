/**
 * PR #3918 (F-008-R7): the PR-workflow revision digest must not bind Git path
 * output that was decoded lossily.
 *
 * `git status --porcelain -z` and `git diff --name-only -z` emit path bytes.
 * Decoding them without validation rewrites a non-UTF-8 name to U+FFFD, the
 * lstat of that rewritten path then misses the real file, and the digest hashes
 * `deleted` — so an edit to the real file would not move the digest. The digest
 * must fail closed on such output. The UTF-8 control proves the fix does not
 * over-reject ordinary names.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePrWorkflowRevisionDigestDetailed } from '../../../src/background/workspace-snapshot';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const projects: string[] = [];

function git(dir: string, ...args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function makeProject(): { dir: string; head: string } {
	const dir = canonicalMkdtemp('swarm-revision-non-utf8-');
	projects.push(dir);
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 'reg@example.com');
	git(dir, 'config', 'user.name', 'Reg');
	fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'base');
	return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

describe('PR workflow revision digest — non-UTF-8 Git path output fails closed (F-008-R7)', () => {
	afterEach(() => {
		for (const dir of projects.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	test.skipIf(process.platform === 'win32')(
		'an untracked non-UTF-8 name yields no revision digest instead of a digest over U+FFFD',
		() => {
			const { dir, head } = makeProject();
			fs.writeFileSync(
				Buffer.concat([
					Buffer.from(`${dir}${path.sep}byte-`),
					Buffer.from([0xff, 0x2e, 0x62, 0x69, 0x6e]),
				]),
				'content A\n',
			);
			expect(resolvePrWorkflowRevisionDigestDetailed(dir, head).ok).toBe(false);
		},
	);

	test('an untracked UTF-8 name still produces a revision digest (control)', () => {
		const { dir, head } = makeProject();
		fs.writeFileSync(path.join(dir, 'plain-name.txt'), 'content A\n');
		expect(resolvePrWorkflowRevisionDigestDetailed(dir, head).ok).toBe(true);
	});
});
