import fs from 'node:fs';
import path from 'node:path';

export interface TestImpactResult {
	impactedTests: string[];
	unrelatedTests: string[];
	untestedFiles: string[];
	impactMap: Record<string, string[]>;
}

const IMPORT_REGEX_ES = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

function isCacheStale(
	impactMap: Record<string, string[]>,
	generatedAtMs: number,
): boolean {
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

function findTestFilesSync(cwd: string): string[] {
	const testFiles: string[] = [];
	const skipDirs = new Set([
		'node_modules',
		'dist',
		'.git',
		'.swarm',
		'.cache',
	]);

	function walk(dir: string, visitedInodes: Set<number>): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // permission denied, skip
		}

		// Check for symlink cycle using inode
		let dirInode: number;
		try {
			dirInode = fs.statSync(dir).ino;
		} catch {
			return; // can't stat, skip
		}
		// On Windows, ino is typically 0 for all files - skip cycle check
		if (dirInode !== 0) {
			if (visitedInodes.has(dirInode)) {
				return; // symlink cycle detected, skip
			}
			visitedInodes.add(dirInode);
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!skipDirs.has(entry.name)) {
					walk(path.join(dir, entry.name), visitedInodes);
				}
			} else if (entry.isFile()) {
				const name = entry.name;
				if (
					/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name) ||
					(dir.includes('__tests__') && /\.(ts|tsx|js|jsx)$/.test(name))
				) {
					testFiles.push(normalizePath(path.join(dir, entry.name)));
				}
			}
		}
	}

	walk(cwd, new Set<number>());
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

async function buildImpactMapInternal(
	cwd: string,
): Promise<Record<string, string[]>> {
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

		const imports = extractImports(content);
		const testDir = path.dirname(testFile);

		for (const importPath of imports) {
			const resolvedSource = resolveRelativeImport(testDir, importPath);
			if (resolvedSource === null) {
				// Skip non-relative imports (e.g., node_modules)
				continue;
			}

			if (!impactMap[resolvedSource]) {
				impactMap[resolvedSource] = [];
			}

			if (!impactMap[resolvedSource].includes(testFile)) {
				impactMap[resolvedSource].push(testFile);
			}
		}
	}

	return impactMap;
}

export const _internals: {
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
} = {
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
} as const;

export async function buildImpactMap(
	cwd: string,
): Promise<Record<string, string[]>> {
	const impactMap = await _internals.buildImpactMapInternal(cwd);
	await _internals.saveImpactMap(cwd, impactMap);
	return impactMap;
}

export async function loadImpactMap(
	cwd: string,
): Promise<Record<string, string[]>> {
	const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');

	if (fs.existsSync(cachePath)) {
		try {
			const content = fs.readFileSync(cachePath, 'utf-8');
			const data = JSON.parse(content);
			const map = data.map as Record<string, string[]>;
			const generatedAt = new Date(data.generatedAt).getTime();

			// Check if any source file is newer than cache
			if (!_internals.isCacheStale(map, generatedAt)) {
				return map;
			}
			// Cache is stale, fall through to rebuild
		} catch {
			// Cache corrupted or unreadable, rebuild
		}
	}

	return _internals.buildImpactMap(cwd);
}

async function saveImpactMap(
	cwd: string,
	impactMap: Record<string, string[]>,
): Promise<void> {
	const cacheDir = path.join(cwd, '.swarm', 'cache');
	const cachePath = path.join(cacheDir, 'impact-map.json');

	// Create directory if it doesn't exist
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}

	const data = {
		generatedAt: new Date().toISOString(),
		fileCount: Object.keys(impactMap).length,
		map: impactMap,
	};

	fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function analyzeImpact(
	changedFiles: string[],
	cwd: string,
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

	const impactMap = await _internals.loadImpactMap(cwd);

	const impactedTestsSet = new Set<string>();
	const untestedFiles: string[] = [];

	for (const changedFile of validFiles) {
		const normalizedChanged = normalizePath(path.resolve(changedFile));

		const tests = impactMap[normalizedChanged];
		if (tests && tests.length > 0) {
			for (const test of tests) {
				impactedTestsSet.add(test);
			}
		} else {
			// Check with different path variations
			let found = false;
			for (const [sourcePath, tests] of Object.entries(impactMap)) {
				if (
					sourcePath.endsWith(changedFile) ||
					changedFile.endsWith(sourcePath)
				) {
					for (const test of tests) {
						impactedTestsSet.add(test);
					}
					found = true;
					break;
				}
			}
			if (!found) {
				untestedFiles.push(changedFile);
			}
		}
	}

	const impactedTests = [...impactedTestsSet];

	// Compute unrelated tests (all tests in impact map minus impacted tests)
	const allTestFiles = new Set<string>();
	for (const tests of Object.values(impactMap)) {
		for (const test of tests) {
			allTestFiles.add(test);
		}
	}
	const unrelatedTests = [...allTestFiles].filter(
		(t) => !impactedTestsSet.has(t),
	);

	return {
		impactedTests,
		unrelatedTests,
		untestedFiles,
		impactMap,
	};
}
