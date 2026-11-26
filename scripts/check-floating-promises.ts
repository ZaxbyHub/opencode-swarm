/**
 * Floating-promise candidate scanner (r17 §7) — TypeScript-checker-based,
 * no inference budget.
 *
 * Why this exists: Biome's lint/nursery/noFloatingPromises has a type
 * inference budget and does not check the two largest files in this repo
 * (src/index.ts ~6000 lines, src/background/completion-observer.ts ~3100
 * lines) — verified during r16: a deliberately-unawaited
 * updateContextMapAfterAgentLocked call is flagged in a small probe file
 * but invisible in the real files. This scanner uses the full TypeScript
 * checker instead.
 *
 * SEMANTICS — a finding is a CANDIDATE, not a bug:
 * An ExpressionStatement is reported when its expression is Promise-like
 * (has a callable `then`), and it is not `await`ed, not a `.then/.catch/
 * .finally` chain member, and not stored/returned (assignments and returns
 * are not ExpressionStatements). Two categories:
 *   - floating:        bare promise-valued call, no visible handling
 *   - void_discard:    `void promiseCall()` — an explicit discard proves
 *                      INTENT to detach, never that rejection is safe; it
 *                      is surfaced for human review, not as an error.
 *
 * DOCUMENTED EXCEPTIONS (do not "fix" these mechanically — r17 triage):
 *   1. Assignment statements of handled chains (`x = p.catch(...)`,
 *      `x = queue.then(task, task)`, memoized `x ??= run()`) — the scanner
 *      reports the statement shape; the stored promise's rejection is
 *      handled at the consumption site (await/return into a promise-aware
 *      caller). r17 triage: ~20 findings, all Intentional.
 *   2. AutomationEventBus.publish() fire-and-forget (31 sites) — publish
 *      catches EVERY listener error inside its Promise.all mapper and its
 *      own body cannot realistically reject; awaiting would serialize
 *      event fan-out (r17: verified the full function).
 *   3. PlanSyncWorker.executeSync / notifyPrFeedbackLoop — full internal
 *      try/catch containment by contract; documented in-source.
 *   4. Never-rejecting promises (resolve-only constructors, self-contained
 *      async IIFEs with internal catch, empty p-limit callbacks).
 *
 * This is a REVIEW TOOL, not a CI ratchet: the existing ~82 candidates were
 * individually triaged in r17 (see docs/releases pending fragment / the r17
 * session report) with zero proven bugs; a ratchet must only ever block NEW
 * genuine hazards, never the triaged baseline.
 *
 * Usage: bun scripts/check-floating-promises.ts [scanDir]
 * Programmatic: scanFiles(repoRoot, files) (used by the fixture suite
 * tests/unit/scripts/check-floating-promises-fixtures.test.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface FloatingPromiseFinding {
	file: string;
	line: number;
	category: 'floating' | 'void_discard';
	text: string;
}

interface TsApi {
	createProgram: typeof import('typescript').createProgram;
	parseJsonConfigFileContent: typeof import('typescript').parseJsonConfigFileContent;
	parseConfigFileTextToJson: typeof import('typescript').parseConfigFileTextToJson;
	sys: typeof import('typescript').sys;
	isExpressionStatement: typeof import('typescript').isExpressionStatement;
	isAwaitExpression: typeof import('typescript').isAwaitExpression;
	isVoidExpression: typeof import('typescript').isVoidExpression;
	isCallExpression: typeof import('typescript').isCallExpression;
	isPropertyAccessExpression: typeof import('typescript').isPropertyAccessExpression;
	forEachChild: typeof import('typescript').forEachChild;
}

async function loadTypeScript(repoRoot: string): Promise<TsApi> {
	return (await import(
		pathToFileURL(
			path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'typescript.js'),
		).href
	)) as unknown as TsApi;
}

const HANDLED_CHAIN_MEMBERS = new Set(['then', 'catch', 'finally']);

/**
 * Scan the given files (project-relative or absolute) for floating-promise
 * candidates using the full TS checker.
 */
