import { logger } from '../logger.js';
import { getJiraTransitions } from './api.js';

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

/**
 * Resolve a Jira transition ID for the given issue.
 *
 * Resolution priority:
 * 1. transitionConfig is null → return null (no transition configured)
 * 2. transitionConfig.statusId is set → return it directly (no API call)
 * 3. transitionConfig.status name → call getJiraTransitions, match case-insensitive
 * 4. No match found → log warning and return null (bot continues working, transition skipped)
 */
export async function resolveJiraTransitionId(
  issueKey: string,
  transitionConfig: { statusId?: string; status?: string } | null,
): Promise<string | null> {
  if (!transitionConfig) return null;

  if (transitionConfig.statusId) {
    return transitionConfig.statusId;
  }

  if (!transitionConfig.status) return null;

  try {
    const transitions = await getJiraTransitions(issueKey);
    const target = transitionConfig.status.toLowerCase();
    const match = transitions.find((t) => t.name.toLowerCase() === target);
    if (!match) {
      logger.warn(
        {
          phase: 'jira',
          issueKey,
          status: transitionConfig.status,
          available: transitions.map((t) => t.name),
        },
        'Jira transition not found by name — skipping transition',
      );
      return null;
    }
    return match.id;
  } catch (err) {
    logger.warn({ err, phase: 'jira', issueKey }, 'Failed to fetch Jira transitions — skipping transition');
    return null;
  }
}
