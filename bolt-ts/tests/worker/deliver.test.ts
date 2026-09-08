import { buildSummaryActionButtons, buildSummaryMetadata, buildCoverageText } from '../../src/worker/deliver';

interface ActionsBlock {
  type: 'actions';
  elements: Array<{ action_id: string; value: string }>;
}

function actionIds(blocks: unknown[]): string[] {
  return ((blocks[0] as ActionsBlock).elements ?? []).map((e) => e.action_id);
}

describe('buildSummaryActionButtons', () => {
  it('includes Share + Roast + Receipts when no style is set', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C1',
      messageCount: 25,
      currentStyle: null,
    });
    expect(actionIds(blocks)).toEqual(['share_summary', 'rerun_roast', 'rerun_receipts']);
  });

  it('hides Roast when the current style already roasts', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C1',
      messageCount: 25,
      currentStyle: 'roast everyone',
    });
    expect(actionIds(blocks)).toEqual(['share_summary', 'rerun_receipts']);
  });

  it('hides Receipts when the current style pulls receipts', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C1',
      messageCount: 25,
      currentStyle: 'bring receipts',
    });
    expect(actionIds(blocks)).toEqual(['share_summary', 'rerun_roast']);
  });

  it('embeds count, source channel, and compact style kind in Share value payload', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C42',
      messageCount: 100,
      currentStyle: 'be funny',
    });
    const block = blocks[0] as ActionsBlock;
    const share = block.elements.find((e) => e.action_id === 'share_summary')!;
    expect(JSON.parse(share.value)).toEqual({
      action: 'share_summary',
      sourceChannelId: 'C42',
      count: 100,
      styleKind: 'default',
    });
  });

  it('keeps every button value under Slack 2,000-char cap even with a maximal style', () => {
    const longStyle = 'roast '.repeat(700); // ~4,200 chars
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C42',
      messageCount: 100,
      currentStyle: longStyle,
    });
    const block = blocks[0] as ActionsBlock;
    for (const element of block.elements) {
      expect(element.value.length).toBeLessThanOrEqual(2000);
    }
  });

  it('includes a provenance footer and feedback buttons', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C42',
      messageCount: 100,
      currentStyle: null,
      deliveredAtMs: 1_700_000_000_000,
    });
    const context = blocks.find((b) => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(context.elements[0].text).toContain('AI-generated');
    expect(context.elements[0].text).toContain('<#C42>');
    expect(context.elements[0].text).toContain('<!date^1700000000^{time}|');

    const feedback = blocks.find(
      (b) => (b as { type: string }).type === 'context_actions'
    ) as { elements: Array<{ type: string; positive_button: { text: { text: string } } }> };
    expect(feedback.elements[0].type).toBe('feedback_buttons');
    expect(feedback.elements[0].positive_button.text.text.length).toBeLessThanOrEqual(75);
  });
});


describe('actual summary coverage', () => {
  const delivery = {
    sourceChannelId: 'C42', messageCount: 25, currentStyle: null,
    coverage: { messageCount: 3, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
  };

  it('shares the included count while retaining the requested count for reruns', () => {
    const actions = buildSummaryActionButtons(delivery)[0] as ActionsBlock;
    expect(JSON.parse(actions.elements.find((element) => element.action_id === 'share_summary')!.value).count).toBe(3);
    expect(JSON.parse(actions.elements.find((element) => element.action_id === 'rerun_roast')!.value).count).toBe(25);
  });

  it('records actual count and exact bounds independently from the request', () => {
    expect(buildSummaryMetadata(delivery).event_payload).toMatchObject({
      message_count: 3, requested_message_count: 25, oldest_ts: delivery.coverage.oldestTs, latest_ts: delivery.coverage.latestTs,
    });
  });

  it('formats a single-message span without duplicated time labels', () => {
    expect(buildCoverageText({ messageCount: 1, oldestTs: '1788825600', latestTs: '1788825600' }))
      .toBe('1 message · Sep 8, 2026 · 00:00 UTC');
  });

  it('preserves both dates when the covered window spans days', () => {
    expect(buildCoverageText({ messageCount: 2, oldestTs: '1788739200', latestTs: '1788825600' }))
      .toBe('2 messages · Sep 7, 2026, 00:00 – Sep 8, 2026, 00:00 UTC');
  });
});
