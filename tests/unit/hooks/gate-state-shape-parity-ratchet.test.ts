import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

// #3601 AC9: every key of `PrWorkflowGateStateSchema` must be declared on the
// exported `PrWorkflowGateState` interface. When a schema key diverges, tests
// that read the field get CI-invisible TS2339 errors (tsconfig `include` is
// src/** only, so `bun run typecheck` never sees test files) — exactly the
// PR #3593 `observabilityRevision` incident this ratchet exists to close.
//
// The direction is deliberately ONE-WAY (schema -> interface): the schema
// ends in `.passthrough()` so interface-extra fields are preserved opaquely
// through read-modify-write cycles by design (rollback tolerance; see the
// comment block at the schema tail in src/hooks/pr-workflow-gate.ts). An
// interface key absent from the schema is therefore legitimate; a schema key
// absent from the interface is the TS2339 hazard.
//
// PrWorkflowGateStateSchema is module-private, so both key sets are
// enumerated from SOURCE via the TypeScript compiler API (the same approach
// as scripts/check-bare-executable-spawn.ts). Unsupported declaration shapes
// fail closed with named diagnostics — a future z.union/transform wrapper or
// a spread/computed member must never silently shorten either key set.

const GATE_SOURCE = path.resolve(
	__dirname,
	'../../..',
	'src/hooks/pr-workflow-gate.ts',
);

class UnsupportedShapeError extends Error {}

/**
 * Walk `const <name> = z(...).object({...})...` to its z.object literal and
 * return the property names. Anything that is not a plain property
 * assignment (spread, method, accessor, computed name) or any wrapper that
 * hides the object literal throws.
 */
export function extractSchemaObjectKeys(
	sourceText: string,
	constName: string,
): string[] {
	const sourceFile = ts.createSourceFile(
		'gate.ts',
		sourceText,
		ts.ScriptTarget.Latest,
		true,
	);
	let initializer: ts.Expression | undefined;
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const decl of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(decl.name) &&
				decl.name.text === constName &&
				decl.initializer
			) {
				initializer = decl.initializer;
			}
		}
	}
	if (!initializer)
		throw new UnsupportedShapeError(
			`unsupported schema declaration shape: ${constName} not found`,
		);

	// Unwrap chained calls (.passthrough(), .strict(), ...) until we reach the
	// CallExpression whose callee is `<x>.object`.
	let node: ts.Expression = initializer;
	for (let depth = 0; depth < 16; depth++) {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.name) &&
				callee.name.text === 'object' &&
				node.arguments.length >= 1 &&
				ts.isObjectLiteralExpression(node.arguments[0])
			) {
				return objectLiteralPropertyNames(
					node.arguments[0] as ts.ObjectLiteralExpression,
					'schema',
				);
			}
			node = callee;
			continue;
		}
		if (ts.isPropertyAccessExpression(node)) {
			node = node.expression;
			continue;
		}
		break;
	}
	throw new UnsupportedShapeError(
		'unsupported schema declaration shape: no z.object literal reached',
	);
}

function objectLiteralPropertyNames(
	literal: ts.ObjectLiteralExpression,
	side: string,
): string[] {
	const names: string[] = [];
	for (const member of literal.properties) {
		if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) {
			const kind = ts.SyntaxKind[member.kind];
			throw new UnsupportedShapeError(
				`unsupported ${side} declaration shape: ${kind} member is not a plain property assignment`,
			);
		}
		names.push(member.name.text);
	}
	return names;
}

/**
 * Return the property names of `export interface <name>`. Heritage clauses,
 * computed names, and non-property members throw (fail closed).
 */
