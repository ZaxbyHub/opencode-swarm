import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSwarmCommandInput } from './command-dispatch.js';
import { resolveCommand } from './registry.js';

/**
 * Regression guard for the TUI compound-command dispatch bug.
 *
 * OpenCode registers each `/swarm <sub>` shortcut under a dash-joined command
 * name (e.g. `swarm-pr-subscribe`). When the user invokes that shortcut, the
 * `command.execute.before` hook receives the raw command name, and
 * `normalizeSwarmCommandInput` strips the `swarm-` prefix to a SINGLE dash
 * token (`pr-subscribe`). For a compound command registered under a SPACE key
 * (`'pr subscribe'`), `resolveCommand(['pr-subscribe'])` returned null unless a
 * dash alias existed — so the TUI reported "command not found".
 *
 * This test simulates the exact TUI dispatch path for EVERY registered
 * `swarm-*` shortcut and asserts it resolves to a runnable handler. It is the
 * coverage that was missing when `/swarm pr subscribe` shipped broken.
 */

function readIndexSource(): string {
	const indexPath = path.join(import.meta.dir, '../index.ts');
	return fs.readFileSync(indexPath, 'utf-8');
}

/**
 * Extract every `'swarm-*'` shortcut key registered in src/index.ts.
 * Excludes the bare parent `swarm` command (handled separately) — only keys
 * with the `swarm-` prefix are TUI subcommand shortcuts.
 */
function extractSwarmShortcutKeys(indexSource: string): string[] {
	const keys = new Set<string>();
	const pattern = /['"](swarm-[a-z0-9-]+)['"]\s*:/g;
	let match: RegExpExecArray | null = pattern.exec(indexSource);
	while (match !== null) {
		keys.add(match[1]);
		match = pattern.exec(indexSource);
	}
	return [...keys];
}

describe('TUI shortcut resolution parity', () => {
	const indexSource = readIndexSource();
	const shortcutKeys = extractSwarmShortcutKeys(indexSource);

	test('found a non-trivial set of swarm-* shortcuts', () => {
		// Sanity: the regex actually matched the shortcut block.
		expect(shortcutKeys.length).toBeGreaterThan(20);
	});

	test('every swarm-* shortcut resolves to a runnable handler', () => {
		const unresolved: string[] = [];
		for (const key of shortcutKeys) {
			// Simulate the TUI dispatch: the hook receives the raw command name
			// with empty arguments, exactly as OpenCode delivers it.
			const { isSwarmCommand, tokens } = normalizeSwarmCommandInput(key, '');
			expect(isSwarmCommand).toBe(true);
			const resolved = resolveCommand(tokens);
			if (!resolved || typeof resolved.entry.handler !== 'function') {
				unresolved.push(`${key} -> [${tokens.join(', ')}]`);
			}
		}
		expect(unresolved).toEqual([]);
	});

	// Explicit regression guard: the exact commands the dash-alias fix restored.
	const previouslyBroken = [
		'swarm-pr-subscribe',
		'swarm-pr-unsubscribe',
		'swarm-pr-status',
		'swarm-sdd-status',
		'swarm-sdd-validate',
		'swarm-sdd-project',
		'swarm-memory-status',
		'swarm-memory-export',
		'swarm-memory-import',
		'swarm-memory-migrate',
	];

	for (const key of previouslyBroken) {
		test(`compound shortcut "${key}" resolves`, () => {
			expect(shortcutKeys).toContain(key);
			const { tokens } = normalizeSwarmCommandInput(key, '');
			const resolved = resolveCommand(tokens);
			expect(resolved).not.toBeNull();
			expect(typeof resolved?.entry.handler).toBe('function');
		});
	}
});
