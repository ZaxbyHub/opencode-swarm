import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEPENDENCY_BUMP_BRANCH_PREFIX,
	DEPENDENCY_BUMP_MAX_COMMITS,
	dependencyBumpBranchProvenanceOk,
	dependencyBumpCommitProvenanceOk,
	dependencyBumpOwnerScopeOk,
	deriveDependencyBumpAutomation,
	deriveReleaseAutomation,
	evaluateReleaseOwnership,
	main,
	mergeGroupDependencyBumpProvenance,
} from '../../../scripts/check-required-check-contract';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Frozen acceptance surface (C1/C2/C3) for the dependency-bump channel arm (.agents/issue-traces/3501-3285-3527-dep-bump-channel/05-fix-plan.md).
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const REPO = 'ZaxbyHub/opencode-swarm';
const CHANNEL_BRANCH = 'dep-bump--zod--abcd1234';
const MERGE_SUBJECT = `Merge pull request #3580 from ZaxbyHub/${CHANNEL_BRANCH}`;
const RELEASE_MERGE_SUBJECT =
	'Merge pull request #1 from ZaxbyHub/release-please--branches--main';
const PIN_TEST_FILE = 'tests/unit/scripts/generate-config-schema.test.ts';
const DEP_BUMP_TRAILERS = [
	'X-Dep-Bump-Channel: dependency-bump',
	'X-Dep-Bump-Package: zod',
	'X-Dep-Bump-Version: 4.6.7',
	'X-Dep-Bump-Advisory: GHSA-mrhx-c7xc-m3w5',
];
const MISSING_VERSION_TRAILERS = DEP_BUMP_TRAILERS.filter(
	(line) => !line.startsWith('X-Dep-Bump-Version:'),
);
const BASE_PACKAGE_JSON = `${JSON.stringify(
	{
		version: '7.0.0',
		meta: null,
		scripts: { build: 'bun run build' },
		dependencies: { zod: '4.3.6' },
		devDependencies: { typescript: '5.9.2' },
	},
	null,
	2,
)}\n`;

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
	}
	return proc.stdout.toString().trim();
}

const BOT_IDENTITY = [
	'-c',
	`user.name=${BOT_NAME}`,
	'-c',
	`user.email=${BOT_EMAIL}`,
];
function botGit(cwd: string, ...args: string[]): string {
	return git(cwd, ...BOT_IDENTITY, ...args);
}

function trailerMessage(trailers: string[]): string {
	return ['chore(deps): bump zod to 4.6.7', '', ...trailers].join('\n');
}

/** The legitimate channel delta: zod 4.3.6 -> 4.6.7 (+ fast-check declared). */
function channelPackageJson(fastCheck: boolean): string {
	const parsed = JSON.parse(BASE_PACKAGE_JSON) as {
		dependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	parsed.dependencies = { zod: '4.6.7' };
	if (fastCheck) {
		parsed.devDependencies = {
			...parsed.devDependencies,
			'fast-check': '^4.9.0',
		};
	}
	return `${JSON.stringify(parsed, null, 2)}\n`;
}

function initChannelRepo(prefix: string, options: { pinFiles?: boolean } = {}) {
	const root = canonicalMkdtemp(prefix);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'test@example.com');
	git(root, 'config', 'user.name', 'Test');
	writeFileSync(join(root, 'package.json'), BASE_PACKAGE_JSON);
	writeFileSync(join(root, 'bun.lock'), '// lockfileVersion: 1\n');
	if (options.pinFiles) {
		mkdirSync(join(root, 'tests', 'unit', 'scripts'), { recursive: true });
		writeFileSync(join(root, PIN_TEST_FILE), '// pinned to zod 4.3.6\n');
	}
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'base');
	return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function commitWorktree(root: string, message: string, bot = false): string {
	git(root, 'add', '-A');
	const run = bot ? botGit : git;
	run(root, 'commit', '-q', '-m', message);
	return git(root, 'rev-parse', 'HEAD');
}

function buildChannelPullRequestFixture(
	variant: 'authorized' | 'human-second-commit',
) {
	const { root, base } = initChannelRepo('dep-bump-main-', { pinFiles: true });
	const withFastCheck = variant === 'authorized';
	writeFileSync(join(root, PIN_TEST_FILE), '// pinned to zod 4.6.7\n');
	writeFileSync(join(root, 'package.json'), channelPackageJson(withFastCheck));
	const botHead = commitWorktree(root, trailerMessage(DEP_BUMP_TRAILERS), true);
	if (variant === 'authorized') {
		return { root, base, head: botHead };
	}
	// Dep-map-only human delta so ONLY commit provenance fails (M7's kill).
	writeFileSync(join(root, 'package.json'), channelPackageJson(true));
	const humanHead = commitWorktree(root, 'human: declare fast-check');
	return { root, base, head: humanHead };
}

