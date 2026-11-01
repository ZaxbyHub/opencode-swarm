import { describe, expect, test } from 'bun:test';
import {
	buildIssueUrl,
	buildPrUrl,
	canonicalForgePrUrl,
	detectForgeFromUrl,
	FLEET_FORGEJO_HOST,
	getProviderCapabilities,
	matchForgeResourceUrl,
	type ProviderSelection,
	parseForgeRemoteUrl,
	resolveProviderSelection,
} from '../../../src/providers/forge-provider.js';

/**
 * Issue #2733 shipped regression tests — the forge provider core, mirroring
 * the frozen acceptance drivers C3 (self-hosted host handling), C4 (provider
 * selection, fail-closed ambiguity, base_url guards) and C7 (canonicalizer +
 * honest capability reporting). Pure functions only: no fs, no subprocess,
 * no network, static strings only.
 */

// -- C3: detectForgeFromUrl --------------------------------------------------

describe('detectForgeFromUrl (#2733 AC3)', () => {
	test('github.com → github context', () => {
		expect(detectForgeFromUrl('https://github.com/owner/repo/pull/1')).toEqual({
			provider: 'github',
			host: 'github.com',
		});
	});

	test('gitlab.com → gitlab context with gitlab.com host', () => {
		expect(
			detectForgeFromUrl('https://gitlab.com/acme/app/-/merge_requests/1'),
		).toEqual({ provider: 'gitlab', host: 'gitlab.com' });
	});

	test('gitlab.-prefixed self-hosted host → gitlab with THAT host, never gitlab.com', () => {
		expect(
			detectForgeFromUrl(
				'https://gitlab.acme.test/ops/infra/-/merge_requests/7',
			),
		).toEqual({ provider: 'gitlab', host: 'gitlab.acme.test' });
	});

	test('generic self-hosted host → null (requires configured context)', () => {
		expect(
			detectForgeFromUrl(
				'https://git.company.example.net/team/proj/-/merge_requests/7',
			),
		).toBeNull();
	});

	test('http scheme → null (HTTPS-only)', () => {
		expect(
			detectForgeFromUrl('http://gitlab.com/acme/app/-/merge_requests/1'),
		).toBeNull();
	});

	test('non-ASCII IDN host (Cyrillic homograph) → null', () => {
		expect(detectForgeFromUrl(`https://gitl${'а'}b.acme.test/x/y`)).toBeNull();
	});

	test('punycode-encoded host → null', () => {
		expect(
			detectForgeFromUrl('https://gitlab.xn--e1afmkfd.test/acme/app'),
		).toBeNull();
	});
});

// -- C3: parseForgeRemoteUrl -------------------------------------------------

describe('parseForgeRemoteUrl (#2733 AC3)', () => {
	test('https gitlab.com remote: host preserved, .git stripped', () => {
		expect(parseForgeRemoteUrl('https://gitlab.com/acme/app.git')).toEqual({
			provider: 'gitlab',
			host: 'gitlab.com',
			owner: 'acme',
			repo: 'app',
		});
	});

	test('ssh scp-style self-hosted remote with nested namespace owner', () => {
		expect(
			parseForgeRemoteUrl('git@gitlab.acme.test:ops/infra/platform/tools.git'),
		).toEqual({
			provider: 'gitlab',
			host: 'gitlab.acme.test',
			owner: 'ops/infra/platform',
			repo: 'tools',
		});
	});

	test('github.com https remote', () => {
		expect(parseForgeRemoteUrl('https://github.com/owner/repo.git')).toEqual({
			provider: 'github',
			host: 'github.com',
			owner: 'owner',
			repo: 'repo',
		});
	});

	test('host is lowercased to the canonical web host', () => {
		expect(parseForgeRemoteUrl('git@gitlab.ACME.test:x/y.git')?.host).toBe(
			'gitlab.acme.test',
		);
	});

	test('control characters in owner → null', () => {
		expect(parseForgeRemoteUrl('git@gitlab.com:ow\x01ner/app.git')).toBeNull();
	});

	test('generic host → null (never guesses a provider)', () => {
		expect(
			parseForgeRemoteUrl('https://git.company.example.net/team/proj.git'),
		).toBeNull();
	});

	test('forgejo fleet host https remote', () => {
		expect(
			parseForgeRemoteUrl(
				'https://git.centralcloud.net/singularity/singularity-engine.git',
			),
		).toEqual({
			provider: 'forgejo',
			host: FLEET_FORGEJO_HOST,
			owner: 'singularity',
			repo: 'singularity-engine',
		});
	});

	test('forgejo fleet host ssh scp-style remote', () => {
		expect(
			parseForgeRemoteUrl(
				'git@git.centralcloud.net:singularity/singularity-engine.git',
			),
		).toEqual({
			provider: 'forgejo',
			host: FLEET_FORGEJO_HOST,
			owner: 'singularity',
			repo: 'singularity-engine',
		});
	});
});

