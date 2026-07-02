import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

describe('extractFileSymbols - JVM and .NET API facts', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('java captures visibility, enums, static imports, and member refs', async () => {
		const source = `
package com.example.api;

import static com.example.MathUtil.max;
import com.example.model.User;

public enum Mode { FAST }

public class Service {
  public int compute(User user) {
    return max(user.score(), 1);
  }

  private void hidden() {}
}
`;

		const facts = await extractFileSymbols('java', source);
		expect(facts).not.toBeNull();
		expect(facts!.defs.find((d) => d.name === 'Mode')).toMatchObject({
			kind: 'enum',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'Service')).toMatchObject({
			kind: 'class',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'compute')).toMatchObject({
			kind: 'method',
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'hidden')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'com.example.MathUtil',
				importType: 'named',
				bindings: [{ imported: 'max', local: 'max' }],
			}),
		);
	});

	test('kotlin captures default/internal/private visibility and aliased imports', async () => {
		const source = `
package com.example.api

import com.example.text.slugify as slug

internal class Formatter {
  fun render(value: String): String = value.slug()
  private fun hidden() {}
}

fun String.slug(): String = slug(this)
`;

		const facts = await extractFileSymbols('kotlin', source);
		expect(facts).not.toBeNull();
		expect(facts!.defs.find((d) => d.name === 'Formatter')).toMatchObject({
			kind: 'class',
			exported: true,
			visibilityInfo: { visibility: 'internal' },
		});
		expect(facts!.defs.find((d) => d.name === 'render')).toMatchObject({
			kind: 'method',
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'hidden')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'com.example.text.slugify',
				importType: 'named',
				bindings: [{ imported: 'slugify', local: 'slug' }],
			}),
		);
	});

	test('csharp captures namespaces, records, constructors, and using aliases', async () => {
		const source = `
using Helper = Example.Core.TextHelper;
using static Example.Core.MathUtil;

namespace Example.Api;

public record UserDto(string Name);

internal class Service {
  public Service() {}
  public int Compute() => Max(1, 2);
  private void Hidden() {}
}
`;

		const facts = await extractFileSymbols('csharp', source);
		expect(facts).not.toBeNull();
		expect(facts!.defs.find((d) => d.name === 'UserDto')).toMatchObject({
			kind: 'class',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'Service')).toMatchObject({
			kind: 'class',
			exported: true,
			visibilityInfo: { visibility: 'internal' },
		});
		expect(facts!.defs.find((d) => d.name === 'Compute')).toMatchObject({
			kind: 'method',
			visibilityInfo: { visibility: 'public' },
		});
		expect(facts!.defs.find((d) => d.name === 'Hidden')).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		expect(facts!.imports).toContainEqual(
			expect.objectContaining({
				specifier: 'Example.Core.TextHelper',
				importType: 'named',
				bindings: [{ imported: 'TextHelper', local: 'Helper' }],
			}),
		);
	});

	test('does not create method defs from calls and preserves C# default private methods', async () => {
		const java = await extractFileSymbols(
			'java',
			'public class App { public int run() { return max(1, 2); } }',
		);
		expect(java).not.toBeNull();
		expect(java!.defs.map((d) => d.name)).toContain('run');
		expect(java!.defs.map((d) => d.name)).not.toContain('max');

		const csharp = await extractFileSymbols(
			'csharp',
			'public class Runner { void Run() { Helper(); } public void Start() {} }',
		);
		expect(csharp).not.toBeNull();
		expect(csharp!.defs.map((d) => d.name)).not.toContain('Helper');
		const run = csharp!.defs.find((d) => d.name === 'Run');
		expect(run).toMatchObject({
			kind: 'method',
			exported: false,
			visibilityInfo: { visibility: 'private' },
		});
		const start = csharp!.defs.find((d) => d.name === 'Start');
		expect(start).toMatchObject({
			kind: 'method',
			exported: true,
			visibilityInfo: { visibility: 'public' },
		});
	});

	test('keeps repeated Java method names distinct across classes and overloads', async () => {
		const acrossClasses = await extractFileSymbols(
			'java',
			`
public class A { public int run() { return 1; } }
public class B { public int run() { return 2; } }
`,
		);
		expect(acrossClasses).not.toBeNull();
		const classRuns = acrossClasses!.defs.filter((d) => d.name === 'run');
		expect(classRuns).toHaveLength(2);
		expect(classRuns.every((d) => d.kind === 'method')).toBe(true);
		expect(classRuns.every((d) => d.exported)).toBe(true);

		const overloads = await extractFileSymbols(
			'java',
			`
public class App {
  public int run() { return 1; }
  public int run(int value) { return value; }
}
`,
		);
		expect(overloads).not.toBeNull();
		const overloadedRuns = overloads!.defs.filter((d) => d.name === 'run');
		expect(overloadedRuns).toHaveLength(2);
		expect(overloadedRuns.map((d) => d.startLine)).toEqual([3, 4]);
		expect(overloadedRuns.every((d) => d.kind === 'method')).toBe(true);
		expect(overloadedRuns.every((d) => d.exported)).toBe(true);
	});
});