type MergeVariant =
	| 'valid'
	| 'release-subject'
	| 'human-parent'
	| 'missing-trailer'
	| 'zero-commit';

function buildMergeFixture(variant: MergeVariant) {
	const { root, base } = initChannelRepo('dep-bump-mg-');
	if (variant === 'zero-commit') {
		// Empty PR side: parents[1] == base (decoy first parent), so the range base..parents[1] is empty.
		writeFileSync(join(root, 'bun.lock'), '// lockfileVersion: 1 // decoy\n');
		const decoy = commitWorktree(root, 'main moves on');
		return {
			root,
			base,
			mergeSha: botGit(
				root,
				'commit-tree',
				`${decoy}^{tree}`,
				'-p',
				decoy,
				'-p',
				base,
				'-m',
				MERGE_SUBJECT,
			),
		};
	}
	git(root, 'checkout', '-q', '-b', CHANNEL_BRANCH);
	writeFileSync(join(root, 'package.json'), channelPackageJson(true));
	const trailers =
		variant === 'missing-trailer'
			? MISSING_VERSION_TRAILERS
			: DEP_BUMP_TRAILERS;
	commitWorktree(root, trailerMessage(trailers), variant !== 'human-parent');
	git(root, 'checkout', '-q', 'main');
	const subject =
		variant === 'release-subject' ? RELEASE_MERGE_SUBJECT : MERGE_SUBJECT;
	botGit(root, 'merge', '--no-ff', '-m', subject, CHANNEL_BRANCH);
	return { root, base, mergeSha: git(root, 'rev-parse', 'HEAD') };
}

function expectMergeProvenance(variant: MergeVariant, expected: boolean): void {
	const fixture = buildMergeFixture(variant);
	try {
		expect(
			mergeGroupDependencyBumpProvenance(fixture.root, {
				event: 'merge_group',
				repository: REPO,
				baseSha: fixture.base,
				headSha: fixture.mergeSha,
			}),
		).toBe(expected);
	} finally {
		safeRmRecursive(fixture.root);
	}
}

function buildBranchProvenanceFixture() {
	const { root, base } = initChannelRepo('dep-bump-prov-');
	let legCount = 0;
	const leg = (message: string, bot: boolean): string => {
		legCount += 1;
		writeFileSync(join(root, 'bun.lock'), `// leg ${legCount}\n`);
		return commitWorktree(root, message, bot);
	};
	const validBot = leg(trailerMessage(DEP_BUMP_TRAILERS), true);
	const humanSecond = leg('human: update lockfile', false);
	const missingTrailer = leg(trailerMessage(MISSING_VERSION_TRAILERS), true);
	const bothAdvisoryAndReason = leg(
		trailerMessage([...DEP_BUMP_TRAILERS, 'X-Dep-Bump-Reason: manual bump']),
		true,
	);
	const noAdvisoryOrReason = leg(
		trailerMessage(DEP_BUMP_TRAILERS.slice(0, 3)),
		true,
	);
	// Mutation M3 closes here: a commit missing the CHANNEL trailer
	// specifically (every other trailer present) must be denied.
	const missingChannelTrailer = leg(
		trailerMessage(
			DEP_BUMP_TRAILERS.filter((line) => !line.startsWith('X-Dep-Bump-Channel:')),
		),
		true,
	);
	return {
		root,
		base,
		validBot,
		humanSecond,
		missingTrailer,
		missingChannelTrailer,
		bothAdvisoryAndReason,
		noAdvisoryOrReason,
	};
}

