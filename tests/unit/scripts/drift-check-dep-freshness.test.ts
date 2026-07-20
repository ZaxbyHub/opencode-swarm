import { afterEach, describe, expect, test } from 'bun:test';
import {
	DEP_FRESHNESS_PACKAGES,
	type DepFreshnessDeps,
	type DriftFinding,
	detectDependencyFreshnessDrift,
	minorSeriesBehind,
	parseMajorMinor,
} from '../../../scripts/drift-check';

// Issue #1899: the dependency-freshness detector guards against the locked
// @opencode-ai/* resolution silently aging behind npm-latest. Every finding it
// emits is a non-blocking `notice` (dependency freshness is an external-world
// fact a blocked PR cannot fix); it is env-gated OFF by default and fails open.
// These tests inject the version reader + latest fetcher (no real network).

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

/**
 * Build DI deps that return the same locked/latest pair for every package, so
 * both DEP_FRESHNESS_PACKAGES are exercised uniformly.
 */
function uniformDeps(
	locked: string | null,
	latest: string | null | (() => Promise<string | null>),
): Partial<DepFreshnessDeps> {
	return {
		readInstalledVersion: () => locked,
		fetchLatestVersion:
			typeof latest === 'function' ? latest : async () => latest,
	};
}

function assertShape(f: DriftFinding): void {
	expect(f.category).toBe('dep-freshness');
	expect(['error', 'warning', 'notice']).toContain(f.severity);
	expect(f.message).toBeString();
}

describe('parseMajorMinor', () => {
	test('parses plain semver', () => {
		expect(parseMajorMinor('1.18.3')).toEqual({ major: 1, minor: 18 });
		expect(parseMajorMinor('1.1.53')).toEqual({ major: 1, minor: 1 });
	});

	test('tolerates a leading v and drops prerelease/build metadata', () => {
		expect(parseMajorMinor('v2.0.0')).toEqual({ major: 2, minor: 0 });
		expect(parseMajorMinor('1.18.3-beta.1')).toEqual({ major: 1, minor: 18 });
		expect(parseMajorMinor('1.18.3+build.7')).toEqual({ major: 1, minor: 18 });
	});

	test('accepts major.minor without patch', () => {
		expect(parseMajorMinor('4.1')).toEqual({ major: 4, minor: 1 });
	});

	test('returns null for unparseable input', () => {
		expect(parseMajorMinor('')).toBeNull();
		expect(parseMajorMinor('latest')).toBeNull();
		expect(parseMajorMinor('not.a.version')).toBeNull();
	});
});

describe('minorSeriesBehind', () => {
	test('same major → minor delta', () => {
		expect(minorSeriesBehind('1.1.53', '1.18.3')).toBe(17);
		expect(minorSeriesBehind('1.18.3', '1.18.3')).toBe(0);
	});

	test('same major, locked ahead → negative (not behind)', () => {
		expect(minorSeriesBehind('1.20.0', '1.18.3')).toBe(-2);
	});

	test('latest major greater → Infinity (always far behind)', () => {
		expect(minorSeriesBehind('1.18.3', '2.0.0')).toBe(Number.POSITIVE_INFINITY);
	});

	test('latest major smaller → 0 (locked ahead of latest)', () => {
		expect(minorSeriesBehind('2.0.0', '1.18.3')).toBe(0);
	});

	test('unparseable either side → null', () => {
		expect(minorSeriesBehind('bogus', '1.18.3')).toBeNull();
		expect(minorSeriesBehind('1.1.53', 'bogus')).toBeNull();
	});
});

describe('detectDependencyFreshnessDrift: env gate', () => {
	test('no-op returning [] when SWARM_DEP_FRESHNESS_CHECK is unset', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', undefined);
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', '1.18.3'),
		);
		expect(findings).toEqual([]);
	});

	test('no-op when the env value is falsy', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '0');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', '1.18.3'),
		);
		expect(findings).toEqual([]);
	});
});

describe('detectDependencyFreshnessDrift: staleness detection', () => {
	test('GUARDRAIL BITES: original-defect fixture (locked 1.1.53 vs latest 1.18.3) flags each package', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', '1.18.3'),
		);
		// One finding per checked package.
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			assertShape(f);
			// Advisory only — must never block a merge, even under enforce.
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('1.1.53');
			expect(f.message).toContain('1.18.3');
			expect(f.message).toContain('17 minor series');
		}
		// Both packages named.
		for (const pkg of DEP_FRESHNESS_PACKAGES) {
			expect(findings.some((f) => f.message.includes(pkg))).toBe(true);
		}
	});

	test('FIXED CODE: current fixture (locked 1.18.3 vs latest 1.18.3) produces no finding', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.18.3', '1.18.3'),
		);
		expect(findings).toEqual([]);
	});

	test('a cross-major gap is flagged as "a major version"', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.18.3', '2.0.0'),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('a major version');
		}
	});

	test('threshold boundary: exactly N behind is NOT flagged; N+1 is', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		setEnv('SWARM_DEP_FRESHNESS_THRESHOLD', '5');
		// 1.10 - 1.5 = 5 → not > 5 → no finding.
		const atThreshold = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.5.0', '1.10.0'),
		);
		expect(atThreshold).toEqual([]);
		// 1.11 - 1.5 = 6 → > 5 → flagged.
		const overThreshold = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.5.0', '1.11.0'),
		);
		expect(overThreshold).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of overThreshold) expect(f.severity).toBe('notice');
	});

	test('non-numeric threshold falls back to the default (does not silently disable)', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		setEnv('SWARM_DEP_FRESHNESS_THRESHOLD', 'not-a-number');
		// 17 behind must still be flagged under the default threshold of 5.
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', '1.18.3'),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
	});
});

describe('detectDependencyFreshnessDrift: fail-open', () => {
	test('a fetch that throws yields a non-blocking notice, never throws', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', async () => {
				throw new Error('ENETUNREACH registry.npmjs.org');
			}),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('errored');
			expect(f.message).toContain('ENETUNREACH');
		}
	});

	test('an unresolved latest (null) yields a skipped notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('1.1.53', null),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('could not resolve npm-latest');
		}
	});

	test('a missing installed version (null) yields a skipped notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps(null, '1.18.3'),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('could not resolve installed version');
		}
	});

	test('an unparseable version pair yields a comparison notice', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(
			process.cwd(),
			uniformDeps('garbage', '1.18.3'),
		);
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('could not compare versions');
		}
	});

	test('a throwing readInstalledVersion degrades to a notice, never escapes', async () => {
		setEnv('SWARM_DEP_FRESHNESS_CHECK', '1');
		const findings = await detectDependencyFreshnessDrift(process.cwd(), {
			readInstalledVersion: () => {
				throw new Error('EACCES node_modules');
			},
			fetchLatestVersion: async () => '1.18.3',
		});
		expect(findings).toHaveLength(DEP_FRESHNESS_PACKAGES.length);
		for (const f of findings) {
			expect(f.severity).toBe('notice');
			expect(f.message).toContain('disposition errored');
			expect(f.message).toContain('EACCES');
		}
	});
});
