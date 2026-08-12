/**
 * Guardrail assertions (issue #1619 follow-up) for the recurrence class
 * "a validator intended for untrusted RELATIVE input applied to a trusted
 * ABSOLUTE project root". The scanner machinery lives in
 * tests/helpers/trusted-root-validator-scan.ts — read its docblock for the two
 * rules, the false-positive discriminators, and the known limitation.
 */
import { describe, expect, test } from 'bun:test';
import {
	countSourceFiles,
	extractFunctionBody,
	extractFunctionParams,
	GUARDED_ENTRY_POINTS,
	importsPathSecurityValidateDirectory,
	looksLikeProjectDirectory,
	scanFileForMisapplication,
	scanGuardedEntryPoints,
	scanTreeForMisapplication,
	splitCallArguments,
} from '../../helpers/trusted-root-validator-scan';

describe('trusted-root validator guardrail (#1619 follow-up)', () => {
	test('falsifiability: the scanner actually reads the src/ tree', () => {
		// If this ever collapses to 0 the whole scan would pass vacuously.
		expect(countSourceFiles()).toBeGreaterThan(100);
		// 5, not 6: #2119 removed `getFailures` from run-memory. The exact count is
		// pinned so a silent removal of a guarded entry point fails here rather
		// than quietly shrinking the rule's coverage.
		expect(GUARDED_ENTRY_POINTS.length).toBe(5);
	});

	test('RULE M — no src/ file passes a project directory to validateDirectory', () => {
		const violations = scanTreeForMisapplication();
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  [rule ${v.rule}] ${v.file}:${v.line} — ${v.detail}`)
				.join('\n');
			throw new Error(
				`Found ${violations.length} call(s) handing a trusted project root to validateDirectory:\n${report}\n\n` +
					`validateDirectory (src/utils/path-security.ts) guards UNTRUSTED, RELATIVE sub-path input and rejects\n` +
					`every absolute path. A project root injected by the plugin host is ALWAYS absolute, so such a call\n` +
					`throws on every real invocation — and every call site sits behind a debug-gated catch, so the feature\n` +
					`silently disappears instead of failing loudly.\n\n` +
					`Fix: use validateProjectDirectory(...) from the same module.`,
			);
		}
		expect(violations).toEqual([]);
	});

	test('RULE P — every entry point taking a project root validates it', () => {
		const violations = scanGuardedEntryPoints();
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  [rule ${v.rule}] ${v.file}:${v.line} — ${v.detail}`)
				.join('\n');
			throw new Error(
				`Found ${violations.length} guarded entry point(s) missing trusted-root validation:\n${report}`,
			);
		}
		expect(violations).toEqual([]);
	});

	/**
	 * #1619 round 6 finding 5. RULE P used to accept ANY
	 * `validateProjectDirectory(` call in the body, so a body that validated some
	 * unrelated local would have passed while the trusted root went unchecked.
	 * The rule now names the parameter; these assertions pin that the declared
	 * parameter is real and that the call is keyed on it.
	 */
	test('RULE P pins the validated argument to a declared parameter', () => {
		for (const { fn, param } of GUARDED_ENTRY_POINTS) {
			expect(
				param.length,
				`${fn} declares no trusted-root parameter`,
			).toBeGreaterThan(0);
		}
		const source = [
			'export async function getReport(',
			'	directory: string,',
			'	config: Config,',
			'): Promise<void> {',
			'	validateProjectDirectory(directory);',
			'}',
		].join('\n');
		expect(extractFunctionParams(source, 'getReport')).toEqual([
			'directory',
			'config',
		]);
		expect(extractFunctionParams(source, 'missingFunction')).toBeNull();
	});
});