function buildOwnerScopeFixture() {
	const { root, base } = initChannelRepo('dep-bump-scope-');
	const withBase = (overrides: Record<string, unknown>): string =>
		`${JSON.stringify(
			{ ...JSON.parse(BASE_PACKAGE_JSON), ...overrides },
			null,
			2,
		)}\n`;
	const scopeLeg = (text: string): string => {
		writeFileSync(join(root, 'package.json'), text);
		return commitWorktree(root, 'scope leg', false);
	};
	const legs = {
		versionField: scopeLeg(withBase({ version: '7.0.1' })),
		scriptsMap: scopeLeg(withBase({ scripts: { build: 'bun run typecheck' } })),
		newTopLevelKey: scopeLeg(withBase({ private: true })),
		// JSON.stringify(Infinity) === 'null', so plain stringify equality
		// would accept this non-dependency delta; the type compare must not.
		infinityVsNull: scopeLeg(
			BASE_PACKAGE_JSON.replace('"meta": null', '"meta": 1e400'),
		),
		depMapAsArray: scopeLeg(withBase({ dependencies: ['zod@4.6.7'] })),
		depEntryNonString: scopeLeg(
			withBase({ dependencies: { zod: { version: '4.6.7' } } }),
		),
		legitDelta: scopeLeg(channelPackageJson(true)),
	};
	return { root, base, legs };
}

type DepBumpInput = Parameters<typeof deriveDependencyBumpAutomation>[0];

function dep(input: Partial<DepBumpInput>): boolean {
	return deriveDependencyBumpAutomation({
		event: 'pull_request',
		actor: BOT_NAME,
		bumpBranch: CHANNEL_BRANCH,
		trustedProvenance: true,
		commitProvenance: true,
		dependencyScope: true,
		...input,
	});
}

function pullRequestPayload(base: string, head: string) {
	return {
		pull_request: {
			base: { sha: base },
			head: { sha: head, ref: CHANNEL_BRANCH, repo: { full_name: REPO } },
			user: { login: BOT_NAME },
		},
	};
}

