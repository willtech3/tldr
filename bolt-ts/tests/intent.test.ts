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

    it('should not treat "helpful" as help', () => {
      const result = parseUserIntent('be helpful');
      expect(result).toEqual({ type: 'unknown' });
    });

    it('should prefer summarize over help when both appear', () => {
      const result = parseUserIntent('help me summarize this channel');
      expect(result).toMatchObject({ type: 'summarize' });
    });

    it('should recognize bare "help me"', () => {
      const result = parseUserIntent('help me');
      expect(result).toEqual({ type: 'help' });
    });

    it('should answer capability questions addressed by name', () => {
      const result = parseUserIntent('tldr what can you do');
      expect(result).toEqual({ type: 'help' });
    });

    it.each([
      'help me write an email to my team',
      'can you help me brainstorm names for a project?',
      'what can I cook tonight',
    ])('should leave %j to general chat, not the manual', (phrase) => {
      const result = parseUserIntent(phrase);
      expect(result).toEqual({ type: 'unknown' });
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

    it('should keep style intent when instructions mention help', () => {
      const result = parseUserIntent('style: write helpful, friendly summaries');
      expect(result).toEqual({
        type: 'style',
        instructions: 'write helpful, friendly summaries',
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
        postHere: false,
        styleOverride: null,
      });
    });

    it('should parse "summarize last 50"', () => {
      const result = parseUserIntent('summarize last 50');
      expect(result).toEqual({
        type: 'summarize',
        count: 50,
        targetChannel: null,
        postHere: false,
        styleOverride: null,
      });
    });

    it('should parse "last 100" without summarize keyword', () => {
      const result = parseUserIntent('last 100');
      expect(result).toEqual({
        type: 'summarize',
        count: 100,
        targetChannel: null,
        postHere: false,
        styleOverride: null,
      });
    });

    it('should extract channel mention', () => {
      const result = parseUserIntent('summarize <#C123ABC|general>');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: 'C123ABC',
        postHere: false,
        styleOverride: null,
      });
    });

    it('should extract bare channel mention without a name', () => {
      const result = parseUserIntent('summarize <#C123ABC>');
      expect(result).toMatchObject({ type: 'summarize', targetChannel: 'C123ABC' });
    });

    it('should extract channel mention with empty name segment', () => {
      const result = parseUserIntent('summarize <#C123ABC|>');
      expect(result).toMatchObject({ type: 'summarize', targetChannel: 'C123ABC' });
    });

    it.each(['summarise last 20', 'tldr', 'tl;dr', 'recap', 'catch me up', 'fill me in', 'what did I miss?', 'what happened here', 'give me a summary'])(
      'should treat %j as a summarize request',
      (phrase) => {
        const result = parseUserIntent(phrase);
        expect(result).toMatchObject({ type: 'summarize' });
      }
    );

    it.each([
      'TLDR?',
      'tldr please',
      'tldr last 50 messages please',
      'tldr post here',
    ])('should treat the bare command %j as summarize', (phrase) => {
      const result = parseUserIntent(phrase);
      expect(result).toMatchObject({ type: 'summarize' });
    });

    it('should parse channel and count given to the tldr command', () => {
      const result = parseUserIntent('tldr <#C123ABC|general> last 50');
      expect(result).toMatchObject({ type: 'summarize', targetChannel: 'C123ABC', count: 50 });
    });

    it('should parse a style override given to the tldr command', () => {
      const result = parseUserIntent('tldr with style: be funny');
      expect(result).toMatchObject({ type: 'summarize', styleOverride: 'be funny' });
    });

    it('should parse count alongside natural phrasing', () => {
      const result = parseUserIntent('catch me up on the last 200');
      expect(result).toMatchObject({ type: 'summarize', count: 200 });
    });

    it('should recognize "post here" flag', () => {
      const result = parseUserIntent('summarize post here');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: true,
        styleOverride: null,
      });
    });

    it('should recognize "public" flag', () => {
      const result = parseUserIntent('summarize public');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: true,
        styleOverride: null,
      });
    });

    it('should parse complex command with all options', () => {
      const result = parseUserIntent('summarize last 25 <#C789XYZ|random> public');
      expect(result).toEqual({
        type: 'summarize',
        count: 25,
        targetChannel: 'C789XYZ',
        postHere: true,
        styleOverride: null,
      });
    });

    it('should parse per-run style override', () => {
      const result = parseUserIntent('summarize with style: be funny');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: false,
        styleOverride: 'be funny',
      });
    });

    it('should parse per-run style override with count', () => {
      const result = parseUserIntent('summarize last 50 with style: write as haiku');
      expect(result).toEqual({
        type: 'summarize',
        count: 50,
        targetChannel: null,
        postHere: false,
        styleOverride: 'write as haiku',
      });
    });

    it('should parse per-run style override with extra whitespace', () => {
      const result = parseUserIntent('summarize with style:   extremely concise  ');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: false,
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

  describe('open-ended chat from the jump', () => {
    // "tldr" is the app's name — addressing it must start a conversation,
    // not hijack the message into a summarize (which dead-ends with
    // "I don't know which channel you're viewing yet" on a fresh thread).
    it.each([
      'hey tldr',
      'hi tldr!',
      'hey tldr, can you write a haiku about standups?',
      'tldr do you know any good lunch spots?',
    ])('should treat %j as general chat', (phrase) => {
      const result = parseUserIntent(phrase);
      expect(result).toEqual({ type: 'unknown' });
    });

    it('should not treat a conversational "last N" as a summarize command', () => {
      const result = parseUserIntent('I read 3 books in the last 2 weeks, recommend a 4th?');
      expect(result).toEqual({ type: 'unknown' });
    });

    it('should still summarize when an addressed message asks for it', () => {
      const result = parseUserIntent('hey tldr, catch me up');
      expect(result).toMatchObject({ type: 'summarize' });
    });
  });
});
