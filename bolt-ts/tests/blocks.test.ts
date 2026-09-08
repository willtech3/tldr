/**
 * Tests for Block Kit builders.
 */

import {
  buildWelcomeBlocks,
  buildHelpBlocks,
  buildStyleModal,
  buildStyleConfirmationBlocks,
  buildChatFailureBlocks,
  CHAT_FAILURE_TEXT,
  buildFailureBlocks,
  buildRetryValue,
  ACTION_OPEN_STYLE_MODAL,
  ACTION_QUICK_SUMMARIZE,
  ACTION_SHOW_HELP,
  ACTION_RETRY_SUMMARY,
  MODAL_CALLBACK_SET_STYLE,
  INPUT_BLOCK_STYLE,
  INPUT_ACTION_STYLE,
} from '../src/blocks';

function findButton(blocks: ReturnType<typeof buildWelcomeBlocks>, actionId: string) {
  for (const block of blocks) {
    if (block.type === 'section' && block.accessory?.type === 'button' && block.accessory.action_id === actionId) {
      return block.accessory;
    }
    if (block.type !== 'actions') {
      continue;
    }
    const button = block.elements.find(
      (e) => e.type === 'button' && 'action_id' in e && e.action_id === actionId
    );
    if (button) {
      return button;
    }
  }
  return undefined;
}

