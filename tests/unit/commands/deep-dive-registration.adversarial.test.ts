/**
 * Adversarial tests for deep-dive command REGISTRATION integrity.
 * Attack vectors: resolveCommand routing, alias resolution, registry structure.
 * CONSTRAINT: These tests target REGISTRATION logic only — NOT handler behavior.
 *
 * Handler adversarial tests live in deep-dive.adversarial.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	type RegisteredCommand,
	resolveCommand,
} from '../../../src/commands/registry.js';

// ---------------------------------------------------------------------------
// Attack Vector 1: resolveCommand arg-passing integrity
// ---------------------------------------------------------------------------
describe('resolveCommand — deep-dive arg-passing integrity', () => {
	test('deep-dive with remaining args preserves all trailing tokens', () => {
		const result = resolveCommand(['deep-dive', 'auth', '--profile', 'full']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['auth', '--profile', 'full']);
	});

	test('deep-dive with many trailing args preserves all tokens', () => {
		const args = [
			'scope',
			'--profile',
			'security',
			'--max-explorers',
			'5',
			'--json',
			'--skip-update',
			'--allow-dirty',
		];
		const result = resolveCommand(['deep-dive', ...args]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(args);
	});

	test('deep-dive single arg is preserved in remainingArgs', () => {
		const result = resolveCommand(['deep-dive', 'auth']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['auth']);
	});

	test('deep-dive with no args yields empty remainingArgs', () => {
		const result = resolveCommand(['deep-dive']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 2: Alias resolution with remaining args
// ---------------------------------------------------------------------------
describe('resolveCommand — deep dive alias passes remaining args', () => {
	test('deep dive (space) resolves to deep-dive with remaining args', () => {
		const result = resolveCommand(['deep', 'dive', 'auth']);
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep dive');
		expect(result!.entry.aliasOf).toBe('deep-dive');
		expect(result!.remainingArgs).toEqual(['auth']);
	});

	test('deep dive alias with multiple trailing args passes all through', () => {
		const args = ['src/auth', '--profile', 'full', '--json'];
		const result = resolveCommand(['deep', 'dive', ...args]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(args);
	});

	test('deep dive alias with no trailing args', () => {
		const result = resolveCommand(['deep', 'dive']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual([]);
	});

	test('deep dive alias does NOT inherit deprecated flag from deep-dive', () => {
		// 'deep dive' alias has aliasOf but is NOT marked deprecated
		// This is intentional (space-separated aliases are first-class)
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.aliasOf).toBe('deep-dive');
		// Not deprecated — space-separated aliases are treated as first-class commands
		expect(entry.deprecated).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 3: No 'deep' command exists — should return null
// ---------------------------------------------------------------------------
describe('resolveCommand — no standalone "deep" command', () => {
	test('resolveCommand(["deep"]) returns null — no such command', () => {
		const result = resolveCommand(['deep']);
		expect(result).toBeNull();
	});

	test('resolveCommand(["deep", "auth"]) with "deep" alone returns null', () => {
		// "deep auth" is not a compound key in registry
		// It should NOT fall back to "deep" alone
		const result = resolveCommand(['deep', 'auth']);
		expect(result).toBeNull();
	});

	test('resolveCommand(["deep", "dive", "auth"]) compound works correctly', () => {
		const result = resolveCommand(['deep', 'dive', 'auth']);
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep dive');
		expect(result!.remainingArgs).toEqual(['auth']);
	});

	test('resolveCommand(["deep", "dive", "extra", "args"]) compound with many trailing args', () => {
		const result = resolveCommand([
			'deep',
			'dive',
			'scope',
			'--profile',
			'full',
		]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['scope', '--profile', 'full']);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 4: deep-dive handler is async function
// ---------------------------------------------------------------------------
describe('COMMAND_REGISTRY["deep-dive"] — handler type is async', () => {
	test('deep-dive handler is an async function', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		// Handler should be async: (ctx: CommandContext) => Promise<string>
		const handlerStr = entry.handler.toString();
		// Async functions contain "async" in their string representation
		expect(handlerStr).toContain('async');
	});

	test('deep-dive handler when called returns a Promise', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		const mockCtx = {
			directory: '/fake',
			args: [],
			sessionID: 'test',
			agents: {} as Record<
				string,
				import('../../../src/agents/index.js').AgentDefinition
			>,
		};
		const result = entry.handler(mockCtx);
		expect(result).toBeInstanceOf(Promise);
	});

	test('deep-dive handler resolves to a string', async () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		const mockCtx = {
			directory: '/fake',
			args: ['auth', '--profile', 'standard'],
			sessionID: 'test',
			agents: {} as Record<
				string,
				import('../../../src/agents/index.js').AgentDefinition
			>,
		};
		const result = await entry.handler(mockCtx);
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 5: COMMAND_REGISTRY deep-dive structure invariants
// ---------------------------------------------------------------------------
describe('COMMAND_REGISTRY["deep-dive"] — structural invariants', () => {
	test('deep-dive has non-empty details field', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.details).toBeDefined();
		expect(typeof entry.details).toBe('string');
		expect(entry.details!.length).toBeGreaterThan(0);
	});

	test('deep-dive details mentions key capabilities', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.details).toContain('explorer');
		expect(entry.details).toContain('reviewer');
		expect(entry.details).toContain('critic');
	});

	test('deep-dive has args field documenting all flags', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.args).toContain('--profile');
		expect(entry.args).toContain('--max-explorers');
		expect(entry.args).toContain('--json');
		expect(entry.args).toContain('--skip-update');
		expect(entry.args).toContain('--allow-dirty');
	});

	test('deep-dive has category "agent"', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.category).toBe('agent');
	});

	test('deep-dive does NOT have aliasOf (it is the canonical form)', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.aliasOf).toBeUndefined();
	});

	test('deep-dive is NOT deprecated', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.deprecated).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 6: deep dive alias structure
// ---------------------------------------------------------------------------
describe('COMMAND_REGISTRY["deep dive"] — alias structure invariants', () => {
	test('deep dive has aliasOf pointing to deep-dive', () => {
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.aliasOf).toBe('deep-dive');
	});

	test('deep dive has handler function (own handler, not inherited)', () => {
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(typeof entry.handler).toBe('function');
	});

	test('deep dive has non-empty description', () => {
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(typeof entry.description).toBe('string');
		expect(entry.description.length).toBeGreaterThan(0);
	});

	test('deep dive is NOT deprecated (space-separated aliases are first-class)', () => {
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		// Space-separated aliases are NOT deprecated — they are first-class commands
		// Deprecation is only for confusing dash-separated names (diagnosis, config-doctor, etc.)
		expect(entry.deprecated).toBeUndefined();
	});

	test('deep dive inherits category from deep-dive', () => {
		const deepDive = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		const deepDiveAlias = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(deepDiveAlias.category).toBe(deepDive.category);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 7: Unknown flags with deep-dive compound — resolveCommand does NOT validate
// ---------------------------------------------------------------------------
describe('resolveCommand — unknown flags pass through (handler validates)', () => {
	test('deep-dive with unknown flag still resolves', () => {
		const result = resolveCommand(['deep-dive', '--unknown-flag', 'scope']);
		// resolveCommand only does registry lookup — it does NOT validate flags
		// Flag validation is the handler's responsibility
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep-dive');
		expect(result!.remainingArgs).toEqual(['--unknown-flag', 'scope']);
	});

	test('deep dive alias with unknown flag still resolves', () => {
		const result = resolveCommand(['deep', 'dive', '--evil-flag', 'scope']);
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep dive');
		expect(result!.remainingArgs).toEqual(['--evil-flag', 'scope']);
	});

	test('deep-dive with injection-like flag still resolves', () => {
		const result = resolveCommand([
			'deep-dive',
			'--profile',
			'full',
			'; rm -rf /',
		]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['--profile', 'full', '; rm -rf /']);
	});

	test('deep-dive with SQL injection in scope position still resolves', () => {
		const result = resolveCommand(['deep-dive', "'; DROP TABLE users; --"]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(["'; DROP TABLE users; --"]);
	});

	test('deep-dive with path traversal still resolves', () => {
		const result = resolveCommand(['deep-dive', '../../../etc/passwd']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['../../../etc/passwd']);
	});

	test('deep-dive with template literal injection still resolves', () => {
		const result = resolveCommand(['deep-dive', '${process.env.SECRET}']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['${process.env.SECRET}']);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 8: Multi-swarm prefixed deep-dive (agent-map coherence — Invariant 11)
// ---------------------------------------------------------------------------
describe('deep-dive registration — multi-swarm prefixed variants (Invariant 11)', () => {
	test('deep-dive is registered in COMMAND_REGISTRY (unprefixed)', () => {
		// Unprefixed form must exist for legacy single-swarm configs
		expect(Object.hasOwn(COMMAND_REGISTRY, 'deep-dive')).toBe(true);
	});

	test('deep-dive is in VALID_COMMANDS list', () => {
		const { VALID_COMMANDS } = require('../../../src/commands/registry.js');
		expect(VALID_COMMANDS).toContain('deep-dive');
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 9: validateAliases passes for deep-dive entries
// ---------------------------------------------------------------------------
describe('validateAliases — deep-dive entries do not cause errors', () => {
	test('validateAliases returns valid: true', () => {
		const { validateAliases } = require('../../../src/commands/registry.js');
		const result = validateAliases();
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('deep-dive alias target exists in registry', () => {
		const deepDiveAlias = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(Object.hasOwn(COMMAND_REGISTRY, deepDiveAlias.aliasOf!)).toBe(true);
	});

	test('deep-dive alias chain is not circular', () => {
		const { validateAliases } = require('../../../src/commands/registry.js');
		const result = validateAliases();
		// Circular aliases would appear in errors
		for (const error of result.errors) {
			expect(error).not.toContain('deep-dive');
			expect(error).not.toContain('deep dive');
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 10: Prototype pollution resistance in resolveCommand
// ---------------------------------------------------------------------------
describe('resolveCommand — prototype pollution resistance', () => {
	test('__proto__ as first token returns null', () => {
		const result = resolveCommand(['__proto__', 'polluted']);
		expect(result).toBeNull();
	});

	test('constructor as first token returns null', () => {
		const result = resolveCommand(['constructor', 'alert']);
		expect(result).toBeNull();
	});

	test('Object.prototype keys return null', () => {
		expect(resolveCommand(['toString', 'evil'])).toBeNull();
		expect(resolveCommand(['valueOf', 'evil'])).toBeNull();
	});

	test('hasOwnProperty simulation returns null', () => {
		// resolveCommand uses Object.hasOwn, so these should be safe
		expect(resolveCommand(['hasOwnProperty', 'foo'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 11: Oversized input to resolveCommand
// ---------------------------------------------------------------------------
describe('resolveCommand — oversized input handling', () => {
	test('very long single token does not crash', () => {
		const longToken = 'a'.repeat(10_000);
		const result = resolveCommand(['deep-dive', longToken]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs[0].length).toBe(10_000);
	});

	test('many trailing args (100+) handled correctly', () => {
		const manyArgs = Array(100).fill('arg');
		const result = resolveCommand(['deep-dive', ...manyArgs]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs.length).toBe(100);
	});

	test('empty string token handled gracefully', () => {
		const result = resolveCommand(['deep-dive', '', 'scope']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['', 'scope']);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 12: deep-dive in swarm command template (src/index.ts)
// ---------------------------------------------------------------------------
describe('swarm-deep-dive command template in index.ts', () => {
	test('swarm-deep-dive template exists in plugin commands config', () => {
		// This is a static verification — the template string should include deep-dive
		// We verify the template string is present in the source
		const indexContent = require('fs').readFileSync(
			require('path').resolve(__dirname, '../../../src/index.ts'),
			'utf-8',
		);
		expect(indexContent).toContain("'swarm-deep-dive'");
		expect(indexContent).toContain("'/swarm deep-dive $ARGUMENTS'");
	});
});
