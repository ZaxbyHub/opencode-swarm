import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { safeRmRecursive } from '../../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

/*
 * Behavioral pins for the two merge-group fast paths in ci.yml's
 * detect-release job. The job's real `run:` script is extracted from the
 * workflow and executed, as GitHub executes it (bash -eo pipefail), against
 * real git fixture repositories shaped like merge-queue groups.
 *
 * A merge group is cumulative: it carries every queued PR ahead of its head,
 * and GitHub merges all of them when it passes. The group boundary is the
 * merge-base of the head with the base branch tip (refs/remotes/origin/main,
 * fetched by the job's full-history checkout), NOT the event's
 * merge_group.base_sha, which for a deeper queue entry is the previous
 * entry's synthetic commit (observed on run 39597759518).
 *
 * is-release: the release fast path skips every test, so it fires only when
 * the group is the release merge alone.
 *
 * docs-only: a group whose whole boundary..head delta stays inside
 * docs/releases/. Any path outside it, a rename in either direction, an empty
 * delta, an unknown boundary or a git failure leaves it false.
 */

const CI_YML = path.join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const BOT = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const MAIN_REF = 'refs/remotes/origin/main';

function detectScript(): string {
	const workflow = yaml.load(fs.readFileSync(CI_YML, 'utf8')) as any;
	const step = workflow.jobs['detect-release'].steps.find(
		(s: any) => s.id === 'check',
	);
	if (!step?.run) throw new Error('detect-release check step not found');
	return step.run as string;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

interface Identity {
	name: string;
	email: string;
}

const DEV: Identity = { name: 'Dev', email: 'dev@example.com' };

function git(
	cwd: string,
	args: string[],
	author: Identity = DEV,
	committer: Identity = DEV,
): string {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
			GIT_CONFIG_NOSYSTEM: '1',
		},
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

const head = (repo: string) => git(repo, ['rev-parse', 'HEAD']);

/** Point the emulated checkout's base branch ref at a commit. */
function setMainTip(repo: string, sha: string): void {
	git(repo, ['update-ref', MAIN_REF, sha]);
}

function write(repo: string, rel: string, content: string): void {
	const abs = path.join(repo, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

/** A repo whose base branch tip (origin/main) is the base commit. */
function newRepo(): { repo: string; base: string } {
	const repo = canonicalMkdtemp('merge-group-fast-path-');
	roots.push(repo);
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	write(repo, 'src/index.ts', 'export {};\n');
	write(repo, 'docs/releases/pending/old.md', 'old fragment\n');
	write(repo, 'package.json', '{"version":"1.0.0"}\n');
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', 'base']);
	const base = head(repo);
	setMainTip(repo, base);
	return { repo, base };
}

/** Merge a side branch with a GitHub-shaped merge commit (a queue entry). */
function mergePr(
	repo: string,
	pr: number,
	branch: string,
	edit: () => void,
	sideAuthor: Identity = DEV,
	sideSubject = `change on ${branch}`,
): void {
	git(repo, ['checkout', '-q', '-b', branch, 'main']);
	edit();
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', sideSubject], sideAuthor, sideAuthor);
	git(repo, ['checkout', '-q', 'main']);
	git(repo, [
		'merge',
		'-q',
		'--no-ff',
		branch,
		'-m',
		`Merge pull request #${pr} from ZaxbyHub/${branch}`,
	]);
}

function mergeRelease(repo: string, pr: number): void {
	mergePr(
		repo,
		pr,
		'release-please--branches--main--components--opencode-swarm',
		() => {
			write(repo, 'package.json', `{"version":"1.0.${pr}"}\n`);
			write(repo, 'CHANGELOG.md', `## 1.0.${pr}\n`);
		},
		{ name: BOT, email: BOT_EMAIL },
		`chore(main): release 1.0.${pr}`,
	);
}

function squashRelease(repo: string): void {
	write(repo, 'package.json', '{"version":"1.1.0"}\n');
	git(repo, ['add', '-A']);
	git(
		repo,
		['commit', '-q', '-m', 'chore(main): release 1.1.0 (#77)'],
		{ name: BOT, email: BOT_EMAIL },
		{ name: 'GitHub', email: 'noreply@github.com' },
	);
}

function mergeCode(repo: string, pr: number): void {
	mergePr(repo, pr, `fix-${pr}`, () =>
		write(repo, 'src/index.ts', `export const v = ${pr};\n`),
	);
}

function mergeDocs(repo: string, pr: number): void {
	mergePr(repo, pr, `chore/release-fragments-${pr}`, () =>
		write(repo, `docs/releases/v${pr}.md`, 'notes\n'),
	);
}

interface DetectOptions {
	headSha?: string;
	baseRef?: string;
	/** The event's merge_group.base_sha; the script must not trust it. */
	eventBaseSha?: string;
	/** Exit status the step must end with; a nonzero status fails the job. */
	expectStatus?: number;
}

function runDetect(
	repo: string,
	options: DetectOptions = {},
): Record<string, string> {
	const runnerTemp = canonicalMkdtemp('merge-group-fast-path-runner-');
	roots.push(runnerTemp);
	const outputFile = path.join(runnerTemp, 'github-output');
	fs.writeFileSync(outputFile, '');
	const result = spawnSync(
		'bash',
		['--noprofile', '--norc', '-eo', 'pipefail', '-c', detectScript()],
		{
			cwd: repo,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
			env: {
				...process.env,
				EVENT: 'merge_group',
				ACTOR: 'github-merge-queue[bot]',
				BRANCH: '',
				REPOSITORY: 'ZaxbyHub/opencode-swarm',
				HEAD_SHA: options.headSha ?? head(repo),
				BASE_REF: options.baseRef ?? 'refs/heads/main',
				BASE_SHA: options.eventBaseSha ?? '',
				GITHUB_WORKSPACE: repo,
				RUNNER_TEMP: runnerTemp,
				GITHUB_OUTPUT: outputFile,
			},
		},
	);
	expect(result.status, result.stderr).toBe(options.expectStatus ?? 0);
	const outputs: Record<string, string> = {};
	for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return outputs;
}

// GitHub runs this step on ubuntu; the Windows bash on PATH is not a
// dependable stand-in, so the behavioral fixtures run on POSIX hosts only.
const posix = process.platform !== 'win32';

describe('merge-group release fast path is limited to a lone release merge', () => {
	test.skipIf(!posix)('a group that is only the release merge skips', () => {
		const { repo } = newRepo();
		mergeRelease(repo, 90);
		expect(runDetect(repo)['is-release']).toBe('true');
	});

	test.skipIf(!posix)(
		'a release queued behind a code PR runs the full suite',
		() => {
			const { repo } = newRepo();
			mergeCode(repo, 91);
			mergeRelease(repo, 92);
			expect(runDetect(repo)['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'the event base_sha of a deeper entry is not trusted as the boundary',
		() => {
			// Observed shape: the event's base_sha is the previous entry's
			// synthetic queue commit, so base_sha..head is ONE commit even though
			// the head also carries the unmerged code PR ahead of it.
			const { repo } = newRepo();
			mergeCode(repo, 93);
			const previousEntry = head(repo);
			mergeRelease(repo, 94);
			expect(
				runDetect(repo, { eventBaseSha: previousEntry })['is-release'],
			).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'entries already merged to main do not count against the release',
		() => {
			const { repo } = newRepo();
			mergeCode(repo, 95);
			setMainTip(repo, head(repo));
			mergeRelease(repo, 96);
			expect(runDetect(repo)['is-release']).toBe('true');
		},
	);

	test.skipIf(!posix)(
		'a lone squash-merged release skips; one behind a code PR does not',
		() => {
			const alone = newRepo();
			squashRelease(alone.repo);
			expect(runDetect(alone.repo)['is-release']).toBe('true');

			const batched = newRepo();
			mergeCode(batched.repo, 97);
			squashRelease(batched.repo);
			expect(runDetect(batched.repo)['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'an unknown boundary never yields the release skip',
		() => {
			const { repo } = newRepo();
			mergeRelease(repo, 98);
			expect(runDetect(repo)['is-release']).toBe('true');
			// main still sits at the group base, so only the base ref is wrong.
			for (const baseRef of ['', 'main', 'refs/heads/other']) {
				expect(runDetect(repo, { baseRef })['is-release']).toBe('false');
			}
			git(repo, ['update-ref', '-d', MAIN_REF]);
			expect(runDetect(repo)['is-release']).toBe('false');
		},
	);
});

describe('merge-group docs-only fast path', () => {
	test.skipIf(!posix)(
		'a group touching only docs/releases/ is docs-only',
		() => {
			const { repo } = newRepo();
			mergePr(repo, 100, 'chore/release-fragments-1.0.0', () => {
				write(repo, 'docs/releases/v1.0.0.md', 'notes\n');
				write(repo, 'docs/releases/manifests/v1.0.0.json', '{}\n');
				fs.rmSync(path.join(repo, 'docs/releases/pending/old.md'));
			});
			const out = runDetect(repo);
			expect(out['docs-only']).toBe('true');
			expect(out['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'a docs PR queued behind a code PR is not docs-only',
		() => {
			const { repo } = newRepo();
			mergeCode(repo, 101);
			const previousEntry = head(repo);
			mergeDocs(repo, 102);
			expect(runDetect(repo)['docs-only']).toBe('false');
			// Same shape with the event's synthetic base_sha supplied.
			expect(
				runDetect(repo, { eventBaseSha: previousEntry })['docs-only'],
			).toBe('false');
			// Once the code PR has merged to main on its own, the docs PR qualifies.
			setMainTip(repo, previousEntry);
			expect(runDetect(repo)['docs-only']).toBe('true');
		},
	);

	test.skipIf(!posix)(
		'lookalike prefixes outside the directory do not qualify',
		() => {
			const { repo } = newRepo();
			mergePr(repo, 103, 'sneaky', () => {
				write(repo, 'docs/releases-extra/x.md', 'x\n');
				write(repo, 'docs/releases.md', 'x\n');
			});
			expect(runDetect(repo)['docs-only']).toBe('false');
		},
	);

	test.skipIf(!posix)('a rename in either direction is not docs-only', () => {
		const out = newRepo();
		mergePr(out.repo, 104, 'move-out', () => {
			git(out.repo, ['mv', 'docs/releases/pending/old.md', 'src/old.ts']);
		});
		expect(runDetect(out.repo)['docs-only']).toBe('false');

		// With rename detection a move reports only its new path, which here
		// sits under docs/releases/ and would hide the deleted source file.
		const into = newRepo();
		mergePr(into.repo, 105, 'move-in', () => {
			git(into.repo, ['mv', 'src/index.ts', 'docs/releases/index.ts']);
		});
		expect(runDetect(into.repo)['docs-only']).toBe('false');
	});

	test.skipIf(!posix)(
		'an empty delta, an unknown boundary or a git failure fails closed',
		() => {
			const { repo, base } = newRepo();
			expect(runDetect(repo, { headSha: base })['docs-only']).toBe('false');
			mergeDocs(repo, 106);
			// An unreadable head fails the step outright after docs-only is set.
			expect(
				runDetect(repo, { headSha: '0'.repeat(40), expectStatus: 128 })[
					'docs-only'
				],
			).toBe('false');
			git(repo, ['update-ref', '-d', MAIN_REF]);
			expect(runDetect(repo)['docs-only']).toBe('false');
		},
	);
});
