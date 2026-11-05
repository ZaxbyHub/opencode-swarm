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
	buildBranchProvenanceFixtureInner,
	buildMergeFixture,
	buildMergeFixtureInner,
	buildOwnerScopeFixtureInner,
	CHANNEL_BRANCH,
	channelPackageJson,
	commitWorktree,
	DEP_BUMP_TRAILERS,
	dep,
	git,
	initChannelRepo,
	MERGE_SUBJECT,
	type MergeVariant,
	MISSING_PACKAGE_TRAILERS,
	MISSING_VERSION_TRAILERS,
	PIN_TEST_FILE,
	pullRequestPayload,
	REASON_ONLY_TRAILERS,
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
	// Dep-map-only human delta so commit provenance fails FIRST (M7's kill: the two-commit shape also trips the exact-one-count bound, so the tip check is the conjunct under test here, not the only denial).
	writeFileSync(join(root, 'package.json'), channelPackageJson(true));
	const humanHead = commitWorktree(root, 'human: declare fast-check');
	return { root, base, head: humanHead };
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
	const created = initChannelRepo('dep-bump-prov-');
	const { root, base } = created;
	try {
		return buildBranchProvenanceFixtureInner(root, base);
	} catch (error) {
		safeRmRecursive(root);
		throw error;
	}
}

function buildOwnerScopeFixture() {
	const created = initChannelRepo('dep-bump-scope-');
	const { root, base } = created;
	try {
		return buildOwnerScopeFixtureInner(root, base);
	} catch (error) {
		safeRmRecursive(root);
		throw error;
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

describe('per-field commit identity (F-12a)', () => {
	const identityCases = [
		['author name', 'user.name', 'human'],
		['author email', 'user.email', 'human@example.com'],
		['committer name', 'committer.name', 'human'],
		['committer email', 'committer.email', 'human@example.com'],
	] as const;
	for (const [label, configKey, humanValue] of identityCases) {
		test(`commit provenance denies when only ${label} is not the bot identity`, () => {
			const { root } = initChannelRepo('dep-bump-ident-');
			try {
				writeFileSync(
					join(root, 'package.json'),
					`${JSON.stringify({ ...JSON.parse(BASE_PACKAGE_JSON), dependencies: { zod: '4.6.7' } }, null, 2)}\n`,
				);
				writeFileSync(join(root, 'bun.lock'), '// identity leg\n');
				git(root, 'add', '-A');
				git(
					root,
					'-c',
					'commit.gpgsign=false',
					'-c',
					`${configKey}=${humanValue}`,
					'commit',
					'-qm',
					trailerMessage(DEP_BUMP_TRAILERS),
				);
				const head = git(root, 'rev-parse', 'HEAD');
				const verdict = dependencyBumpCommitProvenanceOk(root, head);
				expect(verdict.ok).toBe(false);
			} finally {
				safeRmRecursive(root);
			}
		}, 30_000);
	}
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

	test('main() merge_group with a human second parent exits 1 (C2 wiring)', () => {
		const fixture = buildMergeFixture('human-parent');
		try {
			const result = runReleaseOwnerMain(
				fixture.root,
				'merge_group',
				BOT_NAME,
				{ merge_group: { base_sha: fixture.base, head_sha: fixture.mergeSha } },
			);
			expect(result.exit).toBe(1);
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 60_000);

	test('main() pull_request payload binding: foreign head repo AND non-bot PR user each exit 1 (C3)', () => {
		// The payload binding is a TWO-conjunct expression (headRepository ===
		// repository && headUser === bot). Each half must deny INDEPENDENTLY —
		// a leg that mutates both at once survives a half-expression mutant.
		const fixture = buildChannelPullRequestFixture('authorized');
		const foreignRepo = JSON.parse(
			JSON.stringify(pullRequestPayload(fixture.base, fixture.head)),
		);
		foreignRepo.pull_request.head.repo.full_name = 'evil/fork';
		const foreignUser = JSON.parse(
			JSON.stringify(pullRequestPayload(fixture.base, fixture.head)),
		);
		foreignUser.pull_request.user.login = 'someone';
		try {
			const repoResult = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				BOT_NAME,
				foreignRepo,
			);
			expect(repoResult.exit).toBe(1);
			expect(repoResult.stdout).not.toContain('EXCEPTION');
			const userResult = runReleaseOwnerMain(
				fixture.root,
				'pull_request',
				BOT_NAME,
				foreignUser,
			);
			expect(userResult.exit).toBe(1);
			expect(userResult.stdout).not.toContain('EXCEPTION');
		} finally {
			safeRmRecursive(fixture.root);
		}
	}, 60_000);

	test('main() end-to-end laundering: provenance-clean bot PR with an out-of-scope delta exits 1', () => {
		// Final-critic r2/r3: a DEDICATED fixture — fresh repo, exactly ONE
		// bot-authored commit with the FULL trailer set over the version-field
		// delta — so branch provenance (count === 1) AND commit provenance
		// (bot + trailers) both pass by construction (asserted first: the
		// isolation is self-proving), leaving dependencyScope as the ONLY
		// conjunct that can deny this PR inside main()'s composition.
		const { root, base } = initChannelRepo('dep-bump-launder-');
		try {
			writeFileSync(
				join(root, 'package.json'),
				`${JSON.stringify({ ...JSON.parse(BASE_PACKAGE_JSON), version: '7.0.1' }, null, 2)}
`,
			);
			const laundering = commitWorktree(
				root,
				trailerMessage(DEP_BUMP_TRAILERS),
				true,
			);
			expect(dependencyBumpBranchProvenanceOk(root, base, laundering).ok).toBe(
				true,
			);
			expect(dependencyBumpCommitProvenanceOk(root, laundering).ok).toBe(true);
			expect(dependencyBumpOwnerScopeOk(root, base, laundering)).toBe(false);
			const result = runReleaseOwnerMain(
				root,
				'pull_request',
				BOT_NAME,
				pullRequestPayload(base, laundering),
			);
			expect(result.exit).toBe(1);
		} finally {
			safeRmRecursive(root);
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
			// Reason-only positive: the advisory XOR reason accepts either arm.
			expect(commitOk(fixture.reasonOnly)).toBe(true);
			expect(branchOk(fixture.humanSecond)).toBe(false);
			// C1: two commits with a VALID bot tip — only the exact-one-count
			// bound denies (the tip check alone would accept under the mutant).
			expect(branchOk(fixture.botTipOverHuman)).toBe(false);
			expect(branchOk(fixture.base)).toBe(false);
			expect(commitOk(fixture.missingTrailer)).toBe(false);
			expect(commitOk(fixture.missingPackageTrailer)).toBe(false);
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
