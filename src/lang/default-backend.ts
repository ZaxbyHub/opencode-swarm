/**
 * Default backend — registry-driven implementations of every optional hook
 * on `LanguageBackend`. A backend that overrides nothing still works for
 * common cases: any profile with build.commands + test.frameworks +
 * lint.linters declared correctly will get a working `selectTestFramework`,
 * `selectBuildCommand`, etc. without writing any backend code.
 *
 * No subprocess calls happen here — `isCommandAvailable` is the only seam
 * to the environment, and it lives in `src/build/discovery.ts` with full
 * invariant-3 properties (cwd, stdin: 'ignore', timeout, bounded stdio).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCommandAvailable } from '../build/discovery';
import type {
	BuildCommandSelection,
	BuildTestCommandOpts,
	FrameworkSelection,
	LanguageBackend,
	TestFrameworkSelection,
	TestRunSummary,
} from './backend';
import type { LanguageProfile } from './profiles';

/**
 * Resolve a (possibly glob-y) detect file pattern against `dir`. Returns
 * true if any file in `dir` matches. Supports the simple `*.ext` glob
 * shape used by profiles (the same shape `findBuildFiles` understands).
 */
function detectFileExists(dir: string, pattern: string): boolean {
	if (pattern.includes('*') || pattern.includes('?')) {
		try {
			const files = fs.readdirSync(dir);
			// Convert simple glob to anchored regex: `*.csproj` → /^.*\.csproj$/
			const regex = new RegExp(
				`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
			);
			return files.some((f) => regex.test(f));
		} catch {
			return false;
		}
	}
	try {
		fs.accessSync(path.join(dir, pattern));
		return true;
	} catch {
		return false;
	}
}

/**
 * Tokenize a string command into an array. Splits on whitespace; respects
 * single and double quotes for argument grouping. Used to convert profile
 * `cmd` strings (which today are written as "npx tsc --noEmit" etc.) into
 * the array form `bunSpawn` expects.
 *
 * This deliberately does NOT support shell metacharacters (`;`, `&`, `|`,
 * `>`, `<`, backticks, `$()`) — backends with non-trivial commands must
 * override `buildTestCommand`/`selectBuildCommand` to return a custom
 * `cmd: string[]`. Splitting a profile string into words is a 90% case;
 * the 10% override their backend.
 */
export function tokenizeCommand(cmd: string): string[] {
	const out: string[] = [];
	let buf = '';
	let quote: '"' | "'" | null = null;
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				buf += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as '"' | "'";
			continue;
		}
		if (ch === ' ' || ch === '\t') {
			if (buf.length > 0) {
				out.push(buf);
				buf = '';
			}
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

/**
 * Default selectTestFramework: highest-priority framework whose detect
 * file exists AND whose binary is on PATH. Returns null if none.
 */
export async function defaultSelectTestFramework(
	profile: LanguageProfile,
	dir: string,
): Promise<TestFrameworkSelection | null> {
	const sorted = [...profile.test.frameworks].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const fw of sorted) {
		if (!detectFileExists(dir, fw.detect)) continue;
		const argv = tokenizeCommand(fw.cmd);
		if (argv.length === 0) continue;
		if (!isCommandAvailable(argv[0])) continue;
		return {
			name: fw.name,
			cmd: argv,
			cwd: dir,
			detectedVia: fw.detect,
			// Frameworks that ignore per-file selection are explicitly tagged on
			// the framework definition — see the `filesIgnored` flag added to
			// TestFramework in profiles.ts (defaults to false).
			filesIgnored: false,
		};
	}
	return null;
}

/**
 * Default buildTestCommand: full 14-framework switch ported verbatim from
 * the legacy logic that lived in `src/tools/test-runner.ts:buildTestCommand`
 * (pre-Phase-3b). Handles per-framework coverage flags, scope-dependent
 * file inclusion, platform-specific python/python3, pester
 * `-EncodedCommand` for safe path passing, gradlew detection, ctest build-
 * directory probing, flutter-vs-dart selection, bundle/rspec detection,
 * and the minitest `require_relative` trick for multi-file runs.
 *
 * Backends are free to override individual framework cases via their own
 * `buildTestCommand` — this default is a single source of truth so adding
 * a 15th framework only requires one switch arm.
 *
 * `dir` is the base directory used for gradlew/ctest manifest probing.
 * `opts.scope` defaults to `'all'`; `opts.coverage` defaults to `false`.
 * Returns null when the framework name is not in the supported set.
 */
export function defaultBuildTestCommand(
	profile: LanguageProfile,
	framework: string,
	files: string[],
	dir: string = '.',
	opts: BuildTestCommandOpts = {},
): string[] | null {
	const scope = opts.scope ?? 'all';
	const coverage = opts.coverage ?? false;

	switch (framework) {
		case 'bun': {
			const args: string[] = ['bun', 'test'];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'vitest': {
			const args: string[] = [
				'npx',
				'vitest',
				'run',
				'--reporter=json',
				'--outputFile',
				'.swarm/cache/test-runner-vitest.json',
			];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'jest': {
			const args: string[] = ['npx', 'jest', '--json'];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'mocha': {
			const args: string[] = ['npx', 'mocha'];
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'pytest': {
			const isWindows = process.platform === 'win32';
			const args: string[] = isWindows
				? ['python', '-m', 'pytest']
				: ['python3', '-m', 'pytest'];
			if (coverage) args.push('--cov=.', '--cov-report=term-missing');
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'cargo': {
			const args: string[] = ['cargo', 'test'];
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'pester': {
			if (scope !== 'all' && files.length > 0) {
				const escapedFiles = files.map((f) =>
					f.replace(/'/g, "''").replace(/`/g, '``').replace(/\$/g, '`$'),
				);
				const psCommand = `Invoke-Pester -Path @('${escapedFiles.join("','")}')`;
				const utf16Bytes = Buffer.from(psCommand, 'utf16le');
				const base64Command = utf16Bytes.toString('base64');
				return ['pwsh', '-EncodedCommand', base64Command];
			}
			return ['pwsh', '-Command', 'Invoke-Pester'];
		}
		case 'go-test':
			// files param not forwarded — go test does not support arbitrary
			// file paths.
			return ['go', 'test', './...'];
		case 'maven':
			return ['mvn', 'test'];
		case 'gradle': {
			const isWindows = process.platform === 'win32';
			const hasGradlewBat = fs.existsSync(path.join(dir, 'gradlew.bat'));
			const hasGradlew = fs.existsSync(path.join(dir, 'gradlew'));
			if (hasGradlewBat && isWindows) return ['gradlew.bat', 'test'];
			if (hasGradlew) return ['./gradlew', 'test'];
			return ['gradle', 'test'];
		}
		case 'dotnet-test':
			return ['dotnet', 'test'];
		case 'ctest': {
			const buildDirCandidates = [
				'build',
				'_build',
				'cmake-build-debug',
				'cmake-build-release',
				'out',
			];
			const actualBuildDir =
				buildDirCandidates.find((d) =>
					fs.existsSync(path.join(dir, d, 'CMakeCache.txt')),
				) ?? 'build';
			return ['ctest', '--test-dir', actualBuildDir];
		}
		case 'swift-test':
			return ['swift', 'test'];
		case 'dart-test':
			return isCommandAvailable('flutter')
				? ['flutter', 'test', ...files]
				: ['dart', 'test', ...files];
		case 'rspec': {
			const args = isCommandAvailable('bundle')
				? ['bundle', 'exec', 'rspec']
				: ['rspec'];
			if (scope !== 'all' && files.length > 0) args.push(...files);
			return args;
		}
		case 'minitest':
			if (scope !== 'all' && files.length > 0) {
				const requires = files
					.map(
						(f) =>
							`require_relative '${f.replace(/\\/g, '/').replace(/'/g, "\\'")}'`,
					)
					.join('; ');
				return ['ruby', '-Itest', '-e', requires];
			}
			return [
				'ruby',
				'-Itest',
				'-e',
				'Dir.glob("test/**/*_test.rb").sort.each { |f| require_relative f }',
			];
		default: {
			// Unknown framework — fall back to registry-driven tokenization so
			// a profile that adds a new framework entry without updating this
			// switch still gets a working command (best-effort).
			const fw = profile.test.frameworks.find((f) => f.name === framework);
			if (!fw) return null;
			const argv = tokenizeCommand(fw.cmd);
			if (argv.length === 0) return null;
			if (files.length === 0) return argv;
			return [...argv, ...files];
		}
	}
}

