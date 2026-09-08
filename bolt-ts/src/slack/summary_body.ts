/**
 * Recover only the displayed recap. Slack's streamed message `text` can be an
 * accessibility transcript containing button labels and footer copy, so it is
 * never a fallback when structured blocks are present.
 */
type SlackNode = Record<string, unknown>;
interface SummaryMessage { text?: string; blocks?: unknown[] }

const FOOTER_TYPES = new Set(['actions', 'context', 'context_actions']);
const MAX_BODY_LENGTH = 40_000;

function node(value: unknown): SlackNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as SlackNode : null;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]~<>]/g, '\\$&');
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function link(label: string, url: string): string {
  // Preserve destinations, while preventing source labels/URLs from escaping
  // their Markdown syntax. Unrecognized schemes remain plain visible text.
  if (!/^(?:https?:\/\/|mailto:|slack:\/\/)/i.test(url)) {
    return escapeMarkdown(label);
  }
  // eslint-disable-next-line no-control-regex
  const destination = url.replace(/[\s\\()<>\u0000-\u001f\u007f]/g,
    (char) => encodeURIComponent(char).replace(/[()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`));
  return `[${escapeMarkdown(label)}](${destination})`;
}

function styled(text: string, rawStyle: unknown): string {
  const style = node(rawStyle);
  let result = text;
  if (style?.strike === true) { result = `~~${result}~~`; }
  if (style?.italic === true) { result = `_${result}_`; }
  if (style?.bold === true) { result = `**${result}**`; }
  return result;
}

function renderInline(raw: unknown, preformatted = false): string | null {
  const value = node(raw);
  if (!value) { return null; }
  let text: string;
  switch (value.type) {
    case 'text':
      if (typeof value.text !== 'string') { return null; }
      if (preformatted) { return value.text; }
      return node(value.style)?.code === true ? codeSpan(value.text) : styled(escapeMarkdown(value.text), value.style);
    case 'link':
      if (typeof value.url !== 'string' || (value.text !== undefined && typeof value.text !== 'string')) { return null; }
      text = preformatted ? String(value.text ?? value.url) : link(String(value.text ?? value.url), value.url);
      break;
    case 'user':
      if (typeof value.user_id !== 'string' || !/^[UW][A-Z0-9]+$/.test(value.user_id)) { return null; }
      text = `<@${value.user_id}>`;
      break;
    case 'channel':
      if (typeof value.channel_id !== 'string' || !/^[CG][A-Z0-9]+$/.test(value.channel_id)) { return null; }
      text = `<#${value.channel_id}>`;
      break;
    case 'usergroup':
      if (typeof value.usergroup_id !== 'string' || !/^S[A-Z0-9]+$/.test(value.usergroup_id)) { return null; }
      text = `<!subteam^${value.usergroup_id}>`;
      break;
    case 'broadcast':
      if (typeof value.range !== 'string' || !['here', 'channel', 'everyone'].includes(value.range)) { return null; }
      text = `<!${value.range}>`;
      break;
    case 'emoji': {
      if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_+-]+$/.test(value.name)) { return null; }
      const points = typeof value.unicode === 'string' && /^[a-fA-F0-9]+(?:-[a-fA-F0-9]+)*$/.test(value.unicode)
        ? value.unicode.split('-').map((part) => Number.parseInt(part, 16)) : [];
      text = points.length > 0 && points.every((point) => point <= 0x10ffff)
        ? String.fromCodePoint(...points) : `:${value.name}:`;
      break;
    }
    case 'date': {
      const fallback = typeof value.fallback === 'string' ? value.fallback :
        typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) && Math.abs(value.timestamp) <= 8.64e12
          ? new Date(value.timestamp * 1000).toISOString() : null;
      if (fallback === null) { return null; }
      text = typeof value.url === 'string' ? link(fallback, value.url) : escapeMarkdown(fallback);
      break;
    }
    case 'color':
      if (typeof value.value !== 'string') { return null; }
      text = escapeMarkdown(value.value);
      break;
    default: return null;
  }
  return preformatted ? text : styled(text, value.style);
}

function renderInlines(value: unknown, preformatted = false): string | null {
  if (!Array.isArray(value) || value.length > 2000) { return null; }
  const parts = value.map((part) => renderInline(part, preformatted));
  return parts.some((part) => part === null) ? null : parts.join('');
}

