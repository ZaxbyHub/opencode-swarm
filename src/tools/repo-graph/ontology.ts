import * as path from 'node:path';
import type {
	ConventionFact,
	DataOperationFact,
	FileOntology,
	FileRole,
	OntologyFinding,
	RouteFact,
	RouteMethod,
	SecurityFact,
} from './types';

export interface ExtractFileOntologyInput {
	moduleName: string;
	filePath: string;
	content: string;
	language: string;
	exports: string[];
	imports: string[];
}

const HTTP_METHODS: RouteMethod[] = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
];

const MAX_FACTS_PER_KIND = 50;

function stripComments(content: string): string {
	let out = '';
	let i = 0;
	let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' =
		'code';
	while (i < content.length) {
		const ch = content[i];
		const next = i + 1 < content.length ? content[i + 1] : '';
		switch (state) {
			case 'code':
				if (ch === '/' && next === '/') {
					state = 'line';
					i += 2;
				} else if (ch === '/' && next === '*') {
					state = 'block';
					i += 2;
				} else {
					if (ch === "'") state = 'single';
					else if (ch === '"') state = 'double';
					else if (ch === '`') state = 'template';
					out += ch;
					i++;
				}
				break;
			case 'single':
			case 'double':
			case 'template': {
				const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
				if (ch === '\\') {
					out += ch + next;
					i += 2;
				} else {
					if (ch === quote) state = 'code';
					out += ch;
					i++;
				}
				break;
			}
			case 'line':
				if (ch === '\n') {
					state = 'code';
					out += ch;
				}
				i++;
				break;
			case 'block':
				if (ch === '*' && next === '/') {
					state = 'code';
					i += 2;
				} else {
					if (ch === '\n') out += ch;
					i++;
				}
				break;
		}
	}
	return out;
}

function normalizeModuleName(moduleName: string): string {
	return moduleName.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function addRole(roles: Set<FileRole>, role: FileRole): void {
	roles.add(role);
}

function boundaryForModule(moduleName: string): string {
	const normalized = normalizeModuleName(moduleName);
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length === 0) return '.';
	if ((parts[0] === 'packages' || parts[0] === 'crates') && parts.length >= 2) {
		return `${parts[0]}/${parts[1]}`;
	}
	if (parts[0] === 'src' && parts.length >= 3) {
		if (parts[1] === 'tools' && parts[2] === 'repo-graph') {
			return 'src/tools/repo-graph';
		}
		return `src/${parts[1]}`;
	}
	if (parts[0] === 'tests' && parts.length >= 2) return `tests/${parts[1]}`;
	return parts[0];
}

