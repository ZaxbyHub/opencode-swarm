import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dir, '../../..');

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
	[
		'src/hooks/knowledge-curator.ts',
		['enrichLessonsToV3Batched', 'enrichLessonToV3'],
	],
	['src/mutation/generator.ts', ['dispatch']],
	['src/services/skill-generator.ts', ['autoApplyProposals']],
	['src/tools/external-skill-discover.ts', ['fetchContent']],
]);

describe('runtime timeout consumer callsites', () => {
	test('keeps every reported consumer calling the shared cancellable helper', () => {
		for (const relative of REQUIRED_CONSUMERS) {
			const source = readFileSync(path.join(ROOT, relative), 'utf8');
			expect(importedHelperCallSites(source)).toEqual(
				EXPECTED_CALL_SITES.get(relative),
			);
		}
	});

	test('keeps property declarations visible to the helper callsite mapper', () => {
		expect(
			importedHelperCallSites(`
				import { withTimeoutSignal } from '../../utils/timeout.js';
				class Example {
					withTimeoutSignal = () => {
						withTimeoutSignal();
					};
				}
			`),
		).toEqual(['withTimeoutSignal']);
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
});

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
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isClassExpression(node)
		) {
			if (node.name?.text === name) {
				shadowed = true;
				return;
			}
		}
		if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
			if (bindingNameContains(node.variableDeclaration.name, name)) {
				shadowed = true;
				return;
			}
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
		if (ts.isFunctionDeclaration(current) && current.name)
			return current.name.text;
		if (
			(ts.isMethodDeclaration(current) || ts.isPropertyAssignment(current)) &&
			(ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name))
		) {
			return current.name.text;
		}
		if (
			ts.isPropertyDeclaration(current) &&
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
