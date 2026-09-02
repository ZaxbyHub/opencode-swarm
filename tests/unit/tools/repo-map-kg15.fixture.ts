/**
 * Shared KG-15 workspace fixture (issue #1536).
 *
 * Materializes the four fixtures the issue's verification expectations name:
 *   1. an API route with auth, validation, a data write, and a test file
 *      (`app/api/users/route.ts` + `src/services/user-service.test.ts`);
 *   2. an unguarded mutating route (`app/api/orders/route.ts`) — must surface
 *      `api_route_without_detected_auth` / `mutating_route_without_detected_validation`;
 *   3. an implementation file with a colocated test (`src/lib/calc.ts` +
 *      `calc.test.ts`, and `src/lib/widget.ts` + `widget.spec.ts` which does
 *      NOT import the implementation, exercising the colocated-only heuristic);
 *   4. a service used by both a route and a test (`src/services/user-service.ts`).
 * Plus a fixture file (`src/test-fixtures/users.fixture.ts`) imported by the
 * service test, exercising USES_FIXTURE derivation, and an env-key access
 * (`process.env.USERS_TABLE`) exercising CONFIGURES.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Kg15Workspace {
	usersRoute: string;
	ordersRoute: string;
	userService: string;
	userServiceTest: string;
	calc: string;
	calcTest: string;
	widget: string;
	widgetSpec: string;
	userFixture: string;
}

export function writeKg15Workspace(tmp: string): Kg15Workspace {
	const writeFile = (rel: string, lines: string[]): void => {
		const target = path.join(tmp, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${lines.join('\n')}\n`);
	};

	writeFile('src/services/user-service.ts', [
		'export const USERS_TABLE = process.env.USERS_TABLE;',
		'',
		'export interface NewUser {',
		'\tname: string;',
		'\temail: string;',
		'}',
		'',
		'export async function createUser(input: NewUser) {',
		'\t// create is classified as a write on the prisma.user entity',
		'\treturn globalThis.prisma.user.create({ data: input });',
		'}',
		'',
		'export async function listUsers() {',
		'\treturn globalThis.prisma.user.findMany();',
		'}',
	]);

	writeFile('src/services/user-service.test.ts', [
		"import { createUser } from './user-service';",
		"import { userFixture } from '../test-fixtures/users.fixture';",
		'',
		'describe("user-service", () => {',
		'\tit("creates users", async () => {',
		'\t\tconst created = await createUser(userFixture);',
		'\t\texpect(created).toBeTruthy();',
		'\t});',
		'});',
	]);

	writeFile('app/api/users/route.ts', [
		"import { z } from 'zod';",
		"import { createUser, listUsers } from '../../../src/services/user-service';",
		'',
		'const Body = z.object({ name: z.string(), email: z.string().email() });',
		'',
		'export async function GET() {',
		'\treturn Response.json(await listUsers());',
		'}',
		'',
		'export async function POST(req: Request) {',
		'\tconst session = await getServerSession();',
		'\tif (!session) return new Response("denied", { status: 401 });',
		'\tconst parsed = Body.safeParse(await req.json());',
		'\tif (!parsed.success) return new Response("bad request", { status: 400 });',
		'\tconst user = await createUser(parsed.data);',
		'\treturn Response.json(user);',
		'}',
	]);

	writeFile('app/api/orders/route.ts', [
		'export async function POST(req: Request) {',
		'\tconst order = await globalThis.prisma.order.create({',
		'\t\tdata: await req.json(),',
		'\t});',
		'\treturn Response.json(order);',
		'}',
	]);

	writeFile('src/lib/calc.ts', [
		'export function add(a: number, b: number): number {',
		'\treturn a + b;',
		'}',
		'',
		'export function unusedHelper(): number {',
		'\treturn 0;',
		'}',
	]);

	writeFile('src/lib/calc.test.ts', [
		"import { add } from './calc';",
		'',
		'describe("calc", () => {',
		'\tit("adds", () => {',
		'\t\texpect(add(1, 2)).toBe(3);',
		'\t});',
		'});',
	]);

	writeFile('src/lib/widget.ts', [
		'export function makeWidget(): string {',
		'\treturn "widget";',
		'}',
	]);

	// Deliberately does NOT import widget.ts: exercises the colocated-name
	// heuristic (basis 'colocated', medium confidence).
	writeFile('src/lib/widget.spec.ts', [
		'describe("widget (heuristic)", () => {',
		'\tit("makes widgets elsewhere", () => {',
		'\t\texpect(true).toBe(true);',
		'\t});',
		'});',
	]);

	writeFile('src/test-fixtures/users.fixture.ts', [
		'export const userFixture = {',
		'\tname: "Ada",',
		'\temail: "ada@example.com",',
		'};',
	]);

	return {
		usersRoute: 'app/api/users/route.ts',
		ordersRoute: 'app/api/orders/route.ts',
		userService: 'src/services/user-service.ts',
		userServiceTest: 'src/services/user-service.test.ts',
		calc: 'src/lib/calc.ts',
		calcTest: 'src/lib/calc.test.ts',
		widget: 'src/lib/widget.ts',
		widgetSpec: 'src/lib/widget.spec.ts',
		userFixture: 'src/test-fixtures/users.fixture.ts',
	};
}
