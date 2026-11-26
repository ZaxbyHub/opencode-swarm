import { describe, expect, test } from 'bun:test';
import {
	clearTrackedNativeChildrenForTests,
	isKnownNativeAsyncSubagentVersion,
	isTrackedNativeChildSession,
	rememberVerifiedNativeChild,
	resolveV2SubagentDialect,
} from './native-async-mode';

describe('native OpenCode 2.3.x async mode', () => {
	test('pins the dialect to the tested 2.3 minor', () => {
		expect(isKnownNativeAsyncSubagentVersion('2.3.0')).toBe(true);
		expect(isKnownNativeAsyncSubagentVersion('2.3.1')).toBe(true);
		for (const input of [
			'2.2.99',
			'2.4.0',
			'3.0.0',
			'',
			undefined,
			'2.3',
			'bogus',
		]) {
			expect(isKnownNativeAsyncSubagentVersion(input)).toBe(false);
		}
	});
	test('resolveV2SubagentDialect maps the known 2.3 dialect and everything else to legacy', () => {
		expect(resolveV2SubagentDialect('2.3.0')).toBe('native-2.3');
		expect(resolveV2SubagentDialect('2.3.1')).toBe('native-2.3');
		for (const input of [
			'1.0.0',
			'2.0.26',
			'2.2.99',
			'2.4.0',
			'3.0.0',
			'',
			undefined,
			null,
			42,
			{},
			'bogus',
		]) {
			expect(resolveV2SubagentDialect(input)).toBe('legacy');
		}
	});
	test('resolution is pure and has NO capacity path (1025 consecutive resolutions, PR 3922)', () => {
		// The dialect is derived per setup from the host version; no registry
		// exists anymore, so arbitrarily many resolutions cannot exhaust
		// anything. (The former 1024-project capacity bound is gone.)
		for (let i = 0; i < 1025; i++) {
			expect(resolveV2SubagentDialect('2.3.1')).toBe('native-2.3');
			expect(resolveV2SubagentDialect('1.0.0')).toBe('legacy');
		}
	});
	test('verified child identity is immutable per parent, rejects invalid and self references', () => {
		clearTrackedNativeChildrenForTests();
		expect(rememberVerifiedNativeChild('ses_child', 'ses_parent')).toBe(true);
		expect(isTrackedNativeChildSession('ses_child')).toBe(true);
		expect(rememberVerifiedNativeChild('ses_child', 'ses_else')).toBe(false);
		expect(rememberVerifiedNativeChild('ses_parent', 'ses_parent')).toBe(false);
		expect(rememberVerifiedNativeChild('ses_<bad', 'ses_parent')).toBe(false);
		clearTrackedNativeChildrenForTests();
		expect(isTrackedNativeChildSession('ses_child')).toBe(false);
	});
});
