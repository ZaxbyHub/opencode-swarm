import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dir, '../../..');
const SRC = path.join(ROOT, 'src');
const REQUIRED_CONSUMERS = [
	'src/learning/admission.ts',
	'src/hooks/micro-reflector.ts',
	'src/hooks/knowledge-curator.ts',
	'src/mutation/generator.ts',
	'src/services/skill-generator.ts',
	'src/tools/external-skill-discover.ts',
] as const;
const EXPECTED_CALL_SITES = new Map<string, readonly string[]>([
	['src/learning/admission.ts', ['screenCandidate']],
	['src/hooks/micro-reflector.ts', ['runMicroReflection']],
	['src/hooks/knowledge-curator.ts', ['enrichLessonsToV3Batched', 'enrichLessonToV3']],
	['src/mutation/generator.ts', ['dispatch']],
	['src/services/skill-generator.ts', ['autoApplyProposals']],
	['src/tools/external-skill-discover.ts', ['fetchContent']],
]);

function findNativeAbortTimeoutAccesses(source: string): number {
	const file = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const signals = new Set(['AbortSignal']);
	const globals = new Set(['globalThis']);
	const reflects = new Set(['Reflect']);
	const reflectGets = new Set<string>();
	const timeoutKeys = new Set(['timeout']);
	let changed = true;
	while (changed) {
		changed = false;
		const mark = () => {
			changed = true;
		};
		const collect = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
				const { name, initializer } = node;
				if (ts.isIdentifier(name) && initializer) {
					addAlias(globals, name.text, isNamedReference(initializer, globals), mark);
					addAlias(signals, name.text, isAbortSignalReference(initializer, signals, globals, file), mark);
					addAlias(reflects, name.text, isNamedReference(initializer, reflects), mark);
					addAlias(reflectGets, name.text, isReflectGetReference(initializer, reflects), mark);
					addAlias(timeoutKeys, name.text, isStringReference(initializer, timeoutKeys, 'timeout'), mark);
				}
				if (initializer && ts.isObjectBindingPattern(name)) {
					if (isNamedReference(initializer, globals)) collectBindingAliases(name, 'AbortSignal', signals, mark);
					if (isNamedReference(initializer, reflects)) collectBindingAliases(name, 'get', reflectGets, mark);
				}
			}
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				if (ts.isIdentifier(node.left)) {
					addAlias(globals, node.left.text, isNamedReference(node.right, globals), mark);
					addAlias(signals, node.left.text, isAbortSignalReference(node.right, signals, globals, file), mark);
					addAlias(reflects, node.left.text, isNamedReference(node.right, reflects), mark);
					addAlias(reflectGets, node.left.text, isReflectGetReference(node.right, reflects), mark);
					addAlias(timeoutKeys, node.left.text, isStringReference(node.right, timeoutKeys, 'timeout'), mark);
				}
				if (ts.isObjectBindingPattern(node.left)) {
					if (isNamedReference(node.right, globals)) collectBindingAliases(node.left, 'AbortSignal', signals, mark);
					if (isNamedReference(node.right, reflects)) collectBindingAliases(node.left, 'get', reflectGets, mark);
				}
				if (ts.isObjectLiteralExpression(node.left)) {
					if (isNamedReference(node.right, globals)) collectObjectAssignmentAliases(node.left, 'AbortSignal', signals, mark);
					if (isNamedReference(node.right, reflects)) collectObjectAssignmentAliases(node.left, 'get', reflectGets, mark);
				}
			}
			ts.forEachChild(node, collect);
		};
		collect(file);
	}

	let accesses = 0;
	const visit = (node: ts.Node): void => {
		if ((ts.isPropertyAccessExpression(node) && node.name.text === 'timeout' && isAbortSignalReference(node.expression, signals, globals, file)) || (ts.isElementAccessExpression(node) && node.argumentExpression && isTimeoutKeyReference(node.argumentExpression, timeoutKeys) && isAbortSignalReference(node.expression, signals, globals, file))) accesses++;
		if (ts.isCallExpression(node) && (isReflectGetReference(node.expression, reflects) || (ts.isIdentifier(node.expression) && reflectGets.has(node.expression.text))) && node.arguments.length >= 2 && isAbortSignalReference(node.arguments[0], signals, globals, file) && isTimeoutKeyReference(node.arguments[1], timeoutKeys)) accesses++;
		if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name) && node.initializer) {
			if (isAbortSignalReference(node.initializer, signals, globals, file)) accesses += countTimeoutBindings(node.name);
			if (isNamedReference(node.initializer, globals)) accesses += countNestedTimeoutBindings(node.name);
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
			if (isAbortSignalReference(node.right, signals, globals, file)) accesses += countTimeoutProperties(node.left);
			if (isNamedReference(node.right, globals)) accesses += countNestedTimeoutObjectProperties(node.left);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return accesses;
}