// -- C3: buildPrUrl / buildIssueUrl ------------------------------------------

describe('buildPrUrl / buildIssueUrl (#2733 AC3)', () => {
	test('buildPrUrl: github shape unchanged', () => {
		expect(
			buildPrUrl(
				{ provider: 'github', host: 'github.com' },
				'owner',
				'repo',
				42,
			),
		).toBe('https://github.com/owner/repo/pull/42');
	});

	test('buildIssueUrl: github shape unchanged', () => {
		expect(
			buildIssueUrl(
				{ provider: 'github', host: 'github.com' },
				'owner',
				'repo',
				42,
			),
		).toBe('https://github.com/owner/repo/issues/42');
	});

	test('buildPrUrl: gitlab MR shape with nested namespace', () => {
		expect(
			buildPrUrl(
				{ provider: 'gitlab', host: 'gitlab.com' },
				'ops/infra',
				'platform',
				7,
			),
		).toBe('https://gitlab.com/ops/infra/platform/-/merge_requests/7');
	});

	test('buildIssueUrl: self-hosted gitlab issue shape (host from context)', () => {
		expect(
			buildIssueUrl(
				{ provider: 'gitlab', host: 'gitlab.acme.test' },
				'ops/infra',
				'app',
				3,
			),
		).toBe('https://gitlab.acme.test/ops/infra/app/-/issues/3');
	});

	test('buildPrUrl: forgejo pulls shape (fleet host)', () => {
		expect(
			buildPrUrl(
				{ provider: 'forgejo', host: FLEET_FORGEJO_HOST },
				'singularity',
				'singularity-engine',
				42,
			),
		).toBe(
			'https://git.centralcloud.net/singularity/singularity-engine/pulls/42',
		);
	});

	test('buildIssueUrl: forgejo issue shape (host from context)', () => {
		expect(
			buildIssueUrl(
				{ provider: 'forgejo', host: FLEET_FORGEJO_HOST },
				'singularity',
				'singularity-engine',
				7,
			),
		).toBe(
			'https://git.centralcloud.net/singularity/singularity-engine/issues/7',
		);
	});
});

describe('matchForgeResourceUrl (forgejo fleet host)', () => {
	const pullUrl =
		'https://git.centralcloud.net/singularity/singularity-engine/pulls/42';
	const issueUrl =
		'https://git.centralcloud.net/singularity/singularity-engine/issues/99';

	test('pull resource on forgejo host', () => {
		expect(matchForgeResourceUrl(pullUrl, 'pull')).toEqual({
			provider: 'forgejo',
			host: FLEET_FORGEJO_HOST,
			owner: 'singularity',
			repo: 'singularity-engine',
			number: 42,
		});
	});

	test('issues resource on forgejo host', () => {
		expect(matchForgeResourceUrl(issueUrl, 'issues')).toEqual({
			provider: 'forgejo',
			host: FLEET_FORGEJO_HOST,
			owner: 'singularity',
			repo: 'singularity-engine',
			number: 99,
		});
	});

	test('pull matcher rejects forgejo issue path', () => {
		expect(matchForgeResourceUrl(issueUrl, 'pull')).toBeNull();
	});
});

// -- C4: resolveProviderSelection --------------------------------------------

