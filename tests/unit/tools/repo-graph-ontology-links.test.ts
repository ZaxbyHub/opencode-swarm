import { describe, expect, test } from 'bun:test';
import {
	extractFileOntology,
	type FileOntology,
	normalizeRoutePathInput,
} from '../../../src/tools/repo-graph';

function ontologyFor(moduleName: string, content: string): FileOntology {
	return extractFileOntology({
		moduleName,
		filePath: `/repo/${moduleName}`,
		content,
		language: 'typescript',
		exports: [],
		imports: [],
	});
}

describe('extractFileOntology links (KG-15, issue #1536)', () => {
	test('HANDLES_ROUTE binds handler_export routes to the method-named symbol at high confidence', () => {
		const ontology = ontologyFor(
			'app/api/users/route.ts',
			[
				'export async function POST(req: Request) {',
				'\treturn Response.json({});',
				'}',
			].join('\n'),
		);
		const link = ontology.links?.find((l) => l.kind === 'HANDLES_ROUTE');
		expect(link).toMatchObject({
			subject: 'POST /api/users',
			confidence: 'high',
			symbol: 'POST',
			line: 1,
		});
		expect(link?.evidence).toContain('export async function POST');
	});

	test('HANDLES_ROUTE captures named router-call handlers at medium confidence', () => {
		const ontology = ontologyFor(
			'src/routes.ts',
			[
				'export function getUser(req) { return null; }',
				"router.get('/users/:id', getUser);",
			].join('\n'),
		);
		const link = ontology.links?.find((l) => l.kind === 'HANDLES_ROUTE');
		expect(link).toMatchObject({
			subject: 'GET /users/:id',
			confidence: 'medium',
			symbol: 'getUser',
			line: 2,
		});
	});

	test('router-call binding anchors on the LAST argument (middleware chains)', () => {
		const ontology = ontologyFor(
			'src/routes.ts',
			[
				"router.get('/a', mw, handler);",
				'app.post("/b", requireAuth, validate, createUser);',
				"router.all('/c', [mw1, mw2], finalHandler);",
				"router.get('/d', (req, res) => { res.end(); });",
			].join('\n'),
		);
		const handlers = Object.fromEntries(
			(ontology.links ?? [])
				.filter((l) => l.kind === 'HANDLES_ROUTE')
				.map((l) => [l.subject, l.symbol ?? null]),
		);
		expect(handlers['GET /a']).toBe('handler');
		expect(handlers['POST /b']).toBe('createUser');
		expect(handlers['ALL /c']).toBe('finalHandler');
		// Inline arrow handler: file-level binding (no symbol).
		expect(handlers['GET /d']).toBeNull();
	});

	test('HANDLES_ROUTE file_path fallback routes stay file-level at low confidence', () => {
		const ontology = ontologyFor(
			'app/api/health/route.ts',
			'export const other = 1;',
		);
		const link = ontology.links?.find((l) => l.kind === 'HANDLES_ROUTE');
		expect(link).toMatchObject({
			subject: 'ALL /api/health',
			confidence: 'low',
		});
		expect(link?.symbol).toBeUndefined();
		expect(link?.line).toBeUndefined();
	});

	test('READS/WRITES/DELETES map entity-bearing data operations', () => {
		const ontology = ontologyFor(
			'src/db.ts',
			[
				'const a = await prisma.user.findMany();',
				'const b = await prisma.user.create({ data });',
				'const c = await db.order.delete({ where });',
			].join('\n'),
		);
		const kinds = (ontology.links ?? [])
			.filter((l) => l.kind !== 'HANDLES_ROUTE')
			.map((l) => `${l.kind}:${l.subject}:${l.line}`);
		expect(kinds).toEqual(['READS:user:1', 'WRITES:user:2', 'DELETES:order:3']);
	});

	test('transaction and migration operations map to WRITES at low confidence; entity-less ops produce no link', () => {
		const ontology = ontologyFor(
			'src/db.ts',
			[
				'await prisma.payment.$transaction(async (tx) => {});',
				'await migrateSchema();',
				'await createThing();',
			].join('\n'),
		);
		const dataLinks = (ontology.links ?? []).filter((l) =>
			['READS', 'WRITES', 'DELETES'].includes(l.kind),
		);
		expect(dataLinks.length).toBe(1);
		expect(dataLinks[0]).toMatchObject({
			kind: 'WRITES',
			subject: 'payment',
			confidence: 'low',
		});
	});

	test('VALIDATES and AUTHORIZES bind their security facts; other kinds stay facts only', () => {
		const ontology = ontologyFor(
			'src/guard.ts',
			[
				'const Parsed = z.object({});',
				'if (!hasPermission(req)) throw new Error();',
				'const session = getServerSession();',
				'domPurify.sanitize(input);',
			].join('\n'),
		);
		const kinds = (ontology.links ?? []).map((l) => l.kind);
		expect(kinds).toContain('VALIDATES');
		expect(kinds).toContain('AUTHORIZES');
		// authentication and sanitization produce facts, never links (D6).
		expect(ontology.security.map((f) => f.kind)).toEqual([
			'input_validation',
			'authorization',
			'authentication',
			'sanitization',
		]);
		const validates = (ontology.links ?? []).find(
			(l) => l.kind === 'VALIDATES',
		);
		expect(validates).toMatchObject({ line: 1, confidence: 'high' });
	});

	test('CONFIGURES extracts env keys from all four access forms, deduped by key', () => {
		const ontology = ontologyFor(
			'src/config.ts',
			[
				'const a = process.env.API_URL;',
				'const b = process.env["API_URL"];',
				'const c = import.meta.env.VITE_KEY;',
				"const d = Deno.env.get('DENO_KEY');",
			].join('\n'),
		);
		const configures = (ontology.links ?? []).filter(
			(l) => l.kind === 'CONFIGURES',
		);
		expect(configures.map((l) => l.subject)).toEqual([
			'API_URL',
			'VITE_KEY',
			'DENO_KEY',
		]);
		expect(configures[0]).toMatchObject({ line: 1, confidence: 'medium' });
	});

	test('links are not extracted from comments', () => {
		const ontology = ontologyFor(
			'src/x.ts',
			[
				'// const a = process.env.HIDDEN_KEY;',
				'/* router.get("/ghost", ghost); */',
				'export const real = 1;',
			].join('\n'),
		);
		expect(ontology.links ?? []).toEqual([]);
	});

	test('links are always an array (empty when none) and deterministically ordered', () => {
		const ontology = ontologyFor('src/plain.ts', 'export const x = 1;');
		expect(Array.isArray(ontology.links)).toBe(true);
		expect(ontology.links).toEqual([]);

		const rich = ontologyFor(
			'app/api/mixed/route.ts',
			[
				'const cfg = process.env.MIX_KEY;',
				'export async function GET() {',
				'\treturn Response.json(await prisma.thing.findMany());',
				'}',
			].join('\n'),
		);
		expect((rich.links ?? []).map((l) => l.kind)).toEqual([
			'HANDLES_ROUTE',
			'READS',
			'CONFIGURES',
		]);
	});

	test('CONFIGURES is capped and deduped at 20 keys per file', () => {
		const lines = Array.from(
			{ length: 30 },
			(_, i) => `const v${i} = process.env.KEY_${i};`,
		);
		const ontology = ontologyFor('src/env-heavy.ts', lines.join('\n'));
		const configures = (ontology.links ?? []).filter(
			(l) => l.kind === 'CONFIGURES',
		);
		expect(configures.length).toBe(20);
		expect(configures.every((l) => l.line !== undefined)).toBe(true);
	});
});

