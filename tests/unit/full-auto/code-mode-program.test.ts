/**
 * #3446 — the Code Mode sandbox is NOT limited to hooked tools: it exposes
 * `fetch`, `Function`, `crypto`, `URL`, `Promise`, `JSON`, `Math`, `Date`
 * (observed on OpenCode 2.1.4). Full-Auto may therefore only pass-through a
 * program that is exactly one tool call with a plain-data argument.
 */
import { describe, expect, test } from 'bun:test';
import { isSingleToolCallProgram } from '../../../src/full-auto/code-mode-program';

describe('isSingleToolCallProgram — accepts a single tool call with plain data', () => {
	const accepted = [
		'return await tools.declare_scope({ files: ["a.ts"] });',
		"return await tools.update_task_status({ task_id: '1.1', status: 'completed' })",
		'await tools.swarm_command({ command: "sdd status", args: [] })',
		'tools.swarm_status()',
		'return tools.swarm_status({});',
		'return await tools["mcp-mesh"].mesh_call({ name: "x", args: { a: 1, b: [true, false, null, -2.5e3] } });',
		"return await tools['cortex'].cortex_search({ query: 'tmux notes' });",
		'return await search({ query: "tmux" });',
		'return await tools.write_retro({ text: "line one\\nline two \\"quoted\\"" });',
		'\n  return await tools.swarm_status({\n    verbose: true,\n  });\n',
	];
	for (const code of accepted) {
		test(JSON.stringify(code).slice(0, 70), () => {
			expect(isSingleToolCallProgram(code)).toBe(true);
		});
	}
});

describe('isSingleToolCallProgram — rejects anything that can run non-tool code', () => {
	const rejected: Array<[string, string]> = [
		['network fetch', "return await fetch('http://localhost:4000/health');"],
		['fetch as argument', "return await tools.x({ a: fetch('http://u') });"],
		['fetch as sole argument', "return await tools.x(fetch('http://u'));"],
		[
			'statement before the call',
			"await fetch('http://u'); return await tools.x({});",
		],
		['statement after the call', "tools.x({}); fetch('http://u');"],
		['two calls', 'tools.a({}); tools.b({});'],
		['variable binding', 'const r = await tools.x({}); return r;'],
		['Function constructor', "return Function('return fetch')()('http://u');"],
		[
			'.constructor chain',
			"return tools.x.constructor.constructor('return fetch')();",
		],
		['computed constructor', "return tools['con' + 'structor'](1);"],
		['concatenated key', "return tools['a' + 'b']({});"],
		['__proto__ segment', 'return tools.__proto__.x({});'],
		['prototype segment', 'return tools.x.prototype.y({});'],
		['proto key in argument', 'return tools.x({ __proto__: { a: 1 } });'],
		['identifier value', 'return tools.x({ a: b });'],
		['call in value', 'return tools.x({ a: Math.random() });'],
		['spread', 'return tools.x(...args);'],
		['computed object key', 'return tools.x({ ["a"]: 1 });'],
		['arrow function', 'return tools.x(() => 1);'],
		['function expression', 'return tools.x(function () {});'],
		['template literal', 'return tools.x({ a: `${1}` });'],
		['template literal (plain)', 'return tools.x({ a: `abc` });'],
		['block comment', 'return tools.x({}); /* fetch */'],
		['line comment', 'return tools.x({}); // fetch'],
		['chained call', 'return tools.x({}).then(fetch);'],
		['member access after call', 'return tools.x({}).constructor;'],
		['comma operator', "return (0, fetch)('http://u');"],
		['parenthesised callee', 'return (tools.x)({});'],
		['new expression', 'return new tools.X({});'],
		['regex literal', 'return tools.x({ a: /a/ });'],
		['unicode escape in string', 'return tools.x({ a: "\\u0041" });'],
		['escaped newline outside allowlist', 'return tools.x({ a: "\\x41" });'],
		['unterminated string', 'return tools.x({ a: "oops });'],
		['trailing junk', 'return tools.x({}) fetch;'],
		['empty', ''],
		['whitespace only', '   \n  '],
		['bare identifier', 'tools'],
		['callee not tools or search', 'return other.x({});'],
		['unsafe bracket name', 'return tools["a b+c"]({});'],
		['dangerous bracket name', 'return tools["constructor"]({});'],
		['oversized program', `return tools.x({ a: "${'a'.repeat(30_000)}" });`],
		['deep nesting', `return tools.x(${'['.repeat(40)}${']'.repeat(40)});`],
	];
	for (const [label, code] of rejected) {
		test(label, () => {
			expect(isSingleToolCallProgram(code)).toBe(false);
		});
	}
});

describe('isSingleToolCallProgram — input hygiene', () => {
	test('non-string input is rejected', () => {
		for (const v of [undefined, null, 42, {}, []]) {
			expect(isSingleToolCallProgram(v as unknown as string)).toBe(false);
		}
	});
});

describe('isSingleToolCallProgram — exact boundaries', () => {
	const pad = (len: number): string => {
		const head = 'return tools.x({ a: "';
		const tail = '" });';
		return head + 'a'.repeat(len - head.length - tail.length) + tail;
	};
	const nest = (n: number): string =>
		`return tools.x(${'['.repeat(n)}${']'.repeat(n)});`;

	test('program length: 20000 chars accepted, 20001 rejected', () => {
		expect(pad(20_000)).toHaveLength(20_000);
		expect(isSingleToolCallProgram(pad(20_000))).toBe(true);
		expect(isSingleToolCallProgram(pad(20_001))).toBe(false);
	});

	test('argument nesting: 9 levels accepted, 10 rejected', () => {
		expect(isSingleToolCallProgram(nest(9))).toBe(true);
		expect(isSingleToolCallProgram(nest(10))).toBe(false);
	});

	test('bracketed tool name: 100 chars accepted, 101 rejected', () => {
		expect(isSingleToolCallProgram(`tools["${'a'.repeat(100)}"]({})`)).toBe(
			true,
		);
		expect(isSingleToolCallProgram(`tools["${'a'.repeat(101)}"]({})`)).toBe(
			false,
		);
	});

	test('a hyphenated MCP-style bracket name is accepted', () => {
		expect(isSingleToolCallProgram('tools["mcp-mesh"].mesh_call({})')).toBe(
			true,
		);
	});
});