function addAlias(set: Set<string>, name: string, shouldAdd: boolean, mark: () => void): void {
	if (shouldAdd && !set.has(name)) {
		set.add(name);
		mark();
	}
}
function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
	return current;
}
function staticStringValue(node: ts.Expression, aliases: ReadonlyMap<string, string> = new Map()): string | undefined {
	const expression = unwrap(node);
	if (ts.isStringLiteralLike(expression)) return expression.text;
	if (ts.isIdentifier(expression)) return aliases.get(expression.text);
	if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = staticStringValue(expression.left, aliases);
		const right = staticStringValue(expression.right, aliases);
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	return undefined;
}
function isNamedReference(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
	const expression = unwrap(node);
	return ts.isIdentifier(expression) && aliases.has(expression.text);
}
function isAbortSignalReference(node: ts.Expression, aliases: ReadonlySet<string>, globals: ReadonlySet<string>, file: ts.SourceFile): boolean {
	const expression = unwrap(node);
	return (ts.isIdentifier(expression) && aliases.has(expression.text) && !(expression.text === 'AbortSignal' && hasShadowingBinding(file, 'AbortSignal', expression))) || (ts.isPropertyAccessExpression(expression) && isNamedReference(expression.expression, globals) && expression.name.text === 'AbortSignal') || (ts.isElementAccessExpression(expression) && isNamedReference(expression.expression, globals) && expression.argumentExpression !== undefined && staticStringValue(expression.argumentExpression) === 'AbortSignal');
}
function isStringReference(node: ts.Expression, aliases: ReadonlySet<string>, value: string, _mark?: () => void): boolean {
	const expression = unwrap(node);
	return (ts.isIdentifier(expression) && aliases.has(expression.text)) || staticStringValue(expression) === value;
}
function isTimeoutKeyReference(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
	return isStringReference(node, aliases, 'timeout');
}
function isReflectGetReference(node: ts.Expression, reflects: ReadonlySet<string>): boolean {
	const expression = unwrap(node);
	return (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && reflects.has(expression.expression.text) && expression.name.text === 'get') || (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression) && reflects.has(expression.expression.text) && expression.argumentExpression !== undefined && staticStringValue(expression.argumentExpression) === 'get');
}
function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	return ts.isComputedPropertyName(name) ? staticStringValue(name.expression) : undefined;
}
function collectBindingAliases(pattern: ts.ObjectBindingPattern, property: string, aliases: Set<string>, mark: () => void): void {
	for (const element of pattern.elements) {
		if (propertyNameText(element.propertyName ?? element.name) === property && ts.isIdentifier(element.name)) addAlias(aliases, element.name.text, true, mark);
		if (ts.isObjectBindingPattern(element.name)) collectBindingAliases(element.name, property, aliases, mark);
	}
}
function collectObjectAssignmentAliases(object: ts.ObjectLiteralExpression, property: string, aliases: Set<string>, mark: () => void): void {
	for (const entry of object.properties) {
		if (propertyNameText(entry.name) !== property) continue;
		const target = ts.isPropertyAssignment(entry) ? entry.initializer : ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
		if (target && ts.isIdentifier(target)) addAlias(aliases, target.text, true, mark);
	}
}
function countTimeoutBindings(pattern: ts.ObjectBindingPattern): number {
	return pattern.elements.reduce((count, element) => count + (propertyNameText(element.propertyName ?? element.name) === 'timeout' ? 1 : 0) + (ts.isObjectBindingPattern(element.name) ? countTimeoutBindings(element.name) : 0), 0);
}
function countNestedTimeoutBindings(pattern: ts.ObjectBindingPattern): number {
	return pattern.elements.reduce((count, element) => count + (propertyNameText(element.propertyName ?? element.name) === 'AbortSignal' && ts.isObjectBindingPattern(element.name) ? countTimeoutBindings(element.name) : 0), 0);
}
function countTimeoutProperties(object: ts.ObjectLiteralExpression): number {
	return object.properties.filter((property) => propertyNameText(property.name) === 'timeout').length;
}
function countNestedTimeoutObjectProperties(object: ts.ObjectLiteralExpression): number {
	return object.properties.reduce((count, property) => count + (propertyNameText(property.name) === 'AbortSignal' && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) ? countTimeoutProperties(property.initializer) : 0), 0);
}

function importedHelperCallSites(source: string): string[] {
	const file = ts.createSourceFile('consumer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let importedName: string | undefined;
	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.getText(file).includes('utils/timeout.js') && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
			const specifier = statement.importClause.namedBindings.elements.find((element) => (element.propertyName ?? element.name).text === 'withTimeoutSignal');
			if (specifier) importedName = specifier.name.text;
		}
	}
	if (!importedName || hasShadowingBinding(file, importedName)) return [];
	const calls: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === importedName) calls.push(enclosingCallableName(node) ?? '<top-level>');
		ts.forEachChild(node, visit);
	};
	visit(file);
	return calls;
}
function hasShadowingBinding(file: ts.SourceFile, name: string, target?: ts.Node): boolean {
	let found = false;
	const limit = target?.getStart(file) ?? Number.POSITIVE_INFINITY;
	const visit = (node: ts.Node): void => {
		if (found || node.getStart(file) >= limit) return;
		if (!ts.isImportSpecifier(node) && ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && bindingNameContains(node.name, name) || (ts.isCatchClause(node) && node.variableDeclaration && bindingNameContains(node.variableDeclaration.name, name)))) {
			found = true;
			return;
		}
		if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name?.text === name) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}
