/** Regression: OpenCode v2 result.output must preserve a running child. */
import { describe, expect, test } from 'bun:test';
import { translateV2ResultToV1Output } from './hooks';
import type { V2ToolHookInput } from './types';

const WRAP_RUNNING = '<subagent sessionID="ses_child" state="running">launched</subagent>';
const WRAP_COMPLETED = '<subagent sessionID="ses_child" state="completed">done</subagent>';
function input(result: V2ToolHookInput['result'], status: V2ToolHookInput['status'] = 'completed'): V2ToolHookInput {
  return { tool: 'subagent', sessionID: 'ses_parent', agent: 'architect',
    messageID: 'msg_test', id: 'call_test', status, result };
}

describe('OpenCode v2 subagent running state', () => {
  test('running wrapper in result.output is not treated as completed', () => {
    const r = translateV2ResultToV1Output(input({ output: WRAP_RUNNING }), true);
    expect(r.state).toBe('running');
    expect(r.output).toContain('<task id="ses_child" state="running">');
  });
  test('running wrapper in content string remains supported', () => {
    expect(translateV2ResultToV1Output(input({ content: WRAP_RUNNING }), true).state).toBe('running');
  });
  test('running wrapper in content array remains supported', () => {
    expect(translateV2ResultToV1Output(input({ content: [{ type: 'text', text: WRAP_RUNNING }] }), true).state).toBe('running');
  });
  test('valid content wrapper takes precedence over output', () => {
    expect(translateV2ResultToV1Output(input({ content: WRAP_COMPLETED, output: WRAP_RUNNING }), true).state).toBe('completed');
  });
  test('result.output with completed wrapper is terminal', () => {
    expect(translateV2ResultToV1Output(input({ output: WRAP_COMPLETED }), true).state).toBe('completed');
  });
  test('host error takes precedence over a stale running wrapper', () => {
    const r = translateV2ResultToV1Output({ ...input({ output: WRAP_RUNNING }, 'error'), error: { message: 'failure' } }, true);
    expect(r.state).toBe('error');
  });
  test('non-wrapper text never authorizes a running child', () => {
    expect(translateV2ResultToV1Output(input({ output: 'plain text' }), true).state).toBe('completed');
  });
  test('non-subagent tools do not use result.output fallback', () => {
    expect(translateV2ResultToV1Output(input({ output: WRAP_RUNNING }), false).state).toBe('completed');
  });
});
