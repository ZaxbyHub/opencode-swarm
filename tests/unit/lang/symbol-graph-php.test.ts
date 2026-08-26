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

describe('extractFileSymbols — php hardening round 2 (#2361 review)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('PHP 8.1 enums are captured as enum defs (R8)', async () => {
		const source = `<?php
namespace App;
enum Suit: string {
	case Hearts = 'h';
	public function color(): string { return 'red'; }
}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'Suit')).toMatchObject({ kind: 'enum', exported: true });
		expect(def(facts!, 'color')).toMatchObject({ kind: 'method' });
	});

	test('trait `use` inside a class body is not an import edge (R5)', async () => {
		const source = `<?php
trait Loggable {}
class Service {
	use Loggable;
	public function run() {}
}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(0);
	});

	test('string literals with braces/semicolons do not corrupt spans (PRR-011)', async () => {
		const source = `<?php
class Service {
	public function sep($x = '};') { $y = 1; }
	public function brace($s = '{') { $z = 2; }
	public function render() {
		$glue = '}';
		return $glue;
	}
}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		// render spans its whole declaration (5→8), not truncated at the
		// string brace nor inflated to the class end
		expect(def(facts!, 'render')).toMatchObject({
			kind: 'method',
			startLine: 5,
			endLine: 8,
		});
		// sep/brace spans stay on their own signature lines
		const sep = def(facts!, 'sep');
		const brace = def(facts!, 'brace');
		expect(sep!.endLine).toBeLessThanOrEqual(3);
		expect(brace!.endLine).toBeLessThanOrEqual(4);
		expect(sep!.kind).toBe('method');
		expect(brace!.kind).toBe('method');
	});

	test('`#` line comments are masked before augmentation (PRR-020)', async () => {
		const source = `<?php
# class GhostHash {}
# trait PhantomHash {}
class RealHash {}
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'GhostHash')).toBeUndefined();
		expect(def(facts!, 'PhantomHash')).toBeUndefined();
		expect(def(facts!, 'RealHash')).toMatchObject({ kind: 'class' });
	});

	test('CRLF sources produce identical php defs to LF', async () => {
		const lf = `<?php
namespace AppServices;
trait Logs {}
class Service {
	function run() {}
}
`;
		const crlf = lf.replace(/\n/g, '\r\n');
		const lfFacts = await extractFileSymbols('php', lf);
		const crlfFacts = await extractFileSymbols('php', crlf);
		expect(crlfFacts!.defs).toEqual(lfFacts!.defs);
	});

	test('`use` inside a function body string is not an import (lexical mask)', async () => {
		const source = `<?php
$doc = 'use Fake\\Import;';
use RealThing;
`;
		const facts = await extractFileSymbols('php', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({ specifier: 'RealThing' }),
		);
		expect(
			facts!.imports.filter((i) => i.specifier.includes('Fake')),
		).toHaveLength(0);
	});
});
