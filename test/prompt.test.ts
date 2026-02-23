import { describe, it, expect } from 'vitest';
import { buildNewTaskPrompt, buildFeedbackPrompt } from '../src/agent/prompt.js';

describe('buildNewTaskPrompt', () => {
  it('includes card name and ID', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Add dark mode',
      cardUrl: 'https://trello.com/c/abc',
    });
    expect(prompt).toContain('card-123');
    expect(prompt).toContain('Add dark mode');
    expect(prompt).toContain('https://trello.com/c/abc');
  });

  it('includes Playwright instructions when imageDir is provided', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Redesign header',
      cardUrl: 'https://trello.com/c/abc',
      imageDir: '/tmp/workspaces/card-123/images',
    });
    expect(prompt).toContain('/tmp/workspaces/card-123/images');
    expect(prompt).toContain('Playwright');
  });

  it('omits Playwright instructions when no imageDir', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix API bug',
      cardUrl: 'https://trello.com/c/abc',
    });
    expect(prompt).not.toContain('/tmp/images');
  });

  it('instructs Claude to move card to Done and post PR link', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix bug',
      cardUrl: 'https://trello.com/c/abc',
    });
    expect(prompt).toContain('move_card');
    expect(prompt).toContain('add_comment');
    expect(prompt).toContain('gh pr create');
  });
});

describe('buildFeedbackPrompt', () => {
  it('includes comment text and commenter name', () => {
    const prompt = buildFeedbackPrompt({
      cardId: 'card-456',
      cardUrl: 'https://trello.com/c/xyz',
      commentText: 'Please use a spinner instead of skeleton',
      commenterName: 'Alice',
    });
    expect(prompt).toContain('Please use a spinner instead of skeleton');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('card-456');
  });

  it('tells Claude not to open a new PR', () => {
    const prompt = buildFeedbackPrompt({
      cardId: 'card-456',
      cardUrl: 'https://trello.com/c/xyz',
      commentText: 'Fix the padding',
      commenterName: 'Bob',
    });
    expect(prompt).toContain('existing branch');
    expect(prompt).not.toContain('gh pr create');
  });
});
