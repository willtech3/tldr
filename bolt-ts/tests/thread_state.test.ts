/**
 * Tests for thread state helpers.
 */

import {
  TLDR_THREAD_STATE_EVENT_TYPE,
  buildThreadStateMetadata,
  findThreadStateMessage,
  makeThreadKey,
  parseThreadContextFromMetadata,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../src/thread_state';

describe('thread_state', () => {
  describe('makeThreadKey', () => {
    it('should create a stable thread key', () => {
      expect(makeThreadKey('D123', '1700000000.000100')).toBe('D123:1700000000.000100');
    });
  });

  describe('buildThreadStateMetadata', () => {
    it('should include version and omit null fields', () => {
      const meta = buildThreadStateMetadata({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: null,
      });
      expect(meta.event_type).toBe(TLDR_THREAD_STATE_EVENT_TYPE);
      expect(meta.event_payload).toEqual({ v: 1 });
    });

    it('should include viewing channel and custom style when present', () => {
      const meta = buildThreadStateMetadata({
        viewingChannelId: 'C123',
        customStyle: 'write as a haiku',
        defaultMessageCount: null,
      });
      expect(meta.event_payload).toEqual({
        v: 1,
        viewing_channel_id: 'C123',
        custom_style: 'write as a haiku',
      });
    });

    it('should include default message count when present', () => {
      const meta = buildThreadStateMetadata({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: 25,
      });
      expect(meta.event_payload).toEqual({
        v: 1,
        default_message_count: 25,
      });
    });
  });

  describe('parseThreadContextFromMetadata', () => {
    it('should return defaults for non-object payloads', () => {
      expect(parseThreadContextFromMetadata(null)).toEqual({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: null,
      });
      expect(parseThreadContextFromMetadata('nope')).toEqual({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: null,
      });
    });

    it('should parse viewing_channel_id and custom_style when present', () => {
      expect(
        parseThreadContextFromMetadata({
          v: 1,
          viewing_channel_id: 'C999',
          custom_style: 'be funny',
        })
      ).toEqual({
        viewingChannelId: 'C999',
        customStyle: 'be funny',
        defaultMessageCount: null,
      });
    });

    it('should parse default_message_count when present', () => {
      expect(
        parseThreadContextFromMetadata({
          v: 1,
          default_message_count: 100,
        })
      ).toEqual({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: 100,
      });
    });

    it('should ignore malformed fields', () => {
      expect(
        parseThreadContextFromMetadata({
          viewing_channel_id: 123,
          custom_style: { nested: true },
          default_message_count: 'not a number',
        })
      ).toEqual({
        viewingChannelId: null,
        customStyle: null,
        defaultMessageCount: null,
      });
    });
  });

  describe('findThreadStateMessage', () => {
    it('should return cached state without calling Slack', async () => {
      const threadKey = makeThreadKey('D-CACHED', '171.0001');
      setCachedThreadState({
        threadKey,
        stateMessageTs: '171.0002',
        state: { viewingChannelId: 'C1', customStyle: 'x', defaultMessageCount: 25 },
      });

      type RepliesArgs = Parameters<SlackWebApiClient['conversations']['replies']>[0];
      const replies = jest.fn<
        ReturnType<SlackWebApiClient['conversations']['replies']>,
        [RepliesArgs]
      >();
      const client: SlackWebApiClient = { conversations: { replies } };

      const result = await findThreadStateMessage({
        client,
        assistantChannelId: 'D-CACHED',
        assistantThreadTs: '171.0001',
      });

      expect(result).toEqual({
        thread_key: threadKey,
        state_message_ts: '171.0002',
        state: { viewingChannelId: 'C1', customStyle: 'x', defaultMessageCount: 25 },
      });
      expect(replies).not.toHaveBeenCalled();
    });

    it('should find the most recent state message in replies', async () => {
      const replies: SlackWebApiClient['conversations']['replies'] = async () => ({
        messages: [
          // Non-state message
          { ts: '170.0001', metadata: { event_type: 'other', event_payload: {} } },
          // Older state
          {
            ts: '170.0002',
            metadata: {
              event_type: TLDR_THREAD_STATE_EVENT_TYPE,
              event_payload: {
                v: 1,
                viewing_channel_id: 'COLD',
                custom_style: 'old',
                default_message_count: 10,
              },
            },
          },
          // Newer state
          {
            ts: '170.0003',
            metadata: {
              event_type: TLDR_THREAD_STATE_EVENT_TYPE,
              event_payload: {
                v: 1,
                viewing_channel_id: 'CNEW',
                custom_style: 'new',
                default_message_count: 75,
              },
            },
          },
        ],
      });
      const client: SlackWebApiClient = { conversations: { replies } };

      const result = await findThreadStateMessage({
        client,
        assistantChannelId: 'D-FIND',
        assistantThreadTs: '170.0000',
      });

      expect(result).toEqual({
        thread_key: makeThreadKey('D-FIND', '170.0000'),
        state_message_ts: '170.0003',
        state: { viewingChannelId: 'CNEW', customStyle: 'new', defaultMessageCount: 75 },
      });
    });
  });
});


