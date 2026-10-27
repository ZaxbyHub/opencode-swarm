import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type DriftFinding,
	detectV2VendoredPinFreshnessDrift,
	fetchV2PluginLatestVersion,
	npmDistTagsUrl,
} from '../../../scripts/drift-check';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

// Issue #2910 W1.2: the v2 vendored-pin freshness detector guards the
// `@opencode/plugin` pin in src/host/v2/types.ts (the types are PROVENANCE-
// PINNED there, deliberately NOT installed). Production-shaped: no
// node_modules/@opencode/plugin is required; the pin is read from a real
// corpus file and only the dist-tags fetch is stubbed. Every finding is a
// non-blocking `notice` (an external-world fact a blocked PR cannot fix);
// env-gated OFF by default and fail-open, mirroring the v1 battery in
// drift-check-dep-freshness.test.ts (issue #1899).

const ENV_KEYS = [
	'SWARM_DEP_FRESHNESS_CHECK',
	'SWARM_DEP_FRESHNESS_THRESHOLD',
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prev = savedEnv.get(key);
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
	savedEnv.clear();
});

function setEnv(
	key: (typeof ENV_KEYS)[number],
	value: string | undefined,
): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** A minimal vendored-types corpus with the real provenance-header shape. */
function pinCorpus(pin: string): string {
	return [
		'/**',
		' * Vendored structural types for the OpenCode 2 plugin API.',
		' *',
		` * Provenance: distilled from \`@opencode/plugin@${pin}\``,
		' */',
		'export interface V2App { readonly name: string }',
		'',
	].join('\n');
}

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = canonicalMkdtemp('v2-pin-freshness-');
	tempRoots.push(root);
	return root;
}

function writeCorpus(root: string, contents: string): void {
	const full = path.join(root, 'src/host/v2/types.ts');
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf8');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) removeTreeWithRetry(root);
	}
});

function assertNotice(f: DriftFinding): void {
	expect(f.category).toBe('dep-freshness');
	// Advisory only — must never block a merge, even under enforce.
	expect(f.severity).toBe('notice');
}

describe('detectV2VendoredPinFreshnessDrift: env gate', () => {
	test('no-op returning [] when SWARM_DEP_FRESHNESS_CHECK is unset', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', undefined);
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => '9.9.9',
		});
		expect(findings).toEqual([]);
	});

	test('no-op when the env value is falsy', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '0');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		expect(
			await detectV2VendoredPinFreshnessDrift(root, {
				fetchLatestVersion: async () => '9.9.9',
			}),
		).toEqual([]);
	});
});

describe('detectV2VendoredPinFreshnessDrift: staleness detection', () => {
	test('pin 2.0.26 vs latest 2.9.9 flags a notice naming both versions and the types.ts path', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => '2.9.9',
		});
		expect(findings).toHaveLength(1);
		const f = findings[0];
		assertNotice(f);
		expect(f.message).toContain('2.0.26');
		expect(f.message).toContain('2.9.9');
		expect(f.message).toContain('9 minor series');
		expect(f.message).toContain('src/host/v2/types.ts');
		expect(f.message).toContain('@opencode/plugin');
	});

	test('equal versions produce no finding', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		expect(
			await detectV2VendoredPinFreshnessDrift(root, {
				fetchLatestVersion: async () => '2.0.26',
			}),
		).toEqual([]);
	});

	test('within-threshold skew produces no finding (same boundary semantics as v1)', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		setEnv('SWARM_DEP_FRESHNESS_THRESHOLD', '5');
		const root = makeTempRoot();
		// 2.6.26 - 2.0.26 = 6 > 5 → flagged; 2.5.26 → exactly 5 → not flagged.
		writeCorpus(root, pinCorpus('2.0.26'));
		expect(
			await detectV2VendoredPinFreshnessDrift(root, {
				fetchLatestVersion: async () => '2.5.26',
			}),
		).toEqual([]);
		const over = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => '2.6.26',
		});
		expect(over).toHaveLength(1);
		expect(over[0].message).toContain('6 minor series');
	});

	test('production shape: the REAL src/host/v2/types.ts pin vs a major-ahead latest is flagged', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		// Reads the real vendored corpus (process.cwd() is the repo root under
		// bun test); only the registry is stubbed. A major-ahead latest is
		// behind=Infinity for any 2.x pin, so the assertion is pin-bump-proof.
		const findings = await detectV2VendoredPinFreshnessDrift(process.cwd(), {
			fetchLatestVersion: async () => '9.9.9',
		});
		expect(findings).toHaveLength(1);
		const f = findings[0];
		assertNotice(f);
		expect(f.file).toBe('src/host/v2/types.ts');
		expect(f.message).toContain('a major version');
		expect(f.message).toContain('9.9.9');
		expect(f.message).toMatch(/at 2\.\d+\.\d+/);
	});
});

