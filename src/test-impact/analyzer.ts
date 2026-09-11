import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateProjectRoot } from '../evidence/manager.js';
import { _internals as goInternals } from '../lang/backends/go';
import { _internals as pythonInternals } from '../lang/backends/python';
import { IMPACT_CACHE_VERSION } from './constants';

export interface TestImpactResult {
	impactedTests: string[];
	unrelatedTests: string[];
	untestedFiles: string[];
	impactMap: Record<string, string[]>;
	budgetExceeded?: boolean;
}

export type ImpactCacheStatus =
	| 'fresh'
	| 'missing'
	| 'corrupt'
	| 'legacy'
	| 'stale'
	| 'rebuilt_missing'
	| 'rebuilt_corrupt'
	| 'rebuilt_legacy'
	| 'rebuilt_stale'
	| 'stale_unverified'
	| 'missing_unverified'
	| 'corrupt_unverified'
	| 'legacy_unverified'
	| 'fresh_unverified';

export interface ImpactCacheInspection {
	status: ImpactCacheStatus;
	cachePath: string;
}

interface TestFileIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

interface ImpactCacheEnvelope {
	version: number;
	generatedAt: string;
	fileCount: number;
	map: Record<string, string[]>;
	testFiles: TestFileIdentity[];
}

// TS/JS imports (multi-line aware — matches across newlines).
const IMPORT_REGEX_ES = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

// Per-language extension sets. The impact analyzer walks tests of every
// supported language, then routes each file through the right backend's
// `extractImports` based on extension.
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PYTHON_EXTENSIONS = new Set(['.py']);
const GO_EXTENSIONS = new Set(['.go']);

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// Rank helper: count matching directory/path segments from the tail.
function sharedTrailingSegments(a: string, b: string): number {
	const aParts = normalizePath(a).split('/').filter(Boolean);
	const bParts = normalizePath(b).split('/').filter(Boolean);
	let i = aParts.length - 1;
	let j = bParts.length - 1;
	let shared = 0;
	while (i >= 0 && j >= 0 && aParts[i] === bParts[j]) {
		shared++;
		i--;
		j--;
	}
	return shared;
}

function digestContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function buildTestFileManifest(cwd: string): TestFileIdentity[] {
	const manifest: TestFileIdentity[] = [];
	for (const testFile of findTestFilesSync(cwd).sort()) {
		try {
			const stat = fs.statSync(testFile);
			const content = fs.readFileSync(testFile, 'utf-8');
			manifest.push({
				path: normalizePath(testFile),
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				digest: digestContent(content),
			});
		} catch {
			// A concurrently deleted or unreadable test file makes the identity
			// unverifiable; the next load will rebuild safely.
		}
	}
	return manifest;
}

function testManifestChanged(cached: TestFileIdentity[], cwd: string): boolean {
	const currentFiles = findTestFilesSync(cwd).map(normalizePath).sort();
	const cachedFiles = cached.map((entry) => normalizePath(entry.path)).sort();
	if (
		currentFiles.length !== cachedFiles.length ||
		currentFiles.some((file, index) => file !== cachedFiles[index])
	)
		return true;

	const cachedByPath = new Map(
		cached.map((entry) => [normalizePath(entry.path), entry]),
	);
	for (const file of currentFiles) {
		const previous = cachedByPath.get(file);
		if (!previous) return true;
		try {
			const stat = fs.statSync(file);
			const content = fs.readFileSync(file, 'utf-8');
			if (
				stat.size !== previous.size ||
				stat.mtimeMs !== previous.mtimeMs ||
				digestContent(content) !== previous.digest
			)
				return true;
		} catch {
			return true;
		}
	}
	return false;
}

function isCacheStale(
	impactMap: Record<string, string[]>,
	generatedAtMs: number,
	testFiles?: TestFileIdentity[],
	cwd?: string,
): boolean {
	if (testFiles && cwd && testManifestChanged(testFiles, cwd)) return true;
	for (const sourcePath of Object.keys(impactMap)) {
		try {
			const stat = fs.statSync(sourcePath);
			if (stat.mtimeMs > generatedAtMs) {
				return true; // Source file is newer than cache
			}
		} catch {
			// Source file deleted — cache is stale
			return true;
		}
	}
	return false;
}

