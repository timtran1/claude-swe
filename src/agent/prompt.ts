interface NewTaskPromptOptions {
  cardId: string;
  cardShortLink: string;
  cardName: string;
  cardUrl: string;
  repos: string[];
  imageDir?: string;
  doneListId?: string;
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

export function buildPlanPrompt(opts: NewTaskPromptOptions, additionalPrompt?: string): string {
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
   - **Visual Verification**: If this project has a frontend, prepare a visual verification plan:
     a. Find guide on how to run the app locally, through either repo(s) CLAUDE.md, README, or trello card
     b. Describe the steps to run the app locally, including database setup, backend, docker containers, etc.
     c. Include any authentication steps required to access the app, default credentials if available
     d. Specify exactly which pages/components to open in the browser, what interactions to perform, and what the result should look like
     e. Skip this section only for pure backend tasks or projects with no frontend impact
   - **Done Criteria**: Exact conditions that must be true for the task to be complete

## Critical Rules

- Do NOT write any implementation code — only the plan
- Do NOT open PRs, move the Trello card, or post comments
- The plan must be specific enough that another agent can implement it without reading the card again
- If anything in the card is ambiguous, document your interpretation in the plan
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildExecutePrompt(opts: NewTaskPromptOptions, additionalPrompt?: string): string {
  const { cardId, cardShortLink, cardUrl, imageDir, doneListId } = opts;

  const imageSection = imageDir
    ? `
## Visual References

Reference images from the Trello card are in ${imageDir}/. Study them before implementing
any UI changes — they are the visual specification.
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
## Environment

The following runtimes are pre-installed via mise and available immediately (no download needed):
- **Node.js**: 18, 20, 22
- **Python**: 3.10, 3.11, 3.12, 3.13, 3.14
- **Tools**: git, gh (GitHub CLI), docker CLI, imagemagick

Use \`mise use <runtime>@<version>\` to activate a specific version, or rely on a \`.mise.toml\` / \`.python-version\` / \`.nvmrc\` file in the repo.

## Steps to Complete

1. Read /workspace/.plan.md — this is your specification, follow it precisely
2. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions for code style, build commands, and conventions
3. Implement every change described in the plan
4. Run the test suite as specified in the plan — fix any failures before proceeding
5. Follow the visual verification plan in /workspace/.plan.md
   - Run the project locally as specified in the plan
   - Use the Playwright MCP server to navigate to the relevant pages
   - Take screenshots and verify the result looks correct
   - If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   - Do NOT commit until the UI looks right — paste a final screenshot into the PR body as evidence
   - Skip this step only if the task or project is purely backend with zero UI impact.
   - **To attach a screenshot to Trello:** save it to a file with \`browser_take_screenshot\`,
     then upload via curl:
     \`curl -X POST "https://api.trello.com/1/cards/{cardId}/attachments?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg" -F "name=screenshot.jpeg"\`
     Do NOT use base64 or browser_run_code for screenshots — the base64 string bloats the context window and causes timeouts.
6. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
7. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
8. Move the Trello card to the Done list using the trello MCP \`move_card\` tool (card ID: ${cardId}${doneListId ? `, list ID: ${doneListId}` : ''})
9. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool

## Important Rules

- Follow the plan — if you need to deviate, document why in the PR body
- Do NOT move the card to Done until all tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If you use \`docker compose\` for test services, always pass \`--project-name claude-${cardShortLink}\` so services are isolated and cleaned up automatically on exit
- Docker is available in this environment via the \`$DOCKER_HOST\` environment variable — do not override or change \`DOCKER_HOST\`
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildNewTaskPrompt(opts: NewTaskPromptOptions, additionalPrompt?: string): string {
  const { cardId, cardShortLink, cardName, cardUrl, repos, imageDir, doneListId } = opts;

  const imageSection = imageDir
    ? `
## Visual References

Screenshots and mockups from the Trello card have been saved to ${imageDir}/.
Study them carefully before writing any code — they are the visual specification for this task.
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
8. If this task involves any UI or frontend changes, do browser verification:
   a. Start the dev server (e.g. \`npm run dev\`)
   b. Use the Playwright MCP server to navigate to the relevant pages
   c. Take screenshots and verify the result looks correct
   d. If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   e. Fix, screenshot, compare — keep iterating until the UI is correct
   f. Do NOT move forward until the UI visually matches the expected result
   g. To attach a screenshot to Trello: save it to a file with \`browser_take_screenshot\`,
      then upload via curl:
      \`curl -X POST "https://api.trello.com/1/cards/{cardId}/attachments?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg" -F "name=screenshot.jpeg"\`
      Do NOT use base64 or browser_run_code for screenshots — the base64 string bloats the context window and causes timeouts.
   Skip this step only if the task is purely backend with zero UI impact.
9. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
10. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this involved UI changes, paste a final Playwright screenshot into the PR body as evidence
11. Move the Trello card to the Done list using the trello MCP \`move_card\` tool (card ID: ${cardId}${doneListId ? `, list ID: ${doneListId}` : ''})
12. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool
   If this involved UI changes, include the final Playwright screenshot inline in the comment body

## Important Rules

- Do NOT move the card to Done until tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If anything is unclear, make a reasonable implementation choice and document it
- Prefer Trello MCP tools for reading/writing card data (get_card, add_comment, move_card, etc.) — use curl only for file uploads (attachments)
- If you use \`docker compose\` for test services, always pass \`--project-name claude-${cardShortLink}\` so services are isolated and cleaned up automatically on exit
- Docker is available in this environment via the \`$DOCKER_HOST\` environment variable — do not override or change \`DOCKER_HOST\`
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

interface FeedbackPromptOptions {
  cardId: string;
  cardShortLink: string;
  cardUrl: string;
  commentText: string;
  commenterName: string;
  repos: string[];
  imageDir?: string;
  doneListId?: string;
}

export function buildFeedbackPrompt(opts: FeedbackPromptOptions, additionalPrompt?: string): string {
  const { cardId, cardShortLink, cardUrl, commentText, commenterName, imageDir, doneListId } = opts;

  const imageSection = imageDir
    ? `
## Visual References

Reference images from the Trello card have been saved to ${imageDir}/.

Images attached in comments are organized by comment ID:
  /workspace/.comment-images/<comment-id>/<filename>

When you read comments via \`get_card_comments\`, match each comment's \`id\` field to the
corresponding subdirectory to find its images. For example, if a comment has id
\`1234\` and contains a screenshot, look in:
  /workspace/.comment-images/1234/image.webp
`
    : '';

  return `
You are an autonomous software engineer handling review feedback on a pull request.

## Feedback Received

Trello card: ${cardUrl}
Card ID: ${cardId}
Reviewer: ${commenterName}
Latest comment: "${commentText}"
${imageSection}
## Environment

The following runtimes are pre-installed via mise and available immediately (no download needed):
- **Node.js**: 18, 20, 22
- **Python**: 3.10, 3.11, 3.12, 3.13, 3.14
- **Tools**: git, gh (GitHub CLI), docker CLI, imagemagick

Use \`mise use <runtime>@<version>\` to activate a specific version, or rely on a \`.mise.toml\` / \`.python-version\` / \`.nvmrc\` file in the repo.

## Steps to Complete

1. Read the Trello card using the trello MCP \`get_card\` tool for full context
2. Read all comments on the card using the trello MCP \`get_card_comments\` tool to understand
   the full feedback history and any prior iterations — the latest comment is shown above but
   earlier rounds may provide important context
3. **Evaluate whether the comment is actually feedback or an instruction for you.**
   Not every comment on a card is meant as feedback for Claude. If the comment is:
   - A conversation between humans (e.g. status updates, questions to each other, general discussion)
   - Not related to code changes or the implementation
   - Not requesting any action from you
   Then return "Comment Not For Me" without any explanation and exit without making any changes.
4. Read /workspace/.plan.md if it exists — it contains the original implementation plan and
   is essential context for understanding the intended approach and design decisions
5. Understand what change or fix the reviewer is asking for
6. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions
7. Run \`mise install\` if a runtime config file exists, then install project dependencies
8. Implement the requested changes
9. Run the test suite and ensure all tests pass
10. If this task involves any UI or frontend changes, do browser verification:
   a. Start the dev server and use the Playwright MCP server to navigate to the relevant pages
   b. Take screenshots and verify the updated UI looks correct
   c. Check /workspace/.card-images/ for any reference images and compare against them
   d. Iterate until the UI is correct — do NOT commit until it looks right
   e. To attach a screenshot to Trello: save it to a file with \`browser_take_screenshot\`,
      then upload via curl:
      \`curl -X POST "https://api.trello.com/1/cards/{cardId}/attachments?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg" -F "name=screenshot.jpeg"\`
      Do NOT use base64 or browser_run_code for screenshots — the base64 string bloats the context window and causes timeouts.
   Skip this step only if the changes are purely backend with zero UI impact.
11. Commit and push your changes to the existing PR branch(es)
12. Post a reply on the Trello card using the trello MCP \`add_comment\` tool (card ID: ${cardId})
    summarizing what you changed in response to the feedback
${doneListId ? `13. Move the Trello card back to Done using the trello MCP \`move_card\` tool (card ID: ${cardId}, list ID: ${doneListId})` : ''}

## Important Rules

- Only make changes directly related to the feedback
- Do not open a new PR — push to the existing branch
- Post your summary comment on the Trello card only — do NOT comment on the GitHub PR
- Keep the response comment concise and factual
- Prefer Trello MCP tools for reading/writing card data (get_card, add_comment, move_card, etc.) — use curl only for file uploads (attachments)
- If you use \`docker compose\` for test services, always pass \`--project-name claude-${cardShortLink}\` so services are isolated and cleaned up automatically on exit
- Docker is available in this environment via the \`$DOCKER_HOST\` environment variable — do not override or change \`DOCKER_HOST\`
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}
