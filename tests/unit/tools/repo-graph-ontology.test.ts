import { describe, expect, test } from 'bun:test';
import {
	type ExtractFileOntologyInput,
	extractFileOntology,
} from '../../../src/tools/repo-graph';
import { inferPackageBoundary } from '../../../src/tools/repo-graph/types';

describe('repo graph ontology extraction', () => {
	test('extracts route, data, security, and convention facts for an API route', () => {
		const ontology = extractFileOntology({
			moduleName: 'app/api/users/[id]/route.ts',
			filePath: '/repo/app/api/users/[id]/route.ts',
			language: 'typescript',
			exports: ['GET'],
			imports: ['zod'],
			content: [
				"import { z } from 'zod';",
				'const Params = z.object({ id: z.string() });',
				'export async function GET(req: Request) {',
				'  const session = await getServerSession();',
				'  const params = Params.parse(req);',
				'  return Response.json(await prisma.user.findUnique({ where: params }));',
				'}',
			].join('\n'),
		});

		expect(ontology.roles).toContain('api_route');
		expect(ontology.routes).toContainEqual(
			expect.objectContaining({
				method: 'GET',
				path: '/api/users/:id',
				source: 'handler_export',
			}),
		);
		expect(ontology.dataOperations).toContainEqual(
			expect.objectContaining({ operation: 'read', access: 'orm' }),
		);
		expect(ontology.security.map((fact) => fact.kind)).toContain(
			'authentication',
		);
		expect(ontology.security.map((fact) => fact.kind)).toContain(
			'input_validation',
		);
		expect(ontology.conventions.map((fact) => fact.name)).toContain(
			'next_app_route_handler',
		);
	});

	test('does not treat commented-out guards or writes as facts', () => {
		const ontology = extractFileOntology({
			moduleName: 'app/api/public/route.ts',
			filePath: '/repo/app/api/public/route.ts',
			language: 'typescript',
			exports: ['POST'],
			imports: [],
			content: [
				'// const user = requireUser(req);',
				'/* await db.user.create({ data: body }); */',
				'export async function POST(req: Request) {',
				'  return Response.json({ ok: true });',
				'}',
			].join('\n'),
		});

		expect(ontology.security).toEqual([]);
		expect(ontology.dataOperations).toEqual([]);
		expect(ontology.findings.map((finding) => finding.code)).toContain(
			'api_route_without_detected_auth',
		);
	});

	test('handles empty non-route files without inventing ontology facts', () => {
		const ontology = extractFileOntology({
			moduleName: 'src/lib/empty.ts',
			filePath: '/repo/src/lib/empty.ts',
			language: 'typescript',
			exports: [],
			imports: [],
			content: '',
		});

		expect(ontology.roles).not.toContain('api_route');
		expect(ontology.routes).toEqual([]);
		expect(ontology.dataOperations).toEqual([]);
		expect(ontology.security).toEqual([]);
		expect(ontology.findings).toEqual([]);
	});

	test('extracts multiple route handlers from one file', () => {
		const ontology = extractFileOntology({
			moduleName: 'app/api/projects/route.ts',
			filePath: '/repo/app/api/projects/route.ts',
			language: 'typescript',
			exports: ['GET', 'POST'],
			imports: [],
			content: [
				'export async function GET() {',
				'  return Response.json({ ok: true });',
				'}',
				'export async function POST() {',
				'  return Response.json({ created: true });',
				'}',
			].join('\n'),
		});

		expect(ontology.routes).toContainEqual(
			expect.objectContaining({ method: 'GET', path: '/api/projects' }),
		);
		expect(ontology.routes).toContainEqual(
			expect.objectContaining({ method: 'POST', path: '/api/projects' }),
		);
	});
});

describe('package boundary inference (A8)', () => {
	function ontologyFor(
		moduleName: string,
		hasManifest?: (d: string) => boolean,
	) {
		const input: ExtractFileOntologyInput = {
			moduleName,
			filePath: `/repo/${moduleName}`,
			language: 'typescript',
			exports: [],
			imports: [],
			content: '',
			hasManifest,
		};
		return extractFileOntology(input).packageBoundary;
	}

	test('src/tools/repo-graph special case is removed (regression)', () => {
		// Before A8 this returned 'src/tools/repo-graph'; the generic rule now
		// returns 'src/tools'. This is the one intentional behavior change.
		expect(ontologyFor('src/tools/repo-graph/builder.ts')).toBe('src/tools');
	});

	test('generic packages/crates/apps/libs/services boundary', () => {
		expect(ontologyFor('packages/foo/src/index.ts')).toBe('packages/foo');
		expect(ontologyFor('crates/core/src/lib.rs')).toBe('crates/core');
		expect(ontologyFor('apps/web/pages/index.tsx')).toBe('apps/web');
		expect(ontologyFor('libs/shared/src/index.ts')).toBe('libs/shared');
		expect(ontologyFor('services/api/src/main.ts')).toBe('services/api');
	});

	test('src and tests layouts', () => {
		expect(ontologyFor('src/hooks/foo.ts')).toBe('src/hooks');
		expect(ontologyFor('tests/unit/foo.test.ts')).toBe('tests/unit');
	});

	test('manifest-driven boundary for arbitrary top-level dirs', () => {
		// Without a manifest, a custom top-level dir falls back to segment 0.
		expect(ontologyFor('customdomain/index.ts')).toBe('customdomain');
		// With a manifest in customdomain/, the first two segments become the
		// boundary.
		const hasManifest = (d: string) => d === 'customdomain';
		expect(ontologyFor('customdomain/users/svc.ts', hasManifest)).toBe(
			'customdomain/users',
		);
		// Manifest under seg0/seg1 also splits there.
		const hasManifestNested = (d: string) => d === 'customdomain/users';
		expect(ontologyFor('customdomain/users/svc.ts', hasManifestNested)).toBe(
			'customdomain/users',
		);
	});

	test('inferPackageBoundary shared helper matches ontology + query fallback', () => {
		// The shared helper is the single source of truth for both ontology
		// extraction and the query-side no-ontology fallback.
		expect(inferPackageBoundary('packages/a/b.ts')).toBe('packages/a');
		expect(inferPackageBoundary('src/tools/repo-graph/builder.ts')).toBe(
			'src/tools',
		);
		expect(inferPackageBoundary('foo.ts')).toBe('foo.ts');
		expect(inferPackageBoundary('')).toBe('.');
		// Query fallback path (no hasManifest) only uses static rules.
		expect(inferPackageBoundary('customdomain/x/y.ts')).toBe('customdomain');
	});
});