function resolveRelativeImport(
	fromDir: string,
	importPath: string,
): string | null {
	if (!importPath.startsWith('.')) {
		return null;
	}

	const resolved = path.resolve(fromDir, importPath);

	// If the import already has an extension, try as-is first
	if (path.extname(resolved)) {
		if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
			return normalizePath(resolved);
		}
	} else {
		// Try adding extensions
		for (const ext of EXTENSIONS_TO_TRY) {
			const withExt = resolved + ext;
			if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
				return normalizePath(withExt);
			}
		}
	}

	return null;
}

/**
 * Resolve a Python relative import (`from . import x` / `.foo` / `..bar.baz`)
 * to an absolute file path. Non-relative imports return null — they would
 * require sys.path / pyproject resolution that the analyzer does not perform.
 *
 * `module` is the captured dotted name from the `from` clause; values like
 * `.foo`, `..bar.baz`, or `.` (current package).
 */
function resolvePythonImport(fromDir: string, module: string): string | null {
	if (!module.startsWith('.')) return null;
	// Count leading dots — each one walks one directory up.
	const leadingDots = module.match(/^\.+/)?.[0].length ?? 0;
	let baseDir = fromDir;
	for (let i = 1; i < leadingDots; i++) {
		baseDir = path.dirname(baseDir);
	}
	const rest = module.slice(leadingDots);
	if (rest.length === 0) {
		// `from . import x` — caller passes module="."; the actual file is
		// __init__.py in baseDir.
		const initPath = path.join(baseDir, '__init__.py');
		if (fs.existsSync(initPath) && fs.statSync(initPath).isFile()) {
			return normalizePath(initPath);
		}
		return null;
	}
	const subpath = rest.replace(/\./g, path.sep);
	const candidates = [
		`${path.join(baseDir, subpath)}.py`,
		path.join(baseDir, subpath, '__init__.py'),
	];
	for (const c of candidates) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) return normalizePath(c);
	}
	return null;
}

/**
 * Find the `module <path>` line in the nearest go.mod walking up from
 * `fromDir`. Returns `{ moduleRoot, modulePath }` or null when no go.mod
 * is found. Bounded by a 16-level upward walk so an analyzer invocation
 * cannot walk past the filesystem root on pathological inputs.
 *
 * Result is memoized per moduleRoot for the lifetime of an analyzer pass
 * (callers within `buildImpactMapInternal` re-resolve frequently).
 */
const goModuleCache = new Map<
	string,
	{ moduleRoot: string; modulePath: string } | null
