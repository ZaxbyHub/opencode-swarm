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
	'src/services/skill-generator.ts',
	'src/tools/external-skill-discover.ts',
] as const;

const EXPECTED_CALL_SITES = new Map<string, readonly string[]>([
	['src/learning/admission.ts', ['screenCandidate']],
	['src/hooks/micro-reflector.ts', ['runMicroReflection']],
	[
		'src/hooks/knowledge-curator.ts',
		['enrichLessonsToV3Batched', 'enrichLessonToV3'],
	],
	['src/services/skill-generator.ts', ['autoApplyProposals']],
	['src/tools/external-skill-discover.ts', ['fetchContent']],
]);

function findNativeAbortTimeoutAccesses(source: string): number {
	const sourceFile = ts.createSourceFile(
		'candidate.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const signalAliases = new Set(['AbortSignal']);
	const globalAliases = new Set(['globalThis']);
	const reflectGetAliases = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		const collectAliases = (node: ts.Node): void => {
			if (
				(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				isNamedReference(node.initializer, globalAliases) &&
				!globalAliases.has(node.name.text)
			) {
				globalAliases.add(node.name.text);
				changed = true;
			}
			if (
				(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				isAbortSignalReference(
					node.initializer,
					signalAliases,
					globalAliases,
				) &&
				!signalAliases.has(node.name.text)
			) {
				signalAliases.add(node.name.text);
				changed = true;
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left) &&
				isAbortSignalReference(node.right, signalAliases, globalAliases) &&
				!signalAliases.has(node.left.text)
			) {
				signalAliases.add(node.left.text);
				changed = true;
			}
			if (
				ts.isVariableDeclaration(node) &&
				ts.isObjectBindingPattern(node.name) &&
				node.initializer &&
				isNamedReference(node.initializer, globalAliases)
			) {
				for (const element of node.name.elements) {
					const property = element.propertyName ?? element.name;
					if (
						ts.isIdentifier(property) &&
						property.text === 'AbortSignal' &&
						ts.isIdentifier(element.name) &&
						!signalAliases.has(element.name.text)
					) {
						signalAliases.add(element.name.text);
						changed = true;
					}
				}
			}
			if (
				(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				isReflectGetReference(node.initializer) &&
				!reflectGetAliases.has(node.name.text)
			) {
				reflectGetAliases.add(node.name.text);
				changed = true;
			}
			if (
				(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
				ts.isObjectBindingPattern(node.name) &&
				node.initializer &&
				isNamedReference(node.initializer, new Set(['Reflect']))
			) {
				for (const element of node.name.elements) {
					if (
						propertyNameText(element.propertyName ?? element.name) === 'get' &&
						ts.isIdentifier(element.name) &&
						!reflectGetAliases.has(element.name.text)
					) {
						reflectGetAliases.add(element.name.text);
						changed = true;
					}
				}
			}
			ts.forEachChild(node, collectAliases);
		};
		collectAliases(sourceFile);
	}

	let accesses = 0;
	const visit = (node: ts.Node): void => {
		if (
			(ts.isPropertyAccessExpression(node) &&
				node.name.text === 'timeout' &&
				isAbortSignalReference(
					node.expression,
					signalAliases,
					globalAliases,
				)) ||
			(ts.isElementAccessExpression(node) &&
				node.argumentExpression !== undefined &&
				ts.isStringLiteralLike(node.argumentExpression) &&
				node.argumentExpression.text === 'timeout' &&
				isAbortSignalReference(node.expression, signalAliases, globalAliases))
		) {
			accesses += 1;
		}
		if (
			ts.isCallExpression(node) &&
			(isReflectGetReference(node.expression) ||
				(ts.isIdentifier(node.expression) &&
					reflectGetAliases.has(node.expression.text))) &&
			node.arguments.length >= 2 &&
			isAbortSignalReference(node.arguments[0], signalAliases, globalAliases) &&
			ts.isStringLiteralLike(node.arguments[1]) &&
			node.arguments[1].text === 'timeout'
		) {
			accesses += 1;
		}
		if (
			(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer &&
			isAbortSignalReference(node.initializer, signalAliases, globalAliases)
		) {
			accesses += countTimeoutBindings(node.name);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isObjectLiteralExpression(node.left) &&
			isAbortSignalReference(node.right, signalAliases, globalAliases)
		) {
			accesses += node.left.properties.filter(
				(property) => propertyNameText(property.name) === 'timeout',
			).length;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return accesses;
}

function isAbortSignalReference(
	node: ts.Expression,
	aliases: ReadonlySet<string>,
	globalAliases: ReadonlySet<string>,
): boolean {
	const expression = unwrapExpression(node);
	return (
		(ts.isIdentifier(expression) && aliases.has(expression.text)) ||
		(ts.isPropertyAccessExpression(expression) &&
			isNamedReference(expression.expression, globalAliases) &&
			expression.name.text === 'AbortSignal') ||
		(ts.isElementAccessExpression(expression) &&
			isNamedReference(expression.expression, globalAliases) &&
			expression.argumentExpression !== undefined &&
			ts.isStringLiteralLike(expression.argumentExpression) &&
			expression.argumentExpression.text === 'AbortSignal')
	);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function isNamedReference(
	node: ts.Expression,
	aliases: ReadonlySet<string>,
): boolean {
	const expression = unwrapExpression(node);
	return ts.isIdentifier(expression) && aliases.has(expression.text);
}

function isReflectGetReference(node: ts.Expression): boolean {
	const expression = unwrapExpression(node);
	return (
		(ts.isPropertyAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === 'Reflect' &&
			expression.name.text === 'get') ||
		(ts.isElementAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === 'Reflect' &&
			expression.argumentExpression !== undefined &&
			ts.isStringLiteralLike(expression.argumentExpression) &&
			expression.argumentExpression.text === 'get')
	);
}

function propertyNameText(
	name: ts.PropertyName | undefined,
): string | undefined {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	if (
		ts.isComputedPropertyName(name) &&
		ts.isStringLiteralLike(name.expression)
	) {
		return name.expression.text;
	}
	return undefined;
}

function countTimeoutBindings(pattern: ts.ObjectBindingPattern): number {
	return pattern.elements.filter(
		(element) =>
			propertyNameText(element.propertyName ?? element.name) === 'timeout',
	).length;
}

function importedHelperCallSites(source: string): string[] {
	const sourceFile = ts.createSourceFile(
		'consumer.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let importedName: string | undefined;
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			statement.moduleSpecifier
				.getText(sourceFile)
				.includes('utils/timeout.js') &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			const specifier = statement.importClause.namedBindings.elements.find(
				(element) =>
					(element.propertyName ?? element.name).text === 'withTimeoutSignal',
			);
			if (specifier) importedName = specifier.name.text;
		}
	}
	if (!importedName || hasShadowingBinding(sourceFile, importedName)) return [];
	const callSites: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === importedName
		) {
			callSites.push(enclosingCallableName(node) ?? '<top-level>');
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return callSites;
}

function hasShadowingBinding(sourceFile: ts.SourceFile, name: string): boolean {
	let shadowed = false;
	const visit = (node: ts.Node): void => {
		if (shadowed) return;
		if (
			!ts.isImportSpecifier(node) &&
			(ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
			node.name !== undefined &&
			bindingNameContains(node.name, name)
		) {
			shadowed = true;
			return;
		}
		if (
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
			node.name?.text === name
		) {
			shadowed = true;
			return;
		}
		if (
			(ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
			node.name?.text === name
		) {
			shadowed = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return shadowed;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
	if (ts.isIdentifier(binding)) return binding.text === name;
	return binding.elements.some(
		(element) =>
			!ts.isOmittedExpression(element) &&
			bindingNameContains(element.name, name),
	);
}

function enclosingCallableName(node: ts.Node): string | undefined {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isFunctionDeclaration(current) && current.name) {
			return current.name.text;
		}
		if (
			(ts.isMethodDeclaration(current) || ts.isPropertyAssignment(current)) &&
			(ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name))
		) {
			return current.name.text;
		}
		if (
			ts.isVariableDeclaration(current) &&
			ts.isIdentifier(current.name) &&
			current.initializer &&
			(ts.isArrowFunction(current.initializer) ||
				ts.isFunctionExpression(current.initializer))
		) {
			return current.name.text;
		}
	}
	return undefined;
}

function runtimeSourceFiles(): string[] {
	return (readdirSync(SRC, { recursive: true }) as string[])
		.filter((entry) => entry.endsWith('.ts'))
		.filter((entry) => !entry.endsWith('.test.ts'))
		.filter((entry) => !entry.includes(`${path.sep}__tests__${path.sep}`))
		.map((entry) => path.join(SRC, entry));
}

describe('runtime timeout source guard (#1964/#2103)', () => {
	test('forbids runtime AbortSignal timeout construction', () => {
		const offenders = runtimeSourceFiles()
			.filter((file) =>
				findNativeAbortTimeoutAccesses(readFileSync(file, 'utf8')),
			)
			.map((file) => path.relative(ROOT, file));
		expect(offenders).toEqual([]);
	});

	test('rejects equivalent native timeout access syntax (review F1)', () => {
		// Previous guard used one exact substring, so harmless formatting and
		// property-access variants silently bypassed the recurrence machinery.
		for (const source of [
			'AbortSignal.timeout (100)',
			'AbortSignal?.timeout(100)',
			'AbortSignal["timeout"](100)',
			'const timeout = AbortSignal.timeout; timeout(100)',
			'const { timeout } = AbortSignal; timeout(100)',
			'const { timeout: deadline } = AbortSignal; deadline(100)',
			'const Signal = AbortSignal; Signal.timeout(100)',
			'globalThis.AbortSignal.timeout(100)',
			'((AbortSignal)).timeout(100)',
			'(AbortSignal as typeof AbortSignal).timeout(100)',
			'AbortSignal!.timeout(100)',
			'globalThis["AbortSignal"].timeout(100)',
			'const { AbortSignal: Signal } = globalThis; Signal.timeout(100)',
			'let Signal: typeof AbortSignal; Signal = AbortSignal; Signal.timeout(100)',
			'function f(Signal = AbortSignal) { Signal.timeout(100); }',
			'Reflect.get(AbortSignal, "timeout")(100)',
			'({ timeout } = AbortSignal)',
			'function f({ timeout } = AbortSignal) {}',
			'const { ["timeout"]: deadline } = AbortSignal',
			'const root = globalThis; root.AbortSignal.timeout(100)',
			'const get = Reflect.get; get(AbortSignal, "timeout")(100)',
			'const { get } = Reflect; get(AbortSignal, "timeout")(100)',
		]) {
			expect(findNativeAbortTimeoutAccesses(source)).toBeGreaterThan(0);
		}
		expect(
			findNativeAbortTimeoutAccesses(
				'withTimeoutSignal(async () => "ok", 100, new Error("late"))',
			),
		).toBe(0);
	});

	test('rejects helper calls shadowed away from the shared import', () => {
		for (const declaration of [
			'function screenCandidate(withTimeoutSignal: () => void) { withTimeoutSignal(); }',
			'function screenCandidate({ withTimeoutSignal }) { withTimeoutSignal(); }',
			'function screenCandidate(...[withTimeoutSignal]) { withTimeoutSignal(); }',
			'function screenCandidate() { const { withTimeoutSignal } = deps; withTimeoutSignal(); }',
			'const screenCandidate = function withTimeoutSignal() { withTimeoutSignal(); }',
		]) {
			const source = `
				import { withTimeoutSignal } from '../../utils/timeout.js';
				${declaration}
			`;
			expect(importedHelperCallSites(source)).toEqual([]);
		}
	});

	test('keeps every reported consumer calling the shared cancellable helper', () => {
		for (const relative of REQUIRED_CONSUMERS) {
			const source = readFileSync(path.join(ROOT, relative), 'utf8');
			expect(importedHelperCallSites(source)).toEqual(
				EXPECTED_CALL_SITES.get(relative),
			);
		}
	});
});
