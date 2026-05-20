import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSwarmTool } from './create-tool';

// Note: Complex YAML constructs (multi-line strings, anchors) are out of scope for v6.5
// The YAML regex extraction is intentionally simple — document this limitation

// ============ Types ============
interface UndocumentedRoute {
	path: string;
	method: string;
	file: string;
	line: number;
}

interface PhantomRoute {
	path: string;
	methods: string[];
}

interface SchemaDriftResult {
	specFile: string;
	specPathCount: number;
	codeRouteCount: number;
	undocumented: UndocumentedRoute[];
	phantom: PhantomRoute[];
	undocumentedCount: number;
	phantomCount: number;
	consistent: boolean;
}

// ============ Constants ============
const SPEC_CANDIDATES = [
	'openapi.json',
	'openapi.yaml',
	'openapi.yml',
	'swagger.json',
	'swagger.yaml',
	'swagger.yml',
	'api/openapi.json',
	'api/openapi.yaml',
	'docs/openapi.json',
	'docs/openapi.yaml',
	'spec/openapi.json',
	'spec/openapi.yaml',
];

const SKIP_DIRS = [
	'node_modules',
	'dist',
	'build',
	'.git',
	'.swarm',
	'coverage',
	'__tests__',
];

const SKIP_EXTENSIONS = ['.test.', '.spec.'];
const MAX_SPEC_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.json', '.yaml', '.yml'];

// ============ Path Normalization ============
function normalizePath(p: string): string {
	return p
		.replace(/\/$/, '')
		.replace(/\{[^}]+\}/g, ':param')
		.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, ':param');
}

// ============ Spec File Discovery ============
function discoverSpecFile(cwd: string, specFileArg?: string): string | null {
	// If spec_file is provided, validate and use it
	if (specFileArg) {
		const resolvedPath = path.resolve(cwd, specFileArg);

		// Security check: ensure path resolves within cwd
		const normalizedCwd = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
		if (!resolvedPath.startsWith(normalizedCwd) && resolvedPath !== cwd) {
			throw new Error('Invalid spec_file: path traversal detected');
		}

		// Validate extension
		const ext = path.extname(resolvedPath).toLowerCase();
		if (!ALLOWED_EXTENSIONS.includes(ext)) {
			throw new Error(
				`Invalid spec_file: must end in .json, .yaml, or .yml, got ${ext}`,
			);
		}

		// Check file size
		const stats = fs.statSync(resolvedPath);
		if (stats.size > MAX_SPEC_SIZE) {
			throw new Error(
				`Invalid spec_file: file exceeds ${MAX_SPEC_SIZE / 1024 / 1024}MB limit`,
			);
		}

		if (!fs.existsSync(resolvedPath)) {
			throw new Error(`Spec file not found: ${resolvedPath}`);
		}

		return resolvedPath;
	}

	// Auto-detect: check candidates in order
	for (const candidate of SPEC_CANDIDATES) {
		const candidatePath = path.resolve(cwd, candidate);
		if (fs.existsSync(candidatePath)) {
			const stats = fs.statSync(candidatePath);
			if (stats.size <= MAX_SPEC_SIZE) {
				return candidatePath;
			}
		}
	}

	return null;
}

// ============ Spec Parsing ============
interface SpecPath {
	path: string;
	methods: string[];
}

function parseSpec(specFile: string): SpecPath[] {
	const content = fs.readFileSync(specFile, 'utf-8');
	const ext = path.extname(specFile).toLowerCase();

	if (ext === '.json') {
		return parseJsonSpec(content);
	}

	// YAML/yml - regex-based extraction
	// Note: This is intentionally simple and doesn't handle complex YAML constructs
	return parseYamlSpec(content);
}

function parseJsonSpec(content: string): SpecPath[] {
	let spec: { paths?: Record<string, unknown> };
	try {
		spec = JSON.parse(content);
	} catch {
		return [];
	}
	const paths: SpecPath[] = [];

	if (!spec.paths) {
		return paths;
	}

	for (const [pathKey, pathValue] of Object.entries(spec.paths)) {
		const methods: string[] = [];
		if (typeof pathValue === 'object' && pathValue !== null) {
			for (const method of [
				'get',
				'post',
				'put',
				'patch',
				'delete',
				'options',
				'head',
			]) {
				if (method in pathValue) {
					methods.push(method);
				}
			}
		}
		if (methods.length > 0) {
			paths.push({ path: pathKey, methods });
		}
	}

	return paths;
}