>();
function findGoModule(
	fromDir: string,
): { moduleRoot: string; modulePath: string } | null {
	const resolved = path.resolve(fromDir);
	let cur = resolved;
	const walked: string[] = [];
	for (let i = 0; i < 16; i++) {
		const cached = goModuleCache.get(cur);
		if (cached !== undefined) {
			// Backfill walked dirs with this result for O(1) repeat lookups.
			for (const d of walked) goModuleCache.set(d, cached);
			return cached;
		}
		walked.push(cur);
		try {
			const goMod = path.join(cur, 'go.mod');
			const content = fs.readFileSync(goMod, 'utf-8');
			// Strip optional surrounding quotes and trailing `// comment`.
			// Both forms are valid: `module example.com/x` and
			// `module "example.com/x" // some note`. Without the strip the
			// modulePath captured ends up as `"example.com/x"` and never
			// matches imports.
			const moduleMatch = content.match(
				/^\s*module\s+"?([^"\s/]+(?:\/[^"\s]+)*)"?/m,
			);
			if (moduleMatch) {
				const result = { moduleRoot: cur, modulePath: moduleMatch[1] };
				for (const d of walked) goModuleCache.set(d, result);
				return result;
			}
		} catch {
			// no go.mod here — walk up
		}
		// Stop at .git boundary (project root). Prevents leaking past the
		// project into /tmp/go.mod or /home/user/go.mod from other tests.
		// Adversarial review D1.
		try {
			fs.accessSync(path.join(cur, '.git'));
			break;
		} catch {
			// no .git here, continue walking
		}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	for (const d of walked) goModuleCache.set(d, null);
	return null;
}

/**
 * Resolve a Go import to local source files. Handles three cases:
 *
 *   1. Relative: `./pkg/foo` or `../pkg/foo` — resolved against fromDir.
 *   2. Module path: `github.com/myorg/myrepo/pkg/foo` — when the import
 *      starts with the local module path declared in go.mod, the remainder
 *      maps to a directory under the module root. PR #825 review P1 #4
 *      flagged that this resolution was missing; module imports are the
 *      DOMINANT form in real Go projects.
 *   3. Stdlib / external (no slash, or unrecognized prefix): returns [].
 *
 * In all matching cases, walks the target directory and returns ALL .go
 * files (excluding *_test.go), treating the package as a unit.
 */
function resolveGoImport(fromDir: string, importPath: string): string[] {
	let dir: string | null = null;

	if (importPath.startsWith('.')) {
		dir = path.resolve(fromDir, importPath);
	} else {
		const mod = findGoModule(fromDir);
		if (
			mod &&
			(importPath === mod.modulePath ||
				importPath.startsWith(`${mod.modulePath}/`))
		) {
			const subpath = importPath.slice(mod.modulePath.length);
			dir = path.join(mod.moduleRoot, subpath);
		}
	}

	if (dir === null) return [];
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
			.map((f) => normalizePath(path.join(dir, f)));
	} catch {
		return [];
	}
}

/**
 * Test-only: clear the go-module memoization cache. Production code
 * should never need this — the cache is per-call-graph scoped, but tests
 * that reuse the same tempDir benefit from a fresh start.
 */
function _clearGoModuleCache(): void {
	goModuleCache.clear();
}

function findTestFilesSync(cwd: string): string[] {
	const testFiles: string[] = [];
	const skipDirs = new Set([
		'node_modules',
		'dist',
		'.git',
		'.swarm',
		'.cache',
	]);

	function walk(dir: string, visitedRealPaths: Set<string>): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // permission denied, skip
		}

		// Use the canonical path as the directory identity. Bun on Windows may
		// report colliding non-zero inode values for distinct directories, which
		// previously caused nested test trees to be mistaken for symlink cycles.
		// Normalize case on Windows because its default filesystems are
		// case-insensitive and a junction may expose the same target with
		// different casing.
		let realPath: string;
		try {
			realPath = normalizePath(fs.realpathSync.native(dir));
		} catch {
			return; // can't resolve safely, skip
		}
		const directoryKey =
			process.platform === 'win32' ? realPath.toLowerCase() : realPath;
		if (visitedRealPaths.has(directoryKey)) {
			return; // symlink/junction cycle detected, skip
		}
		visitedRealPaths.add(directoryKey);

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!skipDirs.has(entry.name)) {
					walk(path.join(dir, entry.name), visitedRealPaths);
				}
			} else if (entry.isFile()) {
				const name = entry.name;
				const isTsTest =
					/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name) ||
					(dir.includes('__tests__') && /\.(ts|tsx|js|jsx)$/.test(name));
				// Python: `test_*.py` (pytest convention) and `*_test.py` (PEP 8
				// alternative). Also files in a top-level `tests/` directory that
				// have a .py extension.
				const isPyTest =
					/^test_.+\.py$/.test(name) ||
					/.+_test\.py$/.test(name) ||
					(dir.includes(`${path.sep}tests${path.sep}`) && name.endsWith('.py'));
				// Go: convention is `*_test.go` (enforced by `go test`).
				const isGoTest = /.+_test\.go$/.test(name);
				if (isTsTest || isPyTest || isGoTest) {
					testFiles.push(normalizePath(path.join(dir, entry.name)));
				}
			}
		}
	}

	walk(cwd, new Set<string>());
	return [...new Set(testFiles)];
}

function extractImports(content: string): string[] {
	function execRegex(regex: RegExp, content: string): string[] {
		const results: string[] = [];
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: regex exec requires assignment in while condition
		while ((match = regex.exec(content)) !== null) {
			results.push(match[1]);
		}
		return results;
	}

	return [
		...execRegex(IMPORT_REGEX_ES, content),
		...execRegex(IMPORT_REGEX_REQUIRE, content),
		...execRegex(IMPORT_REGEX_REEXPORT, content),
	];
}