/**
 * Default parseTestOutput: full 14-framework switch ported verbatim from
 * `src/tools/test-runner.ts:parseTestOutput`. Returns a TestRunSummary
 * with `passed`/`failed`/`skipped`/`total`/`coveragePercent` populated
 * for every supported framework. Unknown frameworks return an
 * exit-code-only summary.
 *
 * `framework` is the union-name string (e.g. 'bun', 'vitest', 'pytest').
 * Callers pass the combined stdout+stderr as `stdout` and an empty
 * string for `stderr` per the legacy convention — the legacy parser
 * always concatenated streams before parsing.
 */
export function defaultParseTestOutput(
	framework: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): TestRunSummary {
	// The legacy parser receives a combined output string; preserve that by
	// using stdout || stderr || stdout+stderr when both are present.
	const output =
		stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr || '';

	let passed = 0;
	let failed = 0;
	let skipped = 0;
	let total: number | undefined;
	let coveragePercent: number | undefined;

	switch (framework) {
		case 'vitest':
		case 'jest':
		case 'bun': {
			const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					if (parsed.numTotalTests !== undefined) {
						passed = parsed.numPassedTests || 0;
						failed = parsed.numFailedTests || 0;
						skipped = parsed.numPendingTests || 0;
						total = parsed.numTotalTests || 0;
					}
					if (parsed.coverage !== undefined) {
						coveragePercent = parsed.coverage;
					}
				} catch {
					// fall through to regex
				}
			}
			if (total === undefined || total === 0) {
				const passMatch = output.match(/(\d+)\s+pass(ing|ed)?/);
				const failMatch = output.match(/(\d+)\s+fail(ing|ed)?/);
				const skipMatch = output.match(/(\d+)\s+skip(ping|ped)?/);
				if (passMatch) passed = parseInt(passMatch[1], 10);
				if (failMatch) failed = parseInt(failMatch[1], 10);
				if (skipMatch) skipped = parseInt(skipMatch[1], 10);
				total = passed + failed + skipped;
			}
			const coverageMatch = output.match(/All files[^\d]*(\d+\.?\d*)\s*%/);
			if (coveragePercent === undefined && coverageMatch) {
				coveragePercent = parseFloat(coverageMatch[1]);
			}
			break;
		}
		case 'mocha': {
			const passMatch = output.match(/(\d+)\s+passing/);
			const failMatch = output.match(/(\d+)\s+failing/);
			const pendingMatch = output.match(/(\d+)\s+pending/);
			if (passMatch) passed = parseInt(passMatch[1], 10);
			if (failMatch) failed = parseInt(failMatch[1], 10);
			if (pendingMatch) skipped = parseInt(pendingMatch[1], 10);
			total = passed + failed + skipped;
			break;
		}
		case 'pytest': {
			const passMatch = output.match(/(\d+)\s+passed/);
			const failMatch = output.match(/(\d+)\s+failed/);
			const skipMatch = output.match(/(\d+)\s+skipped/);
			if (passMatch) passed = parseInt(passMatch[1], 10);
			if (failMatch) failed = parseInt(failMatch[1], 10);
			if (skipMatch) skipped = parseInt(skipMatch[1], 10);
			total = passed + failed + skipped;
			const coverageMatch = output.match(/TOTAL\s+(\d+\.?\d*)\s*%/);
			if (coverageMatch) coveragePercent = parseFloat(coverageMatch[1]);
			break;
		}
		case 'cargo': {
			const passMatch = output.match(/test result: ok\. (\d+) passed/);
			const failMatch = output.match(
				/test result: FAILED\. (\d+) passed; (\d+) failed/,
			);
			if (failMatch) {
				passed = parseInt(failMatch[1], 10);
				failed = parseInt(failMatch[2], 10);
			} else if (passMatch) {
				passed = parseInt(passMatch[1], 10);
			}
			total = passed + failed;
			break;
		}
		case 'pester': {
			const passMatch = output.match(/Passed:\s*(\d+)/);
			const failMatch = output.match(/Failed:\s*(\d+)/);
			const skipMatch = output.match(/Skipped:\s*(\d+)/);
			if (passMatch) passed = parseInt(passMatch[1], 10);
			if (failMatch) failed = parseInt(failMatch[1], 10);
			if (skipMatch) skipped = parseInt(skipMatch[1], 10);
			total = passed + failed + skipped;
			break;
		}
		case 'go-test': {
			const passMatches = [...output.matchAll(/--- PASS:/g)];
			const failMatches = [...output.matchAll(/--- FAIL:/g)];
			const skipMatches = [...output.matchAll(/--- SKIP:/g)];
			passed = passMatches.length;
			failed = failMatches.length;
			skipped = skipMatches.length;
			total = passed + failed + skipped;
			const covMatch = output.match(/coverage:\s*(\d+\.?\d*)\s*%/);
			if (covMatch) coveragePercent = parseFloat(covMatch[1]);
			break;
		}
		case 'maven': {
			const mavenMatch = output.match(
				/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/,
			);
			if (mavenMatch) {
				const tot = parseInt(mavenMatch[1], 10);
				const failures = parseInt(mavenMatch[2], 10);
				const errors = parseInt(mavenMatch[3], 10);
				const sk = parseInt(mavenMatch[4], 10);
				failed = failures + errors;
				skipped = sk;
				passed = tot - failed - sk;
				total = tot;
			}
			break;
		}
		case 'gradle': {
			const gradleMatch = output.match(
				/(\d+) tests? completed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/,
			);
			if (gradleMatch) {
				total = parseInt(gradleMatch[1], 10);
				failed = gradleMatch[2] ? parseInt(gradleMatch[2], 10) : 0;
				skipped = gradleMatch[3] ? parseInt(gradleMatch[3], 10) : 0;
				passed = total - failed - skipped;
			}
			break;
		}
		case 'dotnet-test': {
			const passMatch = output.match(/Passed[!:]?\s*(\d+)/i);
			const failMatch = output.match(/Failed[!:]?\s*(\d+)/i);
			const skipMatch = output.match(/Skipped[!:]?\s*(\d+)/i);
			if (passMatch) passed = parseInt(passMatch[1], 10);
			if (failMatch) failed = parseInt(failMatch[1], 10);
			if (skipMatch) skipped = parseInt(skipMatch[1], 10);
			total = passed + failed + skipped;
			break;
		}
		case 'ctest': {
			const ctestMatch = output.match(/(\d+) tests? failed out of (\d+)/);
			if (ctestMatch) {
				failed = parseInt(ctestMatch[1], 10);
				total = parseInt(ctestMatch[2], 10);
				passed = total - failed;
			} else {
				const allPassMatch = output.match(/100% tests passed.*?(\d+) tests?/);
				if (allPassMatch) {
					total = parseInt(allPassMatch[1], 10);
					passed = total;
				}
			}
			break;
		}
		case 'swift-test': {
			const swiftMatch = output.match(
				/Executed (\d+) tests?,\s*with (\d+) failures?/,
			);
			if (swiftMatch) {
				total = parseInt(swiftMatch[1], 10);
				failed = parseInt(swiftMatch[2], 10);
				passed = total - failed;
			}
			break;
		}
		case 'dart-test': {
			const dartPassMatch = output.match(/\+(\d+):\s*All tests passed/);
			const dartMixMatch = output.match(/\+(\d+)\s+-(\d+):/);
			if (dartPassMatch) {
				passed = parseInt(dartPassMatch[1], 10);
				total = passed;
			} else if (dartMixMatch) {
				passed = parseInt(dartMixMatch[1], 10);
				failed = parseInt(dartMixMatch[2], 10);
				total = passed + failed;
			}
			break;
		}
		case 'rspec': {
			const rspecMatch = output.match(
				/(\d+) examples?,\s*(\d+) failures?(?:,\s*(\d+) pending)?/,
			);
			if (rspecMatch) {
				total = parseInt(rspecMatch[1], 10);
				failed = parseInt(rspecMatch[2], 10);
				skipped = rspecMatch[3] ? parseInt(rspecMatch[3], 10) : 0;
				passed = total - failed - skipped;
			}
			break;
		}
		case 'minitest': {
			const minitestMatch = output.match(
				/(\d+) runs?,\s*\d+ assertions?,\s*(\d+) failures?,\s*(\d+) errors?,\s*(\d+) skips?/,
			);
			if (minitestMatch) {
				total = parseInt(minitestMatch[1], 10);
				const failures = parseInt(minitestMatch[2], 10);
				const errors = parseInt(minitestMatch[3], 10);
				skipped = parseInt(minitestMatch[4], 10);
				failed = failures + errors;
				passed = total - failed - skipped;
			}
			break;
		}
		default:
			// Unknown framework — return exit-code-only summary.
			break;
	}

	if (total === undefined) total = passed + failed + skipped;

	return {
		ok: exitCode === 0,
		raw: { stdout, stderr, exitCode },
		passed,
		failed,
		skipped,
		total,
		...(coveragePercent !== undefined ? { coveragePercent } : {}),
	};
}

