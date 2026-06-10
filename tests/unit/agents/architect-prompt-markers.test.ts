import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ARCHITECT_FILE_PATH = resolve(
	__dirname,
	'../../../src/agents/architect.ts',
);

describe('architect.ts BEHAVIORAL_GUIDANCE markers', () => {
	const content = readFileSync(ARCHITECT_FILE_PATH, 'utf-8');

	const START_MARKER = '<!-- BEHAVIORAL_GUIDANCE_START -->';
	const END_MARKER = '<!-- BEHAVIORAL_GUIDANCE_END -->';
	const REPLACEMENT_PLACEHOLDER = '[Enforcement: programmatic gates active]';

	// Helper to find all marker positions
	const findMarkerPositions = (marker: string): number[] => {
		const positions: number[] = [];
		let index = 0;
		while ((index = content.indexOf(marker, index)) !== -1) {
			positions.push(index);
			index += marker.length;
		}
		return positions;
	};

	const startPositions = findMarkerPositions(START_MARKER);
	const endPositions = findMarkerPositions(END_MARKER);

	it('should contain exactly 8 START markers', () => {
		// v6.71.1 (#519): added a 4th BEHAVIORAL_GUIDANCE block for SCOPE DISCIPLINE rule 1a.
		// QA gate hardening: added 3 more blocks for SPECIFY step 5b, BRAINSTORM Phase 6,
		// and PLAN inline gate-selection paths.
		// General Council advisory is now an early workflow option, not a SPECIFY step.
		expect(startPositions.length).toBe(8);
	});

	it('should contain exactly 8 END markers', () => {
		expect(endPositions.length).toBe(8);
	});

	it('should have balanced START and END marker counts', () => {
		expect(startPositions.length).toBe(endPositions.length);
	});

	it('should not have nested markers (no START before previous END)', () => {
		// Parse through the string tracking open/closed state
		let isOpen = false;

		// Interleave all markers sorted by position
		const allMarkers: { type: 'START' | 'END'; pos: number }[] = [
			...startPositions.map((pos) => ({ type: 'START' as const, pos })),
			...endPositions.map((pos) => ({ type: 'END' as const, pos })),
		].sort((a, b) => a.pos - b.pos);

		for (const marker of allMarkers) {
			if (marker.type === 'START') {
				// If already open, that's a nesting violation
				expect(isOpen).toBe(false);
				isOpen = true;
			} else {
				// END should only come when we're currently open
				expect(isOpen).toBe(true);
				isOpen = false;
			}
		}

		// Should end in closed state
		expect(isOpen).toBe(false);
	});

	it('should have each START marker come before its corresponding END marker', () => {
		// Each START should have a corresponding END after it
		for (let i = 0; i < startPositions.length; i++) {
			expect(startPositions[i]).toBeLessThan(endPositions[i]);
		}
	});

	it('should NOT contain the replacement placeholder in source file', () => {
		expect(content).not.toContain(REPLACEMENT_PLACEHOLDER);
	});

	it('should use exact HTML comment format for markers', () => {
		// Verify the markers use HTML comment format exactly
		// Check that alternative formats do NOT exist
		const alternativeStartFormats = [
			'// BEHAVIORAL_GUIDANCE_START',
			'/* BEHAVIORAL_GUIDANCE_START',
			'# BEHAVIORAL_GUIDANCE_START',
		];
		const alternativeEndFormats = [
			'// BEHAVIORAL_GUIDANCE_END',
			'/* BEHAVIORAL_GUIDANCE_END',
			'# BEHAVIORAL_GUIDANCE_END',
		];

		for (const alt of alternativeStartFormats) {
			expect(content.includes(alt)).toBe(false);
		}
		for (const alt of alternativeEndFormats) {
			expect(content.includes(alt)).toBe(false);
		}

		// Verify the correct format exists
		expect(content.includes(START_MARKER)).toBe(true);
		expect(content.includes(END_MARKER)).toBe(true);
	});
});
