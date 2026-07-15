import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOOP_SKILL_PATH = join(
	import.meta.dir,
	'../../../.opencode/skills/loop/SKILL.md',
);

const ALLOWED_REASONS = [
	'objective-met',
	'budget-exhausted',
	'plateau',
	'oscillation',
	'unrecoverable-error',
	'user-stop',
] as const;

describe('loop-complete grammar (FR-008, SC-020)', () => {
	const content = readFileSync(LOOP_SKILL_PATH, 'utf-8');

	// Extract the loop-complete marker element from the skill content
	const markerMatch = content.match(/<loop-complete\b[^>]*\/>/);

	// SC-020: The loop-complete marker exists in the skill file
	test('loop-complete marker is present in the loop skill', () => {
		expect(markerMatch).not.toBeNull();
	});

	// SC-020: The marker declares all 6 allowed reason values as an enum
	test('loop-complete marker declares all 6 allowed reason values', () => {
		expect(markerMatch).not.toBeNull();
		if (!markerMatch) return;
		const reasonMatch = markerMatch[0].match(/reason="([^"]*)"/);
		expect(reasonMatch).not.toBeNull();
		if (!reasonMatch) return;
		const declaredReasons = reasonMatch[1].split('|');
		expect(declaredReasons.sort()).toEqual([...ALLOWED_REASONS].sort());
	});

	// SC-020: The marker has a cycles attribute
	test('loop-complete marker has cycles attribute', () => {
		expect(markerMatch).not.toBeNull();
		if (!markerMatch) return;
		expect(markerMatch[0]).toMatch(/cycles="[^"]*"/);
	});

	// SC-020: Exactly 6 allowed reasons (no more, no less)
	test('allowed reasons list has exactly 6 entries', () => {
		expect(ALLOWED_REASONS).toHaveLength(6);
	});

	// SC-020: The marker is self-closing XML
	test('loop-complete marker is self-closing', () => {
		expect(markerMatch).not.toBeNull();
		if (!markerMatch) return;
		expect(markerMatch[0]).toMatch(/\/>$/);
	});
});
