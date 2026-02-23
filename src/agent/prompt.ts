interface NewTaskPromptOptions {
  cardId: string;
  cardName: string;
  cardUrl: string;
  imageDir?: string;
}

export function buildNewTaskPrompt(opts: NewTaskPromptOptions): string {
  const { cardId, cardName, cardUrl, imageDir } = opts;

  const imageSection = imageDir
    ? `
There are visual design references (screenshots/mockups) in ${imageDir}/.
Read these images to understand the expected UI before implementing frontend changes.
Use the Playwright MCP server to start the dev server, take screenshots of your
implementation, and visually verify it matches the designs. Iterate until it looks right.
`
    : '';

  return `
You are an autonomous software engineer working on a task from Trello.

## Your Task

Trello card: "${cardName}"
Card URL: ${cardUrl}
Card ID: ${cardId}

Use the trello MCP server tools to read the full card details (description, checklists,
any additional context). The card contains the full specification for what needs to be done.
${imageSection}
## Steps to Complete

1. Read the Trello card fully using the trello MCP \`get_card\` tool
2. Explore this codebase to understand its structure and conventions
3. Set up the runtime and install dependencies:
   - If a \`.mise.toml\`, \`.tool-versions\`, \`.nvmrc\`, or \`.python-version\` file exists,
     run \`mise install\` first to install the correct runtime version
   - Then install project dependencies based on what you find:
     | File present | Command |
     |---|---|
     | \`package-lock.json\` | \`npm ci\` |
     | \`yarn.lock\` | \`yarn install --frozen-lockfile\` |
     | \`pnpm-lock.yaml\` | \`pnpm install --frozen-lockfile\` |
     | \`bun.lockb\` | \`bun install\` |
     | \`requirements.txt\` | \`pip install -r requirements.txt\` |
     | \`pyproject.toml\` + poetry | \`poetry install\` |
     | \`pyproject.toml\` + uv | \`uv sync\` |
     | \`Pipfile\` | \`pipenv install\` |
     | \`go.mod\` | \`go mod download\` |
     | \`Cargo.toml\` | \`cargo fetch\` |
     | \`Gemfile\` | \`bundle install\` |
   - If installation fails, read the error and fix it (missing system dep, wrong node version, etc.)
4. Implement the solution described in the card
5. Run the project's test suite and fix any failures before proceeding
6. If this is a frontend task, use the Playwright MCP server to:
   a. Start the dev server (e.g., \`npm run dev\`)
   b. Navigate to the relevant pages
   c. Take screenshots and compare against the design references
   d. Iterate until the visual output matches
7. Commit all changes with a clear, descriptive message
8. Push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
9. Move the Trello card to the Done list using the trello MCP \`move_card\` tool
10. Post the PR URL as a comment on the Trello card using the trello MCP \`add_comment\` tool

## Important Rules

- Do NOT move the card to Done until tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If anything is unclear, make a reasonable implementation choice and document it
`.trim();
}

interface FeedbackPromptOptions {
  cardId: string;
  cardUrl: string;
  commentText: string;
  commenterName: string;
}

export function buildFeedbackPrompt(opts: FeedbackPromptOptions): string {
  const { cardId, cardUrl, commentText, commenterName } = opts;

  return `
You are an autonomous software engineer handling review feedback on a pull request.

## Feedback Received

Trello card: ${cardUrl}
Reviewer: ${commenterName}
Comment: "${commentText}"

## Steps to Complete

1. Read the Trello card using the trello MCP \`get_card\` tool for full context
2. Understand what change or fix the reviewer is asking for
3. Run \`mise install\` if a runtime config file exists, then install project dependencies
4. Implement the requested changes
5. Run the test suite and ensure all tests pass
5. Commit and push your changes to the existing PR branch
6. Post a reply on the Trello card using the trello MCP \`add_comment\` tool summarizing
   what you changed in response to the feedback

## Important Rules

- Only make changes directly related to the feedback
- Do not open a new PR — push to the existing branch
- Keep the response comment concise and factual
`.trim();
}