describe('detectV2VendoredPinFreshnessDrift: fail-open', () => {
	test('a fetch that throws yields a non-blocking notice, never throws', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => {
				throw new Error('ENETUNREACH registry.npmjs.org');
			},
		});
		expect(findings).toHaveLength(1);
		assertNotice(findings[0]);
		expect(findings[0].message).toContain('errored');
		expect(findings[0].message).toContain('ENETUNREACH');
	});

	test('an unresolved latest (null) yields a skipped notice (v1 semantics)', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => null,
		});
		expect(findings).toHaveLength(1);
		assertNotice(findings[0]);
		expect(findings[0].message).toContain('could not resolve npm-latest');
		expect(findings[0].message).toContain('src/host/v2/types.ts');
	});

	test('a missing vendored-pin corpus yields a skipped notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot(); // no src/host/v2/types.ts written
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => '9.9.9',
		});
		expect(findings).toHaveLength(1);
		assertNotice(findings[0]);
		expect(findings[0].message).toContain(
			'could not read the v2 vendored-pin corpus',
		);
	});

	test('a corpus without a provenance pin yields a skipped notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, 'export interface V2App { readonly name: string }\n');
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => '9.9.9',
		});
		expect(findings).toHaveLength(1);
		assertNotice(findings[0]);
		expect(findings[0].message).toContain(
			'could not find the @opencode/plugin provenance pin',
		);
	});

	test('an unparseable version pair yields a comparison notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const root = makeTempRoot();
		writeCorpus(root, pinCorpus('2.0.26'));
		const findings = await detectV2VendoredPinFreshnessDrift(root, {
			fetchLatestVersion: async () => 'garbage',
		});
		expect(findings).toHaveLength(1);
		assertNotice(findings[0]);
		expect(findings[0].message).toContain('could not compare versions');
	});
});

describe('fetchV2PluginLatestVersion (bounded dist-tags read for @opencode/plugin)', () => {
	function fakeFetch(
		respond: () => Response,
		urls: string[] = [],
	): typeof fetch {
		return (async (input: string | URL | Request) => {
			urls.push(String(input));
			return respond();
		}) as typeof fetch;
	}

	test('reads latest from the @opencode/plugin dist-tags endpoint (URL-encoded scoped name)', async () => {
		const urls: string[] = [];
		const latest = await fetchV2PluginLatestVersion(
			fakeFetch(
				() =>
					new Response(
						JSON.stringify({ latest: '2.0.26', next: '2.1.0-rc.1' }),
					),
				urls,
			),
		);
		expect(latest).toBe('2.0.26');
		// The v2 host package is deliberately NOT installed, so the URL itself
		// is the only registry reference — assert it targets @opencode/plugin.
		expect(urls).toEqual([npmDistTagsUrl('@opencode/plugin')]);
		expect(urls[0]).toBe(
			'https://registry.npmjs.org/-/package/%40opencode%2Fplugin/dist-tags',
		);
	});

	test('non-OK, unparseable, non-string latest and a throwing fetch yield null', async () => {
		for (const respond of [
			() => new Response('{}', { status: 404 }),
			() => new Response('not json'),
			() => new Response(JSON.stringify({ latest: 7 })),
			() => {
				throw new Error('offline');
			},
		]) {
			expect(await fetchV2PluginLatestVersion(fakeFetch(respond))).toBeNull();
		}
	});
});
