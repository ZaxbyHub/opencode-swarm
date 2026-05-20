import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createSlopDetectorHook,
	type SlopDetectorConfig,
} from './slop-detector';

function generateLines(count: number): string {
	return Array.from({ length: count }, (_, i) => `+line ${i + 1}\n`).join('');
}

describe('slop-detector', () => {
	let projectDir: string;
	let injectSystemMessageCalls: Array<[string, string]>;
	let injectSystemMessage: (sessionId: string, message: string) => void;
	let config: SlopDetectorConfig;

	const defaultConfig: SlopDetectorConfig = {
		enabled: true,
		classThreshold: 3,
		commentStripThreshold: 5,
		diffLineThreshold: 200,
		importHygieneThreshold: 2,
	};

	beforeEach(() => {
		projectDir = join(tmpdir(), `slop-detector-test-${Date.now()}`);
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(join(projectDir, 'src'), { recursive: true });
		writeFileSync(join(projectDir, 'src/dummy.ts'), 'export const x = 1;\n');

		injectSystemMessageCalls = [];
		injectSystemMessage = (sessionId: string, message: string) => {
			injectSystemMessageCalls.push([sessionId, message]);
		};
		config = { ...defaultConfig };
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	// Required test 1: Abstraction bloat — 3+ class declarations
	it('detects 3+ class declarations in content (abstraction_bloat)', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's1' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('abstraction_bloat');
	});

	// Required test 2: Comment stripping
	it('detects comment stripping — 8 removed comments, no additions', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// Simulate a diff where 8 comment lines were removed (leading -) and 0 added (no leading +)
		const newString = `-// comment\n-// comment\n-// comment\n-// comment\n-// comment\n-// comment\n-// comment\n-// comment\n`;

		await hook.toolAfter(
			{ tool: 'edit', sessionID: 's2' },
			{ args: { newString } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('comment_strip');
	});

	// Required test 3: Boilerplate explosion for fix task
	it('detects boilerplate explosion — 250+ lines for "fix validation" task', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = generateLines(250);

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's3' },
			{ args: { content, description: 'fix validation' } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('boilerplate_explosion');
	});

	// Required test 4: No false positive — large diff for build task
	it('no false positive — 250+ lines for "build the payment module" task', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = generateLines(250);

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's4' },
			{ args: { content, description: 'build the payment module' } },
		);

		expect(injectSystemMessageCalls.length).toBe(0);
	});

	// Required test 5: Respects enabled: false
	it('no injection when enabled=false regardless of content', async () => {
		config.enabled = false;
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's5' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(0);
	});

	// Required test 6: Respects custom thresholds
	it('does not trigger with classThreshold: 10 and only 3 classes', async () => {
		config.classThreshold = 10;
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's6' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(0);
	});

	// Additional test 7: Non-write tool (bash) — no injection
	it('no injection for bash tool even with triggering content', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'bash', sessionID: 's7' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(0);
	});

	// Additional test 8: Empty content — no injection, no error
	it('empty content — no injection, no error', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's8' },
			{ args: { content: '' } },
		);

		expect(injectSystemMessageCalls.length).toBe(0);
	});

	// Additional test 9: apply_patch tool uses args.patch field
	it('apply_patch tool uses args.patch for content', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'apply_patch', sessionID: 's9' },
			{ args: { patch: content } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('abstraction_bloat');
	});

	// Additional test 10: edit tool uses args.newString field
	it('edit tool uses args.newString for content', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const newString = `+class Foo {}\n+class Bar {}\n+class Baz {}\n`;

		await hook.toolAfter(
			{ tool: 'edit', sessionID: 's10' },
			{ args: { newString } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('abstraction_bloat');
	});

	// ============================================================
	// ADVERSARIAL TESTS — walkFiles and checkDeadExports
	// ============================================================

	// ADV-1: Non-JS/TS project (no package.json) — dead_export heuristic returns null immediately
	it('dead_export returns null when no package.json exists', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// content has an export that would be flagged as dead without package.json guard
		const content = `+export function fooBar() {}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv1' },
			{ args: { content } },
		);

		// Should NOT flag as dead_export since package.json guard exits early
		const deadExportCalls = injectSystemMessageCalls.filter(([, msg]) =>
			msg.includes('dead_export'),
		);
		expect(deadExportCalls.length).toBe(0);
	});

	// ADV-2: Empty directory — walkFiles returns empty array, no crash
	it('walkFiles returns empty array for empty directory', async () => {
		const emptyDir = join(tmpdir(), `slop-detector-empty-${Date.now()}`);
		mkdirSync(emptyDir, { recursive: true });

		// Create a package.json so checkDeadExports proceeds past the guard
		writeFileSync(join(emptyDir, 'package.json'), '{}');

		const hook = createSlopDetectorHook(config, emptyDir, injectSystemMessage);

		const content = `+export function fooBar() {}\n`;

		// Should not throw — walkFiles returns [] and loop over files is a no-op
		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv2' },
			{ args: { content } },
		);

		// walkFiles returns [] for empty project, but fooBar is still flagged as dead_export
		// because an empty project means "nothing imports this" — which is correct behavior
		const deadExportCalls = injectSystemMessageCalls.filter(([, msg]) =>
			msg.includes('dead_export'),
		);
		expect(deadExportCalls.length).toBe(1);
		expect(deadExportCalls[0][1]).toContain('fooBar');

		rmSync(emptyDir, { recursive: true, force: true });
	});

	// ADV-3: walkFiles catches permission errors gracefully — no crash
	it('walkFiles skips unreadable directories without crashing', async () => {
		const unreadableDir = join(
			tmpdir(),
			`slop-detector-unreadable-${Date.now()}`,
		);
		mkdirSync(unreadableDir, { recursive: true });

		// Create a package.json so checkDeadExports proceeds
		writeFileSync(join(unreadableDir, 'package.json'), '{}');

		// Create a subdir that we will make unreadable (chmod 000 on Unix — on Windows
		// the permission behavior differs, but the try/catch in walkFiles handles both)
		const restrictedDir = join(unreadableDir, 'restricted');
		mkdirSync(restrictedDir, { recursive: true });

		// Try to restrict permissions — on Windows this may or may not work depending on
		// the platform and ACLs. The important invariant is: walkFiles must NEVER throw.
		try {
			if (process.platform !== 'win32') {
				// 000 = no read/write/execute for owner, group, others
				const { execSync } = require('node:child_process');
				execSync(`chmod 000 "${restrictedDir}"`, { stdio: 'ignore' });
			}
		} catch {
			// Permission restriction may fail on Windows or in some CI environments —
			// this is fine; the test verifies the catch-all in walkFiles absorbs errors
		}

		const hook = createSlopDetectorHook(
			config,
			unreadableDir,
			injectSystemMessage,
		);

		const content = `+export function fooBar() {}\n`;

		// Must not throw even if restricted directory cannot be read
		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv3' },
			{ args: { content } },
		);

		// Clean up — restore permissions so rmSync works
		try {
			if (process.platform !== 'win32') {
				const { execSync } = require('node:child_process');
				execSync(`chmod 755 "${restrictedDir}"`, { stdio: 'ignore' });
			}
		} catch {
			// ignore cleanup failures
		}
		rmSync(unreadableDir, { recursive: true, force: true });
	});

	// ADV-4: Export name with regex special characters — the \w{3,} guard should NOT match
	// e.g., "export class $foo() {}" — the $ is not \w, so it won't be captured
	it('export with regex special chars in name is not captured by export regex', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// $InvalidName has $ which is not \w — should not be extracted as a new export
		const content = `+export class $InvalidName {}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv4' },
			{ args: { content } },
		);

		// No abstraction_bloat either — class $InvalidName does not match /^\+.*\bclass\s+\w+/gm
		// because \w does not include $
		const allCalls = injectSystemMessageCalls.filter(
			([, msg]) =>
				msg.includes('abstraction_bloat') || msg.includes('dead_export'),
		);
		expect(allCalls.length).toBe(0);
	});

	// ADV-5: Export name at minimum boundary — exactly 3 characters should be captured
	it('export name exactly 3 chars long is captured correctly', async () => {
		// Isolated dir WITH package.json so checkDeadExports runs past the guard
		const adv5Dir = join(tmpdir(), `slop-detector-adv5-${Date.now()}`);
		mkdirSync(adv5Dir, { recursive: true });
		mkdirSync(join(adv5Dir, 'src'), { recursive: true });
		// Use writeFileSync (not Bun.write) to ensure synchronous completion
		writeFileSync(join(adv5Dir, 'package.json'), '{}');
		writeFileSync(
			join(adv5Dir, 'src', 'consumer.ts'),
			'import { somethingElse } from "./other";\n',
		);

		const hook = createSlopDetectorHook(config, adv5Dir, injectSystemMessage);

		// "foo" is exactly 3 chars — should match \w{3,}
		const content = `+export const foo = 1;\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv5' },
			{ args: { content } },
		);

		// Should flag as dead_export — "foo" is not imported anywhere
		const deadExportCalls = injectSystemMessageCalls.filter(([, msg]) =>
			msg.includes('dead_export'),
		);
		expect(deadExportCalls.length).toBe(1);
		expect(deadExportCalls[0][1]).toContain('foo');

		rmSync(adv5Dir, { recursive: true, force: true });
	});

	// ADV-6: Unicode export names — should NOT match \w{3,} (Unicode not supported)
	it('unicode export name is not captured by export regex', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// 日本語 is not \w — should not be extracted
		const content = `+export const 日本語 = 1;\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-adv6' },
			{ args: { content } },
		);

		const deadExportCalls = injectSystemMessageCalls.filter(([, msg]) =>
			msg.includes('dead_export'),
		);
		// 日本語 is not matched by \w{3,} so no export is extracted → no dead_export
		expect(deadExportCalls.length).toBe(0);
	});

	// ============================================================
	// MULTI-LANGUAGE HEURISTIC TESTS
	// ============================================================

	// ML-1: comment-strip detects removed # Python comments
	it('comment-strip detects removed # Python comments', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// 5+ removed Python comment lines, 0 added
		const newString = `-  # This is a Python comment\n-  # Another Python comment\n-  # Yet another comment\n-  # One more comment\n-  # Final comment\n`;

		await hook.toolAfter(
			{ tool: 'edit', sessionID: 's-ml1' },
			{ args: { newString } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('comment_strip');
	});

	// ML-2: comment-strip detects removed -- SQL comments
	it('comment-strip detects removed -- SQL comments', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// 5+ removed SQL comment lines, 0 added
		const newString = `- -- SELECT * FROM users\n- -- WHERE active = true\n- -- ORDER BY created_at\n- -- LIMIT 100\n- -- This is a SQL comment\n`;

		await hook.toolAfter(
			{ tool: 'edit', sessionID: 's-ml2' },
			{ args: { newString } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('comment_strip');
	});

	// ML-3: abstraction-bloat detects Go struct declarations
	it('abstraction-bloat detects Go struct declarations', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// 3+ Go struct/type declarations - using +struct Name format
		// The regex /^\+.*\b(?:class|struct|impl)\s+\w+/gm matches +struct followed
		// by a space and word chars. With backtracking, +struct User { matches because
		// .* gives up chars until \b can find a boundary before 'struct', then \s+\w+ matches ' User'
		const content = `+struct User {\n+  Name string\n+}\n+struct Order {\n+  ID int\n+}\n+struct Product {\n+  SKU string\n+}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-ml3' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('abstraction_bloat');
	});

	// ML-4: abstraction-bloat detects Rust impl blocks
	it('abstraction-bloat detects Rust impl blocks', async () => {
		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		// 3+ Rust impl blocks
		const content = `+impl User {\n+  fn new() -> Self { Self }\n+}\n+impl Order {\n+  fn total(&self) -> i32 { 0 }\n+}\n+impl Product {\n+  fn sku(&self) -> &str { "" }\n+}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-ml4' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('abstraction_bloat');
	});

	// ============ DUPLICATE_UTILITY heuristic tests ============

	it('detects duplicate utility — new export name matches existing utility', async () => {
		// Create a utility file with a known export
		mkdirSync(join(projectDir, 'src', 'utils'), { recursive: true });
		writeFileSync(
			join(projectDir, 'src', 'utils', 'normalize.ts'),
			'export function normalizePath(path: string): string { return path; }\n',
		);

		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+export function normalizePath(input: string): string {\n+  return input.trim();\n+}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-dup1' },
			{ args: { content } },
		);

		expect(injectSystemMessageCalls.length).toBe(1);
		expect(injectSystemMessageCalls[0][1]).toContain('duplicate_utility');
		expect(injectSystemMessageCalls[0][1]).toContain('normalizePath');
	});

	it('does not flag duplicate when targetFile is the same file', async () => {
		mkdirSync(join(projectDir, 'src', 'utils'), { recursive: true });
		writeFileSync(
			join(projectDir, 'src', 'utils', 'helpers.ts'),
			'export function formatDate(d: Date): string { return d.toISOString(); }\n',
		);

		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+export function formatDate(date: Date): string {\n+  return date.toISOString().split('T')[0];\n+}\n`;

		await hook.toolAfter(
			{ tool: 'edit', sessionID: 's-dup2' },
			{
				args: {
					filePath: join(projectDir, 'src', 'utils', 'helpers.ts'),
					newString: content,
				},
			},
		);

		// Should NOT fire — targetFile matches the utility file
		expect(injectSystemMessageCalls.length).toBe(0);
	});

	it('does not flag genuinely new export names', async () => {
		mkdirSync(join(projectDir, 'src', 'utils'), { recursive: true });
		writeFileSync(
			join(projectDir, 'src', 'utils', 'existing.ts'),
			'export function existingUtil(): void {}\n',
		);

		const hook = createSlopDetectorHook(
			config,
			projectDir,
			injectSystemMessage,
		);

		const content = `+export function brandNewFunction(): number {\n+  return 42;\n+}\n`;

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's-dup3' },
			{ args: { content } },
		);

		// No duplicate_utility finding expected
		expect(injectSystemMessageCalls.length).toBe(0);
	});
});
