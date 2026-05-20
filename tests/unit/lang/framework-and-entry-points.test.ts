import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGoBackend } from '../../../src/lang/backends/go';
import { buildPythonBackend } from '../../../src/lang/backends/python';
import { buildTypescriptBackend } from '../../../src/lang/backends/typescript';

/**
 * Phase 4b completion — backend hooks for PROJECT_FRAMEWORK and
 * ENTRY_POINTS template variables.
 *
 * The adversarial review of PR #825 flagged these two values as
 * hard-coded to the UNRESOLVED sentinel in buildProjectContext. This
 * suite asserts the three concrete backends (TS, Python, Go) now
 * populate them from real manifest signals.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lang-framework-entry-')),
	);
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('TypeScript backend: selectFramework', () => {
	test('detects react from dependencies', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ dependencies: { react: '^19' } }),
		);
		const backend = buildTypescriptBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel?.name).toBe('react');
	});

	test('next beats react when both present', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ dependencies: { react: '^19', next: '^14' } }),
		);
		const backend = buildTypescriptBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel?.name).toBe('next');
	});

	test('returns null when no recognized framework', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ dependencies: { lodash: '^4' } }),
		);
		const backend = buildTypescriptBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel).toBeNull();
	});
});

describe('TypeScript backend: selectEntryPoints', () => {
	test('extracts bin + main + module without duplication', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				main: 'dist/index.js',
				module: 'dist/index.mjs',
				bin: { 'my-cli': 'dist/cli.js' },
			}),
		);
		const backend = buildTypescriptBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toEqual(['dist/cli.js', 'dist/index.js', 'dist/index.mjs']);
	});

	test('string bin field works', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify({ bin: 'src/cli.ts' }),
		);
		const backend = buildTypescriptBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toContain('src/cli.ts');
	});

	test('returns [] when package.json is missing', async () => {
		const backend = buildTypescriptBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toEqual([]);
	});
});

describe('Python backend: selectFramework', () => {
	test('detects django via pyproject', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'pyproject.toml'),
			'[tool.poetry.dependencies]\ndjango = "^5"\n',
		);
		const backend = buildPythonBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel?.name).toBe('django');
	});

	test('detects flask via requirements.txt', async () => {
		fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'flask==3.0.0\n');
		const backend = buildPythonBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel?.name).toBe('flask');
	});
});

describe('Python backend: selectEntryPoints', () => {
	test('detects manage.py + main.py', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'manage.py'),
			'#!/usr/bin/env python\n',
		);
		fs.writeFileSync(
			path.join(tempDir, 'main.py'),
			'if __name__ == "__main__":\n',
		);
		const backend = buildPythonBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toContain('manage.py');
		expect(points).toContain('main.py');
	});

	test('extracts entries from [project.scripts] in pyproject.toml', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'pyproject.toml'),
			'[project.scripts]\nmy-cli = "mypkg.cli:main"\nother = "mypkg.other:run"\n',
		);
		const backend = buildPythonBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toContain('mypkg/cli.py');
		expect(points).toContain('mypkg/other.py');
	});
});

describe('Go backend: selectFramework', () => {
	test('detects gin via go.mod require', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'go.mod'),
			'module x\nrequire github.com/gin-gonic/gin v1.10.0\n',
		);
		const backend = buildGoBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel?.name).toBe('gin');
	});

	test('returns null when no recognized framework', async () => {
		fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module x\n');
		const backend = buildGoBackend();
		const sel = await backend.selectFramework?.(tempDir);
		expect(sel).toBeNull();
	});
});

describe('Go backend: selectEntryPoints', () => {
	test('detects top-level main.go', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'main.go'),
			'package main\nfunc main() {}\n',
		);
		const backend = buildGoBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toEqual(['main.go']);
	});

	test('detects cmd/*/main.go entries when no top-level main.go', async () => {
		const aCmd = path.join(tempDir, 'cmd', 'server');
		const bCmd = path.join(tempDir, 'cmd', 'worker');
		fs.mkdirSync(aCmd, { recursive: true });
		fs.mkdirSync(bCmd, { recursive: true });
		fs.writeFileSync(path.join(aCmd, 'main.go'), 'package main\n');
		fs.writeFileSync(path.join(bCmd, 'main.go'), 'package main\n');
		const backend = buildGoBackend();
		const points = await backend.selectEntryPoints?.(tempDir);
		expect(points).toContain(path.join('cmd', 'server', 'main.go'));
		expect(points).toContain(path.join('cmd', 'worker', 'main.go'));
	});
});
