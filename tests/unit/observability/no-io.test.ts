/**
 * AC4/AC5 support — `src/observability/*.ts` performs zero filesystem,
 * network, subprocess, or dynamic-import I/O, and importing the barrel has no
 * observable side effect (issue #2029).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OBSERVABILITY_DIR = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'src',
	'observability',
);

const FORBIDDEN_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
	{ label: 'node:fs', pattern: /node:fs/ },
	{ label: 'node:child_process', pattern: /node:child_process/ },
	{ label: 'node:net', pattern: /node:net/ },
	{ label: 'node:http', pattern: /node:http/ },
	{ label: 'fetch(', pattern: /fetch\(/ },
	{ label: 'bun:', pattern: /bun:/ },
	{ label: 'Bun.', pattern: /\bBun\./ },
	{ label: 'require(', pattern: /require\(/ },
	{ label: 'dynamic import(', pattern: /[^.]\bimport\(/ },
];

function listSourceFiles(): string[] {
	return fs
		.readdirSync(OBSERVABILITY_DIR)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => path.join(OBSERVABILITY_DIR, f));
}

describe('src/observability/*.ts — no I/O', () => {
	const files = listSourceFiles();

	test('the module directory contains at least the expected source files (self-check)', () => {
		expect(files.length).toBeGreaterThanOrEqual(9);
	});

	describe.each(
		files.map((f) => [path.basename(f), f] as const),
	)('%s', (_basename, filePath) => {
		const content = fs.readFileSync(filePath, 'utf-8');

		for (const { label, pattern } of FORBIDDEN_PATTERNS) {
			test(`does not contain "${label}"`, () => {
				expect(pattern.test(content)).toBe(false);
			});
		}

		test('only imports node:crypto and zod (and relative ./*.js siblings)', () => {
			// Strip comments FIRST: block/line comments in this codebase's doc
			// prose contain the literal word "from" (e.g. "derive projectRef from
			// the path"), which would otherwise make a naive multi-line
			// `import ... from '...'` regex swallow unrelated comment text as
			// part of the specifier and report a false "disallowed import".
			const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
			const withoutComments = withoutBlockComments
				.split('\n')
				.map((line) => line.replace(/\/\/.*$/, ''))
				.join('\n');

			// Multi-line import statements (e.g. `import {\n  a,\n  b,\n} from '...'`)
			// mean a per-line regex under-matches; extract each statement's module
			// specifier across the whole (comment-stripped) file instead. Also
			// matches barrel-style `export { x } from '...'` re-exports (index.ts),
			// which bring in dependencies just like `import`.
			const importPattern =
				/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
			const specifiers: string[] = [];
			let match: RegExpExecArray | null = importPattern.exec(withoutComments);
			while (match !== null) {
				specifiers.push(match[1]);
				match = importPattern.exec(withoutComments);
			}
			// sampling.ts has zero import/export-from statements — that is a
			// legitimate zero, not a broken regex, so no lower-bound assertion here.
			for (const spec of specifiers) {
				const allowed =
					spec.startsWith('./') || spec === 'node:crypto' || spec === 'zod';
				if (!allowed) {
					throw new Error(
						`Disallowed import specifier in ${path.basename(filePath)}: "${spec}"`,
					);
				}
			}
		});
	});

	test('importing the barrel (index.ts) has no observable filesystem side effect', async () => {
		const tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-noio-')),
		);
		const before = fs.readdirSync(tmpDir);

		// Run the import in a subprocess with tmpDir as cwd so any accidental
		// I/O (e.g. relative-path file creation) is trivially detectable and
		// does not pollute the parent test process's cwd.
		const script = `
			process.chdir(${JSON.stringify(tmpDir)});
			await import(${JSON.stringify(path.join(OBSERVABILITY_DIR, 'index.ts').replace(/\\/g, '/'))});
			process.exit(0);
		`;
		const result = spawnSync(
			process.platform === 'win32' ? 'bun.exe' : 'bun',
			['-e', script],
			{ encoding: 'utf-8', timeout: 20_000 },
		);

		expect(result.status).toBe(0);
		const after = fs.readdirSync(tmpDir);
		expect(after).toEqual(before);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