// Simple YAML extraction using regex
// Limitation: Does not handle multi-line strings, anchors, or complex YAML constructs
function parseYamlSpec(content: string): SpecPath[] {
	const paths: SpecPath[] = [];

	// Find paths section - look for "paths:" followed by indented entries
	const pathsMatch = content.match(/^paths:\s*$/m);
	if (!pathsMatch) {
		return paths;
	}

	// Extract all path entries matching pattern: space-space-slash-something-colon
	// This matches /endpoint: at the start of a line (2 spaces indent)
	const pathRegex = /^\s{2}(\/[^\s:]+):/gm;
	for (
		let match = pathRegex.exec(content);
		match !== null;
		match = pathRegex.exec(content)
	) {
		const pathKey = match[1];

		// Extract methods for this path - look for method names under this path
		// Methods are at 4 spaces indent (2 more than path)
		const methodRegex = /^\s{4}(get|post|put|patch|delete|options|head):/gm;
		const methods: string[] = [];
		// Find the section for this path (from this match to the next 2-space indent line)
		const pathStart = match.index;
		const nextPathMatch = content.substring(pathStart + 1).match(/^\s{2}\//m);
		const pathEnd =
			nextPathMatch && nextPathMatch.index !== undefined
				? pathStart + 1 + nextPathMatch.index
				: content.length;
		const pathSection = content.substring(pathStart, pathEnd);
		let methodMatch = methodRegex.exec(pathSection);

		while (methodMatch !== null) {
			methods.push(methodMatch[1]);
			methodMatch = methodRegex.exec(pathSection);
		}

		if (methods.length > 0) {
			paths.push({ path: pathKey, methods });
		}
	}

	return paths;
}

// ============ Route Extraction ============
interface CodeRoute {
	path: string;
	method: string;
	file: string;
	line: number;
}

function extractRoutes(cwd: string): CodeRoute[] {
	const routes: CodeRoute[] = [];

	// Recursive directory walk
	function walkDir(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// Skip directories we can't read
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			// Skip symbolic links to prevent traversal outside the project
			if (entry.isSymbolicLink()) {
				continue;
			}

			if (entry.isDirectory()) {
				// Skip excluded directories
				if (SKIP_DIRS.includes(entry.name)) {
					continue;
				}
				walkDir(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				const baseName = entry.name.toLowerCase();

				// Only process .ts, .js, .mjs files
				if (!['.ts', '.js', '.mjs'].includes(ext)) {
					continue;
				}

				// Skip test files
				if (SKIP_EXTENSIONS.some((skip) => baseName.includes(skip))) {
					continue;
				}

				// Extract routes from file
				const fileRoutes = extractRoutesFromFile(fullPath);
				routes.push(...fileRoutes);
			}
		}
	}

	walkDir(cwd);
	return routes;
}

function extractRoutesFromFile(filePath: string): CodeRoute[] {
	const routes: CodeRoute[] = [];
	const content = fs.readFileSync(filePath, 'utf-8');
	const lines = content.split(/\r?\n/);

	// Express/Fastify pattern: (app|router|server|express).(get|post|put|patch|delete|options|head)
	const expressRegex =
		/(?:app|router|server|express)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g;

	// Flask pattern: @(app|blueprint|bp).route
	const flaskRegex = /@(?:app|blueprint|bp)\.route\s*\(\s*['"]([^'"]+)['"]/g;

	// Track line numbers for Express/Fastify
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];
		let match = expressRegex.exec(line);

		// Reset regex lastIndex for each line
		expressRegex.lastIndex = 0;
		flaskRegex.lastIndex = 0;

		// Check Express/Fastify patterns
		while (match !== null) {
			const method = match[1].toLowerCase();
			const routePath = match[2];
			routes.push({
				path: routePath,
				method,
				file: filePath,
				line: lineNum + 1, // 1-indexed
			});
			match = expressRegex.exec(line);
		}

		// Check Flask patterns
		match = flaskRegex.exec(line);
		while (match !== null) {
			const routePath = match[1];
			// Flask defaults to GET, but we can't know all methods
			// Use 'get' as default since it's most common
			routes.push({
				path: routePath,
				method: 'get',
				file: filePath,
				line: lineNum + 1,
			});
			match = flaskRegex.exec(line);
		}
	}

	return routes;
}