describe('normalizeRoutePathInput (KG-15)', () => {
	test('normalizes dynamic segments in both bracket forms', () => {
		expect(normalizeRoutePathInput('/api/users/[id]')).toBe('/api/users/:id');
		expect(normalizeRoutePathInput('/api/catch/[...slug]')).toBe(
			'/api/catch/:slug*',
		);
	});
	test('router-call lines over 500 chars bail out (no handler symbol, no hang)', () => {
		// PRR-009: the ReDoS guard must drop the binding, not backtrack. The
		// fixture is shaped so the handler regex WOULD capture the identifier
		// without the bail (long path + bare trailing identifier) — removing
		// the guard makes this test fail.
		const filler = 'a'.repeat(600);
		const ontology = ontologyFor(
			'src/routes.ts',
			`router.get('/x/${filler}', handler);`,
		);
		const link = ontology.links?.find((l) => l.kind === 'HANDLES_ROUTE');
		expect(link).toBeDefined();
		expect(link?.symbol).toBeUndefined();
	});

	test('extractLinks handles CRLF line endings with correct line numbers', () => {
		// PRR-014: split on /\r?\n/ must keep 1-based lines intact.
		const ontology = ontologyFor(
			'src/crlf.ts',
			'const a = process.env.FIRST_KEY;\r\nconst b = process.env.SECOND_KEY;',
		);
		const configures = (ontology.links ?? []).filter(
			(l) => l.kind === 'CONFIGURES',
		);
		expect(configures.map((l) => [l.subject, l.line])).toEqual([
			['FIRST_KEY', 1],
			['SECOND_KEY', 2],
		]);
	});

	test('all seven persisted link kinds appear in the declared deterministic order', () => {
		// PRR-016: HANDLES_ROUTE -> READS/WRITES/DELETES -> VALIDATES/AUTHORIZES -> CONFIGURES.
		const ontology = ontologyFor(
			'app/api/full/route.ts',
			[
				'const cfg = process.env.FULL_KEY;',
				'export async function GET() {',
				'  if (!hasPermission(req)) throw new Error();',
				'  const parsed = Body.safeParse(await req.json());',
				'  const rows = await prisma.widget.findMany();',
				'  const created = await prisma.widget.create({ data: parsed });',
				'  await db.widget.delete({ where: { id: 1 } });',
				'  return Response.json(created);',
				'}',
			].join('\n'),
		);
		// security links sort by line: authorization(3) before validation(4).
		expect((ontology.links ?? []).map((l) => l.kind)).toEqual([
			'HANDLES_ROUTE',
			'READS',
			'WRITES',
			'DELETES',
			'AUTHORIZES',
			'VALIDATES',
			'CONFIGURES',
		]);
	});

	test('collapses duplicate slashes and tolerates backslashes', () => {
		expect(normalizeRoutePathInput('//a//b')).toBe('/a/b');
		expect(normalizeRoutePathInput('\\a\\b')).toBe('/a/b');
	});
});
