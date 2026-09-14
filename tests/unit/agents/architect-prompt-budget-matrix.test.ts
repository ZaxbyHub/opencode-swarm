import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import { ARCHITECT_PROMPT_BUDGET_CHARS } from '../../../src/agents/architect';
import type { PluginConfig } from '../../../src/config';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * FAILING-FIRST acceptance tests for issue #2671 — architect prompt budget
 * matrix. The existing tests/unit/agents/architect-prompt-budget.test.ts guard
 * never enables council.general, so composing the general council with all
 * supported features silently exceeded ARCHITECT_PROMPT_BUDGET_CHARS (measured
 * at the unfixed tree: feature-heavy + general = 161,239 chars; prefixed
 * feature-heavy + general = 162,386 chars; ceiling = 161,000).
 *
 *   AC8  — EVERY feature-matrix cell must render under the ceiling, and the
 *          repair may not "fix" the budget by dropping the general-council
 *          feature guidance (the largest cell still names convene_general_council).
 *   AC9  — new exports estimateModelTokens / measureArchitectPromptBudget
 *          (chars and tokenEstimate are separate quantities), plus mandatory
 *          directive anchors present and order-stable in every cell, and a
 *          host-renderable plain-string prompt shape.
 *   AC10  — new export enforceArchitectPromptBudget returns a bounded error
 *          (<= 400 chars, prefixed ARCHITECT_PROMPT_BUDGET_EXCEEDED), and an
 *          over-budget user-variable render emits a visible advisory through
 *          the deferred-warning buffer WITHOUT dropping the guidance.
 *   AC11 — docs/configuration.md gains a prompt-budget section explaining
 *          characters vs model tokens and the supported-together feature matrix.
 *
 * FEATURE_MATRIX doubles as the named regression fixture the issue requires.
 * Zero mocks (Tier 0). Environment isolation mirrors
 * tests/unit/agents/architect-prompt-budget.test.ts.
 */

const testModel = 'test-model';

/** Copied from tests/unit/agents/architect-prompt-budget.test.ts (lines 40-50). */
const featureHeavyConfig: PluginConfig = {
	council: { enabled: true },
	ui_review: { enabled: true },
	design_docs: { enabled: true },
	architectural_supervision: { enabled: true },
	adversarial_testing: { enabled: true, scope: 'all' },
	memory: { enabled: true },
	external_skills: { curation_enabled: true },
	skills: { enabled: true },
	turbo: { enabled: true, strategy: 'standard' },
} as unknown as PluginConfig;

/** The largest supported feature composition: feature-heavy + general council. */
export const LARGEST_SUPPORTED_COMPOSITION: PluginConfig = {
	...featureHeavyConfig,
	council: { enabled: true, general: { enabled: true } },
} as unknown as PluginConfig;

export interface ArchitectBudgetMatrixCell {
	name: string;
	config?: PluginConfig;
	agentKey: string;
}

/** Named regression fixture (issue #2671): every supported composition cell. */
export const FEATURE_MATRIX: ArchitectBudgetMatrixCell[] = [
	{ name: 'default', agentKey: 'architect' },
	{
		name: 'council-enabled-only',
		config: { council: { enabled: true } } as unknown as PluginConfig,
		agentKey: 'architect',
	},
	{
		name: 'general-council-only',
		config: {
			council: { general: { enabled: true } },
		} as unknown as PluginConfig,
		agentKey: 'architect',
	},
	{
		name: 'both-councils',
		config: {
			council: { enabled: true, general: { enabled: true } },
		} as unknown as PluginConfig,
		agentKey: 'architect',
	},
	{
		name: 'feature-heavy-without-general-council',
		config: featureHeavyConfig,
		agentKey: 'architect',
	},
	{
		name: 'feature-heavy-with-general-council (largest supported composition)',
		config: LARGEST_SUPPORTED_COMPOSITION,
		agentKey: 'architect',
	},
	{
		name: 'multi-swarm-prefixed-feature-heavy-with-general-council',
		config: {
			swarms: { cloud: { name: 'Cloud Swarm', agents: {} } },
			...LARGEST_SUPPORTED_COMPOSITION,
		} as unknown as PluginConfig,
		agentKey: 'cloud_architect',
	},
	{
		name: 'memory-only',
		config: { memory: { enabled: true } } as unknown as PluginConfig,
		agentKey: 'architect',
	},
	{
		name: 'ui_review-only',
		config: { ui_review: { enabled: true } } as unknown as PluginConfig,
		agentKey: 'architect',
	},
	{
		name: 'memory + ui_review combined',
		config: {
			memory: { enabled: true },
			ui_review: { enabled: true },
		} as unknown as PluginConfig,
		agentKey: 'architect',
	},
];

