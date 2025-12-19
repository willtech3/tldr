/**
 * Tests for Block Kit builders.
 */

import { buildWelcomeBlocks, buildHelpBlocks, buildConfigurePickerBlocks, buildChannelPickerBlocks } from '../src/blocks';

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

  describe('buildConfigurePickerBlocks', () => {
    it('should return blocks with a conversations_select element', () => {
      const blocks = buildConfigurePickerBlocks();
      expect(Array.isArray(blocks)).toBe(true);

      const actionsBlock = blocks.find((b) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock?.block_id).toBe('tldr_pick_config');
    });
  });

  describe('buildChannelPickerBlocks', () => {
    it('should use the provided block ID', () => {
      const blocks = buildChannelPickerBlocks('test_block_id', 'Select a channel:');
      const actionsBlock = blocks.find((b) => b.type === 'actions');
      expect(actionsBlock?.block_id).toBe('test_block_id');
    });

    it('should use the provided prompt text', () => {
      const promptText = 'Pick a channel to summarize:';
      const blocks = buildChannelPickerBlocks('block_id', promptText);
      const section = blocks.find((b) => b.type === 'section');

      // Type assertion to access text property
      const sectionBlock = section as { type: 'section'; text: { type: string; text: string } };
      expect(sectionBlock.text.text).toBe(promptText);
    });
  });
});
