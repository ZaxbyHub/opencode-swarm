/**
 * Unit tests for src/hooks/code-mode-wrapper.ts (#3446) — the per-call marker
 * the v2 adapter uses to tell the host's Code Mode `execute` wrapper apart from
 * any other tool that merely shares the name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearCodeModeWrapperCall,
	isCodeModeWrapperCall,
	MAX_CODE_MODE_WRAPPER_MARKS,
	recordCodeModeWrapperCall,
	resetCodeModeWrapperCalls,
} from '../../../src/hooks/code-mode-wrapper';

afterEach(() => {
	resetCodeModeWrapperCalls();
});

describe('code-mode wrapper call marker', () => {
	test('an unmarked call is not the wrapper', () => {
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(false);
	});

	test('a recorded call is the wrapper, scoped to its session and call id', () => {
		recordCodeModeWrapperCall('s1', 'c1');
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(true);
		expect(isCodeModeWrapperCall('s2', 'c1')).toBe(false);
		expect(isCodeModeWrapperCall('s1', 'c2')).toBe(false);
	});

	test('empty or missing ids are never marked or matched', () => {
		recordCodeModeWrapperCall('', 'c1');
		recordCodeModeWrapperCall('s1', '');
		expect(isCodeModeWrapperCall('', 'c1')).toBe(false);
		expect(isCodeModeWrapperCall('s1', '')).toBe(false);
		expect(isCodeModeWrapperCall('s1', undefined)).toBe(false);
	});

	test('clearing a call removes only that mark', () => {
		recordCodeModeWrapperCall('s1', 'c1');
		recordCodeModeWrapperCall('s1', 'c2');
		clearCodeModeWrapperCall('s1', 'c1');
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(false);
		expect(isCodeModeWrapperCall('s1', 'c2')).toBe(true);
	});

	test('retained marks are bounded and the oldest are evicted first', () => {
		for (let i = 0; i < MAX_CODE_MODE_WRAPPER_MARKS + 10; i += 1) {
			recordCodeModeWrapperCall('s1', `c${i}`);
		}
		expect(isCodeModeWrapperCall('s1', 'c0')).toBe(false);
		expect(isCodeModeWrapperCall('s1', 'c9')).toBe(false);
		expect(isCodeModeWrapperCall('s1', 'c10')).toBe(true);
		expect(
			isCodeModeWrapperCall('s1', `c${MAX_CODE_MODE_WRAPPER_MARKS + 9}`),
		).toBe(true);
	});
});