describe('trusted-root validator guardrail — scanner behaviour', () => {
	const IMPORT = `import { validateDirectory } from '../utils/path-security';\n`;

	test('RULE M bites: reintroducing the exact defect is reported', () => {
		const source = `${IMPORT}export async function getReport(directory: string) {\n\tvalidateDirectory(directory);\n}\n`;
		const violations = scanFileForMisapplication(
			'src/services/fake-service.ts',
			source,
		);
		expect(violations.length).toBe(1);
		expect(violations[0]?.rule).toBe('M');
		expect(violations[0]?.line).toBe(3);
		expect(violations[0]?.detail).toContain('validateProjectDirectory');
	});

	test.each([
		['ctx.directory', 'member access on the injected tool context'],
		['projectRoot', 'bare project-root identifier'],
		['effectiveWorkspaceDir', 'compound identifier with a known suffix'],
		['process.cwd()', 'the documented CLI/test fallback'],
	])('RULE M bites on %s (%s)', (arg) => {
		const source = `${IMPORT}function f() {\n\tvalidateDirectory(${arg});\n}\n`;
		expect(
			scanFileForMisapplication('src/services/fake.ts', source).length,
		).toBe(1);
	});

	test('RULE M does NOT fire on a relative sub-path argument (the legitimate use)', () => {
		const source = `${IMPORT}function f(relativeSubPath: string) {\n\tvalidateDirectory(relativeSubPath);\n\tvalidateDirectory('src/tools');\n}\n`;
		expect(scanFileForMisapplication('src/services/fake.ts', source)).toEqual(
			[],
		);
	});

	test('RULE M does NOT fire on a local 2-arg validateDirectory (pre-check-batch shape)', () => {
		// No path-security import AND two arguments — either discriminator alone
		// would suppress this, which is the point: neither carries it unaided.
		const local = `function validateDirectory(dir: string, workspaceDir: string) { return null; }\nconst e = validateDirectory(directory, effectiveWorkspaceDir);\n`;
		expect(
			scanFileForMisapplication('src/tools/pre-check-batch.ts', local),
		).toEqual([]);
		const withImport = `${IMPORT}const e = validateDirectory(directory, workspaceDir);\n`;
		expect(scanFileForMisapplication('src/tools/other.ts', withImport)).toEqual(
			[],
		);
	});

	test('the real pre-check-batch.ts is not flagged (live false-positive check)', () => {
		const violations = scanTreeForMisapplication().filter((v) =>
			v.file.includes('pre-check-batch'),
		);
		expect(violations).toEqual([]);
	});

	test('RULE M ignores prose: comments cannot satisfy or trip it', () => {
		const source = `${IMPORT}// validateDirectory(directory) would be wrong here\n/* validateDirectory(projectRoot); */\nfunction f() {}\n`;
		expect(scanFileForMisapplication('src/services/fake.ts', source)).toEqual(
			[],
		);
	});

	test('RULE M exempts the validator module itself', () => {
		const source = `export function validateDirectory(directory: string) {}\nvalidateDirectory(directory);\n`;
		expect(
			scanFileForMisapplication('src/utils/path-security.ts', source),
		).toEqual([]);
	});

	test('RULE P bites: deleting the validation call is reported', () => {
		const body = extractFunctionBody(
			`export async function f(directory: string) {\n\tvalidateProjectDirectory(directory);\n\treturn 1;\n}`,
			'f',
		);
		expect(body).not.toBeNull();
		expect(body).toContain('validateProjectDirectory(');
		const stripped = extractFunctionBody(
			`export async function f(directory: string) {\n\treturn 1;\n}`,
			'f',
		);
		expect(stripped).not.toBeNull();
		expect(/validateProjectDirectory\s*\(/.test(stripped as string)).toBe(
			false,
		);
	});

	test('import detection requires the path-security module specifically', () => {
		expect(importsPathSecurityValidateDirectory(IMPORT)).toBe(true);
		expect(
			importsPathSecurityValidateDirectory(
				`import { validateDirectory } from './local-helpers';\n`,
			),
		).toBe(false);
		expect(
			importsPathSecurityValidateDirectory(
				`import { validateProjectDirectory } from '../utils/path-security';\n`,
			),
		).toBe(false);
	});

	test('argument splitting respects nesting, strings and commas', () => {
		const src = `f(join(a, b), 'x,y', c)`;
		expect(splitCallArguments(src, src.indexOf('('))).toEqual([
			'join(a, b)',
			"'x,y'",
			'c',
		]);
		expect(splitCallArguments('f(a', 1)).toBeNull();
	});

	test('looksLikeProjectDirectory rejects unrelated identifiers', () => {
		for (const arg of ['filename', 'taskId', 'relativePath', "'plan.md'"]) {
			expect(looksLikeProjectDirectory(arg)).toBe(false);
		}
		for (const arg of ['directory', 'ctx.directory', 'cwd', 'rootDir']) {
			expect(looksLikeProjectDirectory(arg)).toBe(true);
		}
	});
});
