/** The native OpenCode `sessionID` resumes a CHILD, not Swarm plan task `1.1`. */
import { describe, expect, test } from 'bun:test';
import { mapV1TaskArgsToV2, mapV2SubagentArgsToV1 } from './hooks';

describe('OpenCode 2.3 native async subagent resume identity', () => {
  test('native resume remains a sessionID and never becomes plan task_id', () => {
    expect(mapV2SubagentArgsToV1({ agent: 'coder', sessionID: 'ses_actualchild', prompt: 'continue' }, true)).toEqual({
      subagent_type: 'coder', sessionID: 'ses_actualchild', prompt: 'continue',
    });
  });
  test('native plan task id is not forwarded as host resume token', () => {
    expect(mapV1TaskArgsToV2({subagent_type: 'coder', task_id: '1.1', prompt: 'go'}, true)).toEqual({agent: 'coder', prompt:'go'});
  });
  test('native roundtrip preserves true resume session ID, not a fabricated one', () => {
    const input = {agent: 'coder', sessionID: 'ses_child', prompt:'continue'};
    expect(mapV1TaskArgsToV2(mapV2SubagentArgsToV1(input, true), true)).toEqual(input);
  });
  test('original wrapper dialect is preserved for other hosts', () => {
    expect(mapV2SubagentArgsToV1({agent:'coder', sessionID:'task_id_legacy'}, false)).toEqual({
      subagent_type:'coder', task_id:'task_id_legacy',
    });
    expect(mapV1TaskArgsToV2({subagent_type:'coder', task_id:'task_id_legacy'}, false)).toEqual({
      agent:'coder', sessionID:'task_id_legacy',
    });
  });
});
