import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEPENDENCY_BUMP_BRANCH_PREFIX,
	DEPENDENCY_BUMP_MAX_COMMITS,
	dependencyBumpBranchProvenanceOk,
	dependencyBumpCommitProvenanceOk,
	dependencyBumpOwnerScopeOk,
	deriveReleaseAutomation,
	evaluateReleaseOwnership,
	mergeGroupDependencyBumpProvenance,
} from '../../../scripts/check-required-check-contract';
// Frozen acceptance surface (C1/C2/C3) for the dependency-bump channel arm (.agents/issue-traces/3501-3285-3527-dep-bump-channel/05-fix-plan.md).
// Stateless helpers live in tests/helpers/dep-bump-channel-fixtures.ts (FR-006 split; every test leg stays in this frozen path).
import {
	BASE_PACKAGE_JSON,
	BOT_NAME,
	botGit,
	CHANNEL_BRANCH,
	channelPackageJson,
	commitWorktree,
	DEP_BUMP_TRAILERS,
	dep,
	git,
	initChannelRepo,
	MERGE_SUBJECT,
	MISSING_VERSION_TRAILERS,
	PIN_TEST_FILE,
	pullRequestPayload,
	RELEASE_MERGE_SUBJECT,
	REPO,
	runReleaseOwnerMain,
	trailerMessage,
} from '../../helpers/dep-bump-channel-fixtures';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

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
	// Mutation M3 closes here: a commit missing the CHANNEL trailer specifically must be denied.
	const missingChannelTrailer = leg(
		trailerMessage(
			DEP_BUMP_TRAILERS.filter(
				(line) => !line.startsWith('X-Dep-Bump-Channel:'),
			),
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
		// Final-critic r1: the dependencyScope conjunct must be pinned at the
		// COMPOSITION seam, not only at the helper — neutralizing it in
		// deriveDependencyBumpAutomation used to leave this whole suite green.
		expect(dep({ dependencyScope: false })).toBe(false);
		expect(
			dep({
				event: 'merge_group',
				dependencyScope: false,
				headCommitSubject: MERGE_SUBJECT,
			}),
		).toBe(false);
	});

	test('main() end-to-end laundering: bot PR with an out-of-scope package.json delta exits 1', () => {
		// Final-critic r1: a channel-shaped PR whose package.json launders the
		// version field must be denied by the scope conjunct inside main()'s
		// composition, not only by the helper in isolation.
		const fixture = buildOwnerScopeFixture();
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				BOT_NAME,
				pullRequestPayload(fixture.base, fixture.legs.versionField),
			);
			expect(result.exit).toBe(1);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 30_000);

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