function runReleaseOwnerMain(
	root: string,
	eventName: string,
	actor: string,
	payload: Record<string, unknown>,
): { exit: number; stdout: string } {
	const eventPath = join(root, 'event.json');
	writeFileSync(eventPath, JSON.stringify(payload));
	const updates = {
		GITHUB_EVENT_NAME: eventName,
		GITHUB_ACTOR: actor,
		GITHUB_REPOSITORY: REPO,
		GITHUB_EVENT_PATH: eventPath,
	};
	const previous = Object.fromEntries(
		Object.keys(updates).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, updates);
	const lines: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	try {
		return { exit: main(['--release-owner'], root), stdout: lines.join('\n') };
	} finally {
		console.log = originalLog;
		for (const key of Object.keys(updates)) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe('channel authorization arm (C1)', () => {
	test('authorized composition derives the arm and pins its constants', () => {
		expect(DEPENDENCY_BUMP_BRANCH_PREFIX).toBe('dep-bump--');
		expect(DEPENDENCY_BUMP_MAX_COMMITS).toBe(1);
		expect(dep({})).toBe(true);
		expect(dep({ bumpBranch: 'feature/x', bumpPredicate: true })).toBe(true);
		const result = evaluateReleaseOwnership({
			changedFiles: ['package.json', 'bun.lock', PIN_TEST_FILE],
			dependencyBumpAutomation: true,
		});
		expect(result.ok).toBe(true);
		expect(result.code).toBe('DEPENDENCY_BUMP_AUTOMATION_EXCEPTION');
	});

	test('workflow_dispatch and non-bot actors never derive the arm', () => {
		expect(dep({ event: 'workflow_dispatch' })).toBe(false);
		expect(dep({ actor: 'contributor' })).toBe(false);
	});

	test('release-please branches keep the release arm and never enter the dep arm', () => {
		expect(dep({ bumpBranch: 'release-please--branches--main' })).toBe(false);
		expect(
			deriveReleaseAutomation({
				event: 'pull_request',
				actor: BOT_NAME,
				releaseBranch: 'release-please--branches--main',
			}),
		).toBe(true);
		expect(
			evaluateReleaseOwnership({
				changedFiles: ['package.json'],
				releaseAutomation: true,
			}).code,
		).toBe('RELEASE_AUTOMATION_EXCEPTION');
	});
});

describe('spoof bounds (C2 spoof)', () => {
	test('human actors on dep-bump-- branches and missing provenance are denied', () => {
		expect(dep({ actor: 'contributor' })).toBe(false);
		expect(dep({ trustedProvenance: false })).toBe(false);
		expect(dep({ commitProvenance: false })).toBe(false);
	});

	test('out-of-scope package.json deltas deny the dependency scope (git fixtures)', () => {
		const fixture = buildOwnerScopeFixture();
		const scopeOk = (head: string): boolean =>
			dependencyBumpOwnerScopeOk(fixture.root, fixture.base, head);
		try {
			expect(scopeOk(fixture.legs.versionField)).toBe(false);
			expect(scopeOk(fixture.legs.scriptsMap)).toBe(false);
			expect(scopeOk(fixture.legs.newTopLevelKey)).toBe(false);
			expect(scopeOk(fixture.legs.infinityVsNull)).toBe(false);
			expect(scopeOk(fixture.legs.depMapAsArray)).toBe(false);
			expect(scopeOk(fixture.legs.depEntryNonString)).toBe(false);
			expect(scopeOk(fixture.legs.legitDelta)).toBe(true);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('CHANGELOG or release manifest in the owner fileset defeats the dep arm', () => {
		const changelog = evaluateReleaseOwnership({
			changedFiles: ['CHANGELOG.md', 'package.json'],
			dependencyBumpAutomation: true,
		});
		expect(changelog.ok).toBe(false);
		expect(changelog.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');
		const manifest = evaluateReleaseOwnership({
			changedFiles: ['.release-please-manifest.json'],
			dependencyBumpAutomation: true,
		});
		expect(manifest.ok).toBe(false);
	});

	test('every-commit provenance: valid single bot commit ok; other shapes denied', () => {
		const fixture = buildBranchProvenanceFixture();
		const branchOk = (head: string): boolean =>
			dependencyBumpBranchProvenanceOk(fixture.root, fixture.base, head).ok;
		const commitOk = (sha: string): boolean =>
			dependencyBumpCommitProvenanceOk(fixture.root, sha).ok;
		try {
			expect(branchOk(fixture.validBot)).toBe(true);
			expect(commitOk(fixture.validBot)).toBe(true);
			expect(branchOk(fixture.humanSecond)).toBe(false);
			expect(branchOk(fixture.base)).toBe(false);
			expect(commitOk(fixture.missingTrailer)).toBe(false);
			expect(commitOk(fixture.missingChannelTrailer)).toBe(false);
			expect(commitOk(fixture.bothAdvisoryAndReason)).toBe(false);
			expect(commitOk(fixture.noAdvisoryOrReason)).toBe(false);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('main() end-to-end: human commit on the channel branch with a bot PR exits 1', () => {
		const fixture = buildChannelPullRequestFixture('human-second-commit');
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				BOT_NAME,
				pullRequestPayload(fixture.base, fixture.head),
			);
			expect(result.exit).toBe(1);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);
});

describe('merge-group provenance arm (C3 merge-group)', () => {
	test('valid merge-group shape authorizes the dep-bump channel', () => {
		expectMergeProvenance('valid', true);
		expect(
			dep({ event: 'merge_group', headCommitSubject: MERGE_SUBJECT }),
		).toBe(true);
	}, 30_000);

	test('release-please-shaped merge subjects stay on the release path', () => {
		expectMergeProvenance('release-subject', false);
		expect(
			deriveReleaseAutomation({
				event: 'merge_group',
				actor: 'contributor',
				headCommitSubject: RELEASE_MERGE_SUBJECT,
			}),
		).toBe(true);
		expect(
			dep({ event: 'merge_group', headCommitSubject: RELEASE_MERGE_SUBJECT }),
		).toBe(false);
	}, 30_000);

	test('human second parent, missing trailer, and zero-commit PR side denied', () => {
		expectMergeProvenance('human-parent', false);
		expectMergeProvenance('missing-trailer', false);
		expectMergeProvenance('zero-commit', false);
	}, 60_000);
});

describe('main() integration (C1)', () => {
	test('authorized channel PR exits 0 with the dependency-bump message', () => {
		const fixture = buildChannelPullRequestFixture('authorized');
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				BOT_NAME,
				pullRequestPayload(fixture.base, fixture.head),
			);
			expect(result.exit).toBe(0);
			// Plan 1b logs 'dependency-bump channel authorized package.json:
			// ...'; case-insensitive so logging the code also satisfies it.
			expect(result.stdout.toLowerCase()).toContain('dependency-bump');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('authorized merge_group payload exits 0', () => {
		const fixture = buildMergeFixture('valid');
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'merge_group',
				BOT_NAME,
				{ merge_group: { base_sha: fixture.base, head_sha: fixture.mergeSha } },
			);
			expect(result.exit).toBe(0);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

	test('human-actor pull_request payload exits 1', () => {
		const fixture = buildChannelPullRequestFixture('authorized');
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				'contributor',
				pullRequestPayload(fixture.base, fixture.head),
			);
			expect(result.exit).toBe(1);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);
});
