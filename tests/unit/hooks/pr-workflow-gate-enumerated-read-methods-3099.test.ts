/**
 * Issue #3099 AC2 — enumerated read-only method vocabulary in the PR-workflow gate.
 *
 * `classifyReadOnlyToolArguments` (src/hooks/pr-workflow-gate.ts) applies one
 * global vocabulary — literal GET/HEAD — to every read-only-gated tool's
 * `method`/`verb` argument, on the assumption that the value is always an HTTP
 * verb. For a tool whose `method` is an enumerated *operation* name
 * (`get_check_runs`, `get_reviews`, `get_review_comments`, `get_comments`)
 * that assumption is false and every value is rejected, so a tool the gate
 * admits by name is made unusable. The plugin ships a skill
 * (.opencode/skills/ci-fix-monitor/SKILL.md) that instructs agents to make
 * exactly this call.
 *
 * Contract after the fix: a tool that declares an enumerated read-method
 * vocabulary accepts those names. Anything not positively declared stays
 * GET/HEAD-only, and mutating methods stay blocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

/** Both spellings are real: normalizeToolName lowercases but keeps underscores. */
const READ_TOOL_NAMES = [
	'github_pull_request_read',
	'mcp__github__pull_request_read',
] as const;

/** The enumerated, non-mutating operations that tool declares. */
const ENUMERATED_READ_METHODS = [
	'get',
	'get_diff',
	'get_status',
	'get_files',
	'get_commits',
	'get_review_comments',
	'get_reviews',
	'get_comments',
	'get_check_runs',
] as const;

/** Operations that mutate. None may be admitted, whatever the vocabulary. */
const MUTATING_METHODS = [
	'POST',
	'PATCH',
	'PUT',
	'DELETE',
	'merge',
	'create',
	'update',
	'update_branch',
] as const;

describe('#3099 AC2 — enumerated read-only method vocabulary', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
	});
	afterEach(teardownPrWorkflowGateFixtures);

	const gate = async (tool: string, args: unknown) => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		return enforcePrWorkflowToolBefore(tempDir, SESSION_ID, tool, args);
	};

	for (const tool of READ_TOOL_NAMES) {
		for (const method of ENUMERATED_READ_METHODS) {
			test(`[${tool}] admits enumerated read method "${method}"`, async () => {
				await expect(
					gate(tool, {
						owner: 'octo-org',
						repo: 'octo-repo',
						pullNumber: 1,
						method,
					}),
				).resolves.toBeUndefined();
			});
		}
	}

	// AC4 PRESERVING: the original HTTP-verb contract is unchanged.
	for (const method of ['GET', 'HEAD', 'get', 'head'] as const) {
		test(`keeps admitting HTTP method "${method}"`, async () => {
			await expect(
				gate('mcp__github__pull_request_read', { method }),
			).resolves.toBeUndefined();
		});
	}

	// AC4 PRESERVING: mutating methods stay blocked. This is the direction the
	// existing suite already pins (pr-workflow-gate-capabilities.test.ts:81-88),
	// so a widened vocabulary must not swallow it.
	for (const method of MUTATING_METHODS) {
		test(`keeps blocking mutating method "${method}"`, async () => {
			await expect(
				gate('mcp__github__pull_request_read', { method }),
			).rejects.toThrow(/rejected argument "method"/i);
		});
	}

	// AC4 PRESERVING: the mutation-bearing ARGUMENT-NAME check runs before the
	// method check, so a widened method vocabulary must not shadow it.
	test('keeps blocking a mutation-bearing argument alongside a read method', async () => {
		await expect(
			gate('mcp__github__pull_request_read', {
				method: 'get_check_runs',
				body: { title: 'changed' },
			}),
		).rejects.toThrow(/rejected argument/i);
	});

	test('keeps blocking an undeclared verb-shaped value', async () => {
		await expect(
			gate('mcp__github__pull_request_read', { verb: 'launch_missiles' }),
		).rejects.toThrow(/rejected argument "verb"/i);
	});
});
