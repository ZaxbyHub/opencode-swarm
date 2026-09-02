import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	extractDartSymbols,
	extractPhpSymbols,
	extractRubySymbols,
} from '../../../src/tools/symbols';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = canonicalMkdtemp('symbols-dart-ruby-php-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols tool — dart/ruby/php extractors (#1531)', () => {
	test('dart: types and functions with `_` privacy filtering', () => {
		write(
			'model.dart',
			`class Foo {
  void bar() {}
  final int _privateField = 0;
}

mixin Helper {}
enum Mode { fast }
void _hidden() {}
void visible() {}
`,
		);

		const symbols = extractDartSymbols('model.dart', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Foo', kind: 'class', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Helper', kind: 'type', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Mode', kind: 'enum', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'visible',
				kind: 'function',
				exported: true,
			}),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: '_privateField' }),
		);
		expect(symbols.find((s) => s.name === '_hidden')?.exported).toBe(false);
	});

	test('dart: control-flow and call expressions are not functions', () => {
		write(
			'flow.dart',
			`void main() {
  if (ready()) {}
  return helper();
  final x = make();
}
`,
		);

		const symbols = extractDartSymbols('flow.dart', root);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'ready' }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'helper' }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'make' }),
		);
		expect(symbols).not.toContainEqual(expect.objectContaining({ name: 'if' }));
	});

	test('dart: extension types, unnamed extensions, typedefs, Dart 3 modifiers', () => {
		write(
			'modern.dart',
			`extension type Meters(int value) {}
extension on String {}
sealed class Node {}
typedef Callback = void Function(int);
`,
		);

		const symbols = extractDartSymbols('modern.dart', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Meters', kind: 'type' }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'type' }),
		);
		expect(symbols).not.toContainEqual(expect.objectContaining({ name: 'on' }));
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Node', kind: 'class' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Callback', kind: 'type' }),
		);
	});

	test('ruby: modules, classes, constants, methods, visibility sections', () => {
		write(
			'service.rb',
			`module Billing
VERSION = '1'
class Service
  def self.build; end
  private
  def token; end
  def _internal; end
end
class Other
  def visible; end
end
end
`,
		);

		const symbols = extractRubySymbols('service.rb', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'Billing',
				kind: 'type',
				exported: true,
			}),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'VERSION', kind: 'const' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Service', kind: 'class' }),
		);
		// singleton methods keep the self. qualification and stay public
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'self.build',
				kind: 'method',
				exported: true,
			}),
		);
		// private-section methods are not exported
		expect(symbols.find((s) => s.name === 'token')?.exported).toBe(false);
		expect(symbols.find((s) => s.name === '_internal')?.exported).toBe(false);
		// a new class body resets the section to public
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'visible',
				kind: 'method',
				exported: true,
			}),
		);
	});

	test('php: namespaces, traits, classes, methods with visibility', () => {
		write(
			'Service.php',
			`<?php
namespace App\\Billing;
trait Logs {}
class Service {
  function run() {}
  static function build() {}
  private function token() {}
}
function helper() {}
`,
		);

		const symbols = extractPhpSymbols('Service.php', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'App\\Billing',
				kind: 'type',
				exported: true,
			}),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Logs', kind: 'interface' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Service', kind: 'class' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'run', kind: 'method', exported: true }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'build',
				kind: 'method',
				exported: true,
			}),
		);
		expect(symbols.find((s) => s.name === 'token')?.exported).toBe(false);
		expect(symbols).toContainEqual(
			expect.objectContaining({
				name: 'helper',
				kind: 'function',
				exported: true,
			}),
		);
	});

	test('php: commented-out declarations are skipped', () => {
		write(
			'ghost.php',
			`<?php
// class Ghost {}
/* function phantom() {} */
class Real {}
`,
		);

		const symbols = extractPhpSymbols('ghost.php', root);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'Ghost' }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'phantom' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Real', kind: 'class' }),
		);
	});
});

describe('symbols tool — dart/ruby/php extractors round 2 (#2361 review)', () => {
	test('dart: class members are qualified TypeName.method, not top-level functions (R6)', () => {
		write(
			'members.dart',
			`class Foo {
  void bar() {}
  static void staticBaz() {}
}
void topLevel() {}
`,
		);

		const symbols = extractDartSymbols('members.dart', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Foo.staticBaz', kind: 'method' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'topLevel', kind: 'function' }),
		);
		expect(symbols).not.toContainEqual(
			expect.objectContaining({ name: 'bar', kind: 'function' }),
		);
	});

	test('dart: same-named members of different classes do not collapse (R7)', () => {
		write(
			'twins.dart',
			`class A {
  void run() {}
}
class B {
  void run() {}
}
`,
		);

		const symbols = extractDartSymbols('twins.dart', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'A.run', kind: 'method' }),
		);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'B.run', kind: 'method' }),
		);
	});

	test('dart: `void Function(int)` type references are not symbols (PRR-006)', () => {
		write('fnref.dart', 'typedef Cb = void Function(int);\nvoid real() {}\n');
		const symbols = extractDartSymbols('fnref.dart', root);
		expect(symbols.find((s) => s.name === 'Function')).toBeUndefined();
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'real', kind: 'function' }),
		);
	});

	test('ruby: CRLF sources report correct line numbers (PRR-001)', () => {
		write(
			'crlf.rb',
			[
				'module Billing',
				'class Service',
				'  def work; end',
				'end',
				'end',
				'',
			].join('\r\n'),
		);
		const symbols = extractRubySymbols('crlf.rb', root);
		const service = symbols.find((s) => s.name === 'Service');
		const work = symbols.find((s) => s.name === 'work');
		expect(service?.line).toBe(2);
		expect(work?.line).toBe(3);
	});

	test('php: enums are extracted (R8)', () => {
		write('suit.php', "<?php\nenum Suit: string {\n\tcase Hearts = 'h';\n}\n");
		const symbols = extractPhpSymbols('suit.php', root);
		expect(symbols).toContainEqual(
			expect.objectContaining({ name: 'Suit', kind: 'enum', exported: true }),
		);
	});

	test('ruby: nested class restores outer private section (R1 parity)', () => {
		write(
			'nested.rb',
			[
				'class Outer',
				'  private',
				'  class Inner',
				'    def inner_m; end',
				'  end',
				'  def outer_m; end',
				'end',
				'',
			].join('\n'),
		);
		const symbols = extractRubySymbols('nested.rb', root);
		expect(symbols.find((s) => s.name === 'inner_m')?.exported).toBe(true);
		expect(symbols.find((s) => s.name === 'outer_m')?.exported).toBe(false);
	});

	test('php: string literals do not corrupt brace ranges', () => {
		write(
			'glue.php',
			[
				'<?php',
				'class S {',
				'  public function render() {',
				"    $glue = '}';",
				'    return $glue;',
				'  }',
				'  public function other() {}',
				'}',
				'',
			].join('\n'),
		);
		const symbols = extractPhpSymbols('glue.php', root);
		expect(symbols.find((s) => s.name === 'other')?.kind).toBe('method');
		expect(symbols.find((s) => s.name === 'render')?.kind).toBe('method');
	});
});