function inferRoles(moduleName: string, content: string): FileRole[] {
	const normalized = normalizeModuleName(moduleName).toLowerCase();
	const roles = new Set<FileRole>();

	if (
		/(^|\/)(__tests__|tests?)\//.test(normalized) ||
		/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
	) {
		addRole(roles, 'test_file');
	}
	if (
		/(^|\/)(app\/api|pages\/api)\//.test(normalized) ||
		/(^|\/)(routes?|controllers?)\//.test(normalized) ||
		/\/route\.[cm]?[jt]sx?$/.test(normalized) ||
		/\b(router|app|server)\s*\.\s*(get|post|put|patch|delete|all)\s*\(/i.test(
			content,
		)
	) {
		addRole(roles, 'api_route');
	}
	if (/(^|\/)middleware\.[cm]?[jt]sx?$/.test(normalized)) {
		addRole(roles, 'middleware');
	}
	if (normalized.startsWith('src/tools/')) addRole(roles, 'swarm_tool');
	if (normalized.startsWith('src/hooks/')) addRole(roles, 'hook');
	if (normalized.startsWith('src/agents/')) addRole(roles, 'agent');
	if (
		normalized.startsWith('src/cli/') ||
		normalized.startsWith('src/commands/')
	) {
		addRole(roles, 'cli_command');
	}
	if (
		normalized.startsWith('src/config/') ||
		/(^|\/)(config|settings)\.[cm]?[jt]s$/.test(normalized)
	) {
		addRole(roles, 'config');
	}
	if (
		/(^|\/)(schema|schemas|types)\//.test(normalized) ||
		/\b(z\.object|type\s+\w+\s*=|interface\s+\w+)/.test(content)
	) {
		addRole(roles, 'schema');
	}
	if (
		/(^|\/)(db|database|repositories?|models?|migrations?)\//.test(
			normalized,
		) ||
		/\b(prisma|drizzle|sequelize|knex|sqlite|sql`|db\.)/i.test(content)
	) {
		addRole(roles, 'data_module');
	}
	if (
		/(^|\/)(services?|lib|utils?)\//.test(normalized) ||
		/\bexport\s+(async\s+)?function\b/.test(content)
	) {
		addRole(roles, 'service_module');
	}
	if (/\.(md|mdx|rst)$/.test(normalized)) addRole(roles, 'documentation');

	if (roles.size === 0) addRole(roles, 'source_module');
	return uniqueSorted(roles);
}

function pathRouteFromModule(moduleName: string): string | null {
	const normalized = normalizeModuleName(moduleName);
	const parts = normalized.split('/');
	const appApi = parts.findIndex((part, index) => {
		return part === 'api' && index > 0 && parts[index - 1] === 'app';
	});
	if (appApi >= 0) {
		const routeParts = parts
			.slice(appApi)
			.filter((part) => !/^route\.[cm]?[jt]sx?$/.test(part));
		return `/${routeParts.map(routeSegment).join('/')}`.replace(/\/+/g, '/');
	}
	const pagesApi = parts.findIndex((part, index) => {
		return part === 'api' && index > 0 && parts[index - 1] === 'pages';
	});
	if (pagesApi >= 0) {
		const last = parts[parts.length - 1]?.replace(/\.[^.]+$/, '');
		const routeParts = [...parts.slice(pagesApi, -1), last].filter(Boolean);
		return `/${routeParts.map(routeSegment).join('/')}`.replace(/\/+/g, '/');
	}
	return null;
}

function routeSegment(segment: string): string {
	return segment
		.replace(
			/^\[(\.\.\.)?(.+)]$/,
			(_m, rest: string | undefined, name: string) =>
				rest ? `:${name}*` : `:${name}`,
		)
		.replace(/\.[^.]+$/, '');
}

function extractRoutes(moduleName: string, content: string): RouteFact[] {
	const routes: RouteFact[] = [];
	const pathRoute = pathRouteFromModule(moduleName);
	const lines = content.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const method of HTTP_METHODS) {
			const exportPattern = new RegExp(
				`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`,
			);
			if (pathRoute && exportPattern.test(line)) {
				routes.push({
					method,
					path: pathRoute,
					line: i + 1,
					source: 'handler_export',
				});
			}
		}

		const routerMatch = line.match(
			/\b(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`\0\r\n]+)['"`]/i,
		);
		if (routerMatch) {
			routes.push({
				method: routerMatch[1].toUpperCase() as RouteMethod,
				path: routerMatch[2],
				line: i + 1,
				source: 'router_call',
			});
		}
	}

	if (pathRoute && routes.length === 0) {
		routes.push({ method: 'ALL', path: pathRoute, source: 'file_path' });
	}

	return routes.slice(0, MAX_FACTS_PER_KIND);
}

function classifyDataOperation(line: string): DataOperationFact | null {
	const trimmed = line.trim();
	const lower = trimmed.toLowerCase();
	const evidence = trimmed.slice(0, 160);
	let operation: DataOperationFact['operation'] | null = null;
	let access: DataOperationFact['access'] = 'unknown';
	let entity: string | undefined;

	if (/\b(transaction|begintransaction|commit|rollback)\b/i.test(trimmed)) {
		operation = 'transaction';
		access = 'database';
	}
	if (
		/\b(migrate|migration|schema\.alter|createTable|dropTable)\b/i.test(trimmed)
	) {
		operation = 'migration';
		access = 'database';
	}
	if (
		/\b(findMany|findUnique|findFirst|select|query|count|aggregate)\b/.test(
			trimmed,
		)
	) {
		operation ??= 'read';
	}
	if (/\b(create|insert|update|upsert|save|patch)\b/.test(trimmed)) {
		operation ??= 'write';
	}
	if (/\b(delete|deleteMany|remove|destroy)\b/.test(trimmed)) {
		operation = 'delete';
	}
	if (
		/\b(sql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bfrom\b)/i.test(
			trimmed,
		)
	) {
		access = 'sql';
	}
	if (
		/\b(prisma|drizzle|sequelize|knex|db\.|database\.|repository\.)/i.test(
			trimmed,
		)
	) {
		access = access === 'sql' ? 'sql' : 'orm';
	}
	if (/\b(readFile|writeFile|appendFile|rmSync|unlink)\b/.test(trimmed)) {
		access = 'filesystem';
		operation ??= lower.includes('read') ? 'read' : 'write';
	}
	if (/\b(fetch|axios|http\.|https\.)\b/.test(trimmed)) {
		access = 'network';
		operation ??= 'read';
	}

	const entityMatch = trimmed.match(/\b(?:prisma|db|database)\.(\w+)/i);
	if (entityMatch) entity = entityMatch[1];

	if (!operation) return null;
	return { operation, access, entity, line: 0, evidence };
}

function extractDataOperations(content: string): DataOperationFact[] {
	const facts: DataOperationFact[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const fact = classifyDataOperation(lines[i]);
		if (!fact) continue;
		fact.line = i + 1;
		facts.push(fact);
		if (facts.length >= MAX_FACTS_PER_KIND) break;
	}
	return facts;
}