describe('resolveProviderSelection (#2733 AC4/AC5)', () => {
	const okGithub = (sel: ProviderSelection): boolean =>
		sel.ok === true &&
		sel.context.provider === 'github' &&
		sel.context.host === 'github.com';
	const okGitlab = (sel: ProviderSelection, host: string): boolean =>
		sel.ok === true &&
		sel.context.provider === 'gitlab' &&
		sel.context.host === host;
	const failClosed = (sel: ProviderSelection): boolean =>
		sel.ok === false &&
		typeof sel.error === 'string' &&
		sel.error.length > 0 &&
		/provider|config/i.test(sel.error);

	test('auto: all-github remotes → github/github.com', () => {
		expect(
			okGithub(
				resolveProviderSelection({
					remotes: [
						'https://github.com/octocat/hello.git',
						'git@github.com:owner/repo.git',
					],
				}),
			),
		).toBe(true);
	});

	test('auto: gitlab.com remotes → gitlab/gitlab.com', () => {
		expect(
			okGitlab(
				resolveProviderSelection({
					remotes: [
						'https://gitlab.com/acme/app.git',
						'git@gitlab.com:acme/other.git',
					],
				}),
				'gitlab.com',
			),
		).toBe(true);
	});

	test('auto: gitlab.-prefixed remote host → gitlab with that host', () => {
		expect(
			okGitlab(
				resolveProviderSelection({
					remotes: ['git@gitlab.internal.example.com:mono/app.git'],
				}),
				'gitlab.internal.example.com',
			),
		).toBe(true);
	});

	test('auto: mixed github+gitlab remotes → fail closed, error demands config', () => {
		expect(
			failClosed(
				resolveProviderSelection({
					remotes: [
						'https://github.com/octocat/hello.git',
						'https://gitlab.com/acme/app.git',
					],
				}),
			),
		).toBe(true);
	});

	test('auto: generic self-hosted host matching no provider → fail closed', () => {
		expect(
			failClosed(
				resolveProviderSelection({
					remotes: ['https://git.company.example.net/team/proj.git'],
				}),
			),
		).toBe(true);
	});

	test('auto: no workflow-relevant remote → fail closed', () => {
		expect(failClosed(resolveProviderSelection({ remotes: [] }))).toBe(true);
	});

	test('auto: two different gitlab hosts → ambiguous → fail closed', () => {
		expect(
			failClosed(
				resolveProviderSelection({
					remotes: [
						'https://gitlab.com/acme/app.git',
						'https://gitlab.acme.test/other/app.git',
					],
				}),
			),
		).toBe(true);
	});

	test('explicit provider github overrides gitlab remotes', () => {
		expect(
			okGithub(
				resolveProviderSelection({
					config: { provider: 'github' },
					remotes: ['git@gitlab.com:acme/app.git'],
				}),
			),
		).toBe(true);
	});

	test('explicit provider gitlab takes host from the gitlab remote', () => {
		expect(
			okGitlab(
				resolveProviderSelection({
					config: { provider: 'gitlab' },
					remotes: ['git@gitlab.acme.test:mono/app.git'],
				}),
				'gitlab.acme.test',
			),
		).toBe(true);
	});

	test('explicit gitlab with no remote and no baseUrl → fail closed (never assumes gitlab.com)', () => {
		expect(
			resolveProviderSelection({ config: { provider: 'gitlab' }, remotes: [] })
				.ok,
		).toBe(false);
	});

	test("explicit provider 'auto' behaves as auto detection", () => {
		expect(
			okGitlab(
				resolveProviderSelection({
					config: { provider: 'auto' },
					remotes: ['https://gitlab.com/acme/app.git'],
				}),
				'gitlab.com',
			),
		).toBe(true);
	});

	test('baseUrl with http scheme → fail closed (HTTPS-only applies to base_url)', () => {
		expect(
			resolveProviderSelection({
				config: { provider: 'gitlab', baseUrl: 'http://gitlab.acme.test' },
				remotes: [],
			}).ok,
		).toBe(false);
	});

	test('baseUrl on localhost → fail closed', () => {
		expect(
			resolveProviderSelection({
				config: { provider: 'gitlab', baseUrl: 'https://localhost/gitlab' },
				remotes: [],
			}).ok,
		).toBe(false);
	});

	test('baseUrl on private IPv4 → fail closed', () => {
		expect(
			resolveProviderSelection({
				config: { provider: 'gitlab', baseUrl: 'https://192.168.1.5' },
				remotes: [],
			}).ok,
		).toBe(false);
	});

	test('baseUrl with non-ASCII IDN host → fail closed', () => {
		expect(
			resolveProviderSelection({
				config: {
					provider: 'gitlab',
					baseUrl: `https://gitl${'а'}b.acme.test`,
				},
				remotes: [],
			}).ok,
		).toBe(false);
	});

	test('explicit gitlab + baseUrl host wins over a github remote (C3-14)', () => {
		const sel = resolveProviderSelection({
			config: { provider: 'gitlab', baseUrl: 'https://gitlab.acme.test' },
			remotes: ['https://github.com/octocat/hello.git'],
		});
		expect(
			sel.ok === true &&
				sel.context.provider === 'gitlab' &&
				sel.context.host === 'gitlab.acme.test',
		).toBe(true);
	});

	test('baseUrl with path/trailing slash normalizes to host only (C3-15)', () => {
		const sel = resolveProviderSelection({
			config: {
				provider: 'gitlab',
				baseUrl: 'https://gitlab.acme.test/team/',
			},
			remotes: [],
		});
		expect(sel.ok === true && sel.context.host === 'gitlab.acme.test').toBe(
			true,
		);
	});
});

// -- C7: canonicalForgePrUrl + capabilities -----------------------------------

