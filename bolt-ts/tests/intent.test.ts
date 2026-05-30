/**
 * Tests for intent parsing.
 */

import { parseUserIntent } from '../src/intent';

describe('parseUserIntent', () => {
  describe('help intent', () => {
    it('should recognize "help" command', () => {
      const result = parseUserIntent('help');
      expect(result).toEqual({ type: 'help' });
    });

    it('should recognize "Help" with different case', () => {
      const result = parseUserIntent('Help');
      expect(result).toEqual({ type: 'help' });
    });

    it('should recognize "?" as help', () => {
      const result = parseUserIntent('?');
      expect(result).toEqual({ type: 'help' });
    });

    it('should recognize "what can you do"', () => {
      const result = parseUserIntent('what can you do');
      expect(result).toEqual({ type: 'help' });
    });

    it('should match "help" as a whole word inside a sentence', () => {
      expect(parseUserIntent('I need help')).toEqual({ type: 'help' });
    });

    it('should NOT treat "helpful" as a help request', () => {
      // Whole-word matching: "helpful" must not trigger the help intent.
      expect(parseUserIntent('that was helpful')).toEqual({ type: 'unknown' });
    });
  });

  describe('style intent', () => {
    it('should recognize "style: ..." command', () => {
      const result = parseUserIntent('style: write as a haiku');
      expect(result).toEqual({ type: 'style', instructions: 'write as a haiku' });
    });

    it('should handle extra whitespace', () => {
      const result = parseUserIntent('  style :   extremely concise   ');
      expect(result).toEqual({ type: 'style', instructions: 'extremely concise' });
    });

    it('should treat "style:" with no instructions as help', () => {
      const result = parseUserIntent('style:   ');
      expect(result).toEqual({ type: 'help' });
    });

    it('should keep a style command even when the instructions contain "help"', () => {
      // Regression: "help" substring must not steal an explicit style command.
      const result = parseUserIntent('style: be more helpful and explain decisions');
      expect(result).toEqual({
        type: 'style',
        instructions: 'be more helpful and explain decisions',
      });
    });
  });

  describe('clear_style intent', () => {
    it('should recognize "clear style" command', () => {
      const result = parseUserIntent('clear style');
      expect(result).toEqual({ type: 'clear_style' });
    });

    it('should recognize "reset style" command', () => {
      const result = parseUserIntent('reset style');
      expect(result).toEqual({ type: 'clear_style' });
    });

    it('should recognize "remove style" command', () => {
      const result = parseUserIntent('remove style');
      expect(result).toEqual({ type: 'clear_style' });
    });

    it('should handle case insensitively', () => {
      const result = parseUserIntent('CLEAR STYLE');
      expect(result).toEqual({ type: 'clear_style' });
    });

    it('should handle whitespace', () => {
      const result = parseUserIntent('  clear   style  ');
      expect(result).toEqual({ type: 'clear_style' });
    });
  });

  describe('summarize intent', () => {
    it('should recognize "summarize" command', () => {
      const result = parseUserIntent('summarize');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        styleOverride: null,
      });
    });

    it('should parse "summarize last 50"', () => {
      const result = parseUserIntent('summarize last 50');
      expect(result).toEqual({
        type: 'summarize',
        count: 50,
        targetChannel: null,
        styleOverride: null,
      });
    });

    it('should parse "last 100" without summarize keyword', () => {
      const result = parseUserIntent('last 100');
      expect(result).toEqual({
        type: 'summarize',
        count: 100,
        targetChannel: null,
        styleOverride: null,
      });
    });

    it('should extract channel mention', () => {
      const result = parseUserIntent('summarize <#C123ABC|general>');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: 'C123ABC',
        styleOverride: null,
      });
    });

    it('should summarize a channel whose name contains "help"', () => {
      // Regression: the help matcher must not pre-empt an explicit summarize.
      const result = parseUserIntent('summarize <#C99HELP|help-desk>');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: 'C99HELP',
        styleOverride: null,
      });
    });

    it('should still summarize when the sentence mentions help in passing', () => {
      const result = parseUserIntent('summarize last 100 when you can, would really help');
      expect(result).toEqual({
        type: 'summarize',
        count: 100,
        targetChannel: null,
        styleOverride: null,
      });
    });

    it('should parse complex command with count and channel', () => {
      const result = parseUserIntent('summarize last 25 <#C789XYZ|random>');
      expect(result).toEqual({
        type: 'summarize',
        count: 25,
        targetChannel: 'C789XYZ',
        styleOverride: null,
      });
    });

    it('should parse per-run style override', () => {
      const result = parseUserIntent('summarize with style: be funny');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        styleOverride: 'be funny',
      });
    });

    it('should parse per-run style override with count', () => {
      const result = parseUserIntent('summarize last 50 with style: write as haiku');
      expect(result).toEqual({
        type: 'summarize',
        count: 50,
        targetChannel: null,
        styleOverride: 'write as haiku',
      });
    });

    it('should parse per-run style override with extra whitespace', () => {
      const result = parseUserIntent('summarize with style:   extremely concise  ');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        styleOverride: 'extremely concise',
      });
    });
  });

  describe('unknown intent', () => {
    it('should return unknown for unrecognized text', () => {
      const result = parseUserIntent('hello there');
      expect(result).toEqual({ type: 'unknown' });
    });

    it('should return unknown for empty string', () => {
      const result = parseUserIntent('');
      expect(result).toEqual({ type: 'unknown' });
    });
  });
});
