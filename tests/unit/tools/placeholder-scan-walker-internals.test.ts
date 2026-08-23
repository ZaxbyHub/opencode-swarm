/**
 * Direct unit tests for the body-shape walker internals exposed via
 * `_internals` on `src/tools/placeholder-scan.ts`. These tests do not exercise
 * the full `placeholderScan` pipeline — they construct AST nodes directly
 * via `getParserForFile` and assert the classifier behavior in isolation.
 *
 * Split from `placeholder-scan-body-shape.test.ts` (FR-006 SC-006.1, 500-line
 * cap per test file).
 */

import { describe, expect, it } from 'bun:test';
import { getParserForFile } from '../../../src/lang/registry';
import { _internals } from '../../../src/tools/placeholder-scan';

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
});
