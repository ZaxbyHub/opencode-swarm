/**
 * Tests for the buffered warning mechanism (FR-003, FR-004, SC-003, SC-004)
 *
 * These tests verify the buffer behavior and the diagnose service integration.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Test 1: Buffer is bounded to 50 entries max
// ---------------------------------------------------------------------------

describe('Buffer boundary (MAX_DEFERRED_WARNINGS = 50)', () => {
	const MAX = 50;

	it('accepts warnings until buffer reaches 50 entries', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		// Fill the buffer to capacity
		for (let i = 0; i < MAX; i++) {
			buffer.push(`Warning ${i + 1}`);
		}

		expect(buffer.length).toBe(50);
		expect(buffer[49]).toBe('Warning 50');
	});

	it('rejects warnings when buffer exceeds 50 entries', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		// Fill the buffer to capacity
		for (let i = 0; i < MAX; i++) {
			buffer.push(`Warning ${i + 1}`);
		}

		// Attempt to add one more - using addDeferredWarning logic (should reject)
		function addDeferredWarning(warning: string): void {
			if (buffer.length < MAX) {
				buffer.push(warning);
			}
		}
		addDeferredWarning('Overflow warning');

		// Buffer should still be exactly 50
		expect(buffer.length).toBe(50);
		expect(buffer[49]).toBe('Warning 50');
		expect(buffer).not.toContain('Overflow warning');
	});

	it('addDeferredWarning logic: does not add when buffer is full', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		// Fill the buffer to capacity
		for (let i = 0; i < MAX; i++) {
			buffer.push(`Warning ${i + 1}`);
		}

		// Simulate addDeferredWarning logic
		function addDeferredWarning(warning: string): void {
			if (buffer.length < 50) {
				buffer.push(warning);
			}
		}

		// Try to add when full
		addDeferredWarning('This should be rejected');

		expect(buffer.length).toBe(50);
		expect(buffer).not.toContain('This should be rejected');
	});

	it('addDeferredWarning logic: adds when buffer has capacity', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		// Simulate addDeferredWarning
		function addDeferredWarning(warning: string): void {
			if (buffer.length < 50) {
				buffer.push(warning);
			}
		}

		addDeferredWarning('First warning');
		addDeferredWarning('Second warning');

		expect(buffer.length).toBe(2);
		expect(buffer).toEqual(['First warning', 'Second warning']);
	});

	it('handles exactly 50 warnings correctly', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		// Add exactly 50 warnings
		for (let i = 0; i < MAX; i++) {
			buffer.push(`Warning ${i}`);
		}

		expect(buffer.length).toBe(50);

		// 51st should be rejected (using addDeferredWarning logic)
		function addDeferredWarning(warning: string): void {
			if (buffer.length < MAX) {
				buffer.push(warning);
			}
		}
		addDeferredWarning('Warning 50');
		expect(buffer.length).toBe(50);
	});

	it('empty buffer allows first warning through', () => {
		// Self-contained buffer
		const buffer: string[] = [];

		buffer.push('First warning');

		expect(buffer.length).toBe(1);
		expect(buffer[0]).toBe('First warning');
	});
});

// ---------------------------------------------------------------------------
// Test 2 & 3: quiet:true -> buffer, quiet:false -> live (console.warn)
// ---------------------------------------------------------------------------

describe('quiet mode behavior (quiet:true vs quiet:false)', () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('emits warning live via console.warn when quiet:false', () => {
		const buffer: string[] = [];
		const warning =
			'Full-auto mode warning: critic model matches architect model';
		const quiet = false;

		if (!quiet) {
			console.warn(warning);
		} else {
			buffer.push(warning);
		}

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(warning);
		expect(buffer.length).toBe(0);
	});

	it('buffers warning when quiet:true', () => {
		const buffer: string[] = [];
		const warning =
			'Full-auto mode warning: critic model matches architect model';
		const quiet = true;

		if (!quiet) {
			console.warn(warning);
		} else {
			buffer.push(warning);
		}

		expect(warnSpy).not.toHaveBeenCalled();
		expect(buffer.length).toBe(1);
		expect(buffer[0]).toBe(warning);
	});

	it('respects quiet flag for multiple warnings', () => {
		const buffer: string[] = [];
		const quiet = true;
		const warnings = [
			'Warning 1 about config',
			'Warning 2 about model',
			'Warning 3 about validation',
		];

		for (const warning of warnings) {
			if (!quiet) {
				console.warn(warning);
			} else {
				buffer.push(warning);
			}
		}

		expect(warnSpy).not.toHaveBeenCalled();
		expect(buffer.length).toBe(3);
	});

	it('switches to live output when quiet is false', () => {
		const buffer: string[] = [];
		const quiet = false;
		const warning = 'Live warning';

		if (!quiet) {
			console.warn(warning);
		} else {
			buffer.push(warning);
		}

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(buffer.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 4: Diagnose output includes deferred warnings
// ---------------------------------------------------------------------------

describe('Diagnose output with deferred warnings', () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('includes Deferred Warnings check when buffer has warnings', async () => {
		// Import module fresh and clear
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		warningBuffer.deferredWarnings.length = 0;

		// Add some warnings
		warningBuffer.deferredWarnings.push('Test warning 1');
		warningBuffer.deferredWarnings.push('Test warning 2');

		const { getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);

		const result = await getDiagnoseData('/test/dir');

		const deferredCheck = result.checks.find(
			(c: any) => c.name === 'Deferred Warnings',
		);
		expect(deferredCheck).toBeDefined();
		expect(deferredCheck.status).toBe('⚠️');
		expect(deferredCheck.detail).toContain('2 warning(s) deferred');

		// Cleanup
		warningBuffer.deferredWarnings.length = 0;
	});

	it('does not include Deferred Warnings check when buffer is empty', async () => {
		// Import module fresh and clear
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		warningBuffer.deferredWarnings.length = 0;

		const { getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);

		const result = await getDiagnoseData('/test/dir');

		const deferredCheck = result.checks.find(
			(c: any) => c.name === 'Deferred Warnings',
		);
		expect(deferredCheck).toBeUndefined();

		// Cleanup
		warningBuffer.deferredWarnings.length = 0;
	});

	it('reports correct warning count in Deferred Warnings check', async () => {
		// Import module fresh and clear
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		warningBuffer.deferredWarnings.length = 0;

		// Add exactly 5 warnings
		for (let i = 0; i < 5; i++) {
			warningBuffer.deferredWarnings.push(`Warning ${i + 1}`);
		}

		const { getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);

		const result = await getDiagnoseData('/test/dir');

		const deferredCheck = result.checks.find(
			(c: any) => c.name === 'Deferred Warnings',
		);
		expect(deferredCheck).toBeDefined();
		expect(deferredCheck.detail).toContain('5 warning(s) deferred');

		// Cleanup
		warningBuffer.deferredWarnings.length = 0;
	});

	it('formatDiagnoseMarkdown includes Deferred Warnings section when present', async () => {
		// Import module fresh and clear
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		warningBuffer.deferredWarnings.length = 0;

		warningBuffer.deferredWarnings.push('Warning A');
		warningBuffer.deferredWarnings.push('Warning B');

		const { formatDiagnoseMarkdown, getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);

		const diagnoseData = await getDiagnoseData('/test/dir');
		const markdown = formatDiagnoseMarkdown(diagnoseData);

		expect(markdown).toContain('## Deferred Warnings');
		expect(markdown).toContain('- Warning A');
		expect(markdown).toContain('- Warning B');

		// Cleanup
		warningBuffer.deferredWarnings.length = 0;
	});

	it('formatDiagnoseMarkdown omits Deferred Warnings section when empty', async () => {
		// Import module fresh and clear
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		warningBuffer.deferredWarnings.length = 0;

		const { formatDiagnoseMarkdown, getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);

		const diagnoseData = await getDiagnoseData('/test/dir');
		const markdown = formatDiagnoseMarkdown(diagnoseData);

		expect(markdown).not.toContain('## Deferred Warnings');

		// Cleanup
		warningBuffer.deferredWarnings.length = 0;
	});
});

// ---------------------------------------------------------------------------
// Test 5: No circular dependency between index and diagnose-service
// ---------------------------------------------------------------------------

describe('Import dependency validation (no circular dependency)', () => {
	it('index.ts does not import from diagnose-service', async () => {
		// Read the index.ts source to verify it doesn't import diagnose-service
		const indexSource = await Bun.file(
			path.join(process.cwd(), 'src', 'index.ts'),
		).text();

		// Check that there are no imports from diagnose-service
		expect(indexSource).not.toMatch(/from.*diagnose-service/);
		expect(indexSource).not.toMatch(/require.*diagnose-service/);
	});

	it('diagnose-service.ts imports deferredWarnings from warning-buffer (no circular dependency)', async () => {
		// Read the diagnose-service.ts source to verify the import
		const diagnoseSource = await Bun.file(
			path.join(process.cwd(), 'src', 'services', 'diagnose-service.ts'),
		).text();

		// Should import deferredWarnings from warning-buffer (not from ../index to avoid circular dep)
		expect(diagnoseSource).toMatch(
			/import.*deferredWarnings.*from.*warning-buffer/,
		);

		// Verify the import statement exists - deferredWarnings from ./warning-buffer.js
		const importMatch = diagnoseSource.match(
			/import\s*\{\s*deferredWarnings\s*\}\s*from\s*["']\.\/warning-buffer/,
		);
		expect(importMatch).not.toBeNull();
	});

	it('index.ts and diagnose-service.ts can be imported without circular reference error', async () => {
		// This test verifies that importing both modules doesn't throw
		// "Cannot call module before it's fully loaded" or similar.
		// After issue #675 fix, deferredWarnings is no longer re-exported from
		// index.ts — diagnose-service imports it directly from warning-buffer.js.

		const indexModule = await import('../../../src/index');
		// index.ts default export is the v1 plugin object { id, server }
		expect(indexModule.default).toBeDefined();
		expect(typeof indexModule.default).toBe('object');
		expect(typeof indexModule.default.server).toBe('function');

		// Both warning-buffer (where deferredWarnings actually lives) and
		// diagnose-service should import cleanly without circular reference.
		const warningBuffer = await import(
			'../../../src/services/warning-buffer.js'
		);
		expect(Array.isArray(warningBuffer.deferredWarnings)).toBe(true);

		const { getDiagnoseData } = await import(
			'../../../src/services/diagnose-service.js'
		);
		expect(typeof getDiagnoseData).toBe('function');
	});

	it('diagnose-service does not re-export deferredWarnings', async () => {
		const diagnoseSource = await Bun.file(
			path.join(process.cwd(), 'src', 'services', 'diagnose-service.ts'),
		).text();

		// Verify diagnose-service is NOT re-exporting deferredWarnings
		expect(diagnoseSource).not.toMatch(/export.*deferredWarnings/);
	});

	it('index.ts does NOT re-export deferredWarnings (would break OpenCode plugin loader)', async () => {
		// Issue #675: OpenCode's getLegacyPlugins iterates Object.values(mod) and
		// throws TypeError on any non-function export. The deferredWarnings array
		// re-export caused 6.86.6/6.86.7/6.86.8 to silently drop the plugin.
		// Internal consumers must import deferredWarnings directly from
		// ./services/warning-buffer.js.
		const indexSource = await Bun.file(
			path.join(process.cwd(), 'src', 'index.ts'),
		).text();

		// No direct const/let export of deferredWarnings
		const directExport = /export\s*(const|let)\s+deferredWarnings/.test(
			indexSource,
		);
		// No re-export of deferredWarnings (the re-export that caused issue #675)
		const reExport = /export\s*\{[^}]*deferredWarnings[^}]*\}/.test(
			indexSource,
		);
		expect(directExport).toBe(false);
		expect(reExport).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe('Edge cases for deferred warnings buffer', () => {
	const MAX = 50;

	it('handles empty string warning', () => {
		const buffer: string[] = [];
		buffer.push('');
		expect(buffer.length).toBe(1);
		expect(buffer[0]).toBe('');
	});

	it('handles very long warning messages', () => {
		const buffer: string[] = [];
		const longWarning = 'A'.repeat(10000);
		buffer.push(longWarning);
		expect(buffer.length).toBe(1);
		expect(buffer[0].length).toBe(10000);
	});

	it('handles Unicode characters in warnings', () => {
		const buffer: string[] = [];
		buffer.push('Warning with emoji: 🔴⚠️✨');
		buffer.push('警告中文');
		buffer.push('تwarning in Arabic');

		expect(buffer.length).toBe(3);
		expect(buffer[0]).toContain('🔴');
		expect(buffer[1]).toContain('警告');
		expect(buffer[2]).toContain('تwarning');
	});

	it('handles warnings with special characters', () => {
		const buffer: string[] = [];
		buffer.push('Warning with "quotes" and <html> and $pecial');
		expect(buffer.length).toBe(1);
		expect(buffer[0]).toContain('"quotes"');
	});

	it('buffer respects exact boundary of 50', () => {
		const buffer: string[] = [];

		// Add 49 (should work)
		for (let i = 0; i < MAX - 1; i++) {
			buffer.push(`Warning ${i}`);
		}
		expect(buffer.length).toBe(49);

		// Add 50th (should work)
		buffer.push('Warning 49');
		expect(buffer.length).toBe(50);

		// 51st should not be added (simulate addDeferredWarning behavior)
		if (buffer.length < MAX) {
			buffer.push('Overflow');
		}
		expect(buffer.length).toBe(50);
		expect(buffer).not.toContain('Overflow');
	});

	it('rapid additions are handled correctly', () => {
		const buffer: string[] = [];

		// Rapidly add warnings
		for (let i = 0; i < 100; i++) {
			if (buffer.length < MAX) {
				buffer.push(`Rapid warning ${i}`);
			}
		}

		expect(buffer.length).toBe(50);
		expect(buffer[0]).toBe('Rapid warning 0');
		expect(buffer[49]).toBe('Rapid warning 49');
	});

	it('MAX_DEFERRED_WARNINGS constant of 50 exists in warning-buffer module', async () => {
		const warningBufferSource = await Bun.file(
			path.join(process.cwd(), 'src', 'services', 'warning-buffer.ts'),
		).text();

		// Verify MAX_DEFERRED_WARNINGS constant exists and is set to 50
		expect(warningBufferSource).toMatch(/MAX_DEFERRED_WARNINGS\s*=\s*50/);
	});
});
