/**
 * Language Profile Registry - Pure Data Types
 *
 * This file defines the LanguageProfile interface and LanguageRegistry class.
 * No tool logic, no subprocess calls - pure data definitions only.
 */

export interface BuildCommand {
	name: string;
	cmd: string;
	detectFile?: string;
	priority: number;
}

export interface TestFramework {
	name: string;
	detect: string;
	cmd: string;
	priority: number;
}

export interface LintTool {
	name: string;
	detect: string;
	cmd: string;
	priority: number;
}

export interface LanguageProfile {
	id: string;
	displayName: string;
	tier: 1 | 2 | 3;
	extensions: string[];
	/**
	 * Reserved for future "parser-only" entries (e.g. css, bash, ini, regex,
	 * and the tsx parser-grammar split) that should register a tree-sitter
	 * parser but never participate in test/build/lint dispatch. Currently
	 * unused — populated in a later phase.
	 */
	parserOnly?: boolean;
	treeSitter: {
		grammarId: string;
		wasmFile: string;
		/**
		 * Tree-sitter node names that represent comments for this language.
		 * Used by tools that strip comments (e.g. ast-diff, syntax-check).
		 *
		 * Optional in the type because tests construct ad-hoc profiles for
		 * fixtures that don't exercise comment-stripping. Production profiles
		 * MUST populate this — enforced by
		 * `tests/unit/lang/profile-registry-parity.test.ts` against every
		 * profile in `LANGUAGE_REGISTRY`. Source of truth lives here;
		 * `src/lang/registry.ts` exposes a parity subset for the parser-only
		 * registry.
		 */
		commentNodes?: string[];
	};
	build: {
		detectFiles: string[];
		commands: BuildCommand[];
	};
	test: {
		detectFiles: string[];
		frameworks: TestFramework[];
	};
	lint: {
		detectFiles: string[];
		linters: LintTool[];
	};
	audit: {
		detectFiles: string[];
		command: string | null;
		outputFormat: 'json' | 'text';
	};
	sast: {
		nativeRuleSet: string | null;
		semgrepSupport: 'ga' | 'beta' | 'experimental' | 'none';
	};
	prompts: {
		coderConstraints: string[];
		reviewerChecklist: string[];
		testConstraints?: string[];
	};
}

export class LanguageRegistry {
	private profiles: Map<string, LanguageProfile>;
	private extensionIndex: Map<string, string>;

	constructor() {
		this.profiles = new Map();
		this.extensionIndex = new Map();
	}

	/**
	 * Remove a previously registered profile and any extensions it claimed.
	 * Primarily used by tests to clean up after registering fixture profiles
	 * into the shared singleton — without this, fixture entries leak across
	 * test files in Bun's per-file-but-shared-process test runner. No-op if
	 * the id is not registered.
	 */
	unregister(id: string): void {
		const profile = this.profiles.get(id);
		if (!profile) return;
		this.profiles.delete(id);
		if (!profile.parserOnly) {
			for (const ext of profile.extensions) {
				if (this.extensionIndex.get(ext) === id) {
					this.extensionIndex.delete(ext);
				}
			}
		}
	}

	register(profile: LanguageProfile): void {
		const existing = this.profiles.get(profile.id);
		if (existing && existing !== profile) {
			throw new Error(
				`LanguageRegistry: profile id "${profile.id}" registered twice. ` +
					`Each LanguageProfile.id must be unique. ` +
					`Got: ${profile.displayName} vs existing ${existing.displayName}.`,
			);
		}
		// parserOnly profiles do not participate in extension dispatch (they
		// only register a parser via the tree-sitter registry). This protects
		// the cpp profile from a future tsx parserOnly entry stealing `.tsx`
		// from the typescript profile, etc.
		if (!profile.parserOnly) {
			for (const ext of profile.extensions) {
				const claimedBy = this.extensionIndex.get(ext);
				if (claimedBy && claimedBy !== profile.id) {
					throw new Error(
						`LanguageRegistry: extension "${ext}" registered by both ` +
							`"${claimedBy}" and "${profile.id}". A non-parserOnly profile ` +
							`must not collide on extensions. If both languages legitimately ` +
							`share an extension, mark one parserOnly: true.`,
					);
				}
				this.extensionIndex.set(ext, profile.id);
			}
		}
		this.profiles.set(profile.id, profile);
	}