/**
 * Per-file impact contribution. Inspects the test file's extension, picks
 * the right import-extraction regex (TS via legacy regex, Python via
 * `lang/backends/python._internals.extractImports`, Go via
 * `lang/backends/go._internals.extractImports`), resolves each import to a
 * source-file path via the matching language-specific resolver, and
 * appends the test file to that source's impact list.
 *
 * Why route through the backend `_internals` rather than `pickBackend`?
 * The impact analyzer runs on individual files inside a workspace; the
 * dispatch resolver picks ONE backend per directory tree. For
 * cross-language repos (e.g. a Go service with a TS web client) we need
 * file-level routing, which the file extension already gives us.
 */
function addImpactEdgesForTestFile(
	testFile: string,
	content: string,
	impactMap: Record<string, string[]>,
): void {
	const ext = path.extname(testFile).toLowerCase();
	const testDir = path.dirname(testFile);

	function addEdge(source: string): void {
		if (!impactMap[source]) impactMap[source] = [];
		if (!impactMap[source].includes(testFile)) {
			impactMap[source].push(testFile);
		}
	}

	if (TS_EXTENSIONS.has(ext)) {
		const imports = extractImports(content);
		for (const importPath of imports) {
			const resolved = resolveRelativeImport(testDir, importPath);
			if (resolved !== null) addEdge(resolved);
		}
		return;
	}

	if (PYTHON_EXTENSIONS.has(ext)) {
		const modules = pythonInternals.extractImports(testFile, content);
		for (const mod of modules) {
			const resolved = resolvePythonImport(testDir, mod);
			if (resolved !== null) addEdge(resolved);
		}
		return;
	}

	if (GO_EXTENSIONS.has(ext)) {
		const imports = goInternals.extractImports(testFile, content);
		for (const importPath of imports) {
			const sourceFiles = resolveGoImport(testDir, importPath);
			for (const source of sourceFiles) addEdge(source);
		}
		return;
	}

	// Unknown extension — no-op. The walker shouldn't surface these, but
	// staying defensive keeps the analyzer stable when new test file types
	// land in the walker before this dispatch is updated.
}

async function buildImpactMapInternal(
	cwd: string,
): Promise<Record<string, string[]>> {
	_clearGoModuleCache();
	const testFiles = findTestFilesSync(cwd);
	const impactMap: Record<string, string[]> = {};

	for (const testFile of testFiles) {
		let content: string;
		try {
			content = fs.readFileSync(testFile, 'utf-8');
		} catch {
			// Skip files that can't be read
			continue;
		}

		// Skip binary files (null bytes in first 8KB)
		if (content.substring(0, 8192).includes('\0')) {
			continue;
		}

		addImpactEdgesForTestFile(testFile, content, impactMap);
	}

	return impactMap;
}

function isValidImpactMap(value: unknown): value is Record<string, string[]> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.values(value).every(
			(v) => Array.isArray(v) && v.every((item) => typeof item === 'string'),
		)
	);
}

function unverifiedStatus(status: ImpactCacheStatus): ImpactCacheStatus {
	if (status === 'fresh' || status === 'stale') return 'fresh_unverified';
	if (status === 'missing') return 'missing_unverified';
	if (status === 'corrupt') return 'corrupt_unverified';
	if (status === 'legacy') return 'legacy_unverified';
	return status;
}

function readImpactCache(
	cwd: string,
	verify = true,
): {
	envelope: ImpactCacheEnvelope | null;
	status: ImpactCacheStatus;
} {
	const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');
	if (!fs.existsSync(cachePath)) {
		return {
			envelope: null,
			status: verify ? 'missing' : 'missing_unverified',
		};
	}
	try {
		const data = JSON.parse(
			fs.readFileSync(cachePath, 'utf-8'),
		) as Partial<ImpactCacheEnvelope>;
		if (
			data.version !== IMPACT_CACHE_VERSION ||
			typeof data.generatedAt !== 'string' ||
			!isValidImpactMap(data.map) ||
			!Array.isArray(data.testFiles) ||
			!data.testFiles.every(
				(entry) =>
					typeof entry === 'object' &&
					entry !== null &&
					typeof entry.path === 'string' &&
					typeof entry.size === 'number' &&
					typeof entry.mtimeMs === 'number' &&
					typeof entry.digest === 'string',
			)
		) {
			const status: ImpactCacheStatus =
				data.map !== undefined &&
				(data.version === undefined ||
					(typeof data.version === 'number' &&
						data.version < IMPACT_CACHE_VERSION))
					? 'legacy'
					: 'corrupt';
			return {
				envelope: null,
				status: verify ? status : unverifiedStatus(status),
			};
		}
		const envelope = data as ImpactCacheEnvelope;
		const generatedAtMs = new Date(envelope.generatedAt).getTime();
		if (!Number.isFinite(generatedAtMs)) {
			return {
				envelope: null,
				status: verify ? 'corrupt' : 'corrupt_unverified',
			};
		}
		if (!verify) {
			return { envelope, status: 'fresh_unverified' };
		}
		if (
			_internals.isCacheStale(
				envelope.map,
				generatedAtMs,
				envelope.testFiles,
				cwd,
			)
		) {
			return { envelope, status: 'stale' };
		}
		return { envelope, status: 'fresh' };
	} catch {
		return {
			envelope: null,
			status: verify ? 'corrupt' : 'corrupt_unverified',
		};
	}
}

