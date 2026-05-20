/**
 * CI gate tests for conflict-registry data integrity.
 * Ensures CRITICAL conflicts are properly registered and disambiguation notes are present.
 */

import { describe, expect, it } from 'bun:test';
import {
	CLAUDE_CODE_CONFLICTS,
	CONFLICT_MAP,
	CRITICAL_CONFLICTS,
	HIGH_CONFLICTS,
} from './conflict-registry.js';
import { COMMAND_REGISTRY } from './registry.js';

/** Approved CRITICAL-level swarm commands — adding a new one without updating this set fails the test. */
const APPROVED_CRITICAL_CONFLICTS = new Set([
	'show-plan',
	'reset',
	'checkpoint',
]);

describe('conflict-registry CI gate', () => {
	// ========== GROUP 1: Registry completeness check ==========
	describe('Group 1: Registry completeness check', () => {
		it('every CRITICAL conflict has a corresponding COMMAND_REGISTRY entry', () => {
			for (const swarmCommand of CRITICAL_CONFLICTS) {
				expect(
					Object.hasOwn(COMMAND_REGISTRY, swarmCommand),
					`CRITICAL conflict '${swarmCommand}' has no entry in COMMAND_REGISTRY`,
				).toBe(true);
			}
		});

		it('every HIGH conflict has a corresponding COMMAND_REGISTRY entry', () => {
			for (const swarmCommand of HIGH_CONFLICTS) {
				expect(
					Object.hasOwn(COMMAND_REGISTRY, swarmCommand),
					`HIGH conflict '${swarmCommand}' has no entry in COMMAND_REGISTRY`,
				).toBe(true);
			}
		});
	});

	// ========== GROUP 2: New CRITICAL conflict guard (the ratchet) ==========
	describe('Group 2: New CRITICAL conflict guard (the ratchet)', () => {
		it('CRITICAL_CONFLICTS size matches APPROVED_CRITICAL_CONFLICTS size', () => {
			expect(CRITICAL_CONFLICTS.size).toBe(APPROVED_CRITICAL_CONFLICTS.size);
		});

		it('every CRITICAL conflict is in APPROVED_CRITICAL_CONFLICTS', () => {
			for (const swarmCommand of CRITICAL_CONFLICTS) {
				expect(
					APPROVED_CRITICAL_CONFLICTS.has(swarmCommand),
					`CRITICAL conflict '${swarmCommand}' is not in APPROVED_CRITICAL_CONFLICTS — ratchet check failed. Add it to the approved set before merging.`,
				).toBe(true);
			}
		});

		it('every APPROVED_CRITICAL_CONFLICTS entry exists in CRITICAL_CONFLICTS', () => {
			for (const approved of APPROVED_CRITICAL_CONFLICTS) {
				expect(
					CRITICAL_CONFLICTS.has(approved),
					`APPROVED_CRITICAL_CONFLICTS contains '${approved}' but it is not in CRITICAL_CONFLICTS`,
				).toBe(true);
			}
		});
	});

	// ========== GROUP 3: Disambiguation note presence ==========
	describe('Group 3: Disambiguation note presence', () => {
		it('every entry has a non-empty disambiguationNote', () => {
			for (const conflict of CLAUDE_CODE_CONFLICTS) {
				expect(
					conflict.disambiguationNote.length > 0,
					`Entry '${conflict.swarmCommand}' has an empty disambiguationNote`,
				).toBe(true);
			}
		});

		it('every disambiguationNote starts with "Use /swarm" or "NEVER invoke"', () => {
			for (const conflict of CLAUDE_CODE_CONFLICTS) {
				const note = conflict.disambiguationNote;
				const validPrefix =
					note.startsWith('Use /swarm') || note.startsWith('NEVER invoke');
				expect(
					validPrefix,
					`Entry '${conflict.swarmCommand}' disambiguationNote must start with "Use /swarm" or "NEVER invoke": "${note}"`,
				).toBe(true);
			}
		});
	});

	// ========== GROUP 4: Conflict map integrity ==========
	describe('Group 4: Conflict map integrity', () => {
		it('CONFLICT_MAP.size equals CLAUDE_CODE_CONFLICTS.length', () => {
			expect(CONFLICT_MAP.size).toBe(CLAUDE_CODE_CONFLICTS.length);
		});

		it('CONFLICT_MAP has entry for every swarmCommand in CLAUDE_CODE_CONFLICTS', () => {
			for (const conflict of CLAUDE_CODE_CONFLICTS) {
				expect(
					CONFLICT_MAP.has(conflict.swarmCommand),
					`CONFLICT_MAP missing entry for '${conflict.swarmCommand}'`,
				).toBe(true);
			}
		});

		it('CONFLICT_MAP entries match CLAUDE_CODE_CONFLICTS by swarmCommand key', () => {
			for (const conflict of CLAUDE_CODE_CONFLICTS) {
				const mapEntry = CONFLICT_MAP.get(conflict.swarmCommand);
				expect(
					mapEntry,
					`CONFLICT_MAP missing key '${conflict.swarmCommand}'`,
				).toBe(conflict);
			}
		});
	});

	// ========== GROUP 5: Severity-set consistency ==========
	describe('Group 5: Severity-set consistency', () => {
		it('CRITICAL_CONFLICTS.size + HIGH_CONFLICTS.size equals CRITICAL+HIGH count in source', () => {
			const sourceCriticalHighCount = CLAUDE_CODE_CONFLICTS.filter(
				(c) => c.severity === 'CRITICAL' || c.severity === 'HIGH',
			).length;
			const combinedSetSize = CRITICAL_CONFLICTS.size + HIGH_CONFLICTS.size;
			expect(
				combinedSetSize,
				`Combined set size (${combinedSetSize}) does not match source CRITICAL+HIGH count (${sourceCriticalHighCount})`,
			).toBe(sourceCriticalHighCount);
		});

		it('CRITICAL_CONFLICTS set contains only CRITICAL-severity entries', () => {
			for (const swarmCommand of CRITICAL_CONFLICTS) {
				const conflict = CLAUDE_CODE_CONFLICTS.find(
					(c) => c.swarmCommand === swarmCommand,
				);
				expect(
					conflict,
					`'${swarmCommand}' not found in CLAUDE_CODE_CONFLICTS`,
				).toBeDefined();
				expect(conflict!.severity).toBe('CRITICAL');
			}
		});

		it('HIGH_CONFLICTS set contains only HIGH-severity entries', () => {
			for (const swarmCommand of HIGH_CONFLICTS) {
				const conflict = CLAUDE_CODE_CONFLICTS.find(
					(c) => c.swarmCommand === swarmCommand,
				);
				expect(
					conflict,
					`'${swarmCommand}' not found in CLAUDE_CODE_CONFLICTS`,
				).toBeDefined();
				expect(conflict!.severity).toBe('HIGH');
			}
		});
	});
});