/**
 * Mandatory directive anchors (read from the ARCHITECT_PROMPT source) in the
 * order they appear in the rendered prompt. The lifecycle/phase-completion
 * gate anchor is the phase-complete RETROSPECTIVE_MISSING gate instruction —
 * a directive the budget repair must never remove.
 */
const MANDATORY_ANCHORS = [
	'## COMMAND NAMESPACE',
	'## GRAPH-FIRST EVIDENCE',
	'## CONTEXT TRIAGE',
	'### MODE: COUNCIL',
	'will be blocked with reason `RETROSPECTIVE_MISSING`',
] as const;

const LIFECYCLE_GATE_ANCHOR = MANDATORY_ANCHORS[4];

function renderCellPrompt(cell: ArchitectBudgetMatrixCell): string {
	const configs = getAgentConfigs(cell.config);
	const prompt = configs[cell.agentKey]?.prompt;
	return typeof prompt === 'string' ? prompt : '';
}

describe('architect prompt budget matrix — issue #2671 acceptance', () => {
	let prevXdg: string | undefined;
	let cfgDir: string;

	beforeEach(() => {
		prevXdg = process.env.XDG_CONFIG_HOME;
		// Same isolation as tests/unit/agents/architect-prompt-budget.test.ts:
		// measure the built-in render, not a developer's custom config prompt.
		cfgDir = canonicalMkdtemp('swarm-budget-matrix-');
		mkdirSync(join(cfgDir, 'opencode', 'opencode-swarm'), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgDir;
		// The deferred-warning buffer is module-global; reset it so assertions
		// only see warnings produced by THIS test file's renders.
		clearDeferredWarnings();
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		rmSync(cfgDir, { recursive: true, force: true });
	});

	test('AC8- every feature-matrix cell renders under ARCHITECT_PROMPT_BUDGET_CHARS without dropping the general-council guidance', () => {
		for (const cell of FEATURE_MATRIX) {
			const prompt = renderCellPrompt(cell);
			expect(
				typeof prompt === 'string' && prompt.length > 0,
				`cell "${cell.name}" must render a non-empty architect prompt`,
			).toBe(true);
			expect(
				prompt.length,
				`cell "${cell.name}" renders ${prompt.length} chars, exceeding ARCHITECT_PROMPT_BUDGET_CHARS (${ARCHITECT_PROMPT_BUDGET_CHARS}). ` +
					'Trim feature-guidance prose or consciously raise the ceiling in src/agents/architect.ts — ' +
					'the general council composed with all supported features must fit.',
			).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
		}

		// The repair may not "fix" the budget by dropping the feature guidance:
		// the largest supported composition still teaches the general council tool.
		const largest = FEATURE_MATRIX.find(
			(cell) => cell.config === LARGEST_SUPPORTED_COMPOSITION,
		);
		expect(largest).toBeDefined();
		const largestPrompt = renderCellPrompt(
			largest as ArchitectBudgetMatrixCell,
		);
		expect(
			largestPrompt.includes('convene_general_council'),
			'the feature-heavy + general-council cell must still contain the convene_general_council tool guidance',
		).toBe(true);
	});

	test('AC9- budget metrics separate chars from model-token estimates; mandatory anchors stay present and order-stable in every cell; prompt stays a host-renderable plain string', async () => {
		// New surface (issue #2671 AC9) — RED at the unfixed tree.
		const architect = await import('../../../src/agents/architect');
		const estimateModelTokens = (
			architect as {
				estimateModelTokens?: (text: string) => number;
			}
		).estimateModelTokens;
		const measureArchitectPromptBudget = (
			architect as {
				measureArchitectPromptBudget?: (prompt: string) => {
					chars: number;
					tokenEstimate: number;
					withinBudget: boolean;
				};
			}
		).measureArchitectPromptBudget;
		expect(
			typeof estimateModelTokens,
			'estimateModelTokens must be exported from src/agents/architect',
		).toBe('function');
		expect(
			typeof measureArchitectPromptBudget,
			'measureArchitectPromptBudget must be exported from src/agents/architect',
		).toBe('function');

		// Known-string token estimate: ~4 chars/token, rounded up.
		expect(estimateModelTokens('a'.repeat(401))).toBe(101);

		// On a real rendered cell, chars and tokenEstimate are separate quantities.
		const defaultPrompt = renderCellPrompt(FEATURE_MATRIX[0]);
		const metrics = measureArchitectPromptBudget(defaultPrompt);
		expect(metrics.chars).toBe(defaultPrompt.length);
		expect(metrics.tokenEstimate).toBe(Math.ceil(defaultPrompt.length / 4));
		expect(metrics.withinBudget).toBe(
			defaultPrompt.length < ARCHITECT_PROMPT_BUDGET_CHARS,
		);
		// Synthetic boundary checks on the metrics helper itself.
		const short = measureArchitectPromptBudget('a'.repeat(401));
		expect(short).toEqual({
			chars: 401,
			tokenEstimate: 101,
			withinBudget: true,
		});
		const over = measureArchitectPromptBudget(
			'x'.repeat(ARCHITECT_PROMPT_BUDGET_CHARS),
		);
		expect(over.withinBudget).toBe(false);
		expect(over.tokenEstimate).toBe(40250);

		// Mandatory directives: present in every cell, relative order stable,
		// and the prompt stays a plain host-renderable string with no
		// role:'system' JSON embedded.
		for (const cell of FEATURE_MATRIX) {
			const prompt = renderCellPrompt(cell);
			expect(typeof prompt).toBe('string');
			expect(
				prompt.includes('"role"'),
				`cell "${cell.name}" must not embed role JSON in the prompt`,
			).toBe(false);
			const indices = MANDATORY_ANCHORS.map((a) => prompt.indexOf(a));
			for (let i = 0; i < MANDATORY_ANCHORS.length; i++) {
				expect(
					indices[i],
					`cell "${cell.name}" is missing mandatory directive anchor: ${MANDATORY_ANCHORS[i]}`,
				).toBeGreaterThanOrEqual(0);
				if (i > 0) {
					expect(
						indices[i],
						`cell "${cell.name}": anchor order must stay stable (${MANDATORY_ANCHORS[i - 1]} before ${MANDATORY_ANCHORS[i]})`,
					).toBeGreaterThan(indices[i - 1]);
				}
			}
		}
	});

	test('AC10- enforceArchitectPromptBudget returns a bounded prefixed error, and over-budget user-variable renders emit a visible advisory without dropping guidance', async () => {
		// New surface (issue #2671 AC10) — RED at the unfixed tree.
		const architect = await import('../../../src/agents/architect');
		const enforceArchitectPromptBudget = (
			architect as {
				enforceArchitectPromptBudget?: (
					label: string,
					prompt: string,
				) =>
					| { ok: true; chars: number; tokenEstimate: number }
					| { ok: false; error: string; chars: number; tokenEstimate: number };
			}
		).enforceArchitectPromptBudget;
		expect(
			typeof enforceArchitectPromptBudget,
			'enforceArchitectPromptBudget must be exported from src/agents/architect',
		).toBe('function');

		// Huge label and prompt must still produce a BOUNDED error.
		const huge = enforceArchitectPromptBudget(
			'L'.repeat(5000),
			'P'.repeat(400_000),
		);
		expect(huge.ok).toBe(false);
		if (!huge.ok) {
			expect(huge.error.startsWith('ARCHITECT_PROMPT_BUDGET_EXCEEDED')).toBe(
				true,
			);
			expect(
				huge.error.length,
				`error must stay bounded (<= 400 chars) even for huge inputs, got ${huge.error.length}`,
			).toBeLessThanOrEqual(400);
		}
		expect(huge.chars).toBe(400_000);
		expect(huge.tokenEstimate).toBe(100_000);

		// Within-budget prompt returns ok with correct metrics.
		const okResult = enforceArchitectPromptBudget('cell', 'short');
		expect(okResult.ok).toBe(true);
		expect(okResult.chars).toBe(5);
		expect(okResult.tokenEstimate).toBe(2);

		// Runtime visibility: an over-budget user-variable composition must
		// surface a bounded advisory through the deferred-warning buffer while
		// the rendered guidance (lifecycle gate anchor) is never silently dropped.
		const beforeCount = getDeferredWarnings().length;
		const bigSwarmId = 'y'.repeat(2000);
		const configs = getAgentConfigs({
			swarms: { [bigSwarmId]: { name: 'X'.repeat(2000), agents: {} } },
			...LARGEST_SUPPORTED_COMPOSITION,
		} as unknown as PluginConfig);
		const bigPrompt = configs[`${bigSwarmId}_architect`]?.prompt ?? '';
		const newWarnings = getDeferredWarnings().slice(beforeCount);
		expect(
			newWarnings.some((w) => /ARCHITECT_PROMPT_BUDGET_EXCEEDED/.test(w)),
			`an over-budget user-variable render must emit a visible ARCHITECT_PROMPT_BUDGET_EXCEEDED advisory through the warning buffer, got: ${JSON.stringify(newWarnings)}`,
		).toBe(true);
		expect(
			bigPrompt.includes(LIFECYCLE_GATE_ANCHOR),
			'the over-budget prefixed architect prompt must still contain the mandatory lifecycle-gate guidance',
		).toBe(true);
	});

	test('AC11- docs explain the prompt budget in characters AND model tokens, and state the supported-together feature matrix', () => {
		// Resolve the repo root from this test file's location (upward search
		// for package.json) so the check works regardless of process.cwd().
		let root = import.meta.dir;
		for (let i = 0; i < 6; i++) {
			if (existsSync(join(root, 'package.json'))) break;
			const parent = dirname(root);
			if (parent === root) break;
			root = parent;
		}
		const configDocPath = join(root, 'docs', 'configuration.md');
		const archDocPath = join(root, 'docs', 'architecture.md');
		expect(
			existsSync(configDocPath),
			`docs/configuration.md must exist at ${configDocPath}`,
		).toBe(true);
		expect(
			existsSync(archDocPath),
			`docs/architecture.md must exist at ${archDocPath}`,
		).toBe(true);
		const configDoc = readFileSync(configDocPath, 'utf-8');
		const archDoc = readFileSync(archDocPath, 'utf-8');

		// configuration.md must carry a section whose heading mentions
		// "prompt budget" (case-insensitive).
		const headingMatch = configDoc.match(/^#{1,6}[^\n]*prompt budget[^\n]*$/im);
		expect(
			headingMatch,
			'docs/configuration.md must contain a section heading mentioning "prompt budget"',
		).toBeTruthy();

		// That section must explain BOTH units: characters and model tokens.
		const headingStart = headingMatch?.index ?? 0;
		const afterHeading = configDoc.slice(configDoc.indexOf('\n', headingStart));
		const nextHeadingIdx = afterHeading.search(/^#{1,6}\s/m);
		const section =
			nextHeadingIdx === -1
				? afterHeading
				: afterHeading.slice(0, nextHeadingIdx);
		const sectionLower = section.toLowerCase();
		expect(
			sectionLower.includes('character'),
			'the prompt-budget section must mention the character ceiling',
		).toBe(true);
		expect(
			sectionLower.includes('model token'),
			'the prompt-budget section must mention the model-token estimate (chars vs tokens explanation)',
		).toBe(true);

		// At least one of the two docs states the supported-together feature
		// matrix (coarse substring checks, not exact-sentence pins).
		const combined = `${section}\n${archDoc}`.toLowerCase();
		expect(
			combined.includes('general council') &&
				/feature|supported/.test(combined),
			'the docs must state that the general council composes with the supported feature matrix under the budget',
		).toBe(true);
	});
});
