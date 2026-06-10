import { describe, expect, test } from 'bun:test';
import { buildGoBackend } from '../../../src/lang/backends/go';
import { buildPythonBackend } from '../../../src/lang/backends/python';

/**
 * Phase 5: Python + Go backend extractImports.
 *
 * Each backend's `extractImports` is the regex-driven equivalent of the
 * TypeScript backend's. Tests lock in the supported import-syntax shapes
 * so future regex tightening doesn't silently drop edges from the
 * test-impact graph.
 */

describe('python backend — extractImports', () => {
	const backend = buildPythonBackend();

	test('captures `import foo`', () => {
		const out = backend.extractImports!('m.py', 'import os');
		expect(out).toContain('os');
	});

	test('captures dotted module path `import foo.bar`', () => {
		const out = backend.extractImports!('m.py', 'import os.path');
		expect(out).toContain('os.path');
	});

	test('captures `import foo as f`', () => {
		const out = backend.extractImports!('m.py', 'import numpy as np');
		expect(out).toContain('numpy');
		expect(out).not.toContain('np');
	});

	test('captures `import foo, bar`', () => {
		const out = backend.extractImports!('m.py', 'import sys, os, json');
		expect(out).toEqual(expect.arrayContaining(['sys', 'os', 'json']));
	});

	test('captures `from foo import x`', () => {
		const out = backend.extractImports!(
			'm.py',
			'from collections import OrderedDict',
		);
		expect(out).toContain('collections');
	});

	test('captures `from foo.bar import x` with dotted path', () => {
		const out = backend.extractImports!('m.py', 'from os.path import join');
		expect(out).toContain('os.path');
	});

	test('`from . import sibling` emits ".sibling" (PR #825 P1 #5: was bare ".")', () => {
		// Pre-fix this emitted "." which resolved to __init__.py instead of
		// sibling.py — a silent miss. Post-fix the import-target name is
		// concatenated with the relative-package prefix.
		const out = backend.extractImports!('m.py', 'from . import sibling');
		expect(out).toContain('.sibling');
	});

	test('captures `from .foo import x` (relative submodule)', () => {
		const out = backend.extractImports!('m.py', 'from .foo import bar');
		expect(out).toContain('.foo');
	});

	test('captures multiple imports in one file with deduplication', () => {
		const src = `
import os
import os.path
from collections import deque
from collections import OrderedDict
`;
		const out = backend.extractImports!('m.py', src);
		// `collections` appears twice but is deduplicated.
		expect(out.filter((p) => p === 'collections')).toHaveLength(1);
		expect(out).toEqual(
			expect.arrayContaining(['os', 'os.path', 'collections']),
		);
	});

	test('ignores commented-out imports (best-effort — only #-prefixed)', () => {
		// Conservative: regex anchors on `^\s*from|import`, so a leading
		// `#` shifts the match, but `# import foo` still matches because
		// `\s*` allows the leading `#` to be skipped only without it.
		// Actually it does NOT match — leading `#` is not whitespace.
		const out = backend.extractImports!('m.py', '# import secret_module');
		expect(out).not.toContain('secret_module');
	});

	test('multi-line `from x import (\\n a,\\n b\\n)` extracts module name', () => {
		const src = `from typing import (
    Dict,
    List,
    Optional,
)`;
		const out = backend.extractImports!('m.py', src);
		expect(out).toContain('typing');
	});

	test('multi-line relative imports with `# noqa` comments do NOT drop names (PR #825 adversarial C2)', () => {
		const src = `from . import (
    helper,  # noqa
    util,  # type: ignore
    other,
)`;
		const out = backend.extractImports!('m.py', src);
		expect(out).toContain('.helper');
		expect(out).toContain('.util');
		expect(out).toContain('.other');
	});

	test('line-continuation `\\\\` does not drop the first name (PR #825 adversarial C3)', () => {
		// `from . import a, \\\n  b` — the trailing backslash escapes the
		// newline and continues the import on the next line.
		const src = 'from . import a, \\\n    b';
		const out = backend.extractImports!('m.py', src);
		expect(out).toContain('.a');
		expect(out).toContain('.b');
	});
});

describe('go backend — extractImports', () => {
	const backend = buildGoBackend();

	test('captures single-line `import "foo"`', () => {
		const out = backend.extractImports!('m.go', 'import "fmt"');
		expect(out).toContain('fmt');
	});

	test('captures aliased single-line `import alias "foo"`', () => {
		const out = backend.extractImports!('m.go', 'import myfmt "fmt"');
		expect(out).toContain('fmt');
	});

	test('captures side-effect single-line `import _ "foo"`', () => {
		const out = backend.extractImports!('m.go', 'import _ "embed"');
		expect(out).toContain('embed');
	});

	test('captures grouped `import (\\n "foo"\\n "bar"\\n)`', () => {
		const src = `import (
    "fmt"
    "os"
    "io"
)`;
		const out = backend.extractImports!('m.go', src);
		expect(out).toEqual(expect.arrayContaining(['fmt', 'os', 'io']));
	});

	test('captures grouped block with aliases and side-effect imports', () => {
		const src = `import (
    "fmt"
    myfmt "fmt/v2"
    _ "github.com/lib/pq"
    . "math"
)`;
		const out = backend.extractImports!('m.go', src);
		expect(out).toEqual(
			expect.arrayContaining(['fmt', 'fmt/v2', 'github.com/lib/pq', 'math']),
		);
	});

	test('handles real-world third-party paths', () => {
		const src = `package main

import (
    "fmt"
    "github.com/spf13/cobra"
    "github.com/sirupsen/logrus"
)`;
		const out = backend.extractImports!('m.go', src);
		expect(out).toEqual(
			expect.arrayContaining([
				'fmt',
				'github.com/spf13/cobra',
				'github.com/sirupsen/logrus',
			]),
		);
	});

	test('deduplicates repeated imports across single + grouped forms', () => {
		const src = `import "fmt"

import (
    "fmt"
    "os"
)`;
		const out = backend.extractImports!('m.go', src);
		expect(out.filter((p) => p === 'fmt')).toHaveLength(1);
	});

	test('returns empty for files without imports', () => {
		const out = backend.extractImports!(
			'm.go',
			'package main\n\nfunc main() {}',
		);
		expect(out).toEqual([]);
	});
});

describe('backend registration: typescript + python + go + php', () => {
	test('all registered backends resolve through LANGUAGE_BACKEND_REGISTRY', async () => {
		await import('../../../src/lang/backends');
		const { LANGUAGE_BACKEND_REGISTRY } = await import(
			'../../../src/lang/registry-backend'
		);
		expect(LANGUAGE_BACKEND_REGISTRY.get('typescript')).toBeDefined();
		expect(LANGUAGE_BACKEND_REGISTRY.get('python')).toBeDefined();
		expect(LANGUAGE_BACKEND_REGISTRY.get('go')).toBeDefined();
		expect(LANGUAGE_BACKEND_REGISTRY.get('php')).toBeDefined();
	});
});
