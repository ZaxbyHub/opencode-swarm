import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function def(
	facts: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>,
	name: string,
) {
	return facts.defs.find((item) => item.name === name);
}

describe('extractFileSymbols — php hardening (#1531)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('captures namespaces, traits, functions, classes, and method visibility', async () => {
		const source = `<?php
namespace App\\Services;
use App\\Models\\User as U;

trait Logs {}
class Service {
	function run(U $user) {}
	static function build() {}
	final protected function flush() {}
	private function hidden() {}
}
function helper() {}
`;

		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'App\\Services')).toMatchObject({
			kind: 'type',
			exported: true,
		});
		expect(def(facts!, 'Logs')).toMatchObject({
			kind: 'interface',
			exported: true,
		});
		expect(def(facts!, 'Service')).toMatchObject({
			kind: 'class',
			exported: true,
		});
		expect(def(facts!, 'run')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(def(facts!, 'build')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(def(facts!, 'flush')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'protected' },
		});
		expect(def(facts!, 'hidden')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(def(facts!, 'helper')).toMatchObject({
			kind: 'function',
			exported: true,
		});
		// aliased use binds the SHORT name — what body expressions spell
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'App\\Models\\User',
				bindings: [{ imported: 'User', local: 'U' }],
			}),
		);
	});

	test('body refs survive while refs inside use declarations are dropped', async () => {
		const source = `<?php
use App\\Models\\User as U;

function main() {
	U::find(1);
}
`;

		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		const uRefs = facts!.refs.filter((r) => r.identifier === 'U');
		expect(uRefs).toHaveLength(1);
		expect(uRefs[0].enclosingDecl).toBe('main');
	});

	test('function_exists and other builtin calls are not defs', async () => {
		const source = `<?php
if (function_exists('mb_strlen')) {
	call_user_func_array('trim', []);
}
function real_fn() {}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		// `function\s+` requires whitespace, so `function_exists(` cannot match
		expect(def(facts!, 'function_exists')).toBeUndefined();
		expect(def(facts!, 'call_user_func_array')).toBeUndefined();
		expect(def(facts!, 'real_fn')).toMatchObject({ kind: 'function' });
	});

	test('namespace brace form is captured', async () => {
		const source = `<?php
namespace App\\Http {
	function handle() {}
}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'App\\Http')).toMatchObject({
			kind: 'type',
			exported: true,
		});
	});

	test('unterminated class body at EOF still yields bounded def lines', async () => {
		const source = `<?php
class Dangling {
	function m() {}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		const cls = def(facts!, 'Dangling');
		expect(cls).toBeDefined();
		expect(cls!.startLine).toBeGreaterThan(0);
		expect(cls!.endLine).toBeGreaterThanOrEqual(cls!.startLine);
	});

	test('commented-out declarations are not augmented', async () => {
		const source = `<?php
// class Ghost {}
/* trait Phantom {} */
class Real {}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'Ghost')).toBeUndefined();
		expect(def(facts!, 'Phantom')).toBeUndefined();
		expect(def(facts!, 'Real')).toMatchObject({ kind: 'class' });
	});
});
