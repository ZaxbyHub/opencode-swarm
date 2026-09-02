#!/usr/bin/env bun
/**
 * Issue #2474 — recurrence guardrail for lexical project-identity decisions.
 *
 * `path.resolve` is useful for constructing a path, but it is not a physical
 * project-root identity. This AST check catches the easy-to-reintroduce forms
 * where a raw resolve result is compared, returned as a root/cache key, or
 * inserted into a project-scoped Map/Set/template key. It understands direct,
 * named, and aliased `resolve` imports and tracks simple function-local
 * intermediates. The canonical-root helper is the sole permitted implementation
 * of a same-root comparison.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const PATH_MODULES = new Set([
	'path',
	'node:path',
	'path/posix',
	'node:path/posix',
	'path/win32',
	'node:path/win32',
]);
const BASE_PATH_MODULES = new Set(['path', 'node:path']);
const LEXICAL_ALIAS_KEY_ALLOWED_FILES = new Set([
	'src/db/project-db.ts',
	'src/memory/provider-pool.ts',
	'src/utils/canonical-root.ts',
]);
const EQ_NEQ = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const ROOT_WORD = /(?:^|_|-)(?:dir|directory|root|project|workspace|worktree|lane)(?:$|_|-)/i;
const IDENTITY_WORD = /(?:root|project|workspace|cache|key|identity|normalized|resolved)/i;

export type PathIdentityViolationKind =
	| 'comparison'
	| 'project-key'
	| 'project-return'
	| 'lexical-alias'
	| 'duplicate-helper';

export interface PathIdentityViolation {
	file: string;
	line: number;
	kind: PathIdentityViolationKind;
	snippet: string;
	detail: string;
}

function calleeName(expression: ts.LeftHandSideExpression): string | undefined {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

function isRootName(name: string): boolean {
	return ROOT_WORD.test(name) || /^(?:cwd|base|current|recorded|expected)$/i.test(name);
}

function isIdentityName(name: string): boolean {
	return IDENTITY_WORD.test(name) || isRootName(name);
}

function isDirectRootName(name: string): boolean {
	return /(?:directory|workspace|worktree(?:Path)?|projectRoot|projectDirectory|rootDir|rootDirectory|rootPath)$/i.test(
		name,
	);
}

function isRootIdentityName(name: string): boolean {
	return isDirectRootName(name) || /(?:^|[_-])root(?:Path)?$/i.test(name);
}

function expressionIdentityName(node: ts.Node): string {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return '';
}

function importsResolve(sf: ts.SourceFile): Set<string> {
	const named = new Set<string>();
	function addNamespace(name: string, moduleName: string): void {
		named.add(`${name}.resolve`);
		if (BASE_PATH_MODULES.has(moduleName)) {
			named.add(`${name}.posix.resolve`);
			named.add(`${name}.win32.resolve`);
		}
	}
	for (const statement of sf.statements) {
		if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			if (
				ts.isExternalModuleReference(reference) &&
				reference.expression &&
				ts.isStringLiteral(reference.expression) &&
				PATH_MODULES.has(reference.expression.text)
			) {
				addNamespace(statement.name.text, reference.expression.text);
			}
			continue;
		}
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		if (!PATH_MODULES.has(statement.moduleSpecifier.text)) continue;
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name) addNamespace(clause.name.text, statement.moduleSpecifier.text);
		if (!clause.namedBindings) continue;
		if (ts.isNamespaceImport(clause.namedBindings)) {
			addNamespace(
				clause.namedBindings.name.text,
				statement.moduleSpecifier.text,
			);
			continue;
		}
		for (const element of clause.namedBindings.elements) {
			if (element.propertyName?.text === 'resolve' || element.name.text === 'resolve') {
				named.add(element.name.text);
			}
		}
	}

	// Track explicit aliases of a known path.resolve binding. Iterate to a fixed
	// point so a short alias chain is covered without requiring type resolution.
	let changed = true;
	while (changed) {
		changed = false;
		function add(name: string): void {
			if (named.has(name)) return;
			named.add(name);
			changed = true;
		}
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && node.initializer) {
				const initializer = node.initializer;
				if (ts.isIdentifier(node.name)) {
					if (
						(ts.isPropertyAccessExpression(initializer) &&
							named.has(initializer.getText(sf))) ||
						(ts.isIdentifier(initializer) && named.has(initializer.text))
					) {
						add(node.name.text);
					}
				} else if (
					ts.isObjectBindingPattern(node.name) &&
					named.has(`${initializer.getText(sf)}.resolve`)
				) {
					for (const element of node.name.elements) {
						const importedName = element.propertyName?.getText(sf) ?? element.name.getText(sf);
						if (importedName === 'resolve' && ts.isIdentifier(element.name)) {
							add(element.name.text);
						}
					}
				}
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left) &&
				((ts.isPropertyAccessExpression(node.right) &&
					named.has(node.right.getText(sf))) ||
					(ts.isIdentifier(node.right) && named.has(node.right.text)))
			) {
				add(node.left.text);
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
	}
	return named;
}

function isResolveCall(node: ts.Node, resolveNames: Set<string>): node is ts.CallExpression {
	if (!ts.isCallExpression(node)) return false;
	if (ts.isIdentifier(node.expression)) return resolveNames.has(node.expression.text);
	return ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'resolve' &&
		resolveNames.has(`${node.expression.expression.getText()}.resolve`);
}

function containsRootResolve(node: ts.Node, resolveNames: Set<string>): boolean {
	let found = false;
	function visit(current: ts.Node): void {
		if (isResolveCall(current, resolveNames) && resolveLooksLikeRoot(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function resolveLooksLikeRoot(call: ts.CallExpression): boolean {
	const first = call.arguments[0];
	if (!first) return false;
	return (
		call.arguments.length === 1 &&
		(isRootName(expressionIdentityName(first)) ||
			isRootIdentityName(expressionIdentityName(first)))
	);
}

function nearestFunction(node: ts.Node, sf: ts.SourceFile): ts.Node {
	return ts.findAncestor(node, ts.isFunctionLike) ?? sf;
}

/** Pure AST scan; no filesystem access, making the recurrence predicate fixture-testable. */
export function scanSourceForPathIdentity(
	relPath: string,
	source: string,
): PathIdentityViolation[] {
	const normalizedRelPath = relPath.replace(/\\/g, '/');
	if (normalizedRelPath === 'src/utils/canonical-root.ts') return [];
	const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const resolveNames = importsResolve(sf);
	const sourceLines = source.split('\n');
	const violations: PathIdentityViolation[] = [];
	const taintedByScope = new Map<ts.Node, Set<string>>();

	function lineOf(node: ts.Node): number {
		return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	}
	function snippet(node: ts.Node): string {
		return (sourceLines[lineOf(node) - 1] ?? '').trim();
	}
	function add(node: ts.Node, kind: PathIdentityViolationKind, detail: string): void {
		violations.push({ file: relPath, line: lineOf(node), kind, snippet: snippet(node), detail });
	}
	if (!LEXICAL_ALIAS_KEY_ALLOWED_FILES.has(normalizedRelPath)) {
		let lexicalAliasReference: ts.Identifier | undefined;
		function findLexicalAliasReference(node: ts.Node): void {
			if (lexicalAliasReference) return;
			if (ts.isIdentifier(node) && node.text === 'lexicalRootAliasKey') {
				lexicalAliasReference = node;
				return;
			}
			ts.forEachChild(node, findLexicalAliasReference);
		}
		findLexicalAliasReference(sf);
		if (lexicalAliasReference) {
			add(
				lexicalAliasReference,
				'lexical-alias',
				'lexical root alias keys are restricted to bounded resource lifecycle tables',
			);
		}
	}
	function scopeTaint(scope: ts.Node): Set<string> {
		let set = taintedByScope.get(scope);
		if (!set) {
			set = new Set();
			taintedByScope.set(scope, set);
		}
		return set;
	}
	function expressionTaintKey(node: ts.Node): string | undefined {
		if (ts.isIdentifier(node)) return node.text;
		if (ts.isPropertyAccessExpression(node)) {
			const base = expressionTaintKey(node.expression);
			return base ? `${base}.${node.name.text}` : undefined;
		}
		if (
			ts.isElementAccessExpression(node) &&
			node.argumentExpression &&
			(ts.isStringLiteral(node.argumentExpression) ||
				ts.isNumericLiteral(node.argumentExpression))
		) {
			const base = expressionTaintKey(node.expression);
			return base ? `${base}.${node.argumentExpression.text}` : undefined;
		}
		return undefined;
	}
	function isRootKeyExpression(node: ts.Node, scope: ts.Node): boolean {
		const taintKey = expressionTaintKey(node);
		if (taintKey && scopeTaint(scope).has(taintKey)) return true;
		if (isResolveCall(node, resolveNames)) return resolveLooksLikeRoot(node);
		if (ts.isParenthesizedExpression(node)) {
			return isRootKeyExpression(node.expression, scope);
		}
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			return isRootKeyExpression(node.expression, scope);
		}
		if (ts.isNonNullExpression(node)) {
			return isRootKeyExpression(node.expression, scope);
		}
		if (ts.isConditionalExpression(node)) {
			return (
				isRootKeyExpression(node.whenTrue, scope) ||
				isRootKeyExpression(node.whenFalse, scope)
			);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			/^(?:normalize|toLowerCase|toUpperCase|replace)$/.test(
				node.expression.name.text,
			)
		) {
			return (
				isRootKeyExpression(node.expression.expression, scope) ||
				node.arguments.some((argument) => isRootKeyExpression(argument, scope))
			);
		}
		return false;
	}
	function isRootIdentityExpression(node: ts.Node, scope: ts.Node): boolean {
		return (
			isRootKeyExpression(node, scope) ||
			isRootIdentityName(expressionIdentityName(node))
		);
	}
	function collectionLooksProjectScoped(call: ts.CallExpression): boolean {
		if (!ts.isPropertyAccessExpression(call.expression)) return false;
		return /(?:cache|map|set|seen|project|root|workspace|worktree|directory|manifest|state|job|record|pool)/i.test(
			call.expression.expression.getText(sf),
		);
	}
	function isDirectRootParameter(node: ts.Node, scope: ts.Node): boolean {
		if (!ts.isFunctionLike(scope)) return false;
		const parameterNames = new Set(
			scope.parameters.flatMap((parameter) =>
				ts.isIdentifier(parameter.name) ? [parameter.name.text] : [],
			),
		);
		if (ts.isIdentifier(node)) {
			return isDirectRootName(node.text) && parameterNames.has(node.text);
		}
		return (
			ts.isPropertyAccessExpression(node) &&
			isDirectRootName(node.name.text) &&
			ts.isIdentifier(node.expression) &&
			parameterNames.has(node.expression.text)
		);
	}
	function isProjectCollectionKey(node: ts.Node, scope: ts.Node): boolean {
		return (
			isRootKeyExpression(node, scope) ||
			isDirectRootParameter(node, scope)
		);
	}
	function functionName(scope: ts.Node): string {
		if (ts.isFunctionDeclaration(scope)) return scope.name?.text ?? '';
		if (ts.isMethodDeclaration(scope)) return scope.name.getText(sf);
		if (ts.isFunctionExpression(scope) && scope.name) return scope.name.text;
		const declaration = scope.parent;
		if (
			(ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
			ts.isVariableDeclaration(declaration) &&
			ts.isIdentifier(declaration.name)
		) {
			return declaration.name.text;
		}
		return '';
	}
	function isContainmentContext(scope: ts.Node): boolean {
		return /(?:within|contain|inside|escape|traversal|boundary|protected|ancestor|symlink)/i.test(
			functionName(scope),
		);
	}

	function scanFunction(node: ts.Node): void {
		const scope = ts.isFunctionLike(node) ? node : sf;
		const tainted = scopeTaint(scope);
		function expressionIsTainted(initializer: ts.Expression): boolean {
			const projectLookup =
				ts.isCallExpression(initializer) &&
				calleeName(initializer.expression) === 'get' &&
				collectionLooksProjectScoped(initializer) &&
				initializer.arguments.some((argument) =>
					isProjectCollectionKey(argument, scope),
				);
			return (
				isRootKeyExpression(initializer, scope) ||
				containsRootResolve(initializer, resolveNames) ||
				projectLookup
			);
		}
		function collectObjectTaint(
			base: string,
			object: ts.ObjectLiteralExpression,
		): void {
			for (const property of object.properties) {
				if (ts.isPropertyAssignment(property)) {
					const propertyName = property.name.getText(sf).replace(/^['"]|['"]$/g, '');
					const key = `${base}.${propertyName}`;
					if (expressionIsTainted(property.initializer)) tainted.add(key);
					if (ts.isObjectLiteralExpression(property.initializer)) {
						collectObjectTaint(key, property.initializer);
					}
				} else if (
					ts.isShorthandPropertyAssignment(property) &&
					tainted.has(property.name.text)
				) {
					tainted.add(`${base}.${property.name.text}`);
				}
			}
		}
		function collect(current: ts.Node): void {
			if (current !== node && ts.isFunctionLike(current)) return;
			if (ts.isVariableDeclaration(current) && current.initializer && ts.isIdentifier(current.name)) {
				if (expressionIsTainted(current.initializer)) tainted.add(current.name.text);
				if (ts.isObjectLiteralExpression(current.initializer)) {
					collectObjectTaint(current.name.text, current.initializer);
				}
			}
			if (
				ts.isBinaryExpression(current) &&
				current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				expressionIsTainted(current.right)
			) {
				const key = expressionTaintKey(current.left);
				if (key) tainted.add(key);
			}
			ts.forEachChild(current, collect);
		}
		let previousSize = -1;
		while (previousSize !== tainted.size) {
			previousSize = tainted.size;
			collect(node);
		}
		function visit(current: ts.Node): void {
			if (current !== node && ts.isFunctionLike(current)) return;
			if (ts.isBinaryExpression(current) && EQ_NEQ.has(current.operatorToken.kind)) {
				const comparesIdentity =
					(isRootKeyExpression(current.left, scope) &&
						isRootIdentityExpression(current.right, scope)) ||
					(isRootKeyExpression(current.right, scope) &&
						isRootIdentityExpression(current.left, scope));
				if (comparesIdentity && !isContainmentContext(scope)) {
					add(current, 'comparison', 'raw path.resolve result used for identity equality');
				}
			}
			if (ts.isCallExpression(current)) {
				const method = calleeName(current.expression);
				if (
					method &&
					/^(?:get|set|has|add|delete|includes)$/.test(method) &&
					collectionLooksProjectScoped(current)
				) {
					for (const argument of current.arguments) {
						if (isProjectCollectionKey(argument, scope)) {
							add(current, 'project-key', 'raw path.resolve result used as a project Map/Set key');
							break;
						}
					}
				}
			}
			if (ts.isNewExpression(current) && current.expression.getText(sf).match(/^(?:Map|Set)$/)) {
				if (
					!isContainmentContext(scope) &&
					current.arguments?.some(
						(argument) =>
							isRootKeyExpression(argument, scope) ||
							containsRootResolve(argument, resolveNames),
					)
				) {
					add(current, 'project-key', 'raw path.resolve result used in a project Map/Set');
				}
			}
			if (ts.isTemplateExpression(current)) {
				const parent = current.parent;
				const assignedName =
					parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
						? parent.name.text
						: '';
				const returnedFromKeyFunction =
					ts.isReturnStatement(parent) &&
					/(?:key|cache)/i.test(functionName(scope));
				const usedAsCollectionKey =
					ts.isCallExpression(parent) && collectionLooksProjectScoped(parent);
				const includesFileIdentity = current.templateSpans.some((span) =>
					/(?:^|[_-])(?:file|filename|relativePath)(?:$|[_-])/i.test(
						expressionIdentityName(span.expression),
					),
				);
				if (
					!includesFileIdentity &&
					(/(?:key|cache)/i.test(assignedName) ||
						returnedFromKeyFunction ||
						usedAsCollectionKey)
				) {
					if (current.templateSpans.some((span) => isProjectCollectionKey(span.expression, scope))) {
					add(current, 'project-key', 'raw path.resolve result used in a project template key');
					}
				}
			}
			if (ts.isReturnStatement(current) && current.expression && isRootKeyExpression(current.expression, scope)) {
				const fn = ts.findAncestor(current, ts.isFunctionLike);
				const fnName = fn && ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined;
				if (fnName && isIdentityName(fnName)) {
					add(current, 'project-return', 'raw path.resolve result returned as a project identity');
				}
			}
			ts.forEachChild(current, visit);
		}
		visit(node);
	}

	function visitFunctions(node: ts.Node): void {
		if (ts.isFunctionLike(node)) scanFunction(node);
		if (
			ts.isFunctionLike(node) &&
			/same.*(?:root|project|workspace)/i.test(functionName(node))
		) {
			add(node, 'duplicate-helper', 'local same-project-root helper; use canonical-root.ts');
		}
		ts.forEachChild(node, visitFunctions);
	}
	scanFunction(sf);
	visitFunctions(sf);
	return violations;
}

export const _internals = { scanSourceForPathIdentity };

function* walkTsFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkTsFiles(full);
		else if (entry.isFile() && entry.name.endsWith('.ts')) yield full;
	}
}

