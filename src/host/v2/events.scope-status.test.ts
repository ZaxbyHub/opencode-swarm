/**
 * Regression: a v2 session.status.updated event is not proof that a child
 * session has finished. In particular busy/retry must not become session.idle,
 * because the v1 terminal handler retires the child's write-scope binding.
 */
import { describe, expect, test } from 'bun:test';
import { mapV2EventToV1 } from './events';

const sid = 'ses_scope_regression_child';

describe('v2 session status events preserve their meaning', () => {
  for (const status of ['busy', 'retry'] as const) {
    test(`session.status.updated ${status} is not translated to session.idle`, () => {
      const mapped = mapV2EventToV1({
        type: 'session.status.updated',
        data: { sessionID: sid, status: { type: status } },
      });
      expect(mapped).toEqual({
        type: 'session.status',
        properties: { sessionID: sid, status: { type: status } },
      });
    });
  }

  test('session.status.updated idle still carries the terminal state', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status.updated',
        properties: { sessionID: sid, status: { type: 'idle' } },
      }),
    ).toEqual({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'idle' } },
    });
  });

  test('a true session.idle event is still delivered as session.idle', () => {
    expect(
      mapV2EventToV1({ type: 'session.idle', data: { sessionID: sid } }),
    ).toEqual({ type: 'session.idle', properties: { sessionID: sid } });
  });

  test('session.status busy is unchanged', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status',
        data: { sessionID: sid, status: { type: 'busy' } },
      }),
    ).toEqual({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'busy' } },
    });
  });

  test('status.updated without status does not fabricate session.idle', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status.updated',
        data: { sessionID: sid },
      })?.type,
    ).toBe('session.status');
  });
});
