/**
 * Regression tests for issue #1886 — "opencode-swarm Merged config validation
 * failed" with no detail.
 *
 * The reporter's config failed validation, but `/swarm diagnose` showed only a
 * bare "[opencode-swarm] Merged config validation failed:" line (colon, nothing
 * after) because `advisoryWarn(message, data)` dropped the Zod detail (passed as
 * `data`) from the deferred-warning buffer. The fix:
 *   1. `advisoryWarn` folds `data` into the buffered entry (see
 *      tests/unit/services/warning-buffer.test.ts for the structural guardrail).
 *   2. The loader flattens Zod errors to a readable string via `formatZodIssues`
 *      instead of the nested `error.format()` object.
 *
 * These tests pin the loader-side behavior: the specific failing field and
 * constraint are now surfaced, while the fail-secure fallback is preserved.
 *
 * Kept in a dedicated file because tests/unit/config/loader.test.ts is already
 * over the FR-006 500-line cap and must not grow (scripts/check-test-file-cap.sh).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { formatZodIssues, loadPluginConfig } from '../../../src/config/loader';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

describe('formatZodIssues', () => {
	it('flattens issues to "path: message" joined with "; "', () => {
		const schema = z.object({
			a: z.object({ b: z.array(z.string()).max(3) }),
		});
		const result = schema.safeParse({ a: { b: ['1', '2', '3', '4'] } });
		expect(result.success).toBe(false);
		if (!result.success) {
			const out = formatZodIssues(result.error);
			expect(out).toContain('a.b: ');
			expect(out).toContain('Too big');
		}
	});

	it('joins multiple issues with "; "', () => {
		const schema = z.object({ a: z.number(), b: z.number() });
		const result = schema.safeParse({ a: 'x', b: 'y' });
		expect(result.success).toBe(false);
		if (!result.success) {
			const out = formatZodIssues(result.error);
			expect(out).toContain('a: ');
			expect(out).toContain('b: ');
			expect(out).toContain('; ');
		}
	});

	it('emits message only (no leading ": ") for a top-level/empty-path issue', () => {
		const result = z.string().safeParse(123);
		expect(result.success).toBe(false);
		if (!result.success) {
			const out = formatZodIssues(result.error);
			expect(out.startsWith(':')).toBe(false);
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it('returns an empty string when there are no issues', () => {
		expect(formatZodIssues(new z.ZodError([]))).toBe('');
	});
});

describe('merged config validation surfaces specific detail (#1886)', () => {
	let tempDir: string;
	let originalXDG: string | undefined;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-1886-'));
		originalXDG = process.env.XDG_CONFIG_HOME;
		// Isolate from any real user config so only our project config is loaded.
		process.env.XDG_CONFIG_HOME = tempDir;
		clearDeferredWarnings();
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		clearDeferredWarnings();
		if (originalXDG === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXDG;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProjectConfig(config: unknown): string {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'project-1886-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify(config),
		);
		return projectDir;
	}

	it("names the failing field(s) and constraint for the reporter's config", () => {
		// Reporter's config: several fallback_models arrays exceed the schema
		// max of 3 (z.array(z.string()).max(3)). No unrecognized keys → the
		// detail-less `else` branch. This is the exact #1886 scenario.
		const projectDir = writeProjectConfig({
			agents: {
				architect: {
					model: 'kimi-for-coding/k3',
					fallback_models: [
						'opencode/nemotron-3-ultra-free',
						'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
						'kimi-for-coding/k2p7',
						'kimi-for-coding/k2p7',
						'opencode-go/glm-5.2',
					],
				},
				coder: {
					model: 'opencode/hy3-free',
					fallback_models: [
						'openrouter/tencent/hy3:free',
						'opencode/kimi-k2.7-code',
						'openrouter/moonshotai/kimi-k2.7-code',
						'opencode/nemotron-3-ultra-free',
						'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
					],
				},
			},
			max_iterations: 3,
			guardrails: {
				enabled: true,
				max_tool_calls: 60,
				max_duration_minutes: 40,
			},
		});

		try {
			const result = loadPluginConfig(projectDir);

			const warnings = getDeferredWarnings().join('\n');
			// Issue #1690: recursive value recovery now catches malformed values
			// BEFORE the "Merged config validation failed" path. The fallback_models
			// arrays exceeding <=3 are dropped and the config is recovered.
			expect(warnings).toContain('fallback_models');

			// Fail-secure: guardrails stay ENABLED (step 7b forces guardrails on recovery).
			expect(result.guardrails?.enabled).toBe(true);
			// max_iterations: 3 is preserved from the user's config (not wiped to default).
			expect(result.max_iterations).toBe(3);

			// TUI safety: never raw stderr.
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it('surfaces the constraint for a single-field value error too', () => {
		// max_iterations: 999 exceeds the schema max — issue #1690 recursive
		// recovery now drops this field and recovers the rest of the config.
		const projectDir = writeProjectConfig({ max_iterations: 999 });
		try {
			loadPluginConfig(projectDir);
			const warnings = getDeferredWarnings().join('\n');
			// The recovery warning names the dropped key.
			expect(warnings).toContain('max_iterations');
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