export async function scanFiles(
	repoRoot: string,
	files: string[],
): Promise<FloatingPromiseFinding[]> {
	const ts = await loadTypeScript(repoRoot);
	const configRaw = fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf-8');
	const config = ts.parseJsonConfigFileContent(
		ts.parseConfigFileTextToJson('tsconfig.json', configRaw).config,
		ts.sys,
		repoRoot,
	);
	const absolute = files.map((file) => path.resolve(repoRoot, file));
	const program = ts.createProgram(absolute, { ...config.options, noEmit: true });
	const checker = program.getTypeChecker();

	function isPromiseLike(expr: unknown, sourceFile: unknown): boolean {
		const type = checker.getTypeAtLocation(expr as never);
		// Union constituents are checked individually: the checker does not
		// resolve `then` on a union like `void | Promise<void>`, but the
		// runtime MAY take the promise branch — a bare call of such a union
		// is a floating-promise candidate whenever ANY constituent is
		// Promise-like (r17 §7 union case).
		const candidates = type.isUnion() ? type.types : [type];
		for (const candidate of candidates) {
			const then = candidate.getProperty('then');
			if (!then) continue;
			const thenType = checker.getTypeOfSymbolAtLocation(then, expr as never);
			if (thenType.getCallSignatures().length > 0) return true;
		}
		return false;
	}

	const findings: FloatingPromiseFinding[] = [];
	for (const sourcePath of absolute) {
		const sf = program.getSourceFile(sourcePath);
		if (!sf) continue;
		const visit = (node: unknown): void => {
			const n = node as import('typescript').Node;
			if (ts.isExpressionStatement(n)) {
				const expr = n.expression;
				if (ts.isAwaitExpression(expr)) {
					ts.forEachChild(n, visit);
					return;
				}
				if (ts.isVoidExpression(expr)) {
					// `void p()` — explicit detach. Surface for review when the
					// operand is Promise-like; the discard proves intent, not a
					// safe rejection path (r17 §7).
					if (isPromiseLike(expr.expression, sf)) {
						const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
						findings.push({
							file: path.relative(repoRoot, sourcePath),
							line: line + 1,
							category: 'void_discard',
							text: expr.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
						});
					}
					ts.forEachChild(n, visit);
					return;
				}
				if (
					ts.isCallExpression(expr) &&
					ts.isPropertyAccessExpression(expr.expression) &&
					HANDLED_CHAIN_MEMBERS.has(expr.expression.name.text)
				) {
					ts.forEachChild(n, visit);
					return;
				}
				if (isPromiseLike(expr, sf)) {
					const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
					findings.push({
						file: path.relative(repoRoot, sourcePath),
						line: line + 1,
						category: 'floating',
						text: expr.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
					});
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return findings;
}

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'graphify-out', 'dist', '.git', '.swarm']);

async function main(): Promise<void> {
	const repoRoot = process.argv[2] ?? process.cwd();
	if (!fs.existsSync(path.join(repoRoot, 'tsconfig.json'))) {
		console.error('usage: check-floating-promises.ts [repoRoot] [scanDir]');
		process.exit(2);
	}
	const scanDir = process.argv[3] ?? 'src';
	const sourceFiles: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
				continue;
			}
			if (!entry.name.endsWith('.ts')) continue;
			if (entry.name.endsWith('.test.ts')) continue; // production code only
			if (entry.name.endsWith('.d.ts')) continue;
			sourceFiles.push(path.join(dir, entry.name));
		}
	};
	walk(path.join(repoRoot, scanDir));
	const findings = await scanFiles(repoRoot, sourceFiles);
	const byFile = new Map<string, FloatingPromiseFinding[]>();
	for (const f of findings) {
		const list = byFile.get(f.file) ?? [];
		list.push(f);
		byFile.set(f.file, list);
	}
	for (const [file, list] of [...byFile.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		console.log(`\n${file} (${list.length})`);
		for (const f of list) {
			console.log(`  ${f.line} [${f.category}]: ${f.text}`);
		}
	}
	console.log(
		`\nTOTAL: ${findings.length} candidates (review tool — see the header for documented exceptions; NOT a CI ratchet)`,
	);
	process.exit(0);
}

// Run as CLI only when invoked directly (not imported by the fixture test).
if (
	process.argv[1] &&
	fs.realpathSync(process.argv[1]) ===
		fs.realpathSync(fileURLToPath(import.meta.url))
) {
	await main();
}
