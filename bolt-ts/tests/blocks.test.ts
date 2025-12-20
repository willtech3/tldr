/**
 * Tests for Block Kit builders.
 */

import {
  buildWelcomeBlocks,
  buildHelpBlocks,
  buildStyleModal,
  buildStyleConfirmationBlocks,
  ACTION_OPEN_STYLE_MODAL,
  MODAL_CALLBACK_SET_STYLE,
  INPUT_BLOCK_STYLE,
  INPUT_ACTION_STYLE,
} from '../src/blocks';

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
      const blocks = buildWelcomeBlocks('be funny');
      const context = blocks.find(
        (b) => b.type === 'context' && 'elements' in b && b.elements.some((e) => 'text' in e && typeof e.text === 'string' && e.text.includes('Active style'))
      );
      expect(context).toBeDefined();
    });

    it('should truncate long styles', () => {
      const longStyle = 'a'.repeat(150);
      const blocks = buildWelcomeBlocks(longStyle);
      const context = blocks.find((b) => b.type === 'context');
      expect(context).toBeDefined();
      if (context?.type === 'context') {
        const textElement = context.elements.find((e) => 'text' in e);
        if (textElement && 'text' in textElement) {
          expect(textElement.text).toContain('...');
          expect(textElement.text.length).toBeLessThan(150);
        }
      }
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

    it('should store private metadata as JSON', () => {
      const metadata = {
        assistantChannelId: 'D123',
        assistantThreadTs: '1700000000.000100',
      };
      const modal = buildStyleModal(null, metadata);
      expect(modal.private_metadata).toBe(JSON.stringify(metadata));
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
  });

  // Note: No channel picker blocks in AI App V1. Context is tracked via
  // `assistant_thread_context_changed` and stored in message metadata.
});