/**
 * Default detectProject: any of `profile.build.detectFiles` is present in
 * `dir`. Honors simple glob patterns the same way `detectFileExists` does.
 */
export async function defaultDetectProject(
	profile: LanguageProfile,
	dir: string,
): Promise<boolean> {
	for (const f of profile.build.detectFiles) {
		if (detectFileExists(dir, f)) return true;
	}
	return false;
}

/**
 * Default selectBuildCommand: highest-priority command whose detectFile
 * (if specified) exists AND whose binary is on PATH. Returns null if none.
 */
export async function defaultSelectBuildCommand(
	profile: LanguageProfile,
	dir: string,
): Promise<BuildCommandSelection | null> {
	const sorted = [...profile.build.commands].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const cmd of sorted) {
		if (cmd.detectFile && !detectFileExists(dir, cmd.detectFile)) continue;
		const argv = tokenizeCommand(cmd.cmd);
		if (argv.length === 0) continue;
		if (!isCommandAvailable(argv[0])) continue;
		return {
			name: cmd.name,
			cmd: argv,
			cwd: dir,
			detectedVia: cmd.detectFile ?? `${profile.id} default`,
		};
	}
	return null;
}

/**
 * Default testFilesFor: convention swap `src/<x>.<ext>` ↔ `tests/<x>.<ext>`
 * (and `tests/<x>_test.<ext>`, `tests/<x>.test.<ext>`). Returns candidates
 * sorted by likelihood. Best-effort — backends with established patterns
 * (e.g. Python's `tests/test_<x>.py`) override.
 */
