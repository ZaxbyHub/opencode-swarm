/**
 * Grammar-level acceptance evidence for issue #1530 (C/C++ and Swift symbol
 * graph hardening). Mirrors the KG-08 (#1529) file structure for java/kotlin/
 * csharp: real tree-sitter grammars, no mocks. Each test maps to an explicit
 * acceptance criterion of the issue:
 *   - C/C++ header-declared public symbols are represented
 *   - C/C++ internal/static caveats handled conservatively (static +
 *     anonymous namespace)
 *   - C++ namespace/class/function/method/enum/typedef extraction, overload
 *     representation + name-collapse caveat, template best-effort
 *   - Swift visibility modifiers (open/public/internal/fileprivate/private),
 *     implicit internal, extension blocks, protocol members, typealias,
 *     attribute-prefixed declarations
 *   - malformed input fails open for both grammars
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function byName(
	facts: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>,
	name: string,
) {
	return facts.defs.find((d) => d.name === name);
}

describe('extractFileSymbols — cpp grammar hardening (issue #1530)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('C header: prototypes and pointer-return prototypes are public defs', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'#ifndef UTIL_H',
				'#define UTIL_H',
				'int add(int a, int b);',
				'char *concat(const char *a, const char *b);',
				'#endif',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const add = byName(facts!, 'add');
		expect(add).toBeDefined();
		expect(add!.kind).toBe('function');
		expect(add!.exported).toBe(true);
		expect(add!.visibilityInfo?.visibility).toBe('public');
		const concat = byName(facts!, 'concat');
		expect(concat).toBeDefined();
		expect(concat!.exported).toBe(true);
	});

	test('C source: static is private, plain function is public', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'#include <stdio.h>',
				'#include "util.h"',
				'',
				'static int helper(int v) { return v * 2; }',
				'int add(int a, int b) { return helper(a) + b; }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!, 'helper')?.exported).toBe(false);
		expect(byName(facts!, 'helper')?.visibilityInfo?.visibility).toBe(
			'private',
		);
		expect(byName(facts!, 'add')?.exported).toBe(true);
	});

	test('C++ namespace/class: members, ctor, enum, struct, typedef represented', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'namespace engine {',
				'  class Engine {',
				'  public:',
				'    Engine(int capacity);',
				'    void start();',
				'    int capacity() const { return capacity_; }',
				'  private:',
				'    int capacity_;',
				'  };',
				'  enum Status { Idle, Running };',
				'  struct Config { int retries; };',
				'  typedef unsigned long token_t;',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const engine = byName(facts!, 'Engine');
		expect(engine?.kind).toBe('class');
		expect(engine?.exported).toBe(true);
		// The constructor reuses the free-prototype pattern; the container walk
		// must re-type it to method and resolve a non-unknown visibility.
		const ctor = facts!.defs.filter((d) => d.name === 'Engine');
		expect(ctor.some((d) => d.kind === 'method')).toBe(true);
		const start = byName(facts!, 'start');
		expect(start?.kind).toBe('method');
		expect(start?.exported).toBe(false);
		const capacity = byName(facts!, 'capacity');
		expect(capacity?.kind).toBe('method');
		expect(capacity?.exported).toBe(false);
		// Class members default private (class_specifier container); access
		// specifiers are not tracked — conservative by design (documented).
		expect(capacity?.visibilityInfo?.visibility).toBe('private');
		expect(byName(facts!, 'Status')?.kind).toBe('enum');
		expect(byName(facts!, 'Config')?.kind).toBe('type');
		expect(byName(facts!, 'token_t')?.kind).toBe('type');
	});

	test('C++ struct members default public visibility (non-exported)', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'struct Config {\n  int retries;\n  void reset() {}\n};\n',
		);
		expect(facts).not.toBeNull();
		const reset = byName(facts!, 'reset');
		expect(reset?.kind).toBe('method');
		expect(reset?.exported).toBe(false);
		expect(reset?.visibilityInfo?.visibility).toBe('public');
	});

	test('C++ overload pair is fully represented; names collapse conservatively', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'void run(int times);',
				'int run(int times, int retries);',
				'void run(int times) { }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const overloads = facts!.defs.filter((d) => d.name === 'run');
		// All three declarations (two prototypes + one definition) are defs.
		// Overload resolution is conservative: same-name defs are NOT merged —
		// downstream (exportRanges) collapses them by name with a documented
		// last-exported-wins policy.
		expect(overloads.length).toBe(3);
		expect(overloads.every((d) => d.exported)).toBe(true);
	});

	test('C++ out-of-class qualified definition is named by the function, not the namespace', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'namespace engine {\nvoid run();\n}\nvoid engine::run() { }\n',
		);
		expect(facts).not.toBeNull();
		// qualified_identifier's namespace segment parses as
		// namespace_identifier (a different node type), so only the trailing
		// `identifier` can be captured: the def must be `run`, never `engine`.
		expect(byName(facts!, 'run')).toBeDefined();
		expect(byName(facts!, 'engine')).toBeUndefined();
	});

	test('C++ anonymous namespace members are internal (not exported)', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'namespace {\n',
				'int internal_fn() { return 1; }\n',
				'}\n',
				'int public_fn() { return 2; }\n',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const internal = byName(facts!, 'internal_fn');
		expect(internal?.exported).toBe(false);
		expect(internal?.visibilityInfo?.visibility).toBe('private');
		expect(byName(facts!, 'public_fn')?.exported).toBe(true);
	});

	test('C++ named namespace members stay exported', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'namespace engine {\nint visible() { return 1; }\n}\n',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!, 'visible')?.exported).toBe(true);
	});

	test('C++ anonymous namespace nested in a named namespace is still internal', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'namespace engine {',
				'namespace {',
				'void nested_hidden() { }',
				'}',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		// The ancestor walk must see THROUGH the named namespace to the
		// anonymous one — anything inside an anonymous namespace has internal
		// linkage regardless of nesting depth.
		expect(byName(facts!, 'nested_hidden')?.exported).toBe(false);
	});

	test('C++ template function and class get best-effort extraction', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'template <typename T>',
				'T identity(T x) { return x; }',
				'',
				'template <typename T>',
				'class Box {',
				'public:',
				'  T value;',
				'};',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const identity = byName(facts!, 'identity');
		expect(identity?.kind).toBe('function');
		expect(identity?.exported).toBe(true);
		const box = byName(facts!, 'Box');
		expect(box?.kind).toBe('class');
		expect(box?.exported).toBe(true);
	});

	test('C++ type references appear in refs (type_identifier capture)', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			[
				'struct Config { int retries; };',
				'',
				'Config makeConfig() {',
				'    Config c = { 1 };',
				'    return c;',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		// Signature AND body type references must surface as refs.
		const configRefs = facts!.refs.filter((r) => r.identifier === 'Config');
		expect(configRefs.length).toBeGreaterThanOrEqual(2);
	});

	test('C++ operators and destructors are deliberately not extracted (documented)', async () => {
		// Documented limitation (PR #2351 review PRR-009): their names parse
		// as dedicated grammar nodes (operator_name / destructor_name), not
		// plain identifiers. Pinned so a future change is a conscious one.
		const facts = await extractFileSymbols(
			'cpp',
			[
				'class Vec {',
				'public:',
				'    Vec operator+(const Vec &other) const { return other; }',
				'    operator int() const { return 0; }',
				'    ~Vec() {}',
				'};',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const names = facts!.defs.map((d) => d.name);
		expect(names).not.toContain('operator+');
		expect(names).not.toContain('operator int');
		expect(names).not.toContain('~Vec');
	});

	test('cpp malformed input fails open', async () => {
		const facts = await extractFileSymbols(
			'cpp',
			'class {{{ int x(;;; \n#include <<<\n',
		);
		expect(facts).not.toBeNull();
		expect(Array.isArray(facts!.defs)).toBe(true);
	});
});

describe('extractFileSymbols — swift grammar hardening (issue #1530)', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('all five explicit visibility modifiers are represented', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'open class OpenC { }',
				'public class PublicC { }',
				'internal class InternalC { }',
				'fileprivate class FileC { }',
				'private class PrivateC { }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!, 'OpenC')?.visibilityInfo?.visibility).toBe('public');
		expect(byName(facts!, 'OpenC')?.exported).toBe(true);
		expect(byName(facts!, 'PublicC')?.visibilityInfo?.visibility).toBe(
			'public',
		);
		expect(byName(facts!, 'InternalC')?.visibilityInfo?.visibility).toBe(
			'internal',
		);
		expect(byName(facts!, 'InternalC')?.exported).toBe(true);
		expect(byName(facts!, 'FileC')?.visibilityInfo?.visibility).toBe('private');
		expect(byName(facts!, 'FileC')?.exported).toBe(false);
		expect(byName(facts!, 'PrivateC')?.visibilityInfo?.visibility).toBe(
			'private',
		);
		expect(byName(facts!, 'PrivateC')?.exported).toBe(false);
	});

	test('members without modifiers default to internal (module-public)', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'public class PublicC {\n    func implicitInternal() {}\n}\n',
		);
		expect(facts).not.toBeNull();
		const member = byName(facts!, 'implicitInternal');
		expect(member?.kind).toBe('method');
		expect(member?.exported).toBe(false);
		expect(member?.visibilityInfo?.visibility).toBe('internal');
		expect(member?.visibilityInfo?.exportedReason).toBe('module_public');
	});

	test('member visibility modifiers override the container default', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'public class Mixed {',
				'    public func open_() {}',
				'    private func hidden() {}',
				'    fileprivate func fileOnly() {}',
				'    internal func moduleOnly() {}',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!, 'open_')?.visibilityInfo?.visibility).toBe('public');
		expect(byName(facts!, 'hidden')?.visibilityInfo?.visibility).toBe(
			'private',
		);
		expect(byName(facts!, 'fileOnly')?.visibilityInfo?.visibility).toBe(
			'private',
		);
		expect(byName(facts!, 'moduleOnly')?.visibilityInfo?.visibility).toBe(
			'internal',
		);
		// No member is a file-level module export.
		for (const name of ['open_', 'hidden', 'fileOnly', 'moduleOnly']) {
			expect(byName(facts!, name)?.exported).toBe(false);
		}
	});

	test('struct, enum, extension, protocol member, and typealias are represented', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'internal struct DataPayload {',
				'    func compute() -> Int { return 1 }',
				'}',
				'private enum Hidden { case one }',
				'protocol Serializable {',
				'    func serialize() -> Int',
				'}',
				'extension DataPayload {',
				'    func extended() -> Int { return 2 }',
				'}',
				'typealias Handler = (Int) -> Void',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		// struct/enum both parse as class_declaration; kind stays 'class'
		// (documented limitation — keyword-child discrimination is not modeled).
		const payload = byName(facts!, 'DataPayload');
		expect(payload?.kind).toBe('class');
		expect(payload?.visibilityInfo?.visibility).toBe('internal');
		expect(byName(facts!, 'compute')?.kind).toBe('method');
		expect(byName(facts!, 'Hidden')?.exported).toBe(false);
		// Protocol requirements are extracted as methods.
		const serialize = byName(facts!, 'serialize');
		expect(serialize?.kind).toBe('method');
		expect(serialize?.exported).toBe(false);
		// The extension contributes a second DataPayload def (type kind) whose
		// members are attributed as methods.
		const payloadDefs = facts!.defs.filter((d) => d.name === 'DataPayload');
		expect(payloadDefs.some((d) => d.kind === 'type')).toBe(true);
		expect(byName(facts!, 'extended')?.kind).toBe('method');
		expect(byName(facts!, 'Handler')?.kind).toBe('type');
	});

	test('protocol/class/function ranges span their declarations', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'protocol Serializable {',
				'    func serialize() -> Int',
				'}',
				'class Holder {',
				'    func compute() -> Int { return 1 }',
				'}',
				'func topLevel() -> Int { return 3 }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!, 'Serializable')).toMatchObject({
			startLine: 1,
			endLine: 3,
		});
		expect(byName(facts!, 'Holder')).toMatchObject({
			startLine: 4,
			endLine: 6,
		});
		expect(byName(facts!, 'topLevel')).toMatchObject({
			startLine: 7,
			endLine: 7,
		});
	});

	test('attribute-prefixed declarations keep their real modifier', async () => {
		const facts = await extractFileSymbols(
			'swift',
			[
				'@available(iOS 14, *)',
				'public func attributed() -> Int { return 1 }',
				'',
				'@MainActor',
				'internal func actorScoped() -> Int { return 2 }',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		// Pre-fix: declarationPrefix truncated at the newline inside the
		// attribute and `attributed` resolved internal instead of public.
		expect(byName(facts!, 'attributed')?.visibilityInfo?.visibility).toBe(
			'public',
		);
		expect(byName(facts!, 'actorScoped')?.visibilityInfo?.visibility).toBe(
			'internal',
		);
	});

	test('swift malformed input fails open', async () => {
		const facts = await extractFileSymbols(
			'swift',
			'class {{{ func (( \nimport <<<<\n',
		);
		expect(facts).not.toBeNull();
		expect(Array.isArray(facts!.defs)).toBe(true);
	});

	test('swift init and stored properties are deliberately not extracted', async () => {
		// Documented non-goal (grammar gives init no name node; properties are
		// outside the symbol scope). Pinned so a future regression toward
		// half-extracted inits (e.g. named by parameter text) is caught.
		const facts = await extractFileSymbols(
			'swift',
			[
				'public class Service {',
				'    public init() {}',
				'    public var stored = 1',
				'    public func work() -> Int { return stored }',
				'}',
				'',
			].join('\n'),
		);
		expect(facts).not.toBeNull();
		const names = facts!.defs.map((d) => d.name);
		expect(names).not.toContain('init');
		expect(names).not.toContain('stored');
		expect(byName(facts!, 'work')?.kind).toBe('method');
	});
});
