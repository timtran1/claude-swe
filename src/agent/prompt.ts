interface NewTaskPromptOptions {
  cardId: string;
  cardName: string;
  cardUrl: string;
  repos: string[];
  imageDir?: string;
}

function buildRepoSection(repos: string[]): string {
  if (repos.length === 0) {
    return `No repos are pre-configured for this board. Read the Trello card to determine the target repo,
then clone it with \`gh repo clone <owner>/<repo>\`.`;
  }
  if (repos.length === 1) {
    return `The configured repo for this board is:
- ${repos[0]}

Clone it with \`gh repo clone ${repoToSlug(repos[0])}\`.
If the card refers to a different repo, clone that one instead.`;
  }
  return `The following repos are configured for this board:
${repos.map((r) => `- ${r}`).join('\n')}

Read the Trello card to determine which repo this task belongs to, then clone it with \`gh repo clone <owner>/<repo>\`.
If the task requires a repo not in this list, clone that one instead.`;
}

function repoToSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
}

export function buildNewTaskPrompt(opts: NewTaskPromptOptions): string {
  const { cardId, cardName, cardUrl, repos, imageDir } = opts;

  const imageSection = imageDir
    ? `
## Visual References

Screenshots and mockups from the Trello card have been saved to ${imageDir}/.
Check this directory after reading the card — if it contains images, they are the
visual specification for this task. Study them carefully before writing any code.

## Visual Verification

If this task involves any frontend or UI changes:
1. Read the images in ${imageDir}/ to understand exactly what the result should look like
2. After implementing, use the Playwright MCP server to verify your work visually:
   a. Start the dev server (e.g. \`npm run dev\`)
   b. Use Playwright to navigate to the relevant pages
   c. Take screenshots and compare them against the reference images in ${imageDir}/
   d. Fix, screenshot, compare — iterate until your implementation matches the designs
3. Do not commit until the UI visually matches the references
4. Paste a final screenshot into the PR description as evidence
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
## Repository

${buildRepoSection(repos)}

## Steps to Complete

1. Read the Trello card fully using the trello MCP \`get_card\` tool
2. Clone the target repo into /workspace and \`cd\` into it
3. Create a new branch: \`git checkout -b claude/${cardId.slice(-6)}\`
4. Explore the codebase to understand its structure and conventions
5. Set up the runtime and install dependencies:
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
6. Implement the solution described in the card
7. Run the project's test suite and fix any failures before proceeding
8. If this is a frontend task:
   a. Check /workspace/.card-images/ — if reference images are present, study them first
   b. Start the dev server (e.g. \`npm run dev\`)
   c. Use the Playwright MCP server to navigate to the relevant pages and take screenshots
   d. Compare your screenshots against the reference images — iterate until they match
   e. Do not move forward until the UI visually matches the designs
9. Commit all changes with a clear, descriptive message
10. Push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this was a frontend task, paste a final Playwright screenshot into the PR body
11. Move the Trello card to the Done list using the trello MCP \`move_card\` tool
12. Post the PR URL as a comment on the Trello card using the trello MCP \`add_comment\` tool

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
  repos: string[];
}

export function buildFeedbackPrompt(opts: FeedbackPromptOptions): string {
  const { cardUrl, commentText, commenterName } = opts;

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
6. If the feedback relates to UI or visual appearance:
   a. Check /workspace/.card-images/ for any reference screenshots on the card
   b. Start the dev server and use the Playwright MCP server to take screenshots
   c. Verify the updated UI looks correct before committing
7. Commit and push your changes to the existing PR branch
8. Post a reply on the Trello card using the trello MCP \`add_comment\` tool summarizing
   what you changed in response to the feedback

## Important Rules

- Only make changes directly related to the feedback
- Do not open a new PR — push to the existing branch
- Keep the response comment concise and factual
`.trim();
}