export async function defaultTestFilesFor(
	profile: LanguageProfile,
	sourceFile: string,
	dir: string,
): Promise<string[]> {
	const ext = path.extname(sourceFile);
	if (!profile.extensions.includes(ext)) return [];
	const base = path.basename(sourceFile, ext);
	const rel = path.relative(dir, sourceFile);
	// Strip the leading `src/` if present, otherwise use the whole relative
	// path's directory.
	const relDir = path.dirname(rel);
	const stripSrc = relDir.replace(/^src(\/|\\)/, '');
	const candidates = new Set<string>();
	for (const tDir of ['tests', 'test', '__tests__', 'spec']) {
		for (const suffix of ['', '_test', '.test', '_spec', '.spec']) {
			candidates.add(path.join(dir, tDir, stripSrc, `${base}${suffix}${ext}`));
		}
	}
	const existing: string[] = [];
	for (const c of candidates) {
		try {
			fs.accessSync(c);
			existing.push(c);
		} catch {
			// not present — skip
		}
	}
	return existing;
}

/**
 * Default extractImports: returns []. The analyzer treats this as
 * "graph scope unavailable for {lang}" and falls back to convention scope
 * with an explicit notice. Backends with parser-driven extraction
 * (TypeScript, Python, Go in the language-agnostic plan's Phase 5) override.
 */