function renderRichElement(raw: unknown): string | null {
  const value = node(raw);
  if (!value) { return null; }
  if (value.type === 'rich_text_list') {
    if (!Array.isArray(value.elements) || value.elements.length > 500 || typeof value.style !== 'string' || !['ordered', 'bullet'].includes(value.style)) { return null; }
    const indent = Number.isInteger(value.indent) && Number(value.indent) >= 0 && Number(value.indent) <= 8 ? Number(value.indent) : 0;
    const offset = Number.isInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) < 10_000 ? Number(value.offset) : 0;
    const items = value.elements.map((item, index) => {
      const section = node(item);
      const text = section?.type === 'rich_text_section' ? renderInlines(section.elements) : null;
      if (text === null) { return null; }
      const prefix = `${'    '.repeat(indent)}${value.style === 'ordered' ? `${offset + index + 1}.` : '-'} `;
      return prefix + text.replace(/\n/g, `\n${'    '.repeat(indent + 1)}`);
    });
    return items.some((item) => item === null) ? null : items.join('\n');
  }
  const text = renderInlines(value.elements, value.type === 'rich_text_preformatted');
  if (text === null) { return null; }
  if (value.type === 'rich_text_section') { return text; }
  if (value.type === 'rich_text_quote') { return text.split('\n').map((line) => `> ${line}`).join('\n'); }
  if (value.type === 'rich_text_preformatted') {
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
    return `${fence}\n${text}\n${fence}`;
  }
  return null;
}

function mrkdwnToMarkdown(text: string): string {
  // Protect code and Slack entity tokens before converting mrkdwn emphasis.
  return text.split(/(```[\s\S]*?```|`[^`]*`|<[^>\n]+>)/g).map((part) => {
    if (part.startsWith('`')) { return part; }
    if (part.startsWith('<') && part.endsWith('>')) {
      const inside = part.slice(1, -1);
      const separator = inside.indexOf('|');
      const target = separator < 0 ? inside : inside.slice(0, separator);
      const label = separator < 0 ? target : inside.slice(separator + 1);
      if (/^(?:https?:\/\/|mailto:|slack:\/\/)/i.test(target)) { return link(label, target); }
      if (/^#[CG][A-Z0-9]+$/.test(target) || /^@[UW][A-Z0-9]+$/.test(target)) { return `<${target}>`; }
      if (target.startsWith('!date^')) { return escapeMarkdown(label); }
      return part;
    }
    return part.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '**$1**').replace(/(?<!~)~([^~\n]+)~(?!~)/g, '~~$1~~');
  }).join('');
}

/** Empty means extraction is unsafe/incomplete; callers should ask for refresh. */
export function extractSummaryBody(message: SummaryMessage): string {
  if (!message.blocks?.length) { return (message.text ?? '').trim(); }
  if (message.blocks.length > 100) { return ''; }
  const parts: string[] = [];
  for (const raw of message.blocks) {
    const block = node(raw);
    if (!block) { return ''; }
    if (FOOTER_TYPES.has(String(block.type))) { break; }
    if (block.type === 'divider') { continue; }
    let text: string | null;
    if (block.type === 'markdown') {
      text = typeof block.text === 'string' ? block.text : null;
    } else if (block.type === 'rich_text') {
      if (!Array.isArray(block.elements) || block.elements.length > 1000) { return ''; }
      const richParts = block.elements.map(renderRichElement);
      text = richParts.some((part) => part === null) ? null : richParts.join('\n\n');
    } else if (block.type === 'section' || block.type === 'header') {
      // A section with controls or fields is not a recap text block.
      if (block.accessory !== undefined || block.fields !== undefined) { break; }
      const content = node(block.text);
      text = typeof content?.text === 'string'
        ? content.type === 'mrkdwn' ? mrkdwnToMarkdown(content.text) : escapeMarkdown(content.text) : null;
    } else { return ''; }
    if (text === null) { return ''; }
    parts.push(text);
    if (parts.join('\n\n').length > MAX_BODY_LENGTH) { return ''; }
  }
  return parts.join('\n\n').replace(/^\n+|\s+$/g, '');
}
