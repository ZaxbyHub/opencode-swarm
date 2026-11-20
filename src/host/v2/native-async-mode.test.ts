import { describe, expect, test } from 'bun:test';
import {
  isKnownNativeAsyncSubagentVersion,
  registerNativeV2AsyncSubagents,
  isNativeV2AsyncSubagentHost,
  rememberVerifiedNativeChild,
  isTrackedNativeChildSession,
  clearTrackedNativeChildrenForTests,
} from './native-async-mode';

describe('native OpenCode 2.3.x async mode', () => {
  test('pins the dialect to the tested 2.3 minor', () => {
    expect(isKnownNativeAsyncSubagentVersion('2.3.0')).toBe(true);
    expect(isKnownNativeAsyncSubagentVersion('2.3.1')).toBe(true);
    for (const input of ['2.2.99', '2.4.0', '3.0.0', '', undefined, '2.3', 'bogus']) {
      expect(isKnownNativeAsyncSubagentVersion(input)).toBe(false);
    }
  });
  test('two concurrent setups do not unmark one another', () => {
    const dir = '/tmp/v2-native-mode-test';
    const one = registerNativeV2AsyncSubagents(dir, 'owner-1');
    const two = registerNativeV2AsyncSubagents(dir, 'owner-2');
    expect(isNativeV2AsyncSubagentHost(dir)).toBe(true);
    one();
    expect(isNativeV2AsyncSubagentHost(dir)).toBe(true);
    one();
    two();
    expect(isNativeV2AsyncSubagentHost(dir)).toBe(false);
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
