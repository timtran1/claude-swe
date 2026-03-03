#!/usr/bin/env node
// Reads claude --output-format stream-json from stdin, prints human-readable logs to stdout.
// Exits with the code from the final "result" event (0 = success, 1 = error/cancelled).

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function summarizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  switch (toolName) {
    case 'Bash':          return String(input.command ?? '');
    case 'Read':          return String(input.file_path ?? '');
    case 'Write':         return String(input.file_path ?? '');
    case 'Edit':          return String(input.file_path ?? '');
    case 'Glob':          return String(input.pattern ?? '');
    case 'Grep':          return String(input.pattern ?? '');
    case 'WebFetch':      return String(input.url ?? '');
    case 'WebSearch':     return String(input.query ?? '');
    case 'Agent':         return String(input.description || input.prompt || '');
    case 'TodoWrite':     return `(${(input.todos || []).length} items)`;
    default:              return JSON.stringify(input);
  }
}

function formatContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[image]';
      return JSON.stringify(c);
    }).join(' ');
  }
  return JSON.stringify(content);
}

let exitCode = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Non-JSON line (e.g. startup messages) — print as-is
    console.log(line);
    return;
  }

  switch (event.type) {
    case 'assistant': {
      const contents = event.message?.content ?? [];
      for (const block of contents) {
        if (block.type === 'text' && block.text?.trim()) {
          console.log(`[text]       ${block.text.trim()}`);
        } else if (block.type === 'tool_use') {
          const summary = summarizeInput(block.name, block.input);
          console.log(`[tool_use]   ${block.name}${summary ? ': ' + summary : ''}`);
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          console.log(`[thinking]   ${block.thinking.trim()}`);
        }
      }
      break;
    }
    case 'tool_result': {
      const text = formatContent(event.content);
      if (text) {
        console.log(`[tool_result] ${text}`);
      }
      break;
    }
    case 'result': {
      if (event.subtype === 'success') {
        console.log(`[result]     success`);
        exitCode = 0;
      } else {
        console.log(`[result]     ${event.subtype ?? 'error'}`);
        if (event.error) {
          // Print the full error message — don't truncate, this is critical for debugging
          console.log(`[error]      ${event.error}`);
        }
        if (event.result) {
          // Some result events include a result field with more detail
          const resultStr = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
          if (resultStr.length > 0) {
            console.log(`[error_detail] ${resultStr.slice(0, 2000)}`);
          }
        }
        exitCode = 1;
      }
      const usage = event.usage;
      const cost = event.total_cost_usd;
      if (usage || cost != null) {
        const parts = [];
        if (usage?.input_tokens != null) parts.push(`in: ${usage.input_tokens.toLocaleString()}`);
        if (usage?.output_tokens != null) parts.push(`out: ${usage.output_tokens.toLocaleString()}`);
        if (cost != null) parts.push(`cost: $${cost.toFixed(4)}`);
        if (parts.length) console.log(`[cost]       ${parts.join(' | ')}`);
      }
      break;
    }
    case 'system':
      // Ignore system init events
      break;
    default:
      // Unknown event type — ignore silently
      break;
  }
});

rl.on('close', () => {
  process.exit(exitCode);
});