function extractSecurityFacts(content: string): SecurityFact[] {
	const facts: SecurityFact[] = [];
	const lines = content.split(/\r?\n/);
	const push = (
		kind: SecurityFact['kind'],
		line: number,
		evidence: string,
		confidence: SecurityFact['confidence'],
	) => {
		facts.push({
			kind,
			line,
			evidence: evidence.trim().slice(0, 160),
			confidence,
		});
	};

	for (let i = 0; i < lines.length && facts.length < MAX_FACTS_PER_KIND; i++) {
		const line = lines[i];
		if (
			/\b(requireAuth|requireUser|getServerSession|currentUser|verifyToken|jwt|isAuthenticated|ctx\.user|session)\b/i.test(
				line,
			)
		) {
			push('authentication', i + 1, line, 'high');
		}
		if (
			/\b(requireRole|hasPermission|authorize|authorization|isAdmin|rbac|policy\.check|can\()\b/i.test(
				line,
			)
		) {
			push('authorization', i + 1, line, 'high');
		}
		if (
			/\b(z\.object|safeParse|\.parse\(|joi\.|yup\.|validate\w*)\b/i.test(line)
		) {
			push('input_validation', i + 1, line, 'high');
		}
		if (/\b(csrf|csrfToken|sameSite)\b/i.test(line)) {
			push('csrf', i + 1, line, 'medium');
		}
		if (/\b(sanitize|escapeHtml|DOMPurify|xss)\b/i.test(line)) {
			push('sanitization', i + 1, line, 'medium');
		}
		if (/\b(secret|api[_-]?key|token|password)\b/i.test(line)) {
			push('secret_handling', i + 1, line, 'low');
		}
	}
	return facts;
}

function extractConventions(
	moduleName: string,
	roles: FileRole[],
	routes: RouteFact[],
): ConventionFact[] {
	const conventions: ConventionFact[] = [];
	if (roles.includes('test_file')) {
		conventions.push({
			name: 'test_file_naming',
			evidence: `${path.basename(moduleName)} matches test/spec naming`,
		});
	}
	if (routes.some((route) => route.source === 'handler_export')) {
		conventions.push({
			name: 'next_app_route_handler',
			evidence: 'HTTP method exports map to route handlers',
		});
	}
	if (roles.includes('swarm_tool')) {
		conventions.push({
			name: 'swarm_tool_module',
			evidence: 'module lives under src/tools',
		});
	}
	if (roles.includes('hook')) {
		conventions.push({
			name: 'hook_module',
			evidence: 'module lives under src/hooks',
		});
	}
	return conventions;
}

function buildFindings(
	roles: FileRole[],
	routes: RouteFact[],
	dataOperations: DataOperationFact[],
	security: SecurityFact[],
): OntologyFinding[] {
	const findings: OntologyFinding[] = [];
	const hasAuth = security.some(
		(fact) =>
			fact.kind === 'authentication' ||
			fact.kind === 'authorization' ||
			fact.kind === 'csrf',
	);
	const hasValidation = security.some(
		(fact) => fact.kind === 'input_validation' || fact.kind === 'sanitization',
	);
	const mutatingRoute = routes.some((route) =>
		['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method),
	);
	const writes = dataOperations.filter((fact) =>
		['write', 'delete', 'migration'].includes(fact.operation),
	);
	const hasTransaction = dataOperations.some(
		(fact) => fact.operation === 'transaction',
	);

	if (roles.includes('api_route') && routes.length > 0 && !hasAuth) {
		findings.push({
			code: 'api_route_without_detected_auth',
			severity: 'medium',
			message:
				'No authentication, authorization, or CSRF guard was detected near this route.',
			line: routes[0]?.line,
		});
	}
	if (mutatingRoute && !hasValidation) {
		findings.push({
			code: 'mutating_route_without_detected_validation',
			severity: 'medium',
			message:
				'Route appears to mutate state without a detected validation or sanitization fact.',
			line: routes.find((route) =>
				['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method),
			)?.line,
		});
	}
	if (writes.length > 1 && !hasTransaction) {
		findings.push({
			code: 'multiple_writes_without_detected_transaction',
			severity: 'low',
			message:
				'Multiple write/delete operations were detected without a transaction fact.',
			line: writes[0]?.line,
		});
	}
	return findings;
}

export function extractFileOntology(
	input: ExtractFileOntologyInput,
): FileOntology {
	const moduleName = normalizeModuleName(input.moduleName);
	const content = stripComments(input.content);
	const roles = inferRoles(moduleName, content);
	const routes = extractRoutes(moduleName, content);
	const dataOperations = extractDataOperations(content);
	const security = extractSecurityFacts(content);
	const conventions = extractConventions(moduleName, roles, routes);
	const findings = buildFindings(roles, routes, dataOperations, security);

	return {
		roles,
		packageBoundary: boundaryForModule(moduleName),
		routes,
		dataOperations,
		security,
		conventions,
		findings,
	};
}
