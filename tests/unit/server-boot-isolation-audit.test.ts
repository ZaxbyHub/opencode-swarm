/**
 * Hygiene test (issue #2010, AC4): audit every plugin `server()` boot appearing
 * directly in a test file for global-state isolation, whatever identifier it
 * uses. Detection reads each file ALONE, so boots inside a shared fixture (e.g.
 * `tests/helpers/knowledge-real-host.ts`) are out of scope; those self-protect.
 *
 * ## The hazard
 *
 * `config-doctor`'s `getUserConfigDir()` (`src/services/config-doctor.ts:582-584`)
 * ignores its `directory` parameter entirely and always resolves the *user's*
 * global config root. When a booted plugin has no project config under the
 * `directory` it was handed, config-doctor's project-absent fallback in
 * `createConfigBackup` (`config-doctor.ts:710-720`) and `applySafeAutoFixes`
 * (`config-doctor.ts:1884-1896`) falls through to the developer's REAL
 * `~/.config/opencode/opencode-swarm.json` — reading it AND REWRITING it. A
 * sandboxed repro proved this: a fake XDG root's `max_iterations: 99` was
 * rewritten to `10` by merely booting the plugin in a test.
 *
 * A manual audit is correct exactly once and then regresses silently as new
 * boot sites are added. This runs on every CI invocation instead.
 *
 * ## The contract
 *
 * A test file that boots the plugin must carry at least ONE of three
 * independent protections (any one neutralizes the hazard on its own):
 *
 *   1. **Env isolation** — `XDG_CONFIG_HOME` is redirected into a temp root, so
 *      "the user's global config" IS the temp root. (`createIsolatedTestEnv`,
 *      `setupIsolatedState`, `withIsolatedState`, or a manual assignment.)
 *   2. **Scheduler stub** — `schedulePostResolutionTasks` is overridden. The
 *      config-doctor task is only reachable from that post-resolution queue, so
 *      stubbing the queue makes the hazardous code path unreachable.
 *   3. **Project config present** — a `.opencode/opencode-swarm.json` is written
 *      into the temp `directory` before the boot, so config-doctor's
 *      project-first branch wins and the global fallback never runs.
 *
 * ...or an explicit, reasoned escape hatch:
 *
 *   `// server-boot-isolation-audit: exempt — <reason>`
 *
 * Repo precedent: `tests/unit/agents/no-hardcoded-tool-lists.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Repo root, from `tests/unit/` up two levels. */
const REPO_ROOT = resolve(__dirname, '../..');

/** Roots scanned for `*.test.ts` files. */
const SCAN_ROOTS = ['tests', 'src'] as const;

/** Directory names never descended into, at any depth. */
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.claude',
	'.opencode',
	'__snapshots__',
]);

/**
 * Build outputs, skipped by ROOT-RELATIVE path rather than by bare name.
 * Skipping the bare name `build` at any depth is what hid `tests/unit/build/**`
 * — real hand-written tests, one of which boots the built plugin — entirely.
 */
const SKIP_ROOT_PATHS = new Set(
	['dist', 'build', 'coverage', 'graphify-out'].map((dir) =>
		join(REPO_ROOT, dir),
	),
);

/**
 * A boot CALL, on a non-comment line.
 *
 * Deliberately identifier-agnostic. An earlier revision matched only
 * `OpenCodeSwarm.server(` and was blind to three real boot sites reaching the
 * same plugin default export under other names: `mod.default.server(…)` in
 * `tests/smoke/packaging.test.ts` and
 * `tests/unit/build/throw-and-verify-located.test.ts`, and
 * `(OpenCodeSwarmPlugin as …).server(…)` in
 * `tests/integration/config-hook-multi-swarm.test.ts`.
 *
 * Broad enough on its own to hit an unrelated `.server(` (an HTTP harness,
 * say), so it counts as a plugin boot only when the file also references the
 * plugin entry module — see {@link referencesPluginEntry}.
 */
