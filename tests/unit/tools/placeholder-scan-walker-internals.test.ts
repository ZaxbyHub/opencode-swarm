/**
 * Direct unit tests for the body-shape walker internals exposed via
 * `_internals` on `src/tools/placeholder-scan.ts`. These tests mostly do not
 * exercise the full `placeholderScan` pipeline — they construct AST nodes
 * directly via `getParserForFile` and assert the classifier behavior in
 * isolation. One exception: the final describe block below runs a real
 * `placeholderScan` end-to-end, because `placeholder-scan-body-shape.test.ts`
 * (the file's natural home) is at the FR-006 500-line cap.
 *
 * Split from `placeholder-scan-body-shape.test.ts` (FR-006 SC-006.1, 500-line
 * cap per test file).
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getParserForFile } from '../../../src/lang/registry';
import {
	_internals,
	placeholderScan,
} from '../../../src/tools/placeholder-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('placeholder_scan walker internals (issue #2301)', () => {
	it('_internals seam exposes the three walker functions', () => {
		expect(typeof _internals.collectNonStubBodyLines).toBe('function');
		expect(typeof _internals.isStubSkeletonFunction).toBe('function');
		expect(typeof _internals.isConstantLiteralNode).toBe('function');
	});

	it('isConstantLiteralNode classifies identifier as constant', async () => {
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('return CONFIG_DEFAULTS;');
		let identifierNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'identifier') identifierNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isConstantLiteralNode(identifierNode)).toBe(true);
	});

	it('isConstantLiteralNode classifies unary -number as constant', async () => {
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('return -1;');
		let unaryNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'unary_expression') unaryNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isConstantLiteralNode(unaryNode)).toBe(true);
	});

	it('isConstantLiteralNode excludes template with substitutions', async () => {
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('return `hello ${name}`;');
		let templateNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'template_string') templateNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isConstantLiteralNode(templateNode)).toBe(false);
	});

	it('isStubSkeletonFunction classifies method_definition sole-return as stub', async () => {
		const parser = await getParserForFile('test.ts');
		const src = `class C {
  method() {
    return null;
  }
}`;
		const tree = parser.parse(src);
		let methodNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'method_definition' && !methodNode) {
				methodNode = node;
			}
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isStubSkeletonFunction(methodNode)).toBe(true);
	});

	it('isStubSkeletonFunction classifies abstract method_definition (no body) as not-stub', async () => {
		const parser = await getParserForFile('test.ts');
		// Abstract method: body is missing (terminated by `;`).
		const src = `abstract class C {
  abstract foo(): void;
}`;
		const tree = parser.parse(src);
		let methodNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'method_definition' && !methodNode) {
				methodNode = node;
			}
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isStubSkeletonFunction(methodNode)).toBe(false);
	});

	it('isStubSkeletonFunction classifies Python function_definition sole return as stub', async () => {
		const parser = await getParserForFile('test.py');
		const tree = parser.parse('def f():\n    return None\n');
		let fnNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'function_definition' && !fnNode) {
				fnNode = node;
			}
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(_internals.isStubSkeletonFunction(fnNode)).toBe(true);
	});

	it('isStubSkeletonFunction classifies function_expression sole-return as stub', async () => {
		// Kimi K3 final-critic F7: function expressions must be in the walker
		// node-type set. Without this, a `const cb = function() { return null; }`
		// inside a non-stub outer would be silently over-suppressed.
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('const cb = function() { return null; };');
		let fnExprNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'function_expression' && !fnExprNode) {
				fnExprNode = node;
			}
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(fnExprNode).not.toBeNull();
		expect(_internals.isStubSkeletonFunction(fnExprNode)).toBe(true);
	});

	it('isStubSkeletonFunction classifies async arrow sole-return as stub', async () => {
		// Reviewer/critic finding PR2306-A: the arrow body-node skip-list must
		// also skip the `async` token, or an async arrow's body resolves to
		// that one-token node instead of the real statement_block.
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('const f = async () => { return null; };');
		let arrowNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'arrow_function' && !arrowNode) arrowNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(arrowNode).not.toBeNull();
		expect(_internals.isStubSkeletonFunction(arrowNode)).toBe(true);
	});

	it('isStubSkeletonFunction classifies generic arrow sole-return as stub', async () => {
		// Same finding, `type_parameters` variant: `<T,>() => {}`.
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('const f = <T,>(): T => { return null; };');
		let arrowNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'arrow_function' && !arrowNode) arrowNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(arrowNode).not.toBeNull();
		expect(_internals.isStubSkeletonFunction(arrowNode)).toBe(true);
	});

	it('collectNonStubBodyLines suppresses an async arrow guard clause', async () => {
		// The FP half of the same finding. NOTE: asserting
		// `isStubSkeletonFunction(arrowNode) === false` here would be
		// tautological pre-fix too (bodyNode resolved to the bare `async`
		// token, which isConstantLiteralNode also rejects, for the wrong
		// reason) — the real behavior under test is whether the guard
		// clause's line actually gets added to the suppression set.
		const parser = await getParserForFile('test.ts');
		const src =
			'const f = async (req) => {\n  if (!req) return null;\n  return doStuff(req);\n};';
		const tree = parser.parse(src);
		const suppressed = _internals.collectNonStubBodyLines(tree.rootNode);
		expect(suppressed.has(2)).toBe(true);
	});

	it('collectNonStubBodyLines suppresses a paren-less async arrow guard clause', async () => {
		// Regression for the paren-less parameter form (`async req => {}`):
		// the bare parameter `identifier` must not be mistaken for the body.
		const parser = await getParserForFile('test.ts');
		const src =
			'const f = async req => {\n  if (!req) return null;\n  return doStuff(req);\n};';
		const tree = parser.parse(src);
		const suppressed = _internals.collectNonStubBodyLines(tree.rootNode);
		expect(suppressed.has(2)).toBe(true);
	});

	it('isStubSkeletonFunction classifies paren-less arrow sole-return as stub', async () => {
		// Same regression, stub-preservation direction: a real stub written
		// without parens (`req => { return null; }`) must still be flagged.
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('const f = req => { return null; };');
		let arrowNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'arrow_function' && !arrowNode) arrowNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(arrowNode).not.toBeNull();
		expect(_internals.isStubSkeletonFunction(arrowNode)).toBe(true);
	});

	it('isStubSkeletonFunction resolves the body via the grammar field, not a leading-child skip-list', async () => {
		// Closeout-reviewer finding: a `comment` between the parameter list
		// and `=>` is one more leading-child shape a skip-list would need to
		// enumerate. `childForFieldName('body')` sidesteps the whole class.
		const parser = await getParserForFile('test.ts');
		const tree = parser.parse('const f = (req) /* c */ => { return null; };');
		let arrowNode: any = null;
		const walk = (node: any) => {
			if (node.type === 'arrow_function' && !arrowNode) arrowNode = node;
			if (node.children) for (const c of node.children) walk(c);
		};
		walk(tree.rootNode);
		expect(arrowNode).not.toBeNull();
		expect(_internals.isStubSkeletonFunction(arrowNode)).toBe(true);
	});

	describe('async/generic/paren-less arrow forms, end-to-end', () => {
		it('single-line stubs still fail; guard clauses still pass', async () => {
			const tempDir = canonicalMkdtemp('ps-walker-e2e-');
			try {
				fs.writeFileSync(
					path.join(tempDir, 'arrows.ts'),
					`const stub1 = async () => { return null; };
const stub2 = <T,>() => { return null; };
const guard1 = async (req) => {
  if (!req) return null;
  return g(req);
};
const guard2 = req => {
  if (!req) return null;
  return g(req);
};
`,
				);
				const result = await placeholderScan(
					{ changed_files: ['arrows.ts'] },
					tempDir,
				);
				const stubReturns = result.findings.filter(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				);
				expect(stubReturns.length).toBe(2);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe('body-shape walker stays out of unverified languages (critic finding)', () => {
		it('Go stub returns are still flagged by the regex-only pass', async () => {
			// Go shares `function_declaration`/`block` node names with TS/JS but
			// wraps its body one level deeper (`block` -> `statement_list` ->
			// `return_statement`), so collectNonStubBodyLines would classify
			// every Go function as non-stub and suppress all its findings if it
			// ran on Go. isBodyShapeSupported gates the walker to TS/JS/TSX/Python.
			const tempDir = canonicalMkdtemp('ps-walker-go-');
			try {
				fs.writeFileSync(
					path.join(tempDir, 'stub.go'),
					// Semicolon is required: the code-stub-return regex for Go
					// (`return\s+nil\s*;`) expects one even though idiomatic Go
					// omits it — a pre-existing regex quirk, not this fix's concern.
					'func f() error {\n\treturn nil;\n}\n',
				);
				const result = await placeholderScan(
					{ changed_files: ['stub.go'] },
					tempDir,
				);
				expect(result.verdict).toBe('fail');
				expect(
					result.findings.some(
						(f) => f.rule_id === 'placeholder/code-stub-return',
					),
				).toBe(true);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe('grammar invariant', () => {
		it('the TS/TSX/JS grammars this parser loads define a `body` field', async () => {
			// The `childForFieldName('body')` fix depends on the grammar
			// defining a `body` field for arrow_function. This asserts that
			// invariant directly against the loaded grammar so a future
			// tree-sitter-wasm version bump that silently drops or renames the
			// field fails here, loudly, instead of just returning null.
			for (const filename of ['test.ts', 'test.tsx', 'test.js']) {
				const parser = await getParserForFile(filename);
				const fieldId = (parser as any).language?.fieldIdForName?.('body');
				expect(fieldId).not.toBeNull();
				expect(fieldId).not.toBeUndefined();
			}
		});
	});
});
