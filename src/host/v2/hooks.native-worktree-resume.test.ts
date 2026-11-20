import { afterEach, describe, expect, test } from 'bun:test';
import {
  laneChildSessionAgents,
  standardWorktreeByCallID,
  type StandardWorktreeDispatch,
  verifiedWorktreeChildForV2Call,
} from '../../hooks/delegation-gate/worktree-isolation';
import { mapV1TaskArgsToV2 } from './hooks';

const callID = 'call_native_worktree_resume_test';
const parentSessionID = 'ses_parent_native_test';
const childSessionId = 'ses_precreated_scoped_test';

afterEach(() => {
  standardWorktreeByCallID.delete(callID);
  laneChildSessionAgents.delete(childSessionId);
});

function setUpLane() {
  standardWorktreeByCallID.set(callID, {
    callID,
    parentSessionID,
    childSessionId,
    taskId: '1.1',
  } as StandardWorktreeDispatch);
  laneChildSessionAgents.set(childSessionId, 'coder');
}

describe('OpenCode 2.3 isolated native child resume', () => {
  test('only the session created for this exact call may be used as resume id', () => {
    setUpLane();
    const matched = verifiedWorktreeChildForV2Call({ callID, parentSessionID, agent: 'coder' });
    expect(matched).toBe(childSessionId);
    expect(mapV1TaskArgsToV2({ subagent_type: 'coder', task_id: matched, prompt: 'write' }, true, matched)).toEqual({
      agent: 'coder', sessionID: childSessionId, prompt: 'write',
    });
    expect(verifiedWorktreeChildForV2Call({ callID, parentSessionID: 'ses_other', agent: 'coder' })).toBeNull();
    expect(verifiedWorktreeChildForV2Call({ callID, parentSessionID, agent: 'reviewer' })).toBeNull();
    expect(verifiedWorktreeChildForV2Call({ callID: 'call_other', parentSessionID, agent: 'coder' })).toBeNull();
  });

  test('unverified plan task IDs or arbitrary session IDs are NEVER translated to resume', () => {
    expect(mapV1TaskArgsToV2({ subagent_type: 'coder', task_id: '1.1' }, true)).toEqual({ agent: 'coder' });
    expect(mapV1TaskArgsToV2({ subagent_type: 'coder', task_id: 'ses_unverified' }, true)).toEqual({ agent: 'coder' });
    setUpLane();
    const matched = verifiedWorktreeChildForV2Call({ callID, parentSessionID, agent: 'coder' });
    expect(() => mapV1TaskArgsToV2({ subagent_type: 'coder', task_id: '1.1' }, true, matched)).toThrow('SWARM_V2_WORKTREE_CHILD_IDENTITY_MISMATCH');
    expect(mapV1TaskArgsToV2({ subagent_type: 'coder', task_id: matched, sessionID: 'ses_foreign' }, true, matched)).toEqual({
      agent: 'coder', sessionID: childSessionId,
    });
  });

  test('role/ownership changes or malformed child session fail closed', () => {
    setUpLane();
    laneChildSessionAgents.set(childSessionId, 'reviewer');
    expect(verifiedWorktreeChildForV2Call({ callID, parentSessionID, agent: 'coder' })).toBeNull();
    laneChildSessionAgents.set(childSessionId, 'coder');
    standardWorktreeByCallID.set(callID, { callID, parentSessionID, childSessionId: '1.1', taskId: '1.1' } as StandardWorktreeDispatch);
    expect(verifiedWorktreeChildForV2Call({ callID, parentSessionID, agent: 'coder' })).toBeNull();
  });
});
