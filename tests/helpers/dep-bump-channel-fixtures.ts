import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	deriveDependencyBumpAutomation,
	main,
} from '../../scripts/check-required-check-contract';
import { safeRmRecursive } from './safe-test-dir';
import { canonicalMkdtemp } from './tmpdir';

// Shared fixtures for the dependency-bump channel contract suites (trace
// 3501-3285-3527; frozen checks C1/C2/C3). Extracted verbatim from the
// .test.ts file to stay under the FR-006 500-line cap — every test leg
// remains in the frozen path; only these helpers live here.

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL =
	'41898282+github-actions[bot]@users.noreply.github.com';
export const REPO = 'ZaxbyHub/opencode-swarm';
export const CHANNEL_BRANCH = 'dep-bump--zod--abcd1234';
export const MERGE_SUBJECT = `Merge pull request #3580 from ZaxbyHub/${CHANNEL_BRANCH}`;
export const RELEASE_MERGE_SUBJECT =
	'Merge pull request #1 from ZaxbyHub/release-please--branches--main';
export const PIN_TEST_FILE =
	'tests/unit/scripts/generate-config-schema.test.ts';
export const DEP_BUMP_TRAILERS = [
	'X-Dep-Bump-Channel: dependency-bump',
	'X-Dep-Bump-Package: zod',
	'X-Dep-Bump-Version: 4.6.7',
	'X-Dep-Bump-Advisory: GHSA-mrhx-c7xc-m3w5',
];
export const MISSING_VERSION_TRAILERS = DEP_BUMP_TRAILERS.filter(
	(l) => !l.startsWith('X-Dep-Bump-Version:'),
);
export const MISSING_PACKAGE_TRAILERS = DEP_BUMP_TRAILERS.filter(
	(l) => !l.startsWith('X-Dep-Bump-Package:'),
);
export const REASON_ONLY_TRAILERS = [
	'X-Dep-Bump-Channel: dependency-bump',
	'X-Dep-Bump-Package: zod',
	'X-Dep-Bump-Version: 4.6.7',
	'X-Dep-Bump-Reason: declare fast-check as a direct devDependency',
];
const BASE_PACKAGE_DOC = {
	version: '7.0.0',
	meta: null,
	scripts: { build: 'bun run build' },
	dependencies: { zod: '4.3.6' },
	devDependencies: { typescript: '5.9.2' },
};
export const BASE_PACKAGE_JSON = `${JSON.stringify(BASE_PACKAGE_DOC, null, 2)}\n`;

export function git(cwd: string, ...args: string[]): string {
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
export function botGit(cwd: string, ...args: string[]): string {
	return git(cwd, ...BOT_IDENTITY, ...args);
}

export function trailerMessage(trailers: string[]): string {
	return ['chore(deps): bump zod to 4.6.7', '', ...trailers].join('\n');
}

/** The legitimate channel delta: zod 4.3.6 -> 4.6.7 (+ fast-check declared). */
export function channelPackageJson(fastCheck: boolean): string {
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

export function initChannelRepo(
	prefix: string,
	options: { pinFiles?: boolean } = {},
) {
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

export function commitWorktree(
	root: string,
	message: string,
	bot = false,
): string {
	git(root, 'add', '-A');
	const run = bot ? botGit : git;
	run(root, 'commit', '-q', '-m', message);
	return git(root, 'rev-parse', 'HEAD');
}

type DepBumpInput = Parameters<typeof deriveDependencyBumpAutomation>[0];

export function dep(input: Partial<DepBumpInput>): boolean {
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

export function pullRequestPayload(base: string, head: string) {
	return {
		pull_request: {
			base: { sha: base },
			head: { sha: head, ref: CHANNEL_BRANCH, repo: { full_name: REPO } },
			user: { login: BOT_NAME },
		},
	};
}

export function runReleaseOwnerMain(
	root: string,
	eventName: string,
	actor: string,
	payload: Record<string, unknown>,
): { exit: number; stdout: string; stderr: string } {
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
	const errors: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
	};
	try {
		return {
			exit: main(['--release-owner'], root),
			stdout: lines.join('\n'),
			stderr: errors.join('\n'),
		};
	} finally {
		console.log = originalLog;
		console.error = originalError;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

type MergeVariant =
	| 'valid'
	| 'release-subject'
	| 'human-parent'
	| 'missing-trailer'
	| 'zero-commit';

export function buildMergeFixture(variant: MergeVariant) {
	const created = initChannelRepo('dep-bump-mg-');
	const { root, base } = created;
	try {
		return buildMergeFixtureInner(root, base, variant);
	} catch (error) {
		safeRmRecursive(root);
		throw error;
	}
}

export function buildMergeFixtureInner(
	root: string,
	base: string,
	variant: MergeVariant,
) {
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

export function buildBranchProvenanceFixtureInner(root: string, base: string) {
	let legCount = 0;
	const leg = (message: string, bot: boolean): string => {
		legCount += 1;
		writeFileSync(join(root, 'bun.lock'), `// leg ${legCount}\n`);
		return commitWorktree(root, message, bot);
	};
	const validBot = leg(trailerMessage(DEP_BUMP_TRAILERS), true);
	const humanSecond = leg('human: update lockfile', false);
	// C1: human interior UNDER a valid bot tip — only the exact-one-count
	// bound denies this shape (the tip check alone would accept).
	const humanInterior = leg('human: interior change', false);
	const botTipOverHuman = leg(trailerMessage(DEP_BUMP_TRAILERS), true);
	const missingTrailer = leg(trailerMessage(MISSING_VERSION_TRAILERS), true);
	const missingPackageTrailer = leg(
		trailerMessage(MISSING_PACKAGE_TRAILERS),
		true,
	);
	const reasonOnly = leg(trailerMessage(REASON_ONLY_TRAILERS), true);
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
		humanInterior,
		botTipOverHuman,
		missingTrailer,
		missingPackageTrailer,
		reasonOnly,
		missingChannelTrailer,
		bothAdvisoryAndReason,
		noAdvisoryOrReason,
	};
}

export function buildOwnerScopeFixtureInner(root: string, base: string) {
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