export function getImpactCacheStatus(
	cwd: string,
	options?: { verify?: boolean },
): ImpactCacheInspection {
	const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');
	return {
		status: readImpactCache(cwd, options?.verify ?? true).status,
		cachePath,
	};
}

export const _internals: {
	validateProjectRoot: typeof validateProjectRoot;
	normalizePath: typeof normalizePath;
	isCacheStale: typeof isCacheStale;
	resolveRelativeImport: typeof resolveRelativeImport;
	findTestFilesSync: typeof findTestFilesSync;
	extractImports: typeof extractImports;
	buildImpactMapInternal: typeof buildImpactMapInternal;
	buildImpactMap: typeof buildImpactMap;
	loadImpactMap: typeof loadImpactMap;
	saveImpactMap: typeof saveImpactMap;
	analyzeImpact: typeof analyzeImpact;
	getImpactCacheStatus: typeof getImpactCacheStatus;
	_clearGoModuleCache: typeof _clearGoModuleCache;
} = {
	validateProjectRoot,
	normalizePath,
	isCacheStale,
	resolveRelativeImport,
	findTestFilesSync,
	extractImports,
	buildImpactMapInternal,
	buildImpactMap,
	loadImpactMap,
	saveImpactMap,
	analyzeImpact,
	getImpactCacheStatus,
	_clearGoModuleCache,
} as const;

export async function buildImpactMap(
	cwd: string,
): Promise<Record<string, string[]>> {
	const impactMap = await _internals.buildImpactMapInternal(cwd);
	await _internals.saveImpactMap(cwd, impactMap);
	return impactMap;
}

export interface LoadImpactMapOptions {
	/** If true and cache is stale, return the stale map instead of rebuilding.
	 *  Use for estimation-only reads where slight staleness is acceptable. */
	skipRebuild?: boolean;
}

export async function loadImpactMap(
	cwd: string,
	options?: LoadImpactMapOptions,
): Promise<Record<string, string[]>> {
	const inspection = readImpactCache(cwd, !options?.skipRebuild);
	if (inspection.envelope) {
		if (inspection.status === 'fresh' || options?.skipRebuild) {
			return inspection.envelope.map;
		}
	}

	if (options?.skipRebuild) return {};
	return _internals.buildImpactMap(cwd);
}

