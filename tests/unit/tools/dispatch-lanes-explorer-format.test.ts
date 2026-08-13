import { afterEach, describe, expect, test } from 'bun:test';
import {
	CANDIDATE_HEADERS,
	CLEAN_TEMPLATES,
} from '../../../src/background/candidate-contract';
import {
	_internals,
	_test_exports,
	BASE_EXPLORER_CANDIDATE_FORMAT_SUFFIX,
	MAX_PROMPT_CHARS,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

function applyExplorerFormatSuffix(
	lanes: Parameters<typeof _test_exports.applyExplorerFormatSuffix>[0],
	options: Parameters<typeof _test_exports.applyExplorerFormatSuffix>[1] = {},
) {
	const result = _test_exports.applyExplorerFormatSuffix(lanes, options);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.errors.join('; '));
	return result.lanes;
}

describe('applyExplorerFormatSuffix', () => {
	test('appends format suffix to explorer-role lanes', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toContain('inspect runtime');
		expect(result[0].prompt).toContain('[CANDIDATE]');
	});

	test('skips non-explorer lanes', () => {
		_internals.getGeneratedAgentNames = () => [
			'swarm_explorer',
			'swarm_reviewer',
		];
		const lanes = [
			{ id: 'L1', agent: 'swarm_reviewer', prompt: 'review findings' },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe('review findings');
		expect(result[0].prompt).not.toContain('[CANDIDATE]');
	});

	test('a casual [CANDIDATE] mention does not suppress the controller contract', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const originalPrompt = 'inspect with [CANDIDATE] format already';
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: originalPrompt },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).not.toBe(originalPrompt);
		expect(result[0].prompt).toContain('CONTROLLER-BOUND OUTPUT IDENTITY');
		expect(result[0].prompt).toContain('[CLEAN] | lane');
		expect(result[0].prompt).toContain('[CLEAN] | micro_lane');
		expect(result[0].prompt).toContain('MICRO WORKED EXAMPLE');
		expect(result[0].prompt).toMatch(/at least 12\s+characters/);
		expect(result[0].prompt).toMatch(/at least 20\s+characters/);
		expect(result[0].prompt).not.toContain(
			'Fill every CLEAN field with the exact workflow_lane',
		);
	});

	test('applying the controller contract twice is idempotent', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const once = applyExplorerFormatSuffix(lanes);
		const twice = applyExplorerFormatSuffix(once);
		expect(twice).toEqual(once);
	});

	test.each([
		'swarm-pr-review:base',
		'swarm-pr-review:micro',
	] as const)('keeps the exact %s contract idempotent', (mode) => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const once = applyExplorerFormatSuffix(lanes, {
			failClosed: true,
			mode,
		});
		const twice = applyExplorerFormatSuffix(once, {
			failClosed: true,
			mode,
		});
		expect(twice).toEqual(once);
	});

	test.each([
		['generic', undefined, 'swarm-pr-review:micro'],
		['base', 'swarm-pr-review:base', 'swarm-pr-review:micro'],
		['micro', 'swarm-pr-review:micro', 'swarm-pr-review:base'],
	] as const)('rejects a pre-applied %s contract when the controller requires another row family', (_label, initialMode, requiredMode) => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const original = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const preformatted = applyExplorerFormatSuffix(
			original,
			initialMode === undefined ? {} : { failClosed: true, mode: initialMode },
		);
		const result = _test_exports.applyExplorerFormatSuffix(preformatted, {
			failClosed: true,
			mode: requiredMode,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected fail-closed result');
		expect(result.errors.join('; ')).toContain(
			'incompatible, duplicate, or controller-unbound',
		);
	});

	test('rejects an expected suffix that lacks the exact controller identity', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const generic = applyExplorerFormatSuffix([
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		]);
		const promptWithoutIdentity = generic[0].prompt.replace(
			/CONTROLLER-BOUND OUTPUT IDENTITY:[^\n]+/,
			'',
		);
		const result = _test_exports.applyExplorerFormatSuffix(
			[{ ...generic[0], prompt: promptWithoutIdentity }],
			{ failClosed: true },
		);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected fail-closed result');
		expect(result.errors.join('; ')).toContain('controller-unbound');
	});

	test('rejects a duplicated expected suffix even with the exact controller identity', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const once = applyExplorerFormatSuffix(
			[{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' }],
			{ failClosed: true, mode: 'swarm-pr-review:base' },
		);
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					...once[0],
					prompt: `${once[0].prompt}${BASE_EXPLORER_CANDIDATE_FORMAT_SUFFIX}`,
				},
			],
			{ failClosed: true, mode: 'swarm-pr-review:base' },
		);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected fail-closed result');
		expect(result.errors.join('; ')).toContain('duplicate');
	});

	test.each([
		{
			mode: 'swarm-pr-review:base',
			expected: 'exact workflow_lane only in the `lane` field',
			header: CANDIDATE_HEADERS.base_explorer,
			clean: CLEAN_TEMPLATES.base_explorer,
			forbiddenHeader: CANDIDATE_HEADERS.micro_lane,
			forbiddenField: 'invariant_violated',
			example: 'example-base-001 | example-base',
		},
		{
			mode: 'swarm-pr-review:micro',
			expected: 'exact workflow_lane only in the `micro_lane` field',
			header: CANDIDATE_HEADERS.micro_lane,
			clean: CLEAN_TEMPLATES.micro_lane,
			forbiddenHeader: CANDIDATE_HEADERS.base_explorer,
			forbiddenField: 'impact_context',
			example: 'example-micro-001 | example-micro',
		},
	] as const)('binds $mode to its exact row-family field', ({
		mode,
		expected,
		header,
		clean,
		forbiddenHeader,
		forbiddenField,
		example,
	}) => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'L1',
					agent: 'swarm_explorer',
					prompt: 'inspect runtime',
				},
			],
			{ failClosed: true, mode },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		const prompt = result.lanes[0].prompt;
		expect(prompt).toContain(expected);
		expect(prompt).toContain(header);
		expect(prompt).toContain(clean);
		expect(prompt).toContain(example);
		expect(prompt).not.toContain(forbiddenHeader);
		expect(prompt).not.toContain(forbiddenField);
		expect(prompt).toContain('final data field');
		expect(prompt).toContain('HIGH, MEDIUM, or LOW');
		expect(prompt).toContain('plain text');
		expect(prompt).toContain('never inside Markdown code fences');
	});

	test('uses the micro-only contract for council explorer lanes', () => {
		_internals.getGeneratedAgentNames = () => ['council_generalist'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'council',
					agent: 'council_generalist',
					prompt: 'challenge the candidates',
					workflow_lane: 'council-generalist',
				},
			],
			{ failClosed: true, mode: 'swarm-pr-review:council' },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		expect(result.lanes[0].prompt).toContain(CANDIDATE_HEADERS.micro_lane);
		expect(result.lanes[0].prompt).not.toContain(
			CANDIDATE_HEADERS.base_explorer,
		);
		expect(result.lanes[0].prompt).not.toContain('impact_context');
	});

	test('appends the controller identity exactly once for a consolidated Tier-M lane', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{
				id: 'L1',
				agent: 'swarm_explorer',
				prompt: 'inspect the consolidated review surface',
				workflow_lane: 'auth-identity-secrets',
				owned_workflow_lanes: [
					'auth-identity-secrets',
					'privacy-data-handling',
				],
			},
		];
		const twice = applyExplorerFormatSuffix(applyExplorerFormatSuffix(lanes));

		expect(
			twice[0].prompt.match(/CONTROLLER-BOUND OUTPUT IDENTITY/g),
		).toHaveLength(1);
		expect(twice[0].prompt).toContain(
			'[CLEAN] | lane | coverage_scope | evidence',
		);
		expect(twice[0].prompt).toContain(
			'[CLEAN] | micro_lane | coverage_scope | evidence',
		);
	});

	test('preserves generic dispatch compatibility when appending would exceed MAX_PROMPT_CHARS', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS - 10);
		const lanes = [{ id: 'L1', agent: 'swarm_explorer', prompt: longPrompt }];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe(longPrompt);
	});

	test('fails closed for PR-workflow enforcement when the suffix would overflow', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'L1',
					agent: 'swarm_explorer',
					prompt: 'x'.repeat(MAX_PROMPT_CHARS - 10),
				},
			],
			{ failClosed: true },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected fail-closed result');
		expect(result.errors.join('; ')).toContain(
			'mandatory explorer output contract',
		);
		expect(result.errors.join('; ').length).toBeLessThan(300);
	});

	test('delivers the hardened format rules into the composed lane prompt', () => {
		// Scope note: this asserts DELIVERY, not compliance. Whether a lane obeys
		// the contract cannot be unit-tested — the measured evidence for that is the
		// real-run replay in 08-test-results.md. What is testable, and what was
		// previously untested, is that the three rules added after the PR #2090
		// analysis actually reach the prompt a lane receives.
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const [lane] = applyExplorerFormatSuffix([
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect the diff' },
		]);

		// 1. Pipe escaping — the rule that 3 of the 14 real failures needed. Must
		// carry a literal backslash: `\|` in a template literal renders as a bare
		// `|`, which would instruct lanes to emit the character that breaks a row.
		expect(lane.prompt).toContain('\\|');
		// 2. Generic mode retains both explicitly separated worked families for
		// non-PR callers that have not selected a controller-owned row family.
		expect(lane.prompt).toContain('WORKED EXAMPLE');
		expect(lane.prompt).toContain('example-base-001 | example-base');
		expect(lane.prompt).toContain('example-micro-001 | example-micro');
		// 3. The [CLEAN] shape — no confidence field, zero-findings only. A
		// confidence appended to CLEAN caused 4 of the real failures.
		expect(lane.prompt).toContain('NO\nconfidence field');
		expect(lane.prompt).toContain('never alongside');
		// The example id obeys the uniqueness rule stated below it, so a lane that
		// copies it verbatim cannot collide at assertNoDuplicates.
		expect(lane.prompt).toContain('Choose exactly one family');
	});
});
