/**
 * Acceptance check C14 for issue #3317 (class: PRESERVING).
 *
 * The `/swarm diagnose` Git Repository check keeps answering correctly through
 * the real (already async) path: a real git repository reports ✅ 'Git
 * repository detected', and a plain directory reports ❌ with a detail
 * containing 'Not a git repository'. No seams are stubbed — getDiagnoseData
 * runs for real against canonical temp directories.
 *
 * GREEN at both ends (base and after the fix).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function findGitRepositoryCheck(
	checks: Array<{ name: string; status: string; detail: string }>,
): { name: string; status: string; detail: string } | undefined {
	return checks.find((c) => c.name === 'Git Repository');
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('diagnose Git Repository check stays truthful (#3317 C14)', () => {
	test('a real git repository reports ✅', async () => {
		const dir = canonicalMkdtemp('3317-diagnose-repo-');
		tempRoots.push(dir);
		git(dir, 'init', '-q');
		git(dir, 'config', 'user.email', 'swarm-test@example.invalid');
		git(dir, 'config', 'user.name', 'Swarm Test');
		git(dir, 'config', 'commit.gpgsign', 'false');
		fs.writeFileSync(`${dir}/tracked.txt`, 'base\n');
		git(dir, 'add', 'tracked.txt');
		git(dir, 'commit', '-q', '-m', 'base');

		const result = await getDiagnoseData(dir);
		const check = findGitRepositoryCheck(result.checks);

		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		expect(check?.detail).toContain('Git repository detected');
	}, 60_000);

	test('a plain non-repository directory reports ❌ Not a git repository', async () => {
		const dir = canonicalMkdtemp('3317-diagnose-plain-');
		tempRoots.push(dir);

		const result = await getDiagnoseData(dir);
		const check = findGitRepositoryCheck(result.checks);

		expect(check).toBeDefined();
		expect(check?.status).toBe('❌');
		expect(check?.detail).toContain('Not a git repository');
	}, 60_000);
});
