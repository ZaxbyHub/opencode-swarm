import { describe, expect, test } from 'bun:test';
import { extractFileOntology } from '../../../src/tools/repo-graph';

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