	get(id: string): LanguageProfile | undefined {
		return this.profiles.get(id);
	}

	getById(id: string): LanguageProfile | undefined {
		return this.profiles.get(id);
	}

	getByExtension(ext: string): LanguageProfile | undefined {
		const profileId = this.extensionIndex.get(ext);
		if (profileId) {
			return this.profiles.get(profileId);
		}
		return undefined;
	}

	getAll(): LanguageProfile[] {
		return Array.from(this.profiles.values());
	}

	getTier(tier: 1 | 2 | 3): LanguageProfile[] {
		return Array.from(this.profiles.values()).filter((p) => p.tier === tier);
	}
}

export const LANGUAGE_REGISTRY = new LanguageRegistry();

LANGUAGE_REGISTRY.register({
	id: 'typescript',
	displayName: 'TypeScript / JavaScript',
	tier: 1,
	extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
	treeSitter: {
		grammarId: 'typescript',
		wasmFile: 'tree-sitter-typescript.wasm',
		commentNodes: ['comment', 'line_comment', 'block_comment'],
	},
	build: {
		detectFiles: ['package.json'],
		commands: [
			{
				name: 'bun build',
				cmd: 'bun run build',
				detectFile: 'package.json',
				priority: 10,
			},
			{
				name: 'tsc',
				cmd: 'npx tsc --noEmit',
				detectFile: 'tsconfig.json',
				priority: 9,
			},
			{
				name: 'vite build',
				cmd: 'npx vite build',
				detectFile: 'vite.config.ts',
				priority: 8,
			},
		],
	},
	test: {
		detectFiles: [
			'package.json',
			'vitest.config.ts',
			'jest.config.js',
			'.mocharc.js',
			'.mocharc.json',
		],
		frameworks: [
			{
				name: 'vitest',
				detect: 'vitest.config.ts',
				cmd: 'bun test',
				priority: 10,
			},
			{ name: 'jest', detect: 'jest.config.js', cmd: 'npx jest', priority: 9 },
			{
				// Bun lockfile is the unambiguous signal for a Bun-managed
				// project — the dispatch path requires this to avoid the
				// false-positive where any plain Node project's package.json
				// triggers bun:test detection. (PR #825 review finding P1 #2.)
				name: 'bun:test',
				detect: 'bun.lock',
				cmd: 'bun test',
				priority: 8,
			},
			{
				name: 'mocha',
				detect: '.mocharc.json',
				cmd: 'npx mocha',
				priority: 7,
			},
		],
	},
	lint: {
		detectFiles: [
			'biome.json',
			'biome.jsonc',
			'.eslintrc.js',
			'.eslintrc.json',
		],
		linters: [
			{
				name: 'biome',
				detect: 'biome.json',
				cmd: 'biome check --write .',
				priority: 10,
			},
			{
				name: 'eslint',
				detect: '.eslintrc.js',
				cmd: 'npx eslint --fix .',
				priority: 9,
			},
		],
	},
	audit: {
		detectFiles: ['package.json'],
		command: 'npm audit --json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'javascript', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Use strict TypeScript; no implicit any or type assertions without justification',
			'Prefer async/await over raw Promises; always handle rejections',
			'Use const/let, never var; prefer immutable data structures',
			'Follow existing import style (ESM); no require() in .ts files',
			'Add JSDoc for all exported functions and types',
		],
		reviewerChecklist: [
			'Verify no implicit any or unsafe type casts',
			'Check async error handling — unhandled Promises are bugs',
			'Confirm ESM import consistency (no mixed require/import)',
			'Validate exported API surface matches declared types',
			'Check for missing null/undefined guards on optional fields',
		],
	},
});

