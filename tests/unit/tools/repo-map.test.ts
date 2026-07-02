import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';

let tmp: string;

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-tool-'));
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) { return a + b; }\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: build', () => {
	it('builds and persists the graph', async () => {
		const out = await call({ action: 'build' });
		const result = JSON.parse(out) as {
			success: boolean;
			fileCount: number;
			edgeCount: number;
		};
		expect(result.success).toBe(true);
		expect(result.fileCount).toBe(2);
		expect(result.edgeCount).toBeGreaterThanOrEqual(1);
		expect(fs.existsSync(path.join(tmp, '.swarm/repo-graph.json'))).toBe(true);
	});

	it('returns a structured error envelope when build fails (no JSON throw)', async () => {
		// Make .swarm a non-writable file so mkdirSync inside saveGraph fails.
		fs.writeFileSync(path.join(tmp, '.swarm'), 'not a directory', 'utf-8');
		const out = await call({ action: 'build' });
		const r = JSON.parse(out) as {
			success: boolean;
			action: string;
			error: string;
		};
		expect(r.success).toBe(false);
		expect(r.action).toBe('build');
		expect(r.error).toContain('build failed');
	});
});

describe('repo_map: query actions without prior build', () => {
	it('returns a clear error pointing the agent at action="build"', async () => {
		const out = await call({ action: 'importers', file: 'src/util.ts' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('repo_map with action="build"');
	});
});

describe('repo_map: graph_health', () => {
	it('returns a bounded health envelope before the graph exists', async () => {
		const out = await call({ action: 'graph_health' });
		const r = JSON.parse(out) as {
			success: boolean;
			action: string;
			schemaVersion: string | null;
			fresh: boolean;
			notes: string[];
		};
		expect(r.success).toBe(true);
		expect(r.action).toBe('graph_health');
		expect(r.schemaVersion).toBeNull();
		expect(r.fresh).toBe(false);
		expect(r.notes.join('\n')).toContain('repo_map with action="build"');
	});

	it('reports fresh graph health after build', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'graph_health' });
		const r = JSON.parse(out) as {
			success: boolean;
			schemaVersion: string;
			fresh: boolean;
			extractionFailures: unknown[];
			unresolvedImports: unknown[];
		};
		expect(r.success).toBe(true);
		expect(r.schemaVersion).toBe('1.2.0');
		expect(r.fresh).toBe(true);
		expect(r.extractionFailures).toEqual([]);
		expect(r.unresolvedImports).toEqual([]);
	});

	it('reports stale graph health after persisted timestamp changes', async () => {
		await call({ action: 'build' });
		const graphPath = path.join(tmp, '.swarm', 'repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			metadata: { generatedAt: string };
		};
		graph.metadata.generatedAt = '2000-01-01T00:00:00.000Z';
		fs.writeFileSync(graphPath, JSON.stringify(graph), 'utf-8');
		fs.utimesSync(graphPath, new Date(), new Date());

		const out = await call({ action: 'graph_health' });
		const r = JSON.parse(out) as {
			success: boolean;
			fresh: boolean;
			staleFiles: string[];
			notes: string[];
		};
		expect(r.success).toBe(true);
		expect(r.fresh).toBe(false);
		expect(r.staleFiles).toContain('src/main.ts');
		expect(r.notes.join('\n')).toContain('Graph is stale');
	});

	it('returns a structured graph_health error for corrupt graph JSON', async () => {
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmp, '.swarm', 'repo-graph.json'), '{ nope');

		const out = await call({ action: 'graph_health' });
		const r = JSON.parse(out) as {
			success: boolean;
			action: string;
			error: string;
		};
		expect(r.success).toBe(false);
		expect(r.action).toBe('graph_health');
		expect(r.error).toContain('failed to load repo graph');
	});
});