export function defaultExtractImports(): string[] {
	return [];
}

/**
 * Default selectFramework: returns null. Frameworks (React, Django, Gin)
 * are not detectable from a profile alone — a concrete backend must read
 * its language-specific manifest. Returning null causes the architect's
 * PROJECT_FRAMEWORK placeholder to resolve to the `unresolved` sentinel.
 */
export async function defaultSelectFramework(): Promise<FrameworkSelection | null> {
	return null;
}

/**
 * Default selectEntryPoints: returns []. Concrete backends override per
 * language. Empty list maps to the `unresolved` sentinel.
 */
export async function defaultSelectEntryPoints(): Promise<string[]> {
	return [];
}

/**
 * Build a backend object that delegates every hook to the registry-driven
 * defaults. Used by `pickBackend` when no language-specific override has
 * been registered. The returned object is a structural `LanguageBackend`
 * (it spreads the profile, then attaches default method bindings).
 */
export function defaultBackendFor(profile: LanguageProfile): LanguageBackend {
	return {
		...profile,
		detectProject: (dir) => defaultDetectProject(profile, dir),
		selectTestFramework: (dir) => defaultSelectTestFramework(profile, dir),
		buildTestCommand: (framework, files, dir, opts) =>
			defaultBuildTestCommand(profile, framework, files, dir, opts),
		parseTestOutput: (framework, stdout, stderr, exitCode) =>
			defaultParseTestOutput(framework, stdout, stderr, exitCode),
		testFilesFor: (sourceFile, dir) =>
			defaultTestFilesFor(profile, sourceFile, dir),
		extractImports: () => defaultExtractImports(),
		selectBuildCommand: (dir) => defaultSelectBuildCommand(profile, dir),
		selectFramework: () => defaultSelectFramework(),
		selectEntryPoints: () => defaultSelectEntryPoints(),
	};
}
