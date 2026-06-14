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
		fs.writeFileSync(
			path.join(tmp, 'app/api/users/route.ts'),
			[
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
			files: ['app/api/users/route.ts', 'app/api/public/route.ts'],
		});
		const r = JSON.parse(out) as {
			success: boolean;
			packet: {
				targets: string[];
				summary: { targetCount: number; routeCount: number };
				findings: Array<{ file: string; code: string }>;
				packageBoundaries: Array<{ name: string }>;
			};
		};
		expect(r.success).toBe(true);
		expect(r.packet.targets).toEqual([
			'app/api/users/route.ts',
			'app/api/public/route.ts',
		]);
		expect(r.packet.summary.targetCount).toBe(2);
		expect(r.packet.summary.routeCount).toBe(2);
		expect(r.packet.findings).toContainEqual(
			expect.objectContaining({
				file: 'app/api/public/route.ts',
				code: 'api_route_without_detected_auth',
			}),
		);
		expect(r.packet.packageBoundaries.map((boundary) => boundary.name)).toEqual(
			['app'],
		);
	});
});

describe('repo_map: validation', () => {
	it('rejects unknown actions', async () => {
		const out = await call({ action: 'destroy_world' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('unknown action');
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