// ============ Matching Algorithm ============
function findDrift(
	specPaths: SpecPath[],
	codeRoutes: CodeRoute[],
): { undocumented: UndocumentedRoute[]; phantom: PhantomRoute[] } {
	// Build normalized spec path map
	const specPathMap = new Map<string, string[]>();
	for (const sp of specPaths) {
		const normalized = normalizePath(sp.path);
		if (!specPathMap.has(normalized)) {
			specPathMap.set(normalized, []);
		}
		specPathMap.get(normalized)!.push(...sp.methods);
	}

	// Build normalized code route map
	const codeRouteMap = new Map<string, CodeRoute[]>();
	for (const cr of codeRoutes) {
		const normalized = normalizePath(cr.path);
		if (!codeRouteMap.has(normalized)) {
			codeRouteMap.set(normalized, []);
		}
		codeRouteMap.get(normalized)!.push(cr);
	}

	// Find undocumented: code routes whose normalized path is NOT in spec
	const undocumented: UndocumentedRoute[] = [];
	for (const [normalized, routes] of codeRouteMap) {
		if (!specPathMap.has(normalized)) {
			for (const route of routes) {
				undocumented.push({
					path: route.path,
					method: route.method,
					file: route.file,
					line: route.line,
				});
			}
		}
	}

	// Find phantom: spec paths whose normalized path is NOT in code
	const phantom: PhantomRoute[] = [];
	for (const [normalized, methods] of specPathMap) {
		if (!codeRouteMap.has(normalized)) {
			phantom.push({
				path: specPaths.find((sp) => normalizePath(sp.path) === normalized)!
					.path,
				methods,
			});
		}
	}

	return { undocumented, phantom };
}

// ============ Tool Definition ============
export const schema_drift: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Compare OpenAPI spec against actual route implementations to find drift. Detects undocumented routes in code and phantom routes in spec.',
	args: {
		spec_file: z
			.string()
			.optional()
			.describe(
				'Path to OpenAPI spec file. Auto-detected if omitted. Checks: openapi.json/yaml/yml, swagger.json/yaml/yml, api/openapi.json/yaml, docs/openapi.json/yaml, spec/openapi.json/yaml',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		const cwd = directory;

		// Validate args
		if (args !== null && typeof args !== 'object') {
			const error: SchemaDriftResult = {
				specFile: '',
				specPathCount: 0,
				codeRouteCount: 0,
				undocumented: [],
				phantom: [],
				undocumentedCount: 0,
				phantomCount: 0,
				consistent: false,
			};
			return JSON.stringify({ ...error, error: 'Invalid arguments' }, null, 2);
		}

		const argsObj = args as { spec_file?: string };

		try {
			// Discover or validate spec file
			const specFile = discoverSpecFile(cwd, argsObj.spec_file);

			if (!specFile) {
				const error: SchemaDriftResult = {
					specFile: '',
					specPathCount: 0,
					codeRouteCount: 0,
					undocumented: [],
					phantom: [],
					undocumentedCount: 0,
					phantomCount: 0,
					consistent: false,
				};
				return JSON.stringify(
					{
						...error,
						error:
							'No OpenAPI spec file found. Provide spec_file or place spec in one of: openapi.json/yaml/yml, swagger.json/yaml/yml, api/openapi.json/yaml, docs/openapi.json/yaml, spec/openapi.json/yaml',
					},
					null,
					2,
				);
			}

			// Parse spec
			const specPaths = parseSpec(specFile);

			// Extract routes from code
			const codeRoutes = extractRoutes(cwd);

			// Find drift
			const { undocumented, phantom } = findDrift(specPaths, codeRoutes);

			const result: SchemaDriftResult = {
				specFile,
				specPathCount: specPaths.length,
				codeRouteCount: codeRoutes.length,
				undocumented,
				phantom,
				undocumentedCount: undocumented.length,
				phantomCount: phantom.length,
				consistent: undocumented.length === 0 && phantom.length === 0,
			};

			return JSON.stringify(result, null, 2);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error';
			const errorResult: SchemaDriftResult = {
				specFile: '',
				specPathCount: 0,
				codeRouteCount: 0,
				undocumented: [],
				phantom: [],
				undocumentedCount: 0,
				phantomCount: 0,
				consistent: false,
			};
			return JSON.stringify({ ...errorResult, error: errorMessage }, null, 2);
		}
	},
});