const BOOT_CALL_RE = /\.server\s*\(/;

/** The plugin's source entry. A boot goes through this module or its build. */
const PLUGIN_SRC_ENTRY = join(REPO_ROOT, 'src', 'index.ts');

/** Any module specifier: `from '…'`, `import('…')`, `require('…')`. */
const MODULE_SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

/**
 * The BUILT plugin entry, loaded by path rather than by specifier:
 * `import(path.join(ROOT, 'dist/index.js'))` or `join(ROOT, 'dist', 'index.js')`.
 */
const BUILT_ENTRY_RE =
	/dist[/\\]index\.js|['"]dist['"]\s*,\s*['"]index\.js['"]/;

/**
 * Protection 1: the global config root is redirected into a temp dir. Matches a
 * CALL (`createIsolatedTestEnv(`), never a bare mention — a mention is
 * satisfied by an `import { … }` clause, which isolates nothing.
 */
const ENV_ISOLATION_RE =
	/(?:createIsolatedTestEnv|setupIsolatedState|withIsolatedState)\s*\(|process\.env\.XDG_CONFIG_HOME\s*=/;

/** Protection 2: the post-resolution queue (config-doctor's only caller) is stubbed. */
const SCHEDULER_STUB_RE = /schedulePostResolutionTasks\s*:/;

/**
 * Protection 3, part A: the file names the project config file.
 *
 * Matching the joined path literal (`'.opencode/opencode-swarm.json'`) alone is
 * too fragile — every real call site builds the path with a multi-argument
 * `path.join(dir, '.opencode', 'opencode-swarm.json')`. Protection 3 is
 * therefore a conjunction of three weaker signals (config filename +
 * `.opencode` directory + a write call), all gathered from NON-COMMENT lines so
 * prose describing the hazard cannot satisfy it. If it ever misfires for a
 * legitimate file, use the exemption marker rather than loosening it.
 */
const PROJECT_CONFIG_NAME_RE = /opencode-swarm\.json/;

/** Protection 3, part B: the `.opencode` project directory is referenced. */
const PROJECT_CONFIG_DIR_RE = /['"`]\.opencode['"`]|\.opencode[/\\]/;

/** Protection 3, part C: something is actually written to disk. */
const WRITE_CALL_RE = /writeFileSync\s*\(|writeFile\s*\(|Bun\.write\s*\(/;

/** Explicit escape hatch, e.g. `// server-boot-isolation-audit: exempt — reason`. */
const EXEMPT_RE = /server-boot-isolation-audit:\s*exempt/;

/**
 * A static import, split into clause and specifier: `import A, { b } from '…'`.
 * `[^;]*?` cannot cross a statement terminator, so a side-effect import
 * (`import './x.js';`) can never swallow the next statement's `from`.
 */
const STATIC_IMPORT_RE = /import\s+([^;]*?)\s+from\s+['"](\.[^'"]+)['"]/g;

/** Named-import identifiers inside an import clause's `{ … }`. */
const NAMED_IMPORT_LIST_RE = /\{([^}]*)\}/;

/** A top-level exported binding, e.g. `export async function foo(`. */
const EXPORT_DECL_RE =
	/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/;

/**
 * Any top-level declaration at column 0 — a block terminator. This repo is
 * biome-formatted with tab-indented bodies, so a column-0 declaration always
 * starts the NEXT top-level binding.
 */
const TOP_LEVEL_DECL_RE =
	/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\b/;

/**
 * Shared setup still protects its importers, so the scan follows imports — but
 * ONLY into `tests/helpers/`. Following them into `src/` would be actively
 * wrong: `src/index.ts` declares the `schedulePostResolutionTasks:` seam and
 * `src/config/loader.ts` reads `process.env.XDG_CONFIG_HOME`, so every boot
 * file would look "protected" and the audit would pass vacuously.
 */
const HELPERS_ROOT = join(REPO_ROOT, 'tests', 'helpers');

/** Max transitive hops through `tests/helpers/` when gathering protections. */
const MAX_HELPER_DEPTH = 2;

/**
 * Lower bound for the self-test. If a refactor breaks {@link BOOT_CALL_RE},
 * {@link referencesPluginEntry}, or the directory walk, this audit would
 * otherwise "pass" by finding nothing to check. The suite had 18 boot files
 * when the identifier-agnostic detector landed.
 */
const MIN_EXPECTED_BOOT_FILES = 15;

/**
 * Directories that MUST contribute at least one scanned file. `tests/unit/build`
 * is called out because the walk really did skip it (the bare name `build` was
 * treated as a build output); a miss here means the walk regressed again.
 */
const REQUIRED_SCAN_DIRS = [
	join('tests', 'smoke'),
	join('tests', 'unit', 'build'),
	join('tests', 'integration'),
] as const;

/** True for lines that are entirely a comment (`//`, `/*`, or a `*` continuation). */
function isCommentLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith('//') ||
		trimmed.startsWith('*') ||
		trimmed.startsWith('/*')
	);
}

/** Recursively collects absolute paths of `*.test.ts` files under `dir`. */
function collectTestFiles(dir: string, out: string[]): void {
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // Root does not exist in this checkout — nothing to scan.
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (SKIP_ROOT_PATHS.has(full)) continue;
			collectTestFiles(full, out);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith('.test.ts')) {
			out.push(full);
		}
	}
}

/** Returns non-comment lines of `source`. */
function codeLinesOf(source: string): string[] {
	return source.split('\n').filter((line) => !isCommentLine(line));
}

/**
 * Resolves a relative import specifier to an existing `.ts` file, or undefined.
 * Handles the repo's `.js`-suffixed ESM specifiers and extensionless imports.
 */
function resolveRelativeImport(
	fromFile: string,
	specifier: string,
): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = base.endsWith('.js')
		? [`${base.slice(0, -3)}.ts`]
		: [`${base}.ts`, join(base, 'index.ts')];
	return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Splits a module into `exported binding name → the code lines of its body`.
 * Everything OUTSIDE an exported binding — the module's own import statements
 * above all — is dropped. That closes the helper-credit loophole:
 * `tests/helpers/test-isolation.ts` merely *re-imports* `createIsolatedTestEnv`,
 * so a file importing `captureFileBytes` from it used to inherit
 * "env-isolation" it never wired.
 */
function exportBlocks(source: string): Map<string, string[]> {
	const blocks = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of codeLinesOf(source)) {
		const declared = EXPORT_DECL_RE.exec(line);
		if (declared?.[1] !== undefined) {
			// Declaration line EXCLUDED: `export function createIsolatedTestEnv(`
			// otherwise matches ENV_ISOLATION_RE (which requires a CALL), so a
			// bare unused import would earn credit. See ...-audit-credit.test.ts.
			current = [];
			blocks.set(declared[1], current);
			continue;
		}
		// A column-0 declaration or `export …` re-export ends the previous body.
		if (
			line.length > 0 &&
			!/^\s/.test(line) &&
			(TOP_LEVEL_DECL_RE.test(line) || line.startsWith('export'))
		) {
			current = undefined;
			continue;
		}
		current?.push(line);
	}
	return blocks;
}

/** Static imports of `source` that resolve into `tests/helpers/**`. */
function helperImportsOf(
	file: string,
	source: string,
): Array<{ module: string; names: string[] }> {
	const imports: Array<{ module: string; names: string[] }> = [];
	for (const match of source.matchAll(STATIC_IMPORT_RE)) {
		const clause = match[1];
		const specifier = match[2];
		if (clause === undefined || specifier === undefined) continue;
		const resolved = resolveRelativeImport(file, specifier);
		if (resolved === undefined) continue;
		if (!resolved.startsWith(HELPERS_ROOT + sep)) continue;
		const named = NAMED_IMPORT_LIST_RE.exec(clause)?.[1] ?? '';
		const names = named
			.split(',')
			.map((entry) => (entry.split(/\s+as\s+/).pop() ?? '').trim())
			.filter((name) => /^[A-Za-z0-9_$]+$/.test(name));
		if (names.length > 0) imports.push({ module: resolved, names });
	}
	return imports;
}

/**
 * Collects the code of the `tests/helpers/**` bindings a file ACTUALLY imports,
 * up to {@link MAX_HELPER_DEPTH} hops.
 *
 * Shared setup factored into a helper still protects its importers — that is
 * why `tests/helpers/index-commands-shared.ts` legitimately carries the guards
 * for the three `index-commands*` files. But credit is scoped to the imported
 * binding's own body, so it is earned only when that binding really invokes the
 * protection. At depth > 1 a binding is followed only if the parent's body
 * references it, so a transitive hop cannot re-open the loophole one level down.
 */
function helperCodeLines(
	file: string,
	source: string,
	usedIn: string | null,
	depth: number,
	visited: Set<string>,
): string[] {
	if (depth > MAX_HELPER_DEPTH) return [];

	const collected: string[] = [];
	for (const { module, names } of helperImportsOf(file, source)) {
		let helperSource: string;
		try {
			helperSource = readFileSync(module, 'utf-8');
		} catch {
			continue;
		}
		const blocks = exportBlocks(helperSource);
		const selected: string[] = [];
		for (const name of names) {
			if (usedIn !== null && !new RegExp(`\\b${name}\\b`).test(usedIn))
				continue;
			const key = `${module}::${name}`;
			if (visited.has(key)) continue;
			visited.add(key);
			selected.push(...(blocks.get(name) ?? []));
		}
		if (selected.length === 0) continue;
		collected.push(...selected);
		collected.push(
			...helperCodeLines(
				module,
				helperSource,
				selected.join('\n'),
				depth + 1,
				visited,
			),
		);
	}
	return collected;
}

/**
 * True when the file loads the plugin entry — `src/index.ts` by specifier, or
 * the built bundle by path. Without this gate the identifier-agnostic
 * {@link BOOT_CALL_RE} would flag any unrelated `.server(` call.
 */
function referencesPluginEntry(file: string, code: string): boolean {
	if (BUILT_ENTRY_RE.test(code)) return true;
	for (const match of code.matchAll(MODULE_SPECIFIER_RE)) {
		const specifier = match[1];
		if (specifier === undefined || !specifier.startsWith('.')) continue;
		if (resolveRelativeImport(file, specifier) === PLUGIN_SRC_ENTRY)
			return true;
	}
	return false;
}

interface ScannedFile {
	/** Repo-relative path, POSIX-ish (whatever `relative` yields on this platform). */
	readonly path: string;
	/** True if a non-comment line boots the plugin. */
	readonly bootsServer: boolean;
	/** Which protections were detected. */
	readonly protections: readonly string[];
	/** True if the file carries the explicit exemption marker. */
	readonly exempt: boolean;
}

function scanFile(absolutePath: string): ScannedFile {
	const source = readFileSync(absolutePath, 'utf-8');
	const codeLines = codeLinesOf(source);

	// Boot detection reads the test file ALONE — a helper that merely mentions
	// booting must not make an inert file look like a boot site.
	const ownCode = codeLines.join('\n');
	const bootsServer =
		codeLines.some((line) => BOOT_CALL_RE.test(line)) &&
		referencesPluginEntry(absolutePath, ownCode);

	// Protection detection additionally reads the `tests/helpers/**` BINDINGS the
	// file imports, since shared setup is the repo's convention for these guards.
	const code = [
		ownCode,
		...helperCodeLines(absolutePath, source, null, 1, new Set<string>()),
	].join('\n');

	const protections: string[] = [];
	if (ENV_ISOLATION_RE.test(code)) protections.push('env-isolation');
	if (SCHEDULER_STUB_RE.test(code)) protections.push('scheduler-stub');
	if (
		PROJECT_CONFIG_NAME_RE.test(code) &&
		PROJECT_CONFIG_DIR_RE.test(code) &&
		WRITE_CALL_RE.test(code)
	) {
		protections.push('project-config-written');
	}

	return {
		path: relative(REPO_ROOT, absolutePath),
		bootsServer,
		protections,
		// The marker is intentionally read from the FULL source: it lives in a
		// comment by construction.
		exempt: EXEMPT_RE.test(source),
	};
}

/** All `*.test.ts` files under the scan roots, excluding this audit itself. */
function scanSuite(): ScannedFile[] {
	const files: string[] = [];
	for (const root of SCAN_ROOTS) {
		collectTestFiles(join(REPO_ROOT, root), files);
	}
	const selfPath = resolve(__filename);
	return files
		.filter((file) => resolve(file) !== selfPath)
		.sort()
		.map(scanFile);
}

const HAZARD_SUMMARY = [
	"config-doctor's getUserConfigDir() (src/services/config-doctor.ts:582-584)",
	'ignores the `directory` param. With no project config under the temp',
	'directory, applySafeAutoFixes (src/services/config-doctor.ts:1884-1896) and',
	'createConfigBackup (config-doctor.ts:710-720) fall back to the DEVELOPER’S',
	'REAL ~/.config/opencode/opencode-swarm.json and REWRITE it.',
].join('\n  ');

const REMEDY_SUMMARY = [
	'Add ONE of these to the offending file (any one is sufficient):',
	'  1. createIsolatedTestEnv() from tests/helpers/isolated-test-env.ts, wired',
	'     into beforeEach/afterEach (redirects XDG_CONFIG_HOME).',
	'  2. overrideIndexInternalsForTest({ schedulePostResolutionTasks: () => {} })',
	'     — config-doctor is only reachable from that queue.',
	'  3. Write a .opencode/opencode-swarm.json into the temp `directory` before',
	'     booting, so config-doctor’s project-first branch wins.',
	'Or, if none apply, add a reasoned marker comment:',
	'  // server-boot-isolation-audit: exempt — <reason>',
].join('\n');

describe('server-boot isolation audit (issue #2010 AC4)', () => {
	const scanned = scanSuite();
	const bootFiles = scanned.filter((file) => file.bootsServer);

	it('scanner finds a plausible number of plugin-boot test files', () => {
		// Defensive self-test, mirroring the guard rationale in
		// tests/unit/agents/no-hardcoded-tool-lists.test.ts: if the boot detector,
		// the directory walk, or the comment filter breaks, this audit would pass
		// vacuously. Fail loudly instead.
		//
		// The assertion is on BOOT files, not on `scanned`: the walk sees ~2400
		// `*.test.ts` files, so a bound on `scanned.length` is trivially true and
		// would let a broken boot detector audit nothing at all.
		expect(bootFiles.length).toBeGreaterThanOrEqual(MIN_EXPECTED_BOOT_FILES);
	});

	it('walk reaches every directory known to contain a plugin boot', () => {
		const missing = REQUIRED_SCAN_DIRS.filter(
			(dir) => !scanned.some((file) => file.path.startsWith(dir + sep)),
		);
		expect(missing).toEqual([]);
	});

	it('every plugin-boot test file isolates global config state', () => {
		const offenders = bootFiles.filter(
			(file) => !file.exempt && file.protections.length === 0,
		);

		if (offenders.length > 0) {
			const list = offenders.map((file) => `  - ${file.path}`).join('\n');
			throw new Error(
				`${offenders.length} test file(s) boot the OpenCode plugin without any ` +
					`global-config isolation:\n${list}\n\n` +
					`HAZARD:\n  ${HAZARD_SUMMARY}\n\n${REMEDY_SUMMARY}`,
			);
		}

		expect(offenders).toEqual([]);
	});

	it('every exemption marker is attached to a file that actually boots', () => {
		// A stale marker on a file that no longer boots is dead configuration —
		// it would silently pre-approve a future boot added to that file.
		const staleExemptions = scanned.filter(
			(file) => file.exempt && !file.bootsServer,
		);
		expect(staleExemptions.map((file) => file.path)).toEqual([]);
	});
});
