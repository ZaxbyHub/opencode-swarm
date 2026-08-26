import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function def(
	facts: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>,
	name: string,
) {
	return facts.defs.find((item) => item.name === name);
}

describe('extractFileSymbols — ruby hardening (#1531)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('captures require_relative, modules, constants, singleton methods, and private methods', async () => {
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
		// singleton methods keep their self. qualification
		expect(def(facts!, 'self.build')).toMatchObject({
			kind: 'method',
			exported: true,
		});
		// a new class body resets the visibility section to public
		expect(def(facts!, 'visible')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
	});

	test('require (non-relative) stays a namespace import', async () => {
		const facts = await extractFileSymbols('ruby', "require 'json'\n");
		expect(facts).not.toBeNull();
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'json',
				importType: 'namespace',
			}),
		);
	});

	test('heredoc bodies do not flip visibility or create defs; opener consts survive', async () => {
		const source = `QUERY = <<~SQL
private
def ghost_method
class Ghost
SQL
class Repo
	def after
	end

	private

	def secret
	end
end
`;
		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		// the heredoc opener line still declares its constant
		expect(def(facts!, 'QUERY')).toMatchObject({ kind: 'const' });
		// heredoc BODY lines are string data, not code
		expect(def(facts!, 'ghost_method')).toBeUndefined();
		expect(def(facts!, 'Ghost')).toBeUndefined();
		// a literal `private` inside the heredoc must NOT flip the section:
		// `after` (declared before the real `private`) is public, and `secret`
		// (after it) is private
		expect(def(facts!, 'after')).toMatchObject({
			kind: 'method',
			exported: true,
		});
		expect(def(facts!, 'secret')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
	});

	test('shift operators (`arr <<item`, `x << y`) never open heredocs', async () => {
		const source = `class Bits
	def build(list)
		list <<item
		x = 2 <<3
	end
end
class After
	def alive
	end
end
`;
		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		// A spurious heredoc would swallow every following augmented def —
		// `After`/`alive` surviving proves the operators did not open one.
		expect(def(facts!, 'Bits')).toMatchObject({ kind: 'class' });
		expect(def(facts!, 'build')).toMatchObject({ kind: 'method' });
		expect(def(facts!, 'After')).toMatchObject({ kind: 'class' });
		expect(def(facts!, 'alive')).toMatchObject({
			kind: 'method',
			exported: true,
		});
	});

	test('`private :symbol` targets one method and does not flip the section', async () => {
		const source = `class C
	def a
	end

	private :a

	def b
	end
end
`;
		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		// `b` is still public — the symbol-argument form is per-method only
		expect(def(facts!, 'b')).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
	});

	test('question/bang method names are captured', async () => {
		const source = `class Doc
	def valid?
	end

	def save!
	end
end
`;
		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'valid?')).toMatchObject({ kind: 'method' });
		expect(def(facts!, 'save!')).toMatchObject({ kind: 'method' });
	});

	test('end keyword inside a string literal does not affect defs', async () => {
		const source = `class C
	def phrase
		"tail end"
	end
end
`;
		const facts = await extractFileSymbols('ruby', source);
		expect(facts).not.toBeNull();
		expect(def(facts!, 'C')).toMatchObject({ kind: 'class' });
		expect(def(facts!, 'phrase')).toMatchObject({ kind: 'method' });
		// exactly one def per name — augmentation upserted, not duplicated
		expect(facts!.defs.filter((d) => d.name === 'phrase')).toHaveLength(1);
	});
});