LANGUAGE_REGISTRY.register({
	id: 'python',
	displayName: 'Python',
	tier: 1,
	extensions: ['.py', '.pyw'],
	treeSitter: {
		grammarId: 'python',
		wasmFile: 'tree-sitter-python.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['setup.py', 'pyproject.toml', 'setup.cfg'],
		commands: [
			{
				name: 'pip install',
				cmd: 'pip install -e .',
				detectFile: 'setup.py',
				priority: 10,
			},
			{
				name: 'build',
				cmd: 'python -m build',
				detectFile: 'pyproject.toml',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'],
		frameworks: [
			{ name: 'pytest', detect: 'pytest.ini', cmd: 'pytest', priority: 10 },
			{
				name: 'unittest',
				detect: 'setup.py',
				cmd: 'python -m unittest discover',
				priority: 8,
			},
		],
	},
	lint: {
		detectFiles: ['pyproject.toml', '.ruff.toml', 'setup.cfg'],
		linters: [
			{
				name: 'ruff',
				detect: 'pyproject.toml',
				cmd: 'ruff check --fix .',
				priority: 10,
			},
			{ name: 'flake8', detect: 'setup.cfg', cmd: 'flake8 .', priority: 8 },
		],
	},
	audit: {
		detectFiles: ['requirements.txt', 'Pipfile.lock', 'pyproject.toml'],
		command: 'pip-audit --format json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'python', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Use type annotations on all function signatures (PEP 484)',
			'Prefer f-strings over .format() or % formatting',
			'Use pathlib.Path over os.path for filesystem operations',
			'Never use bare except:; catch specific exception types',
			'Follow PEP 8 style; max line length 120 characters',
		],
		reviewerChecklist: [
			'Verify type annotations are present on all public functions',
			'Check for bare except clauses or overly broad exception handling',
			'Confirm no mutable default arguments (def f(x=[]) anti-pattern)',
			'Validate f-string usage and no format string injection risks',
			'Check imports are organized (stdlib → third-party → local)',
		],
	},
});

LANGUAGE_REGISTRY.register({
	id: 'rust',
	displayName: 'Rust',
	tier: 1,
	extensions: ['.rs'],
	treeSitter: {
		grammarId: 'rust',
		wasmFile: 'tree-sitter-rust.wasm',
		commentNodes: ['line_comment', 'block_comment'],
	},
	build: {
		detectFiles: ['Cargo.toml'],
		commands: [
			{
				name: 'cargo build',
				cmd: 'cargo build',
				detectFile: 'Cargo.toml',
				priority: 10,
			},
			{
				name: 'cargo check',
				cmd: 'cargo check',
				detectFile: 'Cargo.toml',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['Cargo.toml'],
		frameworks: [
			{
				name: 'cargo test',
				detect: 'Cargo.toml',
				cmd: 'cargo test',
				priority: 10,
			},
		],
	},
	lint: {
		detectFiles: ['Cargo.toml'],
		linters: [
			{
				name: 'clippy',
				detect: 'Cargo.toml',
				cmd: 'cargo clippy --fix --allow-dirty',
				priority: 10,
			},
			{ name: 'rustfmt', detect: 'Cargo.toml', cmd: 'cargo fmt', priority: 9 },
		],
	},
	audit: {
		detectFiles: ['Cargo.lock'],
		command: 'cargo audit --json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'rust', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Prefer owned types over references where ownership is clear; use lifetimes sparingly',
			'Use Result<T, E> and ? operator for error propagation; never unwrap() in library code',
			'Prefer iterators and combinators over explicit loops',
			'Derive standard traits (Debug, Clone, PartialEq) whenever sensible',
			'Avoid unsafe blocks; document any unsafe usage with SAFETY comments',
		],
		reviewerChecklist: [
			'Verify no unwrap() or expect() calls in library/production paths',
			'Check for potential panics in indexing, arithmetic overflow, or slice operations',
			'Confirm error types implement std::error::Error and are propagated correctly',
			'Validate lifetime annotations are minimal and correct',
			'Check unsafe blocks have SAFETY comments explaining invariants',
		],
	},
});

LANGUAGE_REGISTRY.register({
	id: 'go',
	displayName: 'Go',
	tier: 1,
	extensions: ['.go'],
	treeSitter: {
		grammarId: 'go',
		wasmFile: 'tree-sitter-go.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['go.mod'],
		commands: [
			{
				name: 'go build',
				cmd: 'go build ./...',
				detectFile: 'go.mod',
				priority: 10,
			},
			{
				name: 'go vet',
				cmd: 'go vet ./...',
				detectFile: 'go.mod',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['go.mod'],
		frameworks: [
			{ name: 'go test', detect: 'go.mod', cmd: 'go test ./...', priority: 10 },
		],
	},
	lint: {
		detectFiles: ['go.mod', '.golangci.yml', '.golangci.yaml'],
		linters: [
			{
				name: 'golangci-lint',
				detect: '.golangci.yml',
				cmd: 'golangci-lint run --fix',
				priority: 10,
			},
			{ name: 'gofmt', detect: 'go.mod', cmd: 'gofmt -w .', priority: 9 },
		],
	},
	audit: {
		detectFiles: ['go.mod'],
		command: 'govulncheck -json ./...',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: null, semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Always check and return errors; never discard error return values',
			'Use idiomatic Go error wrapping with fmt.Errorf and %w verb',
			'Prefer table-driven tests; use t.Run for subtests',
			'Avoid global mutable state; use dependency injection via interfaces',
			'Use context.Context as first parameter for all I/O-bound functions',
		],
		reviewerChecklist: [
			'Verify all error return values are checked (no _ = err pattern)',
			'Check goroutine usage — confirm no goroutine leaks or missing WaitGroups',
			'Validate context propagation through call chains',
			'Confirm exported types/functions have doc comments',
			'Check for data races in concurrent code (verify sync usage)',
		],
	},
});

// Java (id: 'java')
LANGUAGE_REGISTRY.register({
	id: 'java',
	displayName: 'Java',
	tier: 2,
	extensions: ['.java'],
	treeSitter: {
		grammarId: 'java',
		wasmFile: 'tree-sitter-java.wasm',
		commentNodes: ['line_comment', 'block_comment'],
	},
	build: {
		detectFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
		commands: [
			{
				name: 'maven',
				cmd: 'mvn compile -q',
				detectFile: 'pom.xml',
				priority: 10,
			},
			{
				name: 'gradle',
				cmd: 'gradle build -q',
				detectFile: 'build.gradle',
				priority: 9,
			},
			{
				name: 'gradle-kts',
				cmd: 'gradle build -q',
				detectFile: 'build.gradle.kts',
				priority: 8,
			},
		],
	},
	test: {
		detectFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
		frameworks: [
			{
				name: 'maven-test',
				detect: 'pom.xml',
				cmd: 'mvn test -q',
				priority: 10,
			},
			{
				name: 'gradle-test',
				detect: 'build.gradle',
				cmd: 'gradle test -q',
				priority: 9,
			},
		],
	},
	lint: {
		detectFiles: ['checkstyle.xml', 'pom.xml'],
		linters: [
			{
				name: 'checkstyle',
				detect: 'checkstyle.xml',
				cmd: 'mvn checkstyle:check',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['pom.xml', 'build.gradle'],
		command: null,
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'java', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Use checked exceptions for recoverable conditions; unchecked for programming errors',
			'Prefer composition over inheritance; favor interfaces over abstract classes',
			'Use Optional<T> for nullable return values rather than returning null',
			'Follow Java naming conventions: PascalCase classes, camelCase methods/fields',
			'Close resources in try-with-resources blocks; never rely on finalizers',
		],
		reviewerChecklist: [
			'Check for unclosed resources — verify try-with-resources or explicit close()',
			'Verify null checks are present for all external/injected dependencies',
			'Confirm thread safety for shared mutable state (synchronized, volatile, atomic)',
			'Validate exception handling — no swallowed exceptions or empty catch blocks',
			'Check for proper equals()/hashCode() overrides on value objects',
		],
	},
});

// Kotlin (id: 'kotlin')
LANGUAGE_REGISTRY.register({
	id: 'kotlin',
	displayName: 'Kotlin',
	tier: 2,
	extensions: ['.kt', '.kts'],
	treeSitter: {
		grammarId: 'kotlin',
		wasmFile: 'tree-sitter-kotlin.wasm',
		commentNodes: ['line_comment', 'multiline_comment'],
	},
	build: {
		detectFiles: ['build.gradle.kts', 'build.gradle', 'pom.xml'],
		commands: [
			{
				name: 'gradle-kts',
				cmd: 'gradle build -q',
				detectFile: 'build.gradle.kts',
				priority: 10,
			},
			{
				name: 'gradle',
				cmd: 'gradle build -q',
				detectFile: 'build.gradle',
				priority: 9,
			},
			{
				name: 'maven',
				cmd: 'mvn compile -q',
				detectFile: 'pom.xml',
				priority: 8,
			},
		],
	},
	test: {
		detectFiles: ['build.gradle.kts', 'build.gradle'],
		frameworks: [
			{
				name: 'gradle-test',
				detect: 'build.gradle.kts',
				cmd: 'gradle test -q',
				priority: 10,
			},
			{
				name: 'gradle-test-groovy',
				detect: 'build.gradle',
				cmd: 'gradle test -q',
				priority: 9,
			},
		],
	},
	lint: {
		detectFiles: ['.editorconfig', 'build.gradle.kts'],
		linters: [
			{
				name: 'ktlint',
				detect: '.editorconfig',
				cmd: 'ktlint --format',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['build.gradle.kts', 'build.gradle'],
		command: null,
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: null, semgrepSupport: 'beta' },
	prompts: {
		coderConstraints: [
			'Prefer val over var; use data classes for value objects',
			'Use Kotlin coroutines for async operations; avoid blocking calls on Dispatchers.Main',
			'Leverage extension functions instead of utility classes',
			'Use sealed classes for exhaustive when expressions',
			'Avoid platform types; always declare explicit nullability in API surfaces',
		],
		reviewerChecklist: [
			'Verify no non-null assertions (!!) in production code without justification',
			'Check coroutine scope lifecycle — confirm scopes are cancelled when no longer needed',
			'Validate when expressions are exhaustive (sealed class coverage)',
			'Confirm data class equals/hashCode/copy semantics are appropriate',
			'Check for blocking I/O on the wrong coroutine dispatcher',
		],
	},
});

// C# (id: 'csharp')
LANGUAGE_REGISTRY.register({
	id: 'csharp',
	displayName: 'C# / .NET',
	tier: 2,
	extensions: ['.cs', '.csx'],
	treeSitter: {
		grammarId: 'csharp',
		wasmFile: 'tree-sitter-c-sharp.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['*.csproj', '*.sln', 'Directory.Build.props'],
		commands: [
			{
				name: 'dotnet build',
				cmd: 'dotnet build -v quiet',
				detectFile: '*.csproj',
				priority: 10,
			},
			{
				name: 'dotnet build sln',
				cmd: 'dotnet build -v quiet',
				detectFile: '*.sln',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['*.csproj', '*.sln'],
		frameworks: [
			{
				name: 'dotnet test',
				detect: '*.csproj',
				cmd: 'dotnet test',
				priority: 10,
			},
		],
	},
	lint: {
		detectFiles: ['*.csproj', '.editorconfig'],
		linters: [
			{
				name: 'dotnet-format',
				detect: '*.csproj',
				cmd: 'dotnet format',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['*.csproj', 'packages.lock.json'],
		command: 'dotnet list package --vulnerable --include-transitive',
		outputFormat: 'text',
	},
	sast: { nativeRuleSet: 'csharp', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Use async/await throughout; avoid .Result or .Wait() which can deadlock',
			'Prefer records for immutable value types; use struct only for small value types',
			'Use nullable reference types (NRT) — enable <Nullable>enable</Nullable>',
			'Dispose IDisposable resources with using statements or declarations',
			'Follow C# naming conventions: PascalCase for public members, _camelCase for private fields',
		],
		reviewerChecklist: [
			'Verify no .Result or .Wait() calls that could cause deadlocks',
			'Check all IDisposable are properly disposed (using / IAsyncDisposable)',
			'Confirm nullable reference type annotations are present and correct',
			'Validate LINQ queries do not cause N+1 query patterns in EF contexts',
			'Check for missing ConfigureAwait(false) in library code',
		],
	},
});

// C/C++ (id: 'cpp')
LANGUAGE_REGISTRY.register({
	id: 'cpp',
	displayName: 'C / C++',
	tier: 2,
	extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'],
	treeSitter: {
		grammarId: 'cpp',
		wasmFile: 'tree-sitter-cpp.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['CMakeLists.txt', 'Makefile', 'meson.build'],
		commands: [
			{
				name: 'cmake',
				cmd: 'cmake --build build',
				detectFile: 'CMakeLists.txt',
				priority: 10,
			},
			{ name: 'make', cmd: 'make', detectFile: 'Makefile', priority: 9 },
			{
				name: 'meson',
				cmd: 'meson compile -C builddir',
				detectFile: 'meson.build',
				priority: 8,
			},
		],
	},
	test: {
		detectFiles: ['CMakeLists.txt'],
		frameworks: [
			{
				name: 'ctest',
				detect: 'CMakeLists.txt',
				cmd: 'ctest --test-dir build',
				priority: 10,
			},
		],
	},
	lint: {
		detectFiles: ['.clang-tidy', 'CMakeLists.txt'],
		linters: [
			{
				name: 'cppcheck',
				detect: 'CMakeLists.txt',
				cmd: 'cppcheck --error-exitcode=1 .',
				priority: 10,
			},
			{
				name: 'clang-tidy',
				detect: '.clang-tidy',
				cmd: 'clang-tidy -p build',
				priority: 9,
			},
		],
	},
	audit: {
		detectFiles: ['CMakeLists.txt', 'vcpkg.json', 'conanfile.txt'],
		command: null,
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'cpp', semgrepSupport: 'experimental' },
	prompts: {
		coderConstraints: [
			'Prefer RAII and smart pointers (unique_ptr, shared_ptr) over raw pointers',
			'Use const-correctness throughout; mark all non-mutating methods const',
			'Avoid undefined behaviour: no out-of-bounds access, no use-after-free',
			'Initialize all variables; prefer in-class initializers for member variables',
			'Use std::array or std::vector instead of C-style arrays',
		],
		reviewerChecklist: [
			'Verify no raw owning pointers; confirm smart pointer ownership semantics',
			'Check for memory leaks — every new has a corresponding delete or smart pointer',
			'Validate bounds checking on all array/buffer accesses',
			'Confirm no undefined behavior patterns (signed overflow, strict aliasing violations)',
			'Check thread safety for shared data (mutex, atomic, lock-free patterns)',
		],
	},
});

// Swift (id: 'swift')
LANGUAGE_REGISTRY.register({
	id: 'swift',
	displayName: 'Swift',
	tier: 2,
	extensions: ['.swift'],
	treeSitter: {
		grammarId: 'swift',
		wasmFile: 'tree-sitter-swift.wasm',
		commentNodes: ['comment', 'multiline_comment'],
	},
	build: {
		detectFiles: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
		commands: [
			{
				name: 'swift build',
				cmd: 'swift build',
				detectFile: 'Package.swift',
				priority: 10,
			},
			{
				name: 'xcodebuild',
				cmd: 'xcodebuild build -quiet',
				detectFile: '*.xcodeproj',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['Package.swift', '*.xcodeproj'],
		frameworks: [
			{
				name: 'swift test',
				detect: 'Package.swift',
				cmd: 'swift test',
				priority: 10,
			},
			{
				name: 'xcodebuild-test',
				detect: '*.xcodeproj',
				cmd: 'xcodebuild test -quiet',
				priority: 9,
			},
		],
	},
	lint: {
		detectFiles: ['.swiftlint.yml', 'Package.swift'],
		linters: [
			{
				name: 'swiftlint',
				detect: '.swiftlint.yml',
				cmd: 'swiftlint --fix',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['Package.resolved', 'Package.swift'],
		command: null,
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: null, semgrepSupport: 'experimental' },
	prompts: {
		coderConstraints: [
			'Prefer value types (structs, enums) over classes; use classes only for reference semantics',
			'Use Swift concurrency (async/await, actors) over GCD for new code',
			'Avoid force unwrap (!) and force cast (as!); use guard let or if let',
			'Use Swift Package Manager for dependencies where possible',
			'Mark types and methods as final when subclassing is not intended',
		],
		reviewerChecklist: [
			'Verify no force unwraps (!) or force casts (as!) in production code',
			'Check for retain cycles in closures — confirm [weak self] where needed',
			'Validate Swift concurrency usage — no data races across actor boundaries',
			'Confirm proper error handling with do-try-catch or Result<T,E>',
			'Check value vs reference type choice is appropriate for the use case',
		],
	},
});

LANGUAGE_REGISTRY.register({
	id: 'dart',
	displayName: 'Dart / Flutter',
	tier: 3,
	extensions: ['.dart'],
	treeSitter: {
		grammarId: 'dart',
		wasmFile: 'tree-sitter-dart.wasm',
		commentNodes: ['comment', 'documentation_comment'],
	},
	build: {
		detectFiles: ['pubspec.yaml'],
		commands: [
			{
				name: 'flutter build',
				cmd: 'flutter build apk',
				detectFile: 'pubspec.yaml',
				priority: 10,
			},
			{
				name: 'dart compile',
				cmd: 'dart compile exe .',
				detectFile: 'pubspec.yaml',
				priority: 9,
			},
		],
	},
	test: {
		detectFiles: ['pubspec.yaml'],
		frameworks: [
			{
				name: 'flutter test',
				detect: 'pubspec.yaml',
				cmd: 'flutter test',
				priority: 10,
			},
			{
				name: 'dart test',
				detect: 'pubspec.yaml',
				cmd: 'dart test',
				priority: 9,
			},
		],
	},
	lint: {
		detectFiles: ['analysis_options.yaml', 'pubspec.yaml'],
		linters: [
			{
				name: 'dart analyze',
				detect: 'pubspec.yaml',
				cmd: 'dart analyze',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['pubspec.yaml', 'pubspec.lock'],
		command: 'dart pub outdated --json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: null, semgrepSupport: 'none' },
	prompts: {
		coderConstraints: [
			'Use null safety features — prefer late, required, and ? annotations over dynamic',
			'Follow Dart effective style: lowerCamelCase for variables, UpperCamelCase for types',
			'Prefer const constructors where possible for performance',
			'Use async/await over raw Future callbacks',
			'Separate business logic from UI widgets; use BLoC or Provider patterns',
		],
		reviewerChecklist: [
			'Verify null safety annotations are correct (no unnecessary ?)',
			'Check that const constructors are used where the widget tree is static',
			'Confirm async operations handle error states (catchError or try-catch)',
			'Validate no direct UI state mutation outside setState or stream',
			'Check for platform-specific code isolation (dart:io vs dart:html)',
		],
	},
});

LANGUAGE_REGISTRY.register({
	id: 'ruby',
	displayName: 'Ruby',
	tier: 3,
	extensions: ['.rb', '.rake', '.gemspec'],
	treeSitter: {
		grammarId: 'ruby',
		wasmFile: 'tree-sitter-ruby.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['Gemfile', 'Rakefile'],
		commands: [
			{
				name: 'bundle install',
				cmd: 'bundle install',
				detectFile: 'Gemfile',
				priority: 10,
			},
			{ name: 'rake', cmd: 'rake', detectFile: 'Rakefile', priority: 9 },
		],
	},
	test: {
		detectFiles: ['Gemfile', '.rspec', 'spec/spec_helper.rb'],
		frameworks: [
			{
				name: 'rspec',
				detect: '.rspec',
				cmd: 'bundle exec rspec',
				priority: 10,
			},
			{
				name: 'minitest',
				detect: 'Rakefile',
				cmd: 'bundle exec rake test',
				priority: 9,
			},
		],
	},
	lint: {
		detectFiles: ['.rubocop.yml', 'Gemfile'],
		linters: [
			{
				name: 'rubocop',
				detect: '.rubocop.yml',
				cmd: 'rubocop --autocorrect',
				priority: 10,
			},
		],
	},
	audit: {
		detectFiles: ['Gemfile.lock'],
		command: 'bundle-audit check --format json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: null, semgrepSupport: 'experimental' },
	prompts: {
		coderConstraints: [
			'Follow Ruby community style (Rubocop defaults); 120-char line limit',
			'Prefer symbols over strings for hash keys',
			'Use frozen_string_literal: true magic comment in all files',
			'Avoid monkey-patching core classes; prefer refinements',
			'Use keyword arguments for methods with more than 2 parameters',
		],
		reviewerChecklist: [
			'Verify frozen_string_literal comment is present in new files',
			'Check for N+1 query patterns in ActiveRecord code',
			'Validate no eval or send with user-controlled input (code injection risk)',
			'Confirm exception handling is specific — no bare rescue',
			'Check for missing validations on ActiveRecord models',
		],
	},
});

// PHP - Tier 3
LANGUAGE_REGISTRY.register({
	id: 'php',
	displayName: 'PHP',
	tier: 3,
	extensions: ['.php', '.phtml', '.blade.php'],
	treeSitter: {
		grammarId: 'php',
		wasmFile: 'tree-sitter-php.wasm',
		commentNodes: ['comment'],
	},
	build: {
		detectFiles: ['composer.json'],
		commands: [
			{
				name: 'Composer Install',
				cmd: 'composer install --no-interaction --prefer-dist',
				detectFile: 'composer.json',
				// HIGH-IS-HIGHER PRIORITY convention. The PR #825 review (P2)
				// flagged that this profile previously used low-is-higher,
				// inverting dispatch ordering relative to every other profile.
				priority: 10,
			},
		],
	},
	test: {
		detectFiles: ['Pest.php', 'phpunit.xml', 'phpunit.xml.dist'],
		frameworks: [
			{
				name: 'Pest',
				detect: 'Pest.php',
				cmd: 'vendor/bin/pest',
				priority: 10,
			},
			{
				name: 'PHPUnit',
				detect: 'phpunit.xml',
				cmd: 'vendor/bin/phpunit',
				priority: 8,
			},
			{
				name: 'PHPUnit',
				detect: 'phpunit.xml.dist',
				cmd: 'vendor/bin/phpunit',
				priority: 7,
			},
		],
	},
	lint: {
		detectFiles: [
			'phpstan.neon',
			'phpstan.neon.dist',
			'pint.json',
			'.php-cs-fixer.php',
			'phpcs.xml',
		],
		linters: [
			// PHPStan — highest priority static analysis via phpstan.neon config.
			{
				name: 'PHPStan',
				detect: 'phpstan.neon',
				cmd: 'vendor/bin/phpstan analyse',
				priority: 10,
			},
			{
				name: 'PHPStan',
				detect: 'phpstan.neon.dist',
				cmd: 'vendor/bin/phpstan analyse',
				priority: 9,
			},
			// Pint — Laravel-focused PHP formatter. Preferred when pint.json present.
			{
				name: 'Pint',
				detect: 'pint.json',
				cmd: 'vendor/bin/pint --test',
				priority: 8,
			},
			// PHP-CS-Fixer — fallback formatter for non-Laravel projects.
			{
				name: 'PHP-CS-Fixer',
				detect: '.php-cs-fixer.php',
				cmd: 'vendor/bin/php-cs-fixer fix --dry-run --diff',
				priority: 7,
			},
		],
	},
	audit: {
		detectFiles: ['composer.lock'],
		command: 'composer audit --locked --format=json',
		outputFormat: 'json',
	},
	sast: { nativeRuleSet: 'php', semgrepSupport: 'ga' },
	prompts: {
		coderConstraints: [
			'Follow PSR-12 coding standards',
			'Use strict types declaration: declare(strict_types=1)',
			'Prefer type hints and return type declarations on all functions',
			'Use dependency injection over static methods and singletons',
			'Prefer named constructors and value objects over primitive obsession',
		],
		reviewerChecklist: [
			'Verify no user input reaches SQL queries without parameterised binding',
			'Check for XSS — all output must be escaped with htmlspecialchars()',
			'Confirm no eval(), exec(), or shell_exec() with user-controlled input',
			'Validate proper error handling — no bare catch blocks that swallow errors',
			'Challenge any PHP/Laravel documentation or README claim that exceeds what is implemented and CI-verified in v6.49.0 (composer build, PHPUnit/Pest/artisan test, Pint/PHP-CS-Fixer lint, PHPStan static analysis, composer audit, Laravel detection, Blade scanning, 3 Laravel SAST rules). If a PR adds docs claiming broader support, verify it is backed by tests.',
		],
		testConstraints: [
			'Prefer feature tests for HTTP, middleware, and authentication flows — use Laravel RefreshDatabase or DatabaseTransactions traits',
			'Use unit tests for isolated business logic classes that do not require the full Laravel application container',
			'Pest and PHPUnit coexist in many Laravel repos — php artisan test runs both; do not assume PHPUnit-only',
			'Use .env.testing for test environment configuration; run php artisan config:clear when environment changes affect tests',
			'For database tests, prefer RefreshDatabase over manual setUp/tearDown to avoid state leakage between tests',
			'Run php artisan config:clear and php artisan cache:clear before running tests if environment variables changed',
			'Use separate .env.testing file for test-specific configuration; never rely on .env for CI test runs',
			'For parallel testing with php artisan test --parallel, ensure database connections use separate databases per worker (APP_ENV=testing + test database suffix pattern)',
		],
	},
});
