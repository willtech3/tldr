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
  });

  describe('customize intent', () => {
    it('should recognize "customize" command', () => {
      const result = parseUserIntent('customize');
      expect(result).toEqual({ type: 'customize' });
    });

    it('should recognize "configure" command', () => {
      const result = parseUserIntent('configure');
      expect(result).toEqual({ type: 'customize' });
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
      });
    });

    it('should parse "summarize last 50"', () => {
      const result = parseUserIntent('summarize last 50');
      expect(result).toEqual({
        type: 'summarize',
        count: 50,
        targetChannel: null,
        postHere: false,
      });
    });

    it('should parse "last 100" without summarize keyword', () => {
      const result = parseUserIntent('last 100');
      expect(result).toEqual({
        type: 'summarize',
        count: 100,
        targetChannel: null,
        postHere: false,
      });
    });

    it('should extract channel mention', () => {
      const result = parseUserIntent('summarize <#C123ABC|general>');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: 'C123ABC',
        postHere: false,
      });
    });

    it('should recognize "post here" flag', () => {
      const result = parseUserIntent('summarize post here');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: true,
      });
    });

    it('should recognize "public" flag', () => {
      const result = parseUserIntent('summarize public');
      expect(result).toEqual({
        type: 'summarize',
        count: null,
        targetChannel: null,
        postHere: true,
      });
    });

    it('should parse complex command with all options', () => {
      const result = parseUserIntent('summarize last 25 <#C789XYZ|random> public');
      expect(result).toEqual({
        type: 'summarize',
        count: 25,
        targetChannel: 'C789XYZ',
        postHere: true,
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
