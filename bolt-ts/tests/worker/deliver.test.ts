import { buildShareConfirmText, buildSummaryActionButtons, buildSummaryMetadata, buildCoverageText } from '../../src/worker/deliver';

interface ActionsBlock {
  type: 'actions';
  elements: Array<{ action_id: string; value?: string; confirm?: { text: { text: string } } }>;
}

function actionIds(blocks: unknown[]): string[] {
  return blocks.flatMap((block) => {
    const actions = block as { type?: string; elements?: Array<{ action_id?: string }> };
    if (actions.type !== 'actions') {
      return [];
    }
    return (actions.elements ?? []).map((element) => element.action_id ?? '');
  });
}

function actionElements(blocks: unknown[]): ActionsBlock['elements'] {
  return blocks.flatMap((block) => {
    const actions = block as ActionsBlock;
    return actions.type === 'actions' ? actions.elements : [];
  });
}

function shareButton(blocks: unknown[]): ActionsBlock['elements'][number] {
  for (const block of blocks) {
    const actions = block as ActionsBlock;
    if (actions.type !== 'actions') {
      continue;
    }
    const share = actions.elements.find((element) => element.action_id === 'share_summary');
    if (share) {
      return share;
    }
  }
  throw new Error('missing share button');
}

describe('buildSummaryActionButtons', () => {
  it('includes Share + Roast + Receipts when no style is set', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C012345678',
      messageCount: 25,
      coverage: { messageCount: 25, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: null,
    });
    expect(actionIds(blocks)).toEqual(['summary_whats_new', 'rerun_shorter', 'rerun_roast', 'rerun_receipts', 'summary_latest', 'share_summary']);
  });

  it('hides Roast when the current style already roasts', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C012345678',
      messageCount: 25,
      coverage: { messageCount: 25, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: 'roast everyone',
    });
    expect(actionIds(blocks)).toEqual(['summary_whats_new', 'rerun_shorter', 'rerun_receipts', 'summary_latest', 'share_summary']);
  });

  it('hides Receipts when the current style pulls receipts', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C012345678',
      messageCount: 25,
      coverage: { messageCount: 25, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: 'bring receipts',
    });
    expect(actionIds(blocks)).toEqual(['summary_whats_new', 'rerun_shorter', 'rerun_roast', 'summary_latest', 'share_summary']);
  });

  it('embeds count, source channel, and compact style kind in Share value payload', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C42',
      messageCount: 100,
      coverage: { messageCount: 100, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: 'be funny',
    });
    const share = shareButton(blocks);
    expect(JSON.parse(share.value ?? '{}')).toEqual({
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
      coverage: { messageCount: 100, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: longStyle,
    });
    for (const element of actionElements(blocks)) {
      if (element.value === undefined) {
        continue;
      }
      expect(element.value.length).toBeLessThanOrEqual(2000);
    }
  });

  it('includes a provenance footer and feedback buttons', () => {
    const blocks = buildSummaryActionButtons({
      sourceChannelId: 'C42',
      messageCount: 100,
      coverage: { messageCount: 100, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' },
      currentStyle: null,
      deliveredAtMs: 1_700_000_000_000,
    });
    const context = blocks.find((b) => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(context.elements[0].text).toContain('AI-generated');
    expect(context.elements[0].text).toContain('<#C42>');
    expect(context.elements[0].text).toContain('<!date^1700000000^{time}|');
    expect(context.elements[0].text).not.toContain('Get latest');

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
    const blocks = buildSummaryActionButtons(delivery);
    expect(JSON.parse(shareButton(blocks).value ?? '{}').count).toBe(3);
    const roast = actionElements(blocks).find((element) => element.action_id === 'rerun_roast');
    expect(JSON.parse(roast?.value ?? '{}').count).toBe(25);
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


describe('saved-window action group', () => {
  const original = { oldestTs: '1788825600.000001', latestTs: '1788827400.000002' };
  const input = {
    sourceChannelId: 'C012345678', sourceChannelName: 'testing-bots', messageCount: 5,
    currentStyle: null, window: original,
    coverage: { messageCount: 4, oldestTs: '1788826000.000001', latestTs: original.latestTs },
  };
  it('labels the source destination and preserves the original span after a deletion', () => {
    const actions = buildSummaryActionButtons(input)[0] as ActionsBlock;
    const short = JSON.parse(actions.elements.find((element) => element.action_id === 'rerun_shorter')?.value ?? '{}');
    expect(short).toMatchObject({ v: 2, channelId: input.sourceChannelId, count: 5, window: original });
    const blocks = JSON.stringify(buildSummaryActionButtons(input));
    expect(blocks).toContain('Share to #testing-bots');
    expect(blocks).toContain('same channel and time window');
  });
  it('keeps one-off custom instructions out of both metadata and action values', () => {
    const style = 'Keep the jokes gentle. '.repeat(150);
    const blocks = buildSummaryActionButtons({ ...input, currentStyle: style });
    for (const element of actionElements(blocks)) {
      const value = element.value ?? '';
      expect(value.length).toBeLessThanOrEqual(2000);
      expect(value).not.toContain('Keep the jokes gentle');
      expect(element.confirm?.text.text ?? '').not.toContain('Keep the jokes gentle');
    }
    const metadata = buildSummaryMetadata({ ...input, currentStyle: style });
    expect(metadata.event_payload).not.toHaveProperty('custom_style');
    expect(JSON.stringify(metadata)).not.toContain('Keep the jokes gentle');
    expect(metadata.event_payload.style_key).toBe('custom');
  });
  it('marks every saved-window control so a private recap cannot reply in the channel', () => {
    const blocks = buildSummaryActionButtons({ ...input, privateReply: true });
    const serialized = JSON.stringify(actionElements(blocks));
    expect(serialized).toContain('\\"e\\":1');
    expect(serialized.match(/\\"e\\":1/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('does not offer transformations without saved bounds', () => {
    expect(actionIds(buildSummaryActionButtons({ sourceChannelId: input.sourceChannelId, messageCount: 5, currentStyle: null }))).toEqual(['summary_whats_new', 'summary_latest', 'share_summary']);
  });

  it('puts a short preview in the share confirmation and stays within 300 characters', () => {
    const preview = 'Alice moved the picnic. '.repeat(40);
    const blocks = buildSummaryActionButtons({ ...input, sharePreview: preview });
    const confirm = shareButton(blocks).confirm?.text.text ?? '';
    expect(confirm.length).toBeLessThanOrEqual(300);
    expect(confirm).toContain('<#C012345678>');
    expect(confirm).toContain('Alice moved the picnic');
    expect(buildShareConfirmText('C012345678', '<@U123> <!channel> **bold** [note](https://example.com)')).not.toContain('<@');
    expect(buildShareConfirmText('C012345678', '<@U123> <!channel> **bold** [note](https://example.com)')).not.toContain('**');
    const withSources = buildShareConfirmText(
      'C012345678',
      'A concise recap.\n\n**Sources**\n- [Alice: Alice moved the picnic to Friday.](https://slack.example/p)',
    );
    expect(withSources).toContain('A concise recap');
    expect(withSources).not.toContain('picnic');
  });
});
