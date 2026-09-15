import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import {
	handleMcpCommand,
	parseMcpServeArgs,
	resolveMcpRoot,
} from '../../../src/cli/mcp';
import { computeSyntaxCheck } from '../../../src/tools/syntax-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('MCP offline guard (#2499 R3)', () => {
	test('no child_process or Bun.spawn import is reachable from src/mcp', () => {
		const mcpDir = path.join(import.meta.dir, '..', '..', '..', 'src', 'mcp');
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith('.ts')) continue;
				const source = fs.readFileSync(full, 'utf-8');
				if (
					/from\s+['"]node:child_process|Bun\.spawn|child_process\.spawn/.test(
						source,
					)
				) {
					offenders.push(path.relative(mcpDir, full));
				}
			}
		};
		walk(mcpDir);
		expect(offenders).toEqual([]);
	});
});

describe('MCP CLI wiring (#2499)', () => {
	test('parses --dir and the recognized --allow-write flag', () => {
		const parsed = parseMcpServeArgs(['--dir', '/some/root', '--allow-write']);
		expect(parsed).toEqual({ root: '/some/root', allowWrite: true });
	});

	test('parses --dir=value form', () => {
		const parsed = parseMcpServeArgs(['--dir=/some/root']);
		expect(parsed).toEqual({ root: '/some/root', allowWrite: false });
	});

	test('missing --dir is an error', () => {
		expect('error' in parseMcpServeArgs([])).toBe(true);
	});

	test('unknown arguments are errors', () => {
		expect('error' in parseMcpServeArgs(['--dir', '/x', '--boom'])).toBe(true);
	});

	test('resolveMcpRoot accepts an existing directory', () => {
		const root = canonicalMkdtemp('mcp-cli-root-2499-');
		const resolved = resolveMcpRoot(root);
		expect('root' in resolved && resolved.root).toBe(root);
	});

	test('resolveMcpRoot rejects a nonexistent directory', () => {
		const resolved = resolveMcpRoot(
			path.join(canonicalMkdtemp('mcp-cli-missing-2499-'), 'nope'),
		);
		expect('error' in resolved).toBe(true);
	});

	test('handleMcpCommand without `serve` prints usage and exits 1', async () => {
		expect(await handleMcpCommand([])).toBe(1);
	});

	test('handleMcpCommand with an invalid --dir fails closed with exit 1', async () => {
		expect(
			await handleMcpCommand(['serve', '--dir', 'Z:\\definitely\\not\\a\\dir']),
		).toBe(1);
	});
});

describe('Persistence-free compute cores (#2499 R1)', () => {
	test('computeSyntaxCheck runs without persisting evidence', async () => {
		const root = canonicalMkdtemp('mcp-compute-2499-');
		fs.writeFileSync(path.join(root, 'probe.ts'), 'const x: number = 1;\n');
		const result = await computeSyntaxCheck(
			{ changed_files: [{ path: 'probe.ts', additions: 1 }] },
			root,
		);
		expect(result.verdict).toBe('pass');
		// Read-only guarantee: no .swarm state was materialized by the compute.
		expect(fs.existsSync(path.join(root, '.swarm'))).toBe(false);
	});
});

describe('MCP project-root ownership (#2679)', () => {
	test('an ordinary child of a parent owning .git + .swarm redirects to the parent root', () => {
		const base = canonicalMkdtemp('mcp-root-2679-redirect-');
		const parent = path.join(base, 'outer');
		const child = path.join(parent, 'child');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
		fs.mkdirSync(child, { recursive: true });

		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logged.push(
				args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '),
			);
		};
		let resolved: { root: string; redirectedFrom?: string } | { error: string };
		try {
			resolved = resolveMcpRoot(child);
		} finally {
			console.log = originalLog;
		}

		expect('error' in resolved).toBe(false);
		if ('error' in resolved) return;
		// The resolver canonicalizes the served root; compare via realpath on both sides.
		expect(fs.realpathSync(resolved.root)).toBe(fs.realpathSync(parent));
		expect(resolved.redirectedFrom).toBe(child);
		// Startup line naming the served root (operator sees the redirect).
		expect(
			logged.some(
				(line) =>
					line.includes('serving the owning project root') &&
					line.includes(parent),
			),
		).toBe(true);
	});

	test('fails closed when the claiming ancestor is deeper than the walk budget', () => {
		const base = canonicalMkdtemp('mcp-root-2679-depth-');
		const parent = path.join(base, 'outer');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
		// The walk counts upward until it finds the nearest claiming ancestor,
		// so a chain deeper than MAX_PROJECT_ROOT_DEPTH (20) levels under the
		// claiming parent fails closed with the 'exceeded' reason.
		let deepest = parent;
		for (let i = 0; i < 25; i += 1) {
			deepest = path.join(deepest, `level-${i}`);
		}
		fs.mkdirSync(deepest, { recursive: true });

		const resolved = resolveMcpRoot(deepest);
		expect('error' in resolved).toBe(true);
		if (!('error' in resolved)) return;
		expect(resolved.error).toContain('exceeded');
	});

	test('a plain root with .git passes through unchanged', () => {
		const root = canonicalMkdtemp('mcp-root-2679-git-');
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });

		const resolved = resolveMcpRoot(root);
		expect('root' in resolved).toBe(true);
		if (!('root' in resolved)) return;
		expect(resolved.root).toBe(root);
		expect('redirectedFrom' in resolved).toBe(false);
	});
});