export interface CollectResult {
	errors: string[];
	scannedFiles: number;
}

export function collectPathIdentityErrors(root: string = REPO_ROOT): CollectResult {
	const errors: string[] = [];
	let scannedFiles = 0;
	for (const file of walkTsFiles(path.join(root, 'src'))) {
		if (file.endsWith('.test.ts')) continue;
		scannedFiles++;
		const rel = path.relative(root, file).replace(/\\/g, '/');
		for (const violation of _internals.scanSourceForPathIdentity(rel, fs.readFileSync(file, 'utf8'))) {
			errors.push(`${violation.file}:${violation.line}: ${violation.detail}. Line: ${violation.snippet}`);
		}
	}
	return { errors, scannedFiles };
}

export function main(root: string = REPO_ROOT): number {
	const result = collectPathIdentityErrors(root);
	console.log(`Scanned ${result.scannedFiles} production TypeScript file(s) under src/.`);
	if (result.errors.length > 0) {
		console.error('\nPath-identity check FAILED:\n');
		for (const error of result.errors) console.error(`  - ${error}`);
		console.error(`\n${result.errors.length} violation(s). Use canonical-root.ts for project identity.`);
		return 1;
	}
	console.log('Path-identity check passed: no raw lexical project-identity decisions found.');
	return 0;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exit(main());
