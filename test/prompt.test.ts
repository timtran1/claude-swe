import { describe, it, expect } from 'vitest';
import { buildNewTaskPrompt, buildFeedbackPrompt } from '../src/agent/prompt.js';

describe('buildNewTaskPrompt', () => {
  it('includes card name and ID', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Add dark mode',
      cardUrl: 'https://trello.com/c/abc',
      repos: [],
    });
    expect(prompt).toContain('card-123');
    expect(prompt).toContain('Add dark mode');
    expect(prompt).toContain('https://trello.com/c/abc');
  });

  it('includes single repo with clone instructions', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix bug',
      cardUrl: 'https://trello.com/c/abc',
      repos: ['https://github.com/myorg/my-app'],
    });
    expect(prompt).toContain('https://github.com/myorg/my-app');
    expect(prompt).toContain('gh repo clone myorg/my-app');
  });

  it('lists multiple repos and tells Claude to pick', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix bug',
      cardUrl: 'https://trello.com/c/abc',
      repos: ['https://github.com/myorg/frontend', 'https://github.com/myorg/backend'],
    });
    expect(prompt).toContain('https://github.com/myorg/frontend');
    expect(prompt).toContain('https://github.com/myorg/backend');
    expect(prompt).toContain('determine which repo');
  });

  it('handles no configured repos', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix bug',
      cardUrl: 'https://trello.com/c/abc',
      repos: [],
    });
    expect(prompt).toContain('No repos are pre-configured');
    expect(prompt).toContain('gh repo clone');
  });

  it('includes visual reference and Playwright instructions when imageDir is provided', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Redesign header',
      cardUrl: 'https://trello.com/c/abc',
      repos: [],
      imageDir: '/workspace/.card-images',
    });
    expect(prompt).toContain('/workspace/.card-images');
    expect(prompt).toContain('Playwright');
    expect(prompt).toContain('Visual References');
    expect(prompt).toContain('Visual Verification');
  });

  it('omits visual sections when no imageDir is provided', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix API bug',
      cardUrl: 'https://trello.com/c/abc',
      repos: [],
    });
    expect(prompt).not.toContain('Visual References');
    expect(prompt).not.toContain('Visual Verification');
  });

  it('instructs Claude to move card to Done and post PR link', () => {
    const prompt = buildNewTaskPrompt({
      cardId: 'card-123',
      cardName: 'Fix bug',
      cardUrl: 'https://trello.com/c/abc',
      repos: [],
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
      repos: [],
    });
    expect(prompt).toContain('Please use a spinner instead of skeleton');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('https://trello.com/c/xyz');
  });

  it('tells Claude not to open a new PR', () => {
    const prompt = buildFeedbackPrompt({
      cardId: 'card-456',
      cardUrl: 'https://trello.com/c/xyz',
      commentText: 'Fix the padding',
      commenterName: 'Bob',
      repos: [],
    });
    expect(prompt).toContain('existing branch');
    expect(prompt).not.toContain('gh pr create');
  });
});
