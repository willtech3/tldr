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

    it('should not include active style context when no style set', () => {
      const blocks = buildWelcomeBlocks();
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Active style'))
      );
      expect(context).toBeUndefined();
    });

    it('should include active style context when style is set', () => {
      const blocks = buildWelcomeBlocks(null, 'be funny');
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Active style'))
      );
      expect(context).toBeDefined();
    });

    it('should truncate long styles', () => {
      const longStyle = 'a'.repeat(150);
      const blocks = buildWelcomeBlocks(null, longStyle);
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Active style'))
      );
      expect(context).toBeDefined();
      if (context?.type === 'context') {
        const textElement = context.elements.find((e) => 'text' in e);
        if (textElement && 'text' in textElement) {
          expect(textElement.text).toContain('...');
          expect(textElement.text.length).toBeLessThan(150);
        }
      }
    });

    it('should include viewing channel context when viewingChannelId is set', () => {
      const blocks = buildWelcomeBlocks('C12345');
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Viewing'))
      );
      expect(context).toBeDefined();
      if (context?.type === 'context') {
        const textElement = context.elements.find((e) => 'text' in e);
        if (textElement && 'text' in textElement) {
          expect(textElement.text).toContain('<#C12345>');
        }
      }
    });

    it('should not include viewing channel context when viewingChannelId is null', () => {
      const blocks = buildWelcomeBlocks(null);
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Viewing'))
      );
      expect(context).toBeUndefined();
    });

    it('should include both viewing channel and active style when both are set', () => {
      const blocks = buildWelcomeBlocks('C12345', 'be funny');
      const viewingContext = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Viewing'))
      );
      const styleContext = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Active style'))
      );
      expect(viewingContext).toBeDefined();
      expect(styleContext).toBeDefined();
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
    it('should return a modal view', () => {
      const modal = buildStyleModal(null, {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      });
      expect(modal.type).toBe('modal');
      expect(modal.callback_id).toBe(MODAL_CALLBACK_SET_STYLE);
    });

    it('should include input block with correct IDs', () => {
      const modal = buildStyleModal(null, {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      });
      const inputBlock = modal.blocks.find(
        (b) => b.type === 'input' && 'block_id' in b && b.block_id === INPUT_BLOCK_STYLE
      );
      expect(inputBlock).toBeDefined();
      if (inputBlock?.type === 'input' && 'element' in inputBlock) {
        expect(inputBlock.element.action_id).toBe(INPUT_ACTION_STYLE);
      }
    });

    it('should pre-fill current style when provided', () => {
      const modal = buildStyleModal('be funny', {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      });
      const inputBlock = modal.blocks.find((b) => b.type === 'input');
      if (inputBlock?.type === 'input' && 'element' in inputBlock && inputBlock.element.type === 'plain_text_input') {
        expect(inputBlock.element.initial_value).toBe('be funny');
      }
    });

    it('should store private metadata as JSON including the prefill text', () => {
      const metadata = {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      };
      const modal = buildStyleModal('be funny', metadata);
      expect(JSON.parse(modal.private_metadata ?? '{}')).toEqual({
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
        originalStyle: 'be funny',
      });
    });

    it('keeps every preset option value within Slack limits', () => {
      const modal = buildStyleModal(null, {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      });
      const presetBlock = modal.blocks.find(
        (b) => b.type === 'input' && 'block_id' in b && b.block_id === 'style_preset_block'
      ) as unknown as {
        element: { type: string; options?: Array<{ value?: string; text: { text: string } }> };
      };
      expect(presetBlock.element.type).toBe('static_select');
      for (const option of presetBlock.element.options ?? []) {
        expect(option.value!.length).toBeLessThanOrEqual(150);
        expect(option.text.text.length).toBeLessThanOrEqual(75);
      }
      // Includes the "default" sentinel for clearing a saved preset.
      expect(presetBlock.element.options?.[0].value).toBe('__default__');
    });
  });

  describe('buildStyleConfirmationBlocks', () => {
    it('should return confirmation for set style', () => {
      const blocks = buildStyleConfirmationBlocks('be funny');
      expect(blocks.length).toBeGreaterThan(0);
      const section = blocks.find((b) => b.type === 'section');
      expect(section).toBeDefined();
      if (section?.type === 'section' && section.text && section.text.type === 'mrkdwn') {
        expect(section.text.text).toContain('Style saved');
      }
    });

    it('should include context with active style', () => {
      const blocks = buildStyleConfirmationBlocks('be funny');
      const context = blocks.find((b) => b.type === 'context');
      expect(context).toBeDefined();
      if (context?.type === 'context') {
        const textElement = context.elements.find((e) => 'text' in e);
        if (textElement && 'text' in textElement) {
          expect(textElement.text).toContain('be funny');
        }
      }
    });

    it('should return cleared message when style is null', () => {
      const blocks = buildStyleConfirmationBlocks(null);
      expect(blocks.length).toBeGreaterThan(0);
      const section = blocks.find((b) => b.type === 'section');
      expect(section).toBeDefined();
      if (section?.type === 'section' && section.text && section.text.type === 'mrkdwn') {
        expect(section.text.text).toContain('Style cleared');
      }
    });

    it('truncates a long style by code point without splitting an emoji', () => {
      const longEmoji = '😀'.repeat(120);
      const blocks = buildStyleConfirmationBlocks(longEmoji);
      const context = blocks.find((b) => b.type === 'context');
      expect(context).toBeDefined();
      if (context?.type === 'context') {
        const textElement = context.elements.find((e) => 'text' in e);
        expect(textElement).toBeDefined();
        if (textElement && 'text' in textElement) {
          const styleSegment = textElement.text.split('Active style: ')[1];
          // 97 emoji + "..." == 100 code points, with no lone surrogate halves.
          expect([...styleSegment].length).toBe(100);
          expect(styleSegment.endsWith('...')).toBe(true);
          expect(styleSegment.startsWith('😀')).toBe(true);
        }
      }
    });
  });

  describe('quick summarize affordances', () => {
    it('welcome blocks should include a primary Summarize now button', () => {
      const button = findButton(buildWelcomeBlocks(), ACTION_QUICK_SUMMARIZE);
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

  // Note: No channel picker blocks in AI App V1. Context is tracked via
  // `assistant_thread_context_changed` and stored in message metadata.
});
