import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * Architect prompt wiring for architecture supervision (issue #893). Asserts the
 * workflow block renders only when the feature is enabled, with gate/advisory phrasing,
 * and that the disabled/absent paths are byte-for-byte identical (non-regression).
 */
// Phrases UNIQUE to the workflow block — chosen to NOT overlap with the always-on
// auto-generated tool-description list (which mentions the tool/agent names regardless).
const SENTINELS = [
	'## ARCHITECTURE SUPERVISION (summary-level cross-task review)',
	'WORKER SUMMARIES (continuous)',
	'MANDATORY SEQUENCE — at phase end',
	'It reads summaries only',
];

function buildPrompt(arch?: {
	enabled?: boolean;
	mode?: 'advisory' | 'gate';
}): string {
	return createArchitectAgent(
		'test-model',
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		arch,
	).config.prompt!;
}

describe('Architect prompt — architecture supervision block', () => {
	it('renders the block when enabled (advisory)', () => {
		const prompt = buildPrompt({ enabled: true, mode: 'advisory' });
		for (const s of SENTINELS) expect(prompt).toContain(s);
		expect(prompt).toContain('Advisory mode');
		expect(prompt).not.toContain('{{ARCH_SUPERVISION_WORKFLOW}}');
	});

	it('uses gate-mode phrasing when mode is gate', () => {
		const prompt = buildPrompt({ enabled: true, mode: 'gate' });
		expect(prompt).toContain('Gate mode is ACTIVE');
		expect(prompt).toContain('will BLOCK');
	});

	it('omits the block when disabled', () => {
		const prompt = buildPrompt({ enabled: false });
		for (const s of SENTINELS) expect(prompt).not.toContain(s);
		expect(prompt).not.toContain('{{ARCH_SUPERVISION_WORKFLOW}}');
	});

	it('omits the block when config is absent', () => {
		const prompt = buildPrompt(undefined);
		expect(prompt).not.toContain(
			'## ARCHITECTURE SUPERVISION (summary-level cross-task review)',
		);
		expect(prompt).not.toContain('{{ARCH_SUPERVISION_WORKFLOW}}');
	});

	it('disabled and absent paths are byte-for-byte identical', () => {
		expect(buildPrompt({ enabled: false })).toBe(buildPrompt(undefined));
	});
});
