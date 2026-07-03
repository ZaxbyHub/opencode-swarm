import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function def(
	facts: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>,
	name: string,
) {
	return facts.defs.find((item) => item.name === name);
}

describe('extractFileSymbols - native language hardening', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('cpp captures local/system includes, header declarations, enums, and static internals', async () => {
		const source = `#include "api.h"
#include <vector>

static int hidden() { return 0; }
namespace api {
enum Mode { Fast };
struct Widget {};
int make_widget();
int score(int value);
int score(double value);
}
int make_widget() { return hidden(); }
`;

		const facts = await extractFileSymbols('cpp', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './api.h',
				importType: 'default',
			}),
		);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'vector',
				importType: 'namespace',
			}),
		);
		expect(def(facts!, 'Mode')).toMatchObject({
			kind: 'enum',
			exported: true,
		});
		expect(def(facts!, 'Widget')).toMatchObject({
			kind: 'type',
			exported: true,
		});
		expect(def(facts!, 'make_widget')).toMatchObject({
			kind: 'function',
			exported: true,
		});
		expect(def(facts!, 'hidden')).toMatchObject({
			kind: 'function',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		const overloads = facts!.defs.filter((item) => item.name === 'score');
		expect(overloads).toHaveLength(2);
		expect(overloads.every((item) => item.exported)).toBe(true);
	});

	test('cpp refs inside namespaces are not suppressed', async () => {
		const source = `namespace api {
int compute() { return helper(); }
int helper() { return 42; }
}
`;
		const facts = await extractFileSymbols('cpp', source);
		expect(facts).not.toBeNull();
		// The 'helper' call inside namespace api { ... } must NOT be filtered
		// by isInsideImportStatement (regression: namespace_definition was
		// wrongly in IMPORT_ANCESTOR_TYPES, suppressing all refs inside namespaces)
		expect(facts!.refs.some((r) => r.identifier === 'helper')).toBe(true);
	});

	test('swift captures visibility modifiers, structs/enums/protocols, and extension members', async () => {
		const source = `import Foundation

public struct Model {}
internal enum Mode { case fast }
open protocol Renderable {}
fileprivate func hidden() {}
public extension Model {
	func render() { hidden() }
}
`;

		const facts = await extractFileSymbols('swift', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'Model')).toMatchObject({
			kind: 'type',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(def(facts!, 'Mode')).toMatchObject({
			kind: 'enum',
			exported: true,
			visibilityInfo: { visibility: 'internal' },
		});
		expect(def(facts!, 'Renderable')).toMatchObject({
			kind: 'interface',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(def(facts!, 'hidden')).toMatchObject({
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(def(facts!, 'render')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
	});
});

describe('extractFileSymbols - dynamic language hardening', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('dart captures import/export directives and underscore-private API convention', async () => {
		const source = `import './src/helper.dart' as helper;
export './src/public_api.dart' show PublicApi;

class PublicWidget {}
void _hidden() {}
`;

		const facts = await extractFileSymbols('dart', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './src/helper.dart',
				importType: 'namespace',
				bindings: [],
			}),
		);
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './src/public_api.dart',
				reExport: true,
				exportedBindings: [{ imported: 'PublicApi', exported: 'PublicApi' }],
			}),
		);
		expect(def(facts!, 'PublicWidget')).toMatchObject({
			kind: 'class',
			exported: true,
		});
		expect(def(facts!, '_hidden')).toMatchObject({
			kind: 'function',
			exported: false,
		});
	});

	test('ruby captures require_relative, modules, constants, singleton methods, and private methods', async () => {
		const source = `require_relative 'helper'

module Api
	VERSION = '1'
	class Client
		def call
			Helper.run
		end

		private

		def hidden
		end

		def self.build
			new
		end
	end

	class Other
		def visible
		end
	end
end
`;

		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: './helper',
				importType: 'default',
			}),
		);
		expect(def(facts!, 'Api')).toMatchObject({ kind: 'type', exported: true });
		expect(def(facts!, 'VERSION')).toMatchObject({
			kind: 'const',
			exported: true,
		});
		expect(def(facts!, 'Client')).toMatchObject({
			kind: 'class',
			exported: true,
		});
		expect(def(facts!, 'call')).toMatchObject({
			kind: 'method',
			exported: true,
		});
		expect(def(facts!, 'hidden')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(def(facts!, 'self.build')).toMatchObject({
			kind: 'method',
			exported: true,
		});
		expect(def(facts!, 'visible')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
	});

	test('php captures namespaces, traits, functions, classes, and method visibility', async () => {
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
	});
});