describe('canonicalForgePrUrl (#2733 AC7)', () => {
	test('github URL → scheme-less lowercased canonical form', () => {
		expect(canonicalForgePrUrl('https://github.com/owner/repo/pull/42')).toBe(
			'github.com/owner/repo/pull/42',
		);
	});

	test('github case + trailing slash normalized (drop-in parity)', () => {
		expect(canonicalForgePrUrl('https://GitHub.com/Owner/Repo/pull/42/')).toBe(
			'github.com/owner/repo/pull/42',
		);
	});

	test('gitlab.com MR URL → canonical MR form', () => {
		expect(
			canonicalForgePrUrl('https://gitlab.com/acme/app/-/merge_requests/155'),
		).toBe('gitlab.com/acme/app/-/merge_requests/155');
	});

	test('self-hosted nested-namespace MR URL, lowercased, host preserved', () => {
		expect(
			canonicalForgePrUrl(
				'https://gitlab.acme.test/Ops/Infra/Platform/-/merge_requests/7',
			),
		).toBe('gitlab.acme.test/ops/infra/platform/-/merge_requests/7');
	});

	test('gitlab trailing slash normalized', () => {
		expect(
			canonicalForgePrUrl('https://gitlab.com/acme/app/-/merge_requests/155/'),
		).toBe('gitlab.com/acme/app/-/merge_requests/155');
	});

	test('gitlab ISSUES resource is not a PR URL → null', () => {
		expect(
			canonicalForgePrUrl('https://gitlab.com/acme/app/-/issues/42'),
		).toBeNull();
	});

	test('generic host → null', () => {
		expect(
			canonicalForgePrUrl('https://example.com/owner/repo/pull/1'),
		).toBeNull();
	});

	test('http scheme → null (https-only)', () => {
		expect(
			canonicalForgePrUrl('http://gitlab.com/acme/app/-/merge_requests/1'),
		).toBeNull();
	});

	test('buildPrUrl gitlab output round-trips through the canonicalizer', () => {
		const built = buildPrUrl(
			{ provider: 'gitlab', host: 'gitlab.com' },
			'acme',
			'app',
			155,
		);
		expect(built).toBe('https://gitlab.com/acme/app/-/merge_requests/155');
		expect(canonicalForgePrUrl(built)).toBe(
			'gitlab.com/acme/app/-/merge_requests/155',
		);
	});

	test('forgejo fleet pull URL → canonical pulls form', () => {
		expect(
			canonicalForgePrUrl(
				'https://git.centralcloud.net/singularity/singularity-engine/pulls/42',
			),
		).toBe(
			'git.centralcloud.net/singularity/singularity-engine/pulls/42',
		);
	});

	test('forgejo case + trailing slash normalized', () => {
		expect(
			canonicalForgePrUrl(
				'https://Git.CentralCloud.NET/Singularity/Singularity-Engine/pulls/42/',
			),
		).toBe(
			'git.centralcloud.net/singularity/singularity-engine/pulls/42',
		);
	});

	test('forgejo issues path is not a PR URL → null', () => {
		expect(
			canonicalForgePrUrl(
				'https://git.centralcloud.net/singularity/singularity-engine/issues/7',
			),
		).toBeNull();
	});

	test('buildPrUrl forgejo output round-trips through the canonicalizer', () => {
		const built = buildPrUrl(
			{ provider: 'forgejo', host: FLEET_FORGEJO_HOST },
			'singularity',
			'singularity-engine',
			42,
		);
		expect(built).toBe(
			'https://git.centralcloud.net/singularity/singularity-engine/pulls/42',
		);
		expect(canonicalForgePrUrl(built)).toBe(
			'git.centralcloud.net/singularity/singularity-engine/pulls/42',
		);
	});
});

describe('getProviderCapabilities (#2733 AC7)', () => {
	test('github: all synthesized fields available', () => {
		expect(getProviderCapabilities('github')).toEqual({
			statusCheckRollup: true,
			reviewDecision: true,
			mergeStateStatus: true,
		});
	});

	test('gitlab: GitHub-synthesized fields honestly reported unavailable', () => {
		expect(getProviderCapabilities('gitlab')).toEqual({
			statusCheckRollup: false,
			reviewDecision: false,
			mergeStateStatus: false,
		});
	});
});

describe('review-round coverage (PR #2884 feedback: PRR-16, TC-02/03)', () => {
	test('provider github + baseUrl is a rejected configuration conflict (PRR-16)', () => {
		const sel = resolveProviderSelection({
			config: { provider: 'github', baseUrl: 'https://gitlab.example.com' },
			remotes: ['https://github.com/octocat/hello.git'],
		});
		expect(sel.ok).toBe(false);
	});

	test('http remote URL is rejected by parseForgeRemoteUrl (TC-02)', () => {
		expect(parseForgeRemoteUrl('http://gitlab.com/acme/app.git')).toBeNull();
	});

	test('punycode remote host is rejected by parseForgeRemoteUrl (TC-03)', () => {
		expect(
			parseForgeRemoteUrl('https://gitlab.xn--80ak6aa92e.com/acme/app.git'),
		).toBeNull();
	});
});
