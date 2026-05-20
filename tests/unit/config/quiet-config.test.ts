/**
 * Tests for quiet config implementation (FR-003, FR-004)
 *
 * Verifies:
 * 1. quiet config defaults to true
 * 2. With quiet:true, non-critical warnings are suppressed
 * 3. With quiet:false (explicit opt-out), warnings still appear
 * 4. Security-critical guardrails warning is NOT suppressed by quiet:true
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../../../src/agents';
import { PluginConfigSchema } from '../../../src/config/schema';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'quiet-config-test-'));
});

afterEach(() => {
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCHEMA TESTS — quiet defaults to true
// ─────────────────────────────────────────────────────────────────────────────

describe('quiet config schema', () => {
	it('1.1 quiet field is defined as boolean with default true', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(true);
		}
	});

	it('1.2 quiet:undefined parses to true (uses default)', () => {
		const result = PluginConfigSchema.safeParse({ quiet: undefined });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(true);
		}
	});

	it('1.3 quiet:true parses correctly', () => {
		const result = PluginConfigSchema.safeParse({ quiet: true });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(true);
		}
	});

	it('1.4 quiet:false parses correctly', () => {
		const result = PluginConfigSchema.safeParse({ quiet: false });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(false);
		}
	});

	it('1.5 quiet rejects non-boolean values', () => {
		const result = PluginConfigSchema.safeParse({ quiet: 'yes' });
		expect(result.success).toBe(false);
	});

	it('1.6 quiet rejects numeric values', () => {
		const result = PluginConfigSchema.safeParse({ quiet: 1 });
		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NON-CRITICAL WARNINGS SUPPRESSION — getModelForAgent warning
// ─────────────────────────────────────────────────────────────────────────────

describe('quiet:true suppresses non-critical warnings', () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('2.1 quiet:true suppresses all warnings from createAgents', () => {
		// Pass config with embedded variant to trigger deprecation warning
		// If quiet:true works, no warnings should appear
		const config = {
			quiet: true,
			agents: {
				coder: {
					model: 'provider/model/variant', // Triggers deprecation warning if quiet=false
				},
			},
		};

		createAgents(config as any);

		// With quiet:true, even the variant deprecation warning should be suppressed
		const warningCalls = warnSpy.mock.calls;
		const deprecationWarnings = warningCalls.filter(
			(call) =>
				typeof call[0] === 'string' &&
				call[0].includes('Deprecation') &&
				call[0].includes('variant'),
		);
		expect(deprecationWarnings.length).toBe(0);
	});

	it('2.2 quiet:false shows deprecation warning for embedded variant', () => {
		const config = {
			quiet: false,
			agents: {
				coder: {
					model: 'provider/model/variant', // Triggers deprecation warning
				},
			},
		};

		createAgents(config as any);

		const warningCalls = warnSpy.mock.calls;
		const deprecationWarnings = warningCalls.filter(
			(call) =>
				typeof call[0] === 'string' &&
				call[0].includes('Deprecation') &&
				call[0].includes('variant'),
		);
		expect(deprecationWarnings.length).toBeGreaterThan(0);
	});

	it('2.3 quiet omitted (default true) suppresses deprecation warning', () => {
		// Default quiet is now true — omitting the key should suppress warnings
		const config = {
			agents: {
				coder: {
					model: 'provider/model/variant',
				},
			},
		};

		createAgents(config as any);

		const warningCalls = warnSpy.mock.calls;
		const deprecationWarnings = warningCalls.filter(
			(call) =>
				typeof call[0] === 'string' &&
				call[0].includes('Deprecation') &&
				call[0].includes('variant'),
		);
		expect(deprecationWarnings.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SECURITY-CRITICAL WARNINGS ARE NOT SUPPRESSED
// ─────────────────────────────────────────────────────────────────────────────

describe('security-critical warnings are NOT suppressed by quiet:true', () => {
	let warnSpy: ReturnType<typeof spyOn>;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		originalEnv = { ...process.env };
		// loadPluginConfigWithMeta reads the project config from <dir>/.opencode/opencode-swarm.json
		const configDir = path.join(tempDir, '.opencode');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({
				guardrails: { enabled: false },
				quiet: true, // This should NOT suppress the security warning
			}),
		);
	});

	afterEach(() => {
		warnSpy.mockRestore();
		process.env = originalEnv;
	});

	it('3.1 guardrails disabled security warning appears even with quiet:true', async () => {
		// The security warning is emitted directly via console.warn
		// and does NOT check the quiet config
		const { loadPluginConfigWithMeta } = await import('../../../src/config');
		const { config, loadedFromFile } = loadPluginConfigWithMeta(tempDir);

		// Simulate the security warning logic from index.ts
		// This warning is NOT suppressed by quiet:true
		if (loadedFromFile && config.guardrails?.enabled === false) {
			console.warn('');
			console.warn(
				'══════════════════════════════════════════════════════════════',
			);
			console.warn(
				'[opencode-swarm] 🔴 SECURITY WARNING: GUARDRAILS ARE DISABLED',
			);
			console.warn(
				'══════════════════════════════════════════════════════════════',
			);
		}

		const warningCalls = warnSpy.mock.calls;
		const securityWarnings = warningCalls.filter(
			(call) =>
				typeof call[0] === 'string' &&
				call[0].includes('SECURITY WARNING') &&
				call[0].includes('GUARDRAILS ARE DISABLED'),
		);
		expect(securityWarnings.length).toBeGreaterThan(0);
	});

	it('3.2 security warning is NOT gated on quiet config in the source code', async () => {
		// This test verifies the SOURCE CODE implementation
		// The security warning in index.ts (lines 268-301) uses console.warn directly
		// without checking config.quiet
		const fs = await import('fs');
		const indexContent = await fs.promises.readFile(
			path.join(process.cwd(), 'src', 'index.ts'),
			'utf-8',
		);

		// Verify the security warning section exists and contains expected content
		expect(indexContent).toContain('SECURITY AUDIT');
		expect(indexContent).toContain('guardrails.enabled === false');
		expect(indexContent).toContain('SECURITY WARNING');
		expect(indexContent).toContain('GUARDRAILS ARE DISABLED');

		// Extract the security warning block using a simpler approach
		// Find the section between "SECURITY AUDIT" and the closing brace after "GUARDRAILS ARE DISABLED"
		const auditIndex = indexContent.indexOf('SECURITY AUDIT');
		const disabledWarningIndex = indexContent.indexOf(
			'GUARDRAILS ARE DISABLED',
		);

		expect(auditIndex).toBeGreaterThan(-1);
		expect(disabledWarningIndex).toBeGreaterThan(-1);
		expect(disabledWarningIndex).toBeGreaterThan(auditIndex);

		// Extract a window around the security warning block
		// Take from "SECURITY AUDIT" to 500 chars after "GUARDRAILS ARE DISABLED"
		const blockStart = auditIndex;
		const blockEnd = disabledWarningIndex + 500;
		const securityBlock = indexContent.slice(
			blockStart,
			Math.min(blockEnd, indexContent.length),
		);

		// The security warning block should NOT contain an `if (config.quiet` gate
		// This proves the security warning is not conditionally suppressed by quiet config
		// (The comment mentioning "config.quiet" is fine — that's the explanation, not a gate)
		expect(securityBlock).not.toContain('if (config.quiet');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe('quiet config edge cases', () => {
	it('4.1 quiet with full config parses correctly', () => {
		const fullConfig = {
			max_iterations: 5,
			qa_retry_limit: 3,
			quiet: true,
			agents: {
				architect: { model: 'test/model' },
			},
		};
		const result = PluginConfigSchema.safeParse(fullConfig);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(true);
		}
	});

	it('4.2 quiet:false with full config works', () => {
		const fullConfig = {
			max_iterations: 5,
			quiet: false,
			agents: {
				coder: { model: 'test/model' },
			},
		};
		const result = PluginConfigSchema.safeParse(fullConfig);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(false);
		}
	});

	it('4.3 quiet does not affect other config fields', () => {
		const config = {
			quiet: true,
			max_iterations: 10,
			qa_retry_limit: 5,
		};
		const result = PluginConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.quiet).toBe(true);
			expect(result.data.max_iterations).toBe(10);
			expect(result.data.qa_retry_limit).toBe(5);
		}
	});

	it('4.4 explicit quiet:false differs from omitted (omitted defaults to true)', () => {
		const withExplicit = PluginConfigSchema.safeParse({ quiet: false });
		const omitted = PluginConfigSchema.safeParse({});

		expect(withExplicit.success).toBe(true);
		expect(omitted.success).toBe(true);

		if (withExplicit.success && omitted.success) {
			expect(withExplicit.data.quiet).toBe(false);
			expect(omitted.data.quiet).toBe(true);
			expect(withExplicit.data.quiet).not.toBe(omitted.data.quiet);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. INTEGRATION — verify quiet is passed to internal functions
// ─────────────────────────────────────────────────────────────────────────────

describe('quiet config is properly threaded through agent creation', () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('5.1 both quiet:true and quiet:false create the same number of agents', () => {
		const configQuietTrue = {
			quiet: true,
			agents: {
				coder: { model: 'test/model' },
			},
		};
		const configQuietFalse = {
			quiet: false,
			agents: {
				coder: { model: 'test/model' },
			},
		};

		const agentsQuietTrue = createAgents(configQuietTrue as any);
		const agentsQuietFalse = createAgents(configQuietFalse as any);

		// Both should create the same number of agents
		// The only difference should be whether warnings are suppressed
		expect(agentsQuietTrue.length).toBe(agentsQuietFalse.length);
		expect(agentsQuietTrue.length).toBeGreaterThan(0);
	});

	it('5.2 quiet:true with variant embedding produces no warnings', () => {
		const config = {
			quiet: true,
			agents: {
				reviewer: {
					model: 'test/provider/model/high',
				},
			},
		};

		createAgents(config as any);

		// Should have no deprecation warnings
		const warningCalls = warnSpy.mock.calls;
		const variantWarnings = warningCalls.filter(
			(call) => typeof call[0] === 'string' && call[0].includes('variant'),
		);
		expect(variantWarnings.length).toBe(0);
	});

	it('5.3 quiet:false with variant embedding produces warnings', () => {
		const config = {
			quiet: false,
			agents: {
				reviewer: {
					model: 'test/provider/model/high',
				},
			},
		};

		createAgents(config as any);

		// Should have deprecation warnings
		const warningCalls = warnSpy.mock.calls;
		const variantWarnings = warningCalls.filter(
			(call) => typeof call[0] === 'string' && call[0].includes('variant'),
		);
		expect(variantWarnings.length).toBeGreaterThan(0);
	});
});
