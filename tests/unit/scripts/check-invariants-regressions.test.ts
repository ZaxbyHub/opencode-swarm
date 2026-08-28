import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	expandScopePattern,
	normalizeMockTarget,
} from '../../../scripts/check-invariants';
import { spawnUtf8 } from '../../../scripts/gate-utils';
import { bashCommand, resolveBash } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-invariants.sh');
const SCRIPT_TS_PATH = path.join(REPO_ROOT, 'scripts', 'check-invariants.ts');
const GATE_UTILS_PATH = path.join(REPO_ROOT, 'scripts', 'gate-utils.ts');
const LIB_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'lib',
	'normalize-mock-target.sh',
);
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');
const ADVISORY_PUSH_SCRIPT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'check-no-raw-advisory-push.sh',
);
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;
const hasBash = (() => {
	try {
		resolveBash();
		return true;
	} catch {
		return false;
	}
})();

async function runCheckInvariants(cwd: string): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const localScript = path.join(cwd, 'scripts', 'check-invariants.sh');
	const scriptPath = fs.existsSync(localScript) ? localScript : SCRIPT_PATH;
	const result = await spawnUtf8(
		bashCommand(scriptPath),
		cwd,
		SPAWN_TIMEOUT_MS,
	);

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}

function setupFixtureDir(fixtureName: string): string {
	const fixtureDir = canonicalMkdtemp(`check-invariants-${fixtureName}-`);
	fs.mkdirSync(path.join(fixtureDir, 'scripts', 'lib'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'tools'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'hooks'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

	fs.copyFileSync(
		SCRIPT_PATH,
		path.join(fixtureDir, 'scripts', 'check-invariants.sh'),
	);
	fs.copyFileSync(
		SCRIPT_TS_PATH,
		path.join(fixtureDir, 'scripts', 'check-invariants.ts'),
	);
	fs.copyFileSync(
		GATE_UTILS_PATH,
		path.join(fixtureDir, 'scripts', 'gate-utils.ts'),
	);
	fs.copyFileSync(
		LIB_PATH,
		path.join(fixtureDir, 'scripts', 'lib', 'normalize-mock-target.sh'),
	);
	fs.copyFileSync(
		ALLOWLIST_PATH,
		path.join(fixtureDir, 'scripts', 'mock-allowlist.txt'),
	);
	fs.copyFileSync(
		ADVISORY_PUSH_SCRIPT_PATH,
		path.join(fixtureDir, 'scripts', 'check-no-raw-advisory-push.sh'),
	);

	return fixtureDir;
}

describe('check-invariants regressions', () => {
	test('FB-004 regression: mock-target normalization matches Bash edge semantics', () => {
		// The prior TypeScript path.posix.normalize implementation removed `./`
		// segments that the archived Bash owner intentionally preserves.
		expect(normalizeMockTarget('src/./foo.js')).toBe('src/./foo');
		expect(normalizeMockTarget('src/foo/../../bar.js')).toBe('src/bar');
		expect(normalizeMockTarget('../../../src/foo/bar.js')).toBe('src/foo/bar');
	});

	test(
		'regression: real repo knowledge-scope glob expands without regex failure',
		() => {
			const matches = expandScopePattern(REPO_ROOT, 'src/knowledge/*.ts');
			expect(matches.length).toBeGreaterThan(0);
			expect(
				matches.some((file) =>
					file.replace(/\\/g, '/').endsWith('src/knowledge/entry-merge.ts'),
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'regression: bun-compat.ts is exempt from timeout warning by basename',
		async () => {
			if (!hasBash) return;
			const fixtureDir = setupFixtureDir('bun-compat');

			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'bun-compat.ts'),
				'import { spawnSync } from "node:child_process";\nspawnSync("cmd", []);\n',
			);
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'not-bun-compat.ts'),
				'import { spawnSync } from "node:child_process";\nspawnSync("cmd", []);\n',
			);

			const result = await runCheckInvariants(fixtureDir);
			expect(result.stdout).not.toContain(
				'WARNING: src/bun-compat.ts uses spawn/spawnSync',
			);
			expect(result.stdout).toContain('not-bun-compat.ts');

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'regression: LEGACY_EXEMPTS uses exact path match',
		async () => {
			if (!hasBash) return;
			const fixtureDir = setupFixtureDir('legacy-exempts');

			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'tools', 'create-tool.ts'),
				'process.cwd();\n',
			);
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'tools', 'create-tool-helper.ts'),
				'process.cwd();\n',
			);

			const result = await runCheckInvariants(fixtureDir);
			expect(result.stdout).not.toContain('src/tools/create-tool.ts');
			expect(result.stdout).toContain('src/tools/create-tool-helper.ts');

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);
});
