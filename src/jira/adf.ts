import { logger } from '../logger.js';

/**
 * Convert a Markdown string to ADF (Atlassian Document Format).
 *
 * Supported elements:
 *   - Headings: # / ## / ###
 *   - Fenced code blocks: ```lang\n...\n```
 *   - Unordered lists: lines starting with "- " or "* "
 *   - Ordered lists: lines starting with "1. " etc.
 *   - Inline: **bold**, `code`, [text](url)
 *   - Horizontal rules: ---
 *   - Blank lines → paragraph breaks
 *   - Plain text / mixed inline
 *
 * Anything not matched falls through as plain text.
 */
export function textToAdf(markdown: string): object {
  const blocks = splitBlocks(markdown);
  const content = blocks.map(blockToAdf).filter((b) => b !== null) as object[];
  return { version: 1, type: 'doc', content };
}

// --- Block splitting ---

interface RawBlock {
  type: 'heading' | 'code' | 'bullet_list' | 'ordered_list' | 'rule' | 'paragraph';
  raw: string;
  level?: number;
  language?: string;
  items?: string[];
}

function splitBlocks(md: string): RawBlock[] {
  const lines = md.split('\n');
  const blocks: RawBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'rule', raw: line });
      i++; continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', raw: headingMatch[2], level: headingMatch[1].length });
      i++; continue;
    }

    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', raw: codeLines.join('\n'), language });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'bullet_list', raw: '', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ordered_list', raw: '', items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,3}\s/) &&
      !lines[i].startsWith('```') &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', raw: paraLines.join('\n') });
    }
  }

  return blocks;
}

// --- Block → ADF node ---

function blockToAdf(block: RawBlock): object | null {
  switch (block.type) {
    case 'rule':
      return { type: 'rule' };

    case 'heading':
      return {
        type: 'heading',
        attrs: { level: block.level ?? 1 },
        content: parseInline(block.raw),
      };

    case 'code':
      return {
        type: 'codeBlock',
        attrs: block.language ? { language: block.language } : {},
        content: [{ type: 'text', text: block.raw }],
      };

    case 'bullet_list':
      return {
        type: 'bulletList',
        content: (block.items ?? []).map((item) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(item) }],
        })),
      };

    case 'ordered_list':
      return {
        type: 'orderedList',
        content: (block.items ?? []).map((item) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(item) }],
        })),
      };

    case 'paragraph': {
      const lines = block.raw.split('\n');
      const inlineNodes: object[] = [];
      for (let i = 0; i < lines.length; i++) {
        inlineNodes.push(...parseInline(lines[i]));
        if (i < lines.length - 1) {
          inlineNodes.push({ type: 'hardBreak' });
        }
      }
      return { type: 'paragraph', content: inlineNodes };
    }

    default:
      return null;
  }
}

// --- Inline parser: bold, inline code, links, plain text ---

type AdfMark = { type: string; attrs?: Record<string, string> };
type AdfInlineNode = { type: string; text?: string; marks?: AdfMark[]; attrs?: Record<string, string> };

function parseInline(text: string): AdfInlineNode[] {
  const nodes: AdfInlineNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    if (match[0].startsWith('**')) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    } else if (match[0].startsWith('`')) {
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'code' }] });
    } else {
      nodes.push({
        type: 'text',
        text: match[4],
        marks: [{ type: 'link', attrs: { href: match[5] } }],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: '' }];
}

/**
 * Recursively extract plain text from an ADF (Atlassian Document Format) node.
 * Joins all text content with spaces — used for repo URL extraction.
 */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;

  if (n['type'] === 'text' && typeof n['text'] === 'string') {
    return n['text'];
  }

  const content = n['content'];
  if (Array.isArray(content)) {
    return content.map(adfToText).join(' ');
  }

  return '';
}

/**
 * Convert an ADF document to readable plain text for embedding in Claude prompts.
 * Block-level nodes (paragraphs, headings, code blocks, list items) are separated
 * by newlines for readability. Unknown node types are traversed recursively.
 */
export function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const node = adf as Record<string, unknown>;

  /** Node types whose children should be joined with newlines between siblings */
  const BLOCK_TYPES = new Set([
    'doc', 'paragraph', 'heading', 'bulletList', 'orderedList',
    'listItem', 'blockquote', 'codeBlock', 'rule', 'table',
    'tableRow', 'tableCell', 'tableHeader', 'expand', 'nestedExpand',
  ]);

  function walkNode(n: unknown, isBlock: boolean): string {
    if (!n || typeof n !== 'object') return '';
    const obj = n as Record<string, unknown>;

    // Leaf text node
    if (obj['type'] === 'text' && typeof obj['text'] === 'string') {
      return obj['text'];
    }

    const nodeType = (obj['type'] as string) ?? '';
    const childIsBlock = BLOCK_TYPES.has(nodeType);
    const content = obj['content'];
    if (!Array.isArray(content)) return '';

    const parts = content.map((child) => walkNode(child, childIsBlock)).filter(Boolean);

    // Join children of block nodes with newlines; inline nodes with empty string
    return childIsBlock ? parts.join('\n') : parts.join('');
  }

  const result = walkNode(node, true);

  // Collapse 3+ consecutive newlines to 2, and trim
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

