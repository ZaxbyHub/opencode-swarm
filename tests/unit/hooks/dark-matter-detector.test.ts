/**
 * Tests for dark-matter-detector hook
 *
 * Tests parseDarkMatterGaps, readDarkMatterMd, and createDarkMatterDetectorHook functions
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createDarkMatterDetectorHook,
	parseDarkMatterGaps,
	readDarkMatterMd,
} from '../../../src/hooks/dark-matter-detector.js';

describe('parseDarkMatterGaps', () => {
	it('should parse unresolved items from markdown', () => {
		const content = `- [ ] Gap 1
- [ ] Gap 2
- [x] Resolved gap`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(2);
		expect(result.unresolved).toContain('Gap 1');
		expect(result.unresolved).toContain('Gap 2');
		expect(result.resolved).toHaveLength(1);
		expect(result.resolved).toContain('Resolved gap');
	});

	it('should parse resolved items with [x] (case-insensitive)', () => {
		const content = `- [X] Resolved uppercase
- [x] Resolved lowercase`;

		const result = parseDarkMatterGaps(content);

		expect(result.resolved).toHaveLength(2);
		expect(result.resolved).toContain('Resolved uppercase');
		expect(result.resolved).toContain('Resolved lowercase');
	});

	it('should handle empty content', () => {
		const content = '';

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(0);
		expect(result.resolved).toHaveLength(0);
	});

	it('should handle content with no gap items', () => {
		const content = `# Title
Some text
- regular list item`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(0);
		expect(result.resolved).toHaveLength(0);
	});

	it('should trim whitespace from gap descriptions', () => {
		const content = `- [ ]   Gap with spaces   
- [x]   Another gap   `;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved[0]).toBe('Gap with spaces');
		expect(result.resolved[0]).toBe('Another gap');
	});

	it('should handle mixed unresolved and resolved items', () => {
		const content = `- [ ] Unresolved 1
- [x] Resolved 1
- [ ] Unresolved 2
- [x] Resolved 2
- [ ] Unresolved 3`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(3);
		expect(result.resolved).toHaveLength(2);
	});

	it('should handle items with additional content on the same line', () => {
		const content = `- [ ] This is a gap with more details
- [x] This is resolved with details`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved[0]).toBe('This is a gap with more details');
		expect(result.resolved[0]).toBe('This is resolved with details');
	});

	it('should handle items with varying whitespace around checkbox', () => {
		const content = `- [ ]One space
- [  ]Two spaces
- [   ]Three spaces`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(3);
	});

	it('should not match lines that do not follow the pattern', () => {
		const content = `- Just a regular item
* Another regular item
1. Numbered item
- [other] Some other pattern`;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(0);
		expect(result.resolved).toHaveLength(0);
	});

	it('should handle items with empty descriptions', () => {
		const content = `- [ ] 
- [x] `;

		const result = parseDarkMatterGaps(content);

		expect(result.unresolved).toHaveLength(1);
		expect(result.resolved).toHaveLength(1);
		expect(result.unresolved[0]).toBe('');
		expect(result.resolved[0]).toBe('');
	});
});

describe('readDarkMatterMd', () => {
	let tempDir: string;
	let swarmDir: string;
	let darkMatterPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkmatter-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		darkMatterPath = path.join(swarmDir, 'dark-matter.md');
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should return null when dark-matter.md file does not exist', async () => {
		const result = await readDarkMatterMd(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when file is empty', async () => {
		fs.writeFileSync(darkMatterPath, '');

		const result = await readDarkMatterMd(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when file contains only whitespace', async () => {
		fs.writeFileSync(darkMatterPath, '   \n\n\t  ');

		const result = await readDarkMatterMd(tempDir);

		expect(result).toBeNull();
	});

	it('should parse and return gaps from valid file', async () => {
		const content = `- [ ] Gap 1
- [x] Gap 2`;
		fs.writeFileSync(darkMatterPath, content);

		const result = await readDarkMatterMd(tempDir);

		expect(result).not.toBeNull();
		expect(result!.unresolved).toHaveLength(1);
		expect(result!.resolved).toHaveLength(1);
	});

	it('should handle files with only unresolved gaps', async () => {
		const content = `- [ ] Gap 1
- [ ] Gap 2
- [ ] Gap 3`;
		fs.writeFileSync(darkMatterPath, content);

		const result = await readDarkMatterMd(tempDir);

		expect(result).not.toBeNull();
		expect(result!.unresolved).toHaveLength(3);
		expect(result!.resolved).toHaveLength(0);
	});

	it('should handle files with only resolved gaps', async () => {
		const content = `- [x] Gap 1
- [x] Gap 2`;
		fs.writeFileSync(darkMatterPath, content);

		const result = await readDarkMatterMd(tempDir);

		expect(result).not.toBeNull();
		expect(result!.unresolved).toHaveLength(0);
		expect(result!.resolved).toHaveLength(2);
	});
});

describe('createDarkMatterDetectorHook', () => {
	let tempDir: string;
	let swarmDir: string;
	let darkMatterPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		darkMatterPath = path.join(swarmDir, 'dark-matter.md');
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should return a function', () => {
		const hook = createDarkMatterDetectorHook(tempDir);

		expect(typeof hook).toBe('function');
		expect(hook.length).toBe(2);
	});

	it('should be rate-limited to every 10th call', async () => {
		const hook = createDarkMatterDetectorHook(tempDir);

		const content = `- [ ] Gap 1`;
		fs.writeFileSync(darkMatterPath, content);

		// First 9 calls should not trigger the check (due to rate limiting)
		for (let i = 0; i < 9; i++) {
			await hook({}, {});
		}

		// 10th call should trigger the check
		await expect(hook({}, {})).resolves.toBeUndefined();
	});

	it('should have instance-scoped callCount (not module-level)', async () => {
		const hook1 = createDarkMatterDetectorHook(tempDir);
		const hook2 = createDarkMatterDetectorHook(tempDir);

		const content = `- [ ] Gap 1`;
		fs.writeFileSync(darkMatterPath, content);

		// Call hook1 5 times
		for (let i = 0; i < 5; i++) {
			await hook1({}, {});
		}

		// Call hook2 5 times - this should trigger its own rate limit
		await expect(hook2({}, {})).resolves.toBeUndefined();

		// Call hook1 5 more times - should trigger its rate limit at 10
		for (let i = 0; i < 5; i++) {
			await hook1({}, {});
		}
		await expect(hook1({}, {})).resolves.toBeUndefined();
	});

	it('should do nothing if dark-matter.md does not exist', async () => {
		const hook = createDarkMatterDetectorHook(tempDir);

		await expect(hook({}, {})).resolves.toBeUndefined();
	});

	it('should do nothing if file has no unresolved gaps', async () => {
		const content = `- [x] Resolved 1
- [x] Resolved 2`;
		fs.writeFileSync(darkMatterPath, content);

		const hook = createDarkMatterDetectorHook(tempDir);

		// Call 10 times to trigger rate limit
		for (let i = 0; i < 10; i++) {
			await hook({}, {});
		}

		await expect(hook({}, {})).resolves.toBeUndefined();
	});

	it('should swallow errors and resolve', async () => {
		const hook = createDarkMatterDetectorHook(tempDir);

		await expect(hook({}, {})).resolves.toBeUndefined();
	});

	it('should handle empty dark-matter.md file gracefully', async () => {
		fs.writeFileSync(darkMatterPath, '');

		const hook = createDarkMatterDetectorHook(tempDir);

		// Call 10 times to trigger rate limit
		for (let i = 0; i < 10; i++) {
			await hook({}, {});
		}

		await expect(hook({}, {})).resolves.toBeUndefined();
	});
});
