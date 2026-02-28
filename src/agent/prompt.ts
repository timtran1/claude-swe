interface NewTaskPromptOptions {
  cardId: string;
  cardShortLink: string;
  cardName: string;
  cardUrl: string;
  repos: string[];
  imageDir?: string;
}

function buildRepoSection(repos: string[]): string {
  if (repos.length === 0) {
    return `No repos are pre-configured for this board. Read the Trello card to determine the target repo,
then clone it with \`gh repo clone <owner>/<repo>\`.
After cloning, read \`CLAUDE.md\` in the repo root if it exists — it contains project-specific instructions.`;
  }
  if (repos.length === 1) {
    return `The configured repo for this board is:
- ${repos[0]}

Clone it with \`gh repo clone ${repoToSlug(repos[0])}\`.
After cloning, read \`CLAUDE.md\` in the repo root if it exists — it contains project-specific instructions.
If the card refers to a different repo, clone that one instead.`;
  }
  const cloneCommands = repos.map((r) => `  gh repo clone ${repoToSlug(r)}`).join('\n');
  return `The following repos are configured for this board — clone all of them, as this task may span multiple:
${repos.map((r) => `- ${r}`).join('\n')}

\`\`\`bash
cd /workspace
${cloneCommands}
\`\`\`

After cloning each repo, read its \`CLAUDE.md\` if present — it contains project-specific instructions for that codebase.
Work in whichever repos the task requires. Open a separate PR in each repo that has changes.`;
}

function repoToSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
}

export function buildPlanPrompt(opts: NewTaskPromptOptions): string {
  const { cardId, cardShortLink, cardName, cardUrl, repos, imageDir } = opts;

  const imageSection = imageDir
    ? `
## Visual References

Screenshots and mockups from the Trello card have been saved to ${imageDir}/.
Check this directory after reading the card — if it contains images, study them carefully
as they are the visual specification for this task. Document what you observe in the plan.
`
    : '';

  return `
You are a senior software architect planning a task for another AI agent to implement.

## Your Task

Trello card: "${cardName}"
Card URL: ${cardUrl}
Card ID: ${cardId}

Use the trello MCP server tools to read the full card details (description, checklists,
any additional context). The card contains the full specification for what needs to be done.
${imageSection}
## Repository

${buildRepoSection(repos)}

## What You Must Do

1. Read the Trello card fully using the trello MCP \`get_card\` tool
2. Clone the repo(s) into /workspace as described above
3. In each repo you will modify, create a new branch: \`git checkout -b claude/${cardShortLink}\`
4. Run \`mise install\` if a runtime config file exists, then install project dependencies:
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
5. Explore the codebase thoroughly:
   - If a \`CLAUDE.md\` exists in the repo root, read it first — it contains project-specific instructions
   - Understand the directory structure and architecture
   - Find existing code patterns and conventions (naming, formatting, imports)
   - Locate the test suite and understand how tests are written and run
   - Identify which files are most relevant to this task
6. Write a detailed implementation plan to /workspace/.plan.md with the following sections:
   - **Task Summary**: One paragraph describing what needs to be done and why
   - **Codebase Context**: Key conventions, patterns, and constraints you observed
   - **Setup**: Runtime/dependency install commands already run (so the executor can skip them)
   - **Files to Modify**: For each file, list the specific changes needed
   - **Files to Create**: For each new file, describe its purpose and content
   - **Test Strategy**: Which tests to run, what new tests to write
   - **Visual Verification**: If this is a frontend task, describe what pages/components to screenshot and what they should look like
   - **Done Criteria**: Exact conditions that must be true for the task to be complete

## Critical Rules

- Do NOT write any implementation code — only the plan
- Do NOT open PRs, move the Trello card, or post comments
- The plan must be specific enough that another agent can implement it without reading the card again
- If anything in the card is ambiguous, document your interpretation in the plan
`.trim();
}

export function buildExecutePrompt(opts: NewTaskPromptOptions): string {
  const { cardId, cardShortLink, cardUrl, imageDir } = opts;

  const imageSection = imageDir
    ? `
## Visual References

If this task involves frontend or UI changes, reference images are in ${imageDir}/.
After implementing, use the Playwright MCP server to verify your work:
1. Start the dev server (e.g. \`npm run dev\`)
2. Navigate to the relevant pages and take screenshots
3. Compare against the reference images — iterate until they match
4. Paste a final screenshot into the PR description as evidence
`
    : '';

  return `
You are an autonomous software engineer implementing a planned task.

## Context

Trello card: ${cardUrl}
Card ID: ${cardId}

The workspace is already prepared:
- The repo(s) have been cloned into /workspace (each in its own subdirectory)
- The branch \`claude/${cardShortLink}\` has been created and checked out in each repo that requires changes
- Runtime and dependencies have been installed
- A detailed implementation plan is at /workspace/.plan.md
${imageSection}
## Steps to Complete

1. Read /workspace/.plan.md — this is your specification, follow it precisely
2. Implement every change described in the plan
3. Run the test suite as specified in the plan — fix any failures before proceeding
4. If this is a frontend task, perform visual verification as described in the plan
5. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
6. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this was a frontend task, paste a final Playwright screenshot into the PR body
7. Move the Trello card to the Done list using the trello MCP \`move_card\` tool
8. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool

## Important Rules

- Follow the plan — if you need to deviate, document why in the PR body
- Do NOT move the card to Done until all tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
`.trim();
}

export function buildNewTaskPrompt(opts: NewTaskPromptOptions): string {
  const { cardId, cardShortLink, cardName, cardUrl, repos, imageDir } = opts;

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
2. Clone the repo(s) into /workspace as described above
3. In each repo you will modify, create a new branch: \`git checkout -b claude/${cardShortLink}\`
4. In each repo, read \`CLAUDE.md\` in the root if it exists, then explore the codebase to understand its structure and conventions
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
9. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
10. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this was a frontend task, paste a final Playwright screenshot into the PR body
11. Move the Trello card to the Done list using the trello MCP \`move_card\` tool
12. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool

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
  const { cardId, cardUrl, commentText, commenterName } = opts;

  return `
You are an autonomous software engineer handling review feedback on a pull request.

## Feedback Received

Trello card: ${cardUrl}
Card ID: ${cardId}
Reviewer: ${commenterName}
Latest comment: "${commentText}"

## Steps to Complete

1. Read the Trello card using the trello MCP \`get_card\` tool for full context
2. Read all comments on the card using the trello MCP \`get_card_comments\` tool to understand
   the full feedback history and any prior iterations — the latest comment is shown above but
   earlier rounds may provide important context
3. Understand what change or fix the reviewer is asking for
4. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions
5. Run \`mise install\` if a runtime config file exists, then install project dependencies
6. Implement the requested changes
7. Run the test suite and ensure all tests pass
8. If the feedback relates to UI or visual appearance:
   a. Check /workspace/.card-images/ for any reference screenshots on the card
   b. Start the dev server and use the Playwright MCP server to take screenshots
   c. Verify the updated UI looks correct before committing
9. Commit and push your changes to the existing PR branch(es)
10. Post a reply on the Trello card using the trello MCP \`add_comment\` tool (card ID: ${cardId})
    summarizing what you changed in response to the feedback

## Important Rules

- Only make changes directly related to the feedback
- Do not open a new PR — push to the existing branch
- Post your summary comment on the Trello card only — do NOT comment on the GitHub PR
- Keep the response comment concise and factual
`.trim();
}