describe('repo_map: importers / dependencies / blast_radius / localization', () => {
	beforeEach(async () => {
		await call({ action: 'build' });
	});

	it('importers returns consumers for util.ts', async () => {
		const out = await call({ action: 'importers', file: 'src/util.ts' });
		const r = JSON.parse(out) as {
			success: boolean;
			count: number;
			importers: { file: string }[];
		};
		expect(r.success).toBe(true);
		expect(r.count).toBe(1);
		expect(r.importers[0].file).toBe('src/main.ts');
	});

	it('dependencies returns the resolved targets', async () => {
		const out = await call({ action: 'dependencies', file: 'src/main.ts' });
		const r = JSON.parse(out) as {
			success: boolean;
			dependencies: { file: string }[];
		};
		expect(r.success).toBe(true);
		expect(r.dependencies.map((d) => d.file)).toContain('src/util.ts');
	});

	it('blast_radius reports a low risk for a tiny repo', async () => {
		const out = await call({
			action: 'blast_radius',
			file: 'src/util.ts',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			riskLevel: string;
			totalDependents: number;
		};
		expect(r.success).toBe(true);
		expect(r.totalDependents).toBe(1);
		expect(r.riskLevel).toBe('low');
	});

	it('localization produces a summary block', async () => {
		const out = await call({
			action: 'localization',
			file: 'src/util.ts',
		});
		const r = JSON.parse(out) as { success: boolean; summary: string };
		expect(r.success).toBe(true);
		expect(r.summary).toContain('LOCALIZATION CONTEXT');
		expect(r.summary).toContain('src/util.ts');
	});

	it('importers + symbol filters by exported name', async () => {
		const out = await call({
			action: 'importers',
			file: 'src/util.ts',
			symbol: 'add',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			consumers: { file: string }[];
		};
		expect(r.success).toBe(true);
		expect(r.consumers.map((c) => c.file)).toContain('src/main.ts');
	});

	it('key_files surfaces util.ts as the most-imported', async () => {
		const out = await call({ action: 'key_files', top_n: 5 });
		const r = JSON.parse(out) as {
			success: boolean;
			files: { file: string; inDegree: number }[];
		};
		expect(r.success).toBe(true);
		expect(r.files[0].file).toBe('src/util.ts');
		expect(r.files[0].inDegree).toBe(1);
	});
});

describe('repo_map: ontology / package boundaries / preflight packet', () => {
	beforeEach(async () => {
		fs.mkdirSync(path.join(tmp, 'app/api/users'), { recursive: true });
		fs.mkdirSync(path.join(tmp, 'app/api/public'), { recursive: true });
		fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'lib/db.ts'),
			'export const db = { user: { create: async (_input: unknown) => ({ id: "1" }) } };\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'app/api/users/route.ts'),
			[
				"import { db } from '../../../lib/db';",
				"import { z } from 'zod';",
				'const Body = z.object({ name: z.string() });',
				'export async function POST(req: Request) {',
				'  const user = requireUser(req);',
				'  const body = Body.parse(await req.json());',
				'  await db.user.create({ data: body, ownerId: user.id });',
				'  return Response.json({ ok: true });',
				'}',
			].join('\n'),
		);
		fs.writeFileSync(
			path.join(tmp, 'app/api/public/route.ts'),
			[
				'export async function POST(req: Request) {',
				'  await db.post.create({ data: await req.json() });',
				'  return Response.json({ ok: true });',
				'}',
			].join('\n'),
		);
		await call({ action: 'build' });
	});

	it('returns route, data, and security ontology for a guarded route file', async () => {
		const out = await call({
			action: 'ontology',
			file: 'app/api/users/route.ts',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			ontology: {
				roles: string[];
				routes: Array<{ method: string; path: string }>;
				dataOperations: Array<{ operation: string; access: string }>;
				security: Array<{ kind: string }>;
				findings: Array<{ code: string }>;
			};
		};
		expect(r.success).toBe(true);
		expect(r.ontology.roles).toContain('api_route');
		expect(r.ontology.routes).toContainEqual(
			expect.objectContaining({ method: 'POST', path: '/api/users' }),
		);
		expect(r.ontology.dataOperations).toContainEqual(
			expect.objectContaining({ operation: 'write' }),
		);
		expect(r.ontology.security.map((fact) => fact.kind)).toContain(
			'authentication',
		);
		expect(r.ontology.security.map((fact) => fact.kind)).toContain(
			'input_validation',
		);
		expect(r.ontology.findings.map((finding) => finding.code)).not.toContain(
			'api_route_without_detected_auth',
		);
	});

	it('surfaces ontology findings for an unguarded mutating route', async () => {
		const out = await call({
			action: 'ontology',
			file: 'app/api/public/route.ts',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			ontology: { findings: Array<{ code: string }> };
		};
		expect(r.success).toBe(true);
		const codes = r.ontology.findings.map((finding) => finding.code);
		expect(codes).toContain('api_route_without_detected_auth');
		expect(codes).toContain('mutating_route_without_detected_validation');
	});

	it('summarizes inferred package boundaries', async () => {
		const out = await call({ action: 'package_boundaries', top_n: 10 });
		const r = JSON.parse(out) as {
			success: boolean;
			boundaries: Array<{ name: string; routeCount: number }>;
		};
		expect(r.success).toBe(true);
		expect(r.boundaries).toContainEqual(
			expect.objectContaining({ name: 'app', routeCount: 2 }),
		);
	});

	it('builds a bounded ontology preflight packet for target files', async () => {
		const out = await call({
			action: 'preflight_packet',
			files: ['app/api/users/route.ts', 'app/api/public/route.ts', 'lib/db.ts'],
		});
		const r = JSON.parse(out) as {
			success: boolean;
			packet: {
				targets: string[];
				summary: { targetCount: number; routeCount: number };
				findings: Array<{ file: string; code: string }>;
				packageBoundaries: Array<{
					name: string;
					dependsOn: string[];
					dependedOnBy: string[];
				}>;
			};
		};
		expect(r.success).toBe(true);
		expect(r.packet.targets).toEqual([
			'app/api/users/route.ts',
			'app/api/public/route.ts',
			'lib/db.ts',
		]);
		expect(r.packet.summary.targetCount).toBe(3);
		expect(r.packet.summary.routeCount).toBe(2);
		expect(r.packet.findings).toContainEqual(
			expect.objectContaining({
				file: 'app/api/public/route.ts',
				code: 'api_route_without_detected_auth',
			}),
		);
		const app = r.packet.packageBoundaries.find(
			(boundary) => boundary.name === 'app',
		);
		const lib = r.packet.packageBoundaries.find(
			(boundary) => boundary.name === 'lib',
		);
		expect(app?.dependsOn).toEqual(['lib']);
		expect(lib?.dependedOnBy).toEqual(['app']);
	});
});

describe('repo_map: validation', () => {
	it('rejects unknown actions', async () => {
		const out = await call({ action: 'destroy_world' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('unknown action');
	});

	it('requires build before new ontology actions are queried', async () => {
		const out = await call({ action: 'ontology', file: 'src/util.ts' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('repo_map with action="build"');
	});

	it('requires file for ontology', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ontology' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('ontology requires `file`');
	});

	it('rejects path traversal in preflight_packet files', async () => {
		await call({ action: 'build' });
		const out = await call({
			action: 'preflight_packet',
			files: ['src/util.ts', '../outside.ts'],
		});
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('path traversal');
	});

	it('supports package_boundaries after build without a target file', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'package_boundaries' });
		const r = JSON.parse(out) as {
			success: boolean;
			boundaries: Array<{ name: string }>;
		};
		expect(r.success).toBe(true);
		expect(r.boundaries.length).toBeGreaterThan(0);
	});

	it('rejects path traversal in file argument', async () => {
		await call({ action: 'build' });
		const out = await call({
			action: 'importers',
			file: '../../etc/passwd',
		});
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('path traversal');
	});

	it('rejects absolute paths (POSIX)', async () => {
		await call({ action: 'build' });
		const out = await call({
			action: 'importers',
			file: '/etc/passwd',
		});
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('workspace-relative');
	});

	it('rejects Windows drive-letter absolute paths', async () => {
		await call({ action: 'build' });
		const out = await call({
			action: 'importers',
			file: 'C:\\Windows\\system32\\drivers\\etc\\hosts',
		});
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('workspace-relative');
	});

	it('requires file for importers/dependencies/localization', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'importers' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `file`');
	});
});

describe('repo_map: callers / dead_exports', () => {
	it('callers reports files that reference an exported symbol', async () => {
		await call({ action: 'build' });
		const out = await call({
			action: 'callers',
			file: 'src/util.ts',
			symbol: 'add',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			count: number;
			callers: Array<{ file: string; resolution: string }>;
		};
		expect(r.success).toBe(true);
		// main.ts both imports and calls add(1, 2) -> 'used' resolution.
		expect(r.callers).toEqual([{ file: 'src/main.ts', resolution: 'used' }]);
	});

	it('callers requires a symbol', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'callers', file: 'src/util.ts' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `symbol`');
	});

	it('dead_exports flags an unreferenced export but not a used one', async () => {
		// util.ts gains an extra export that main.ts never references.
		fs.writeFileSync(
			path.join(tmp, 'src/util.ts'),
			'export function add(a: number, b: number) { return a + b; }\n' +
				'export function orphan() { return 0; }\n',
		);
		await call({ action: 'build' });
		const out = await call({ action: 'dead_exports' });
		const r = JSON.parse(out) as {
			success: boolean;
			schemaSupported: boolean;
			candidates: Array<{ file: string; symbol: string }>;
		};
		expect(r.success).toBe(true);
		expect(r.schemaSupported).toBe(true);
		const symbols = r.candidates.map((c) => c.symbol);
		expect(r.candidates.length).toBe(1);
		expect(symbols).toContain('orphan');
		expect(symbols).not.toContain('add');
	});
});

describe('repo_map: context_pack', () => {
	it('happy path: returns spans for a symbol with callers (1.2.0 graph)', async () => {
		// Build creates a 1.2.0 graph with exportRanges + symbolEdges.
		await call({ action: 'build' });
		const out = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			schemaSupported: boolean;
			spans: Array<{ file: string }>;
			estimatedTokens: number;
			target: { file: string; symbol: string };
		};
		expect(r.success).toBe(true);
		expect(r.schemaSupported).toBe(true);
		expect(r.spans.length).toBeGreaterThan(0);
		expect(r.estimatedTokens).toBeGreaterThan(0);
		// Target file should be workspace-relative.
		expect(r.target.file).toBe('src/util.ts');
		// Spans should have workspace-relative paths (no leading slash on POSIX, no drive letter on Windows).
		for (const span of r.spans) {
			expect(span.file).not.toMatch(/^[A-Z]:|^\//);
		}
	});

	it('returns context for Python package-root exports and Rust/Go symbols', async () => {
		fs.mkdirSync(path.join(tmp, 'src/pkg'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src/pkg/__init__.py'),
			"__all__ = ['public_fn']\nfrom .api import public_fn\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'src/pkg/api.py'),
			'@cached\nasync def public_fn():\n    return 1\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'src/consumer.py'),
			'from .pkg import public_fn\n\n\ndef call_it():\n    return public_fn()\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'src/lib.rs'),
			'use crate::helper::Worker;\npub enum Mode { Fast }\npub trait Runner {}\npub fn run(_: Worker) {}\n',
		);
		fs.writeFileSync(path.join(tmp, 'src/helper.rs'), 'pub struct Worker;\n');
		fs.writeFileSync(
			path.join(tmp, 'src/main.go'),
			'package main\n\nfunc PublicFunc() {}\n',
		);

		await call({ action: 'build' });

		const py = JSON.parse(
			await call({
				action: 'context_pack',
				file: 'src/pkg/__init__.py',
				symbol: 'public_fn',
			}),
		) as {
			success: boolean;
			target: { file: string; symbol: string };
			spans: Array<{ file: string; startLine: number }>;
		};
		expect(py.success).toBe(true);
		expect(py.target).toEqual({
			file: 'src/pkg/__init__.py',
			symbol: 'public_fn',
		});
		expect(py.spans).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'src/pkg/__init__.py',
					startLine: 2,
				}),
			]),
		);

		const rust = JSON.parse(
			await call({
				action: 'context_pack',
				file: 'src/lib.rs',
				symbol: 'Mode',
			}),
		) as { success: boolean; spans: Array<{ file: string }> };
		expect(rust.success).toBe(true);
		expect(rust.spans).toEqual(
			expect.arrayContaining([expect.objectContaining({ file: 'src/lib.rs' })]),
		);
		const rustDeps = JSON.parse(
			await call({ action: 'dependencies', file: 'src/lib.rs' }),
		) as { success: boolean; dependencies: Array<{ file: string }> };
		expect(rustDeps.success).toBe(true);
		expect(rustDeps.dependencies.map((d) => d.file)).toContain('src/helper.rs');

		const go = JSON.parse(
			await call({
				action: 'context_pack',
				file: 'src/main.go',
				symbol: 'PublicFunc',
			}),
		) as { success: boolean; spans: Array<{ file: string }> };
		expect(go.success).toBe(true);
		expect(go.spans).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: 'src/main.go' }),
			]),
		);
	});

	it('missing file: rejects context_pack without file', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'context_pack', symbol: 'add' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toBe('context_pack requires `file`');
	});

	it('missing symbol: rejects context_pack without symbol', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'context_pack', file: 'src/util.ts' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toBe('context_pack requires `symbol` (the exported name)');
	});

	it('unknown action: rejects bogus action', async () => {
		const out = await call({ action: 'bogus' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('unknown action');
	});

	it('schema fallback: returns empty spans on a 1.1.0 graph', async () => {
		// Build a proper 1.2.0 graph first.
		await call({ action: 'build' });

		// Overwrite with a synthetic 1.1.0 graph (no symbolEdges, no exportRanges).
		// loadGraph uses mtime to detect external changes and will re-read the file.
		const graphPath = path.join(tmp, '.swarm', 'repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			schema_version: string;
			symbolEdges?: unknown[];
			nodes: Record<string, { exportRanges?: unknown }>;
		};
		graph.schema_version = '1.1.0';
		delete graph.symbolEdges;
		for (const node of Object.values(graph.nodes)) {
			delete node.exportRanges;
		}
		// Touch the file to update mtime so loadGraph re-reads it.
		fs.writeFileSync(graphPath, JSON.stringify(graph), 'utf-8');

		const out = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			schemaSupported: boolean;
			spans: unknown[];
			note?: string;
		};
		expect(r.success).toBe(true);
		expect(r.schemaSupported).toBe(false);
		expect(r.spans).toEqual([]);
		expect(r.note).toBe('rebuild with repo_map action="build"');
	});
});

describe('repo_map: context_pack target-not-found', () => {
	it('returns empty spans with note when file is not in 1.2.0 graph', async () => {
		// Build a proper 1.2.0 graph.
		await call({ action: 'build' });

		// Call context_pack with a file that does NOT exist in the graph.
		const out = await call({
			action: 'context_pack',
			file: 'src/does-not-exist.ts',
			symbol: 'NonExistent',
		});
		const r = JSON.parse(out) as {
			success: boolean;
			schemaSupported: boolean;
			spans: unknown[];
			note?: string;
		};
		expect(r.success).toBe(true);
		expect(r.schemaSupported).toBe(true);
		expect(r.spans).toEqual([]);
		expect(r.note).toBe('Target file not found in graph');
	});
});