async function saveImpactMap(
	cwd: string,
	impactMap: Record<string, string[]>,
): Promise<void> {
	// Guard: reject if cwd is not an absolute path
	if (!path.isAbsolute(cwd)) {
		throw new Error(
			`saveImpactMap requires an absolute project root path, got: "${cwd}"`,
		);
	}

	// Guard: reject writes to subdirectories of projects that already have .swarm/
	_internals.validateProjectRoot(cwd);

	const cacheDir = path.join(cwd, '.swarm', 'cache');
	const cachePath = path.join(cacheDir, 'impact-map.json');

	// Create directory if it doesn't exist
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}

	const data: ImpactCacheEnvelope = {
		version: IMPACT_CACHE_VERSION,
		generatedAt: new Date().toISOString(),
		fileCount: Object.keys(impactMap).length,
		map: impactMap,
		testFiles: buildTestFileManifest(cwd),
	};

	fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function analyzeImpact(
	changedFiles: string[],
	cwd: string,
	budget?: number,
	impactMapOverride?: Record<string, string[]>,
): Promise<TestImpactResult> {
	// Validate input
	if (!Array.isArray(changedFiles)) {
		const emptyMap: Record<string, string[]> = {};
		return {
			impactedTests: [],
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: emptyMap,
		};
	}

	// Filter to valid string entries only
	const validFiles = changedFiles.filter(
		(f): f is string =>
			typeof f === 'string' && f.length > 0 && !f.includes('\0'),
	);

	const impactMap = impactMapOverride ?? (await _internals.loadImpactMap(cwd));

	const impactedTestsSet = new Set<string>();
	const impactedTestKeys = new Set<string>();
	const untestedFiles: string[] = [];
	let budgetExceeded = false;

	const testKey = (test: string): string => {
		const resolved = path.isAbsolute(test) ? test : path.resolve(cwd, test);
		const normalized = normalizePath(resolved);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	const addImpactedTest = (test: string): boolean => {
		const key = testKey(test);
		if (impactedTestKeys.has(key)) return true;
		if (budget !== undefined && impactedTestKeys.size >= budget) {
			budgetExceeded = true;
			return false;
		}
		impactedTestKeys.add(key);
		impactedTestsSet.add(test);
		return true;
	};

	for (const changedFile of validFiles) {
		const normalizedChanged = normalizePath(path.resolve(cwd, changedFile));

		const tests = impactMap[normalizedChanged];
		if (tests && tests.length > 0) {
			for (const test of tests) {
				addImpactedTest(test);
				if (budgetExceeded) break;
			}
			if (budgetExceeded) break;
		} else {
			// Check with different path variations
			const changedDir = normalizePath(path.dirname(normalizedChanged));
			const changedInputDir = normalizePath(path.dirname(changedFile));
			const suffixMatches = Object.entries(impactMap)
				.filter(([sourcePath]) => {
					return (
						sourcePath.endsWith(changedFile) ||
						changedFile.endsWith(sourcePath) ||
						sourcePath.endsWith(normalizedChanged) ||
						normalizedChanged.endsWith(sourcePath)
					);
				})
				.sort(([sourceA], [sourceB]) => {
					const sourceDirA = normalizePath(path.dirname(sourceA));
					const sourceDirB = normalizePath(path.dirname(sourceB));
					const exactA =
						sourceDirA === changedDir ||
						(changedInputDir !== '.' &&
							(sourceDirA === changedInputDir ||
								sourceDirA.endsWith(`/${changedInputDir}`)));
					const exactB =
						sourceDirB === changedDir ||
						(changedInputDir !== '.' &&
							(sourceDirB === changedInputDir ||
								sourceDirB.endsWith(`/${changedInputDir}`)));
					if (exactA !== exactB) return exactA ? -1 : 1;

					const sharedA = Math.max(
						sharedTrailingSegments(sourceDirA, changedDir),
						changedInputDir === '.'
							? 0
							: sharedTrailingSegments(sourceDirA, changedInputDir),
					);
					const sharedB = Math.max(
						sharedTrailingSegments(sourceDirB, changedDir),
						changedInputDir === '.'
							? 0
							: sharedTrailingSegments(sourceDirB, changedInputDir),
					);
					const nearestA = sharedA > 0;
					const nearestB = sharedB > 0;
					if (nearestA !== nearestB) return nearestA ? -1 : 1;
					if (sharedA !== sharedB) return sharedB - sharedA;
					return sourceA.localeCompare(sourceB);
				});
			// A file is "found" if any suffix-matching map entry exists, regardless of
			// whether budget allows all its tests to be collected.
			const found = suffixMatches.length > 0;
			for (const [, tests] of suffixMatches) {
				for (const test of tests) {
					addImpactedTest(test);
					if (budgetExceeded) break;
				}
				if (budgetExceeded) break;
			}
			if (budgetExceeded) break;
			if (!found) {
				untestedFiles.push(changedFile);
			}
		}
	}

	const impactedTests = [...impactedTestsSet];

	// Compute unrelated tests (all tests in impact map minus impacted tests)
	const allTestFiles = new Map<string, string>();
	for (const tests of Object.values(impactMap)) {
		for (const test of tests) {
			const key = testKey(test);
			if (!allTestFiles.has(key)) allTestFiles.set(key, test);
		}
	}
	const unrelatedTests = [...allTestFiles.entries()]
		.filter(([key]) => !impactedTestKeys.has(key))
		.map(([, test]) => test);

	return {
		impactedTests,
		unrelatedTests,
		untestedFiles,
		impactMap,
		budgetExceeded,
	};
}