describe('Block Kit builders', () => {
  describe('buildWelcomeBlocks', () => {
    it('should return an array of blocks', () => {
      const blocks = buildWelcomeBlocks();
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('should include a section block with welcome text', () => {
      const blocks = buildWelcomeBlocks();
      const section = blocks.find((b) => b.type === 'section');
      expect(section).toBeDefined();
      expect(section?.type).toBe('section');
    });

    it('should include Set style button', () => {
      const blocks = buildWelcomeBlocks();
      const actions = blocks.find((b) => b.type === 'actions');
      expect(actions).toBeDefined();
      if (actions?.type === 'actions') {
        const button = actions.elements.find(
          (e) => e.type === 'button' && e.action_id === ACTION_OPEN_STYLE_MODAL
        );
        expect(button).toBeDefined();
      }
    });

    it('shows a persistent source picker, even when Slack supplies no context', () => {
      const blocks = buildWelcomeBlocks();
      const source = blocks.find((b) => b.type === 'section' && b.accessory?.type === 'conversations_select');
      expect(source).toMatchObject({
        accessory: { action_id: 'select_source', filter: { include: ['public', 'private'] } },
      });
      expect(JSON.stringify(blocks)).toContain('Source');
      expect(JSON.stringify(blocks)).not.toContain('Viewing');
      expect(findButton(blocks, ACTION_QUICK_SUMMARIZE)).toBeUndefined();
    });

    it('puts the selected source beside its primary action and does not expose raw style text', () => {
      const blocks = buildWelcomeBlocks('C012345678', 'a'.repeat(4000), 5);
      expect(blocks).toContainEqual(expect.objectContaining({
        type: 'section', text: { type: 'mrkdwn', text: 'Catch up on <#C012345678>' },
        accessory: expect.objectContaining({ action_id: ACTION_QUICK_SUMMARIZE, style: 'primary' }),
      }));
      expect(JSON.stringify(blocks)).toContain('Custom');
      expect(JSON.stringify(blocks)).not.toContain('a'.repeat(100));
      expect(JSON.stringify(blocks)).toContain('initial_conversation');
    });
  });

  describe('buildHelpBlocks', () => {
    it('should return an array of blocks', () => {
      const blocks = buildHelpBlocks();
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('should include a header block', () => {
      const blocks = buildHelpBlocks();
      const header = blocks.find((b) => b.type === 'header');
      expect(header).toBeDefined();
    });

    it('should include multiple section blocks', () => {
      const blocks = buildHelpBlocks();
      const sections = blocks.filter((b) => b.type === 'section');
      expect(sections.length).toBeGreaterThan(1);
    });
  });

  describe('buildStyleModal', () => {
    const metadata = { assistantChannelId: 'D12345678', assistantThreadTs: '1700000000.000100' };

    it('returns the registered modal with editable custom style and compact metadata', () => {
      const modal = buildStyleModal('be funny', metadata);
      expect(modal.type).toBe('modal');
      expect(modal.callback_id).toBe(MODAL_CALLBACK_SET_STYLE);
      const input = modal.blocks.find((block) => block.type === 'input' && block.block_id === INPUT_BLOCK_STYLE);
      expect(input).toMatchObject({
        element: { type: 'plain_text_input', action_id: INPUT_ACTION_STYLE, initial_value: 'be funny', max_length: 3000 },
      });
      expect(JSON.parse(modal.private_metadata ?? '{}')).toEqual({
        ...metadata, originalStyleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(modal.private_metadata).not.toContain('be funny');
    });

    it.each([null, 'x'.repeat(3000), '"'.repeat(3000), '😀'.repeat(1500), 'x'.repeat(4000)])(
      'keeps every style modal within Slack input and metadata limits', (style) => {
        const modal = buildStyleModal(style, metadata);
        expect((modal.private_metadata ?? '').length).toBeLessThanOrEqual(3000);
        const input = modal.blocks.find((block) => block.type === 'input' && block.block_id === INPUT_BLOCK_STYLE);
        expect(input).toMatchObject({ element: { max_length: 3000 } });
        if (input?.type !== 'input' || !('element' in input) || input.element.type !== 'plain_text_input') {
          throw new Error('Missing style text editor');
        }
        expect((input.element.initial_value ?? '').length).toBeLessThanOrEqual(3000);
      }
    );

    it('explains long saved styles and never silently truncates their prefill', () => {
      const modal = buildStyleModal('x'.repeat(4000), metadata);
      const input = modal.blocks.find((block) => block.type === 'input' && block.block_id === INPUT_BLOCK_STYLE);
      if (input?.type !== 'input' || !('element' in input) || input.element.type !== 'plain_text_input') {
        throw new Error('Missing style text editor');
      }
      expect(input.element.initial_value).toBeUndefined();
      expect(JSON.parse(modal.private_metadata ?? '{}')).toMatchObject({ hasLongSavedStyle: true });
      expect(JSON.stringify(modal.blocks)).toContain('stays active');
    });

    it('keeps every preset option within Slack limits and offers a reset', () => {
      const modal = buildStyleModal(null, metadata);
      const preset = modal.blocks.find((block) => block.type === 'input' && block.block_id === 'style_preset_block');
      if (preset?.type !== 'input' || !('element' in preset) || preset.element.type !== 'static_select') {
        throw new Error('Missing style preset selector');
      }
      for (const option of preset.element.options ?? []) {
        expect(option.value!.length).toBeLessThanOrEqual(150);
        expect(option.text.text.length).toBeLessThanOrEqual(75);
      }
      expect(preset.element.options?.[0].value).toBe('__default__');
    });
  });

  describe('buildStyleConfirmationBlocks', () => {
    it('confirms the active style and explicitly scopes it to this thread', () => {
      const blocks = buildStyleConfirmationBlocks('be funny');
      expect(JSON.stringify(blocks)).toContain('Style saved for this thread');
      expect(JSON.stringify(blocks)).toContain('Active style: Custom');
      expect(JSON.stringify(blocks)).not.toContain('be funny');
    });

    it('confirms the default when a saved style is reset', () => {
      expect(JSON.stringify(buildStyleConfirmationBlocks(null))).toContain('Default style saved for this thread');
    });

    it('never repeats raw instructions or Slack mention syntax in the confirmation', () => {
      const blocks = buildStyleConfirmationBlocks('<!channel> <@U12345678> ' + '😀'.repeat(120));
      expect(JSON.stringify(blocks)).toContain('Active style: Custom');
      expect(JSON.stringify(blocks)).not.toContain('<!channel>');
      expect(JSON.stringify(blocks)).not.toContain('<@U12345678>');
      expect(JSON.stringify(blocks)).not.toContain('😀');
    });
  });

  describe('quick summarize affordances', () => {
    it('welcome blocks should include a primary Summarize now button', () => {
      const button = findButton(buildWelcomeBlocks('C012345678'), ACTION_QUICK_SUMMARIZE);
      expect(button).toBeDefined();
      if (button?.type === 'button') {
        expect(button.style).toBe('primary');
      }
    });

    it('style confirmation should include a try-it-now button', () => {
      expect(findButton(buildStyleConfirmationBlocks('be funny'), ACTION_QUICK_SUMMARIZE)).toBeDefined();
      expect(findButton(buildStyleConfirmationBlocks(null), ACTION_QUICK_SUMMARIZE)).toBeDefined();
    });
  });

  describe('buildChatFailureBlocks', () => {
    it('should show the failure copy, not "I didn\'t catch that"', () => {
      const blocks = buildChatFailureBlocks('C12345');
      const section = blocks.find((b) => b.type === 'section');
      if (section?.type === 'section' && section.text?.type === 'mrkdwn') {
        expect(section.text.text).toContain(CHAT_FAILURE_TEXT);
        expect(section.text.text).toContain('<#C12345>');
        expect(section.text.text).not.toContain("didn't catch that");
      } else {
        throw new Error('expected mrkdwn section');
      }
    });

    it('should offer summarize and help buttons', () => {
      const blocks = buildChatFailureBlocks(null);
      expect(findButton(blocks, ACTION_QUICK_SUMMARIZE)).toBeDefined();
      expect(findButton(blocks, ACTION_SHOW_HELP)).toBeDefined();
    });
  });

  describe('buildFailureBlocks', () => {
    it('should carry the original request in the retry button value', () => {
      const blocks = buildFailureBlocks(buildRetryValue('C999', 75, 'roast'));
      const button = findButton(blocks, ACTION_RETRY_SUMMARY);
      expect(button).toBeDefined();
      if (button?.type === 'button') {
        expect(JSON.parse(button.value ?? '{}')).toEqual({
          channelId: 'C999',
          count: 75,
          style: 'roast',
        });
      }
    });

    it('falls back to thread style when the style is too long for a button value', () => {
      const longStyle = 'x'.repeat(4000);
      const value = buildRetryValue('C999', 75, longStyle);
      expect(value).toEqual({ channelId: 'C999', count: 75, style: null, useThreadStyle: true });
      expect(JSON.stringify(value).length).toBeLessThanOrEqual(2000);
    });
  });

});