function bindingNameContains(binding: ts.BindingName, name: string): boolean {
	return ts.isIdentifier(binding) ? binding.text === name : binding.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, name));
}
function enclosingCallableName(node: ts.Node): string | undefined {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
		if ((ts.isMethodDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) && (ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name))) return current.name.text;
		if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) return current.name.text;
	}
	return undefined;
}
function runtimeSourceFiles(): string[] {
	return (readdirSync(SRC, { recursive: true }) as string[]).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.includes(`${path.sep}__tests__${path.sep}`)).map((entry) => path.join(SRC, entry));
}

describe('runtime timeout source guard (#1964/#2103)', () => {
	test('forbids runtime AbortSignal timeout construction', () => {
		const offenders = runtimeSourceFiles().filter((file) => findNativeAbortTimeoutAccesses(readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file));
		expect(offenders).toEqual([]);
	});
	test('rejects equivalent native timeout access syntax (F-001, FB-006)', () => {
		// Before F-001/FB-006, alias, nested, assignment, reflection, and computed-key forms bypassed the recurrence guard.
		for (const source of [
			'AbortSignal.timeout (100)', 'AbortSignal?.timeout(100)', 'AbortSignal["timeout"](100)', 'const k = "time" + "out"; AbortSignal[k](100)',
			'const timeout = AbortSignal.timeout; timeout(100)', 'const { timeout: deadline } = AbortSignal; deadline(100)', 'const Signal = AbortSignal; Signal.timeout(100)',
			'globalThis.AbortSignal.timeout(100)', 'globalThis["AbortSignal"].timeout(100)', 'const { AbortSignal: Signal } = globalThis; Signal.timeout(100)',
			'({ AbortSignal: Signal } = globalThis); Signal.timeout(100)', 'const { AbortSignal: { timeout: deadline } } = globalThis; deadline(100)',
			'let Signal: typeof AbortSignal; Signal = AbortSignal; Signal.timeout(100)', 'Reflect.get(AbortSignal, "timeout")(100)', 'const R = Reflect; R.get(AbortSignal, "timeout")(100)',
			'const get = Reflect.get; get(AbortSignal, "timeout")(100)', 'const { get } = Reflect; get(AbortSignal, "timeout")(100)', '({ timeout } = AbortSignal)',
			'function f({ timeout } = AbortSignal) {}', 'const { ["timeout"]: deadline } = AbortSignal',
		]) expect(findNativeAbortTimeoutAccesses(source), source).toBeGreaterThan(0);
		expect(findNativeAbortTimeoutAccesses('withTimeoutSignal(async () => "ok", 100, new Error("late"))')).toBe(0);
	});
	test('rejects helper calls shadowed away from the shared import (F-003)', () => {
		for (const declaration of [
			'function screenCandidate(withTimeoutSignal: () => void) { withTimeoutSignal(); }', 'function screenCandidate({ withTimeoutSignal }) { withTimeoutSignal(); }',
			'function screenCandidate(...[withTimeoutSignal]) { withTimeoutSignal(); }', 'function screenCandidate() { const { withTimeoutSignal } = deps; withTimeoutSignal(); }',
			'function screenCandidate() { try {} catch (withTimeoutSignal) { withTimeoutSignal(); } }', 'const screenCandidate = function withTimeoutSignal() { withTimeoutSignal(); }',
		]) {
			expect(importedHelperCallSites(`import { withTimeoutSignal } from '../../utils/timeout.js'; ${declaration}`)).toEqual([]);
		}
	});
	test('keeps shadowed native names and class-field callables safe (F-002, FB-005)', () => {
		// Before F-002, a local AbortSignal binding was mistaken for the global object.
		expect(findNativeAbortTimeoutAccesses('function f(AbortSignal: { timeout: (ms: number) => void }) { AbortSignal.timeout(100); }')).toBe(0);
		// Before FB-005, class-field arrows were reported as <top-level>.
		expect(importedHelperCallSites('import { withTimeoutSignal } from "../../utils/timeout.js"; class C { run = () => withTimeoutSignal(); }')).toEqual(['run']);
	});
	test('keeps every reported consumer calling the shared cancellable helper', () => {
		for (const relative of REQUIRED_CONSUMERS) expect(importedHelperCallSites(readFileSync(path.join(ROOT, relative), 'utf8'))).toEqual(EXPECTED_CALL_SITES.get(relative));
	});
});