export function extractInterfaceKeys(
	sourceText: string,
	interfaceName: string,
): string[] {
	const sourceFile = ts.createSourceFile(
		'gate.ts',
		sourceText,
		ts.ScriptTarget.Latest,
		true,
	);
	for (const statement of sourceFile.statements) {
		if (
			!ts.isInterfaceDeclaration(statement) ||
			statement.name.text !== interfaceName
		)
			continue;
		if (statement.heritageClauses && statement.heritageClauses.length > 0) {
			throw new UnsupportedShapeError(
				'unsupported interface declaration: heritage clauses present',
			);
		}
		const names: string[] = [];
		for (const member of statement.members) {
			if (
				!ts.isPropertySignature(member) ||
				!member.name ||
				!ts.isIdentifier(member.name)
			) {
				const kind = ts.SyntaxKind[member.kind];
				throw new UnsupportedShapeError(
					`unsupported interface declaration: ${kind} member is not a property signature`,
				);
			}
			names.push(member.name.text);
		}
		return names;
	}
	throw new UnsupportedShapeError(
		`unsupported interface declaration: ${interfaceName} not found`,
	);
}

/** Pure comparator (unit-tested directly): schema keys missing from the interface. */
export function missingSchemaKeys(
	schemaKeys: readonly string[],
	interfaceKeys: readonly string[],
): string[] {
	return schemaKeys.filter((key) => !interfaceKeys.includes(key));
}

describe('PrWorkflowGateState schema/interface shape parity ratchet (#3601 AC9)', () => {
	const source = fs.readFileSync(GATE_SOURCE, 'utf8');
	const schemaKeys = extractSchemaObjectKeys(
		source,
		'PrWorkflowGateStateSchema',
	);
	const interfaceKeys = extractInterfaceKeys(source, 'PrWorkflowGateState');

	test('real-source extraction is nonempty and anchored (an empty walk cannot pass)', () => {
		// Extraction-discrimination proof: these anchors exist in the real
		// declarations today; an accidentally-empty walk fails here instead of
		// passing the subset assertion vacuously.
		expect(schemaKeys).toContain('schemaVersion');
		expect(schemaKeys).toContain('sessionID');
		expect(interfaceKeys).toContain('workflowInstanceId');
		expect(interfaceKeys.length).toBeGreaterThan(50);
	}, 30_000);

	test('every PrWorkflowGateStateSchema key is declared on the PrWorkflowGateState interface', () => {
		const missing = missingSchemaKeys(schemaKeys, interfaceKeys);
		expect(missing).toEqual([]);
	}, 30_000);

	test('comparator names a synthetic divergent key (the ratchet can fail)', () => {
		const syntheticSchema = ['schemaVersion', 'sessionID', 'futureField'];
		const syntheticInterface = ['schemaVersion', 'sessionID'];
		expect(missingSchemaKeys(syntheticSchema, syntheticInterface)).toEqual([
			'futureField',
		]);
	}, 30_000);

	test('walker refuses a spread member in the schema object literal', () => {
		const synthetic =
			'const S = z\n\t.object({\n\t\ta: z.string(),\n\t\t...rest,\n\t})\n\t.passthrough();\n';
		expect(() => extractSchemaObjectKeys(synthetic, 'S')).toThrow(
			/unsupported schema declaration shape/,
		);
	}, 30_000);

	test('walker refuses a schema with no z.object literal (union wrapper)', () => {
		const synthetic =
			'const S = z.union([z.object({ a: z.string() }), z.null()]);\n';
		expect(() => extractSchemaObjectKeys(synthetic, 'S')).toThrow(
			/unsupported schema declaration shape/,
		);
	}, 30_000);

	test('walker refuses a computed interface member and heritage clauses', () => {
		const computed =
			'export interface I { [k: string]: unknown; a: string; }\n';
		expect(() => extractInterfaceKeys(computed, 'I')).toThrow(
			/unsupported interface declaration/,
		);
		const heritage = 'export interface J extends Base { a: string; }\n';
		expect(() => extractInterfaceKeys(heritage, 'J')).toThrow(
			/unsupported interface declaration/,
		);
	}, 30_000);
});
