import { buildSummaryActionButtons } from '../../src/worker/deliver';

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

  it('embeds count and source channel in Share value payload', () => {
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
      style: 'be funny',
    });
  });
});
