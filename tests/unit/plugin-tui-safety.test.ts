import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const INDEX_SRC = readFileSync(
	path.resolve(import.meta.dir, '../../src/index.ts'),
	'utf-8',
);

// Scope: console.warn calls only. Unconditional console.error / logger.error()
// calls on exceptional paths (init failure, pr-monitor errors) are intentionally
// out of scope — they are not covered by these assertions.
describe('Plugin TUI safety', () => {
	test('no process.exit in SIGINT/SIGTERM handlers', () => {
		const sigintBlock = /process\.once\(\s*['"]SIGINT['"][\s\S]*?process\.exit/;
		const sigtermBlock =
			/process\.once\(\s*['"]SIGTERM['"][\s\S]*?process\.exit/;
		expect(sigintBlock.test(INDEX_SRC)).toBe(false);
		expect(sigtermBlock.test(INDEX_SRC)).toBe(false);
	});

	test('no SIGINT/SIGTERM handler registrations via any method', () => {
		const methods = ['process.once', 'process.on', 'process.addListener'];
		const signals = ['SIGINT', 'SIGTERM'];
		for (const method of methods) {
			for (const signal of signals) {
				expect(INDEX_SRC).not.toContain(`${method}('${signal}'`);
				expect(INDEX_SRC).not.toContain(`${method}("${signal}"`);
			}
		}
	});

	test('Config Doctor console.warn calls are guarded by config.quiet', () => {
		const doctorSection = INDEX_SRC.slice(
			INDEX_SRC.indexOf('Config Doctor'),
			INDEX_SRC.indexOf('Advisory emission must never block startup') + 50,
		);
		const warnCalls = doctorSection.match(/console\.warn\(/g) || [];
		const quietGuards = doctorSection.match(/!config\.quiet/g) || [];
		expect(warnCalls.length).toBeGreaterThan(0);
		expect(quietGuards.length).toBeGreaterThanOrEqual(warnCalls.length);
	});

	test('every console.warn in index.ts is guarded by config.quiet check', () => {
		const lines = INDEX_SRC.split('\n');
		const unguarded: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (/console\.warn\(/.test(lines[i])) {
				const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
				const hasNegatedGuard = context.includes('!config.quiet');
				const inElseBranch =
					context.includes('config.quiet') && context.includes('} else');
				if (!hasNegatedGuard && !inElseBranch) {
					unguarded.push(i + 1);
				}
			}
		}
		expect(unguarded).toEqual([]);
	});
});
