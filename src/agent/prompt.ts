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

/**
 * Dependency install lookup table — reused across all prompt types that set up a workspace.
 */
function buildDepsInstallTable(): string {
  return `| File present | Command |
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
   | \`Gemfile\` | \`bundle install\``;
}

/**
 * Pre-installed runtimes section — reused in execute and feedback prompts.
 */
function buildEnvironmentSection(): string {
  return `## Environment

The following runtimes are pre-installed via mise and available immediately (no download needed):
- **Node.js**: 18, 20, 22
- **Python**: 3.10, 3.11, 3.12, 3.13, 3.14
- **Tools**: git, gh (GitHub CLI), docker CLI, imagemagick

Use \`mise use <runtime>@<version>\` to activate a specific version, or rely on a \`.mise.toml\` / \`.python-version\` / \`.nvmrc\` file in the repo.`;
}

/**
 * Docker isolation and DOCKER_HOST rules — reused in every implementation prompt.
 * @param taskId - The task/card/issue short ID used as the docker-compose project name.
 */
function buildDockerNote(taskId: string): string {
  return `- If you use \`docker compose\` for test services, always pass \`--project-name claude-${taskId}\` so services are isolated and cleaned up automatically on exit
- Docker is available in this environment via the \`$DOCKER_HOST\` environment variable — do not override or change \`DOCKER_HOST\``;
}

export function buildPlanPrompt(opts: NewTaskPromptOptions, additionalPrompt?: string): string {
  const { cardId, cardShortLink, cardName, cardUrl, repos, imageDir } = opts;

  const imageSection = imageDir
    ? `
## Card Attachments

All attachments from the Trello card have been downloaded to ${imageDir}/.
Check this directory after reading the card:
- **Images** (screenshots, mockups): study them carefully as they are the visual specification for this task. Document what you observe in the plan.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements relevant to the task.
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

## Available MCP Servers

You have two MCP servers available — use their tools throughout this task:
- **trello** — read cards, post comments, move cards (\`get_card\`, \`add_comment\`, \`move_card\`, etc.)
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, etc.). Chromium is pre-installed and runs headless.

## What You Must Do

1. Read the Trello card fully using the trello MCP \`get_card\` tool
2. Clone the repo(s) into /workspace as described above
3. In each repo you will modify, create a new branch: \`git checkout -b claude/${cardShortLink}\`
4. Run \`mise install\` if a runtime config file exists, then install project dependencies:
   ${buildDepsInstallTable()}
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
   - **Visual Verification** (REQUIRED — skip ONLY for pure backend tasks in repos with zero frontend code):
     a. Find guide on how to run the app locally, through either repo(s) CLAUDE.md, README, or trello card
     b. Describe the steps to run the app locally, including database setup, backend, docker containers, etc.
     c. Include any authentication steps required to access the app, default credentials if available
     d. Specify exactly which pages/components to open in the browser, what interactions to perform, and what the result should look like
     e. The executor has a Playwright MCP server with tools like \`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc. Write verification steps using these tools.
     f. Visual evidence is REQUIRED — the executor MUST attach final screenshot(s) to the Trello card as proof after verification passes. To upload, save to file with \`browser_take_screenshot\` then:
        \`curl -s -X POST "https://api.trello.com/1/cards/{cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`
        Do NOT plan for base64 encoding or browser_run_code — base64 bloats the context window and causes timeouts.
     Include this upload step explicitly in the verification plan.
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
## Card Attachments

All attachments from the Trello card are in ${imageDir}/.
- **Images**: study them before implementing any UI changes — they are the visual specification.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements.
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
## Available MCP Servers

You have two MCP servers available — use their tools throughout this task:
- **trello** — read cards, post comments, move cards (\`get_card\`, \`add_comment\`, \`move_card\`, etc.)
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless. Use this to verify any frontend changes.

${buildEnvironmentSection()}

## Steps to Complete

1. Read /workspace/.plan.md — this is your specification, follow it precisely
2. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions for code style, build commands, and conventions
3. Implement every change described in the plan
4. Run the test suite as specified in the plan — fix any failures before proceeding
5. Visual verification — follow the visual verification plan in /workspace/.plan.md. This is REQUIRED for any task that touches frontend code, UI components, styles, or pages. Skip ONLY if the task is purely backend with zero frontend files changed.
   - Run the project locally as specified in the plan
   - Use the Playwright MCP tools (\`browser_navigate\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   - Take screenshots and verify the result looks correct
   - If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   - Do NOT commit until the UI looks right
   - **Visual evidence is REQUIRED**: after verification passes, you MUST attach the final screenshot(s) to the Trello card as proof. Save the screenshot to a file with \`browser_take_screenshot\`, then upload:
     \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`
     Do NOT use base64 or browser_run_code for screenshots.
6. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
7. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
8. Move the Trello card to the Done list using the trello MCP \`move_card\` tool (card ID: ${cardId}${doneListId ? `, list ID: ${doneListId}` : ''})
9. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool.
   If visual verification was performed, you MUST attach the final screenshot(s) to the Trello card as visual evidence using:
   \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`

## Important Rules

- Follow the plan — if you need to deviate, document why in the PR body
- Do NOT move the card to Done until all tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
${buildDockerNote(cardShortLink)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildNewTaskPrompt(opts: NewTaskPromptOptions, additionalPrompt?: string): string {
  const { cardId, cardShortLink, cardName, cardUrl, repos, imageDir, doneListId } = opts;

  const imageSection = imageDir
    ? `
## Card Attachments

All attachments from the Trello card have been downloaded to ${imageDir}/.
- **Images** (screenshots, mockups): study them carefully before writing any code — they are the visual specification for this task.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements relevant to the task.
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
## Available MCP Servers

You have two MCP servers available — use their tools throughout this task:
- **trello** — read cards, post comments, move cards (\`get_card\`, \`add_comment\`, \`move_card\`, etc.)
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless. Use this to verify any frontend changes.

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
     ${buildDepsInstallTable()}
   - If installation fails, read the error and fix it (missing system dep, wrong node version, etc.)
6. Implement the solution described in the card
7. Run the project's test suite and fix any failures before proceeding
8. Visual verification — REQUIRED for any task that touches frontend code, UI components, styles, or pages. Skip ONLY if the task is purely backend with zero frontend files changed:
   a. Start the dev server (e.g. \`npm run dev\`)
   b. Use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   c. Take screenshots and verify the result looks correct
   d. If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   e. Fix, screenshot, compare — keep iterating until the UI is correct
   f. Do NOT move forward until the UI visually matches the expected result
   g. **Visual evidence is REQUIRED**: after verification passes, you MUST attach the final screenshot(s) to the Trello card as proof. Save the screenshot to a file with \`browser_take_screenshot\`, then upload:
      \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`
      Do NOT use base64 or browser_run_code for screenshots.
9. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
10. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this involved UI changes, paste a final Playwright screenshot into the PR body as evidence
11. Move the Trello card to the Done list using the trello MCP \`move_card\` tool (card ID: ${cardId}${doneListId ? `, list ID: ${doneListId}` : ''})
12. Post all PR URLs as a comment on the Trello card using the trello MCP \`add_comment\` tool.
    If visual verification was performed, you MUST attach the final screenshot(s) to the Trello card as visual evidence using:
    \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`

## Important Rules

- Do NOT move the card to Done until tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If anything is unclear, make a reasonable implementation choice and document it
- Prefer Trello MCP tools for reading/writing card data (get_card, add_comment, move_card, etc.) — use curl only for file uploads (attachments)
${buildDockerNote(cardShortLink)}
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
## Card Attachments

All attachments from the Trello card have been downloaded to ${imageDir}/.
- **Images**: visual specifications and reference screenshots.
- **Documents** (.md, .txt, .pdf, etc.): conventions, specs, or requirements — read them.

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
## Available MCP Servers

You have two MCP servers available — use their tools throughout this task:
- **trello** — read cards, post comments, move cards (\`get_card\`, \`add_comment\`, \`move_card\`, etc.)
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless. Use this to verify any frontend changes.

${buildEnvironmentSection()}

## Steps to Complete

1. Read the Trello card using the trello MCP \`get_card\` tool for full context
2. Read all comments on the card using the trello MCP \`get_card_comments\` tool to understand
   the full feedback history and any prior iterations — the latest comment is shown above but
   earlier rounds may provide important context
3. Read /workspace/.plan.md if it exists — it contains the original implementation plan and
   is essential context for understanding the intended approach and design decisions
4. Understand what change or fix the reviewer is asking for
5. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions
6. Run \`mise install\` if a runtime config file exists, then install project dependencies
7. Implement the requested changes
8. Run the test suite and ensure all tests pass
9. Visual verification — REQUIRED for any changes that touch frontend code, UI components, styles, or pages. Skip ONLY if changes are purely backend with zero frontend files changed:
   a. Start the dev server and use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   b. Take screenshots and verify the updated UI looks correct
   c. Check /workspace/.card-images/ for any reference images and compare against them
   d. Iterate until the UI is correct — do NOT commit until it looks right
   e. **Visual evidence is REQUIRED**: after verification passes, you MUST attach the final screenshot(s) to the Trello card as proof. Save the screenshot to a file with \`browser_take_screenshot\`, then upload:
      \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`
      Do NOT use base64 or browser_run_code for screenshots.
10. Commit and push your changes:
    - Check if the branch still exists on the remote: \`git ls-remote --heads origin claude/${cardShortLink}\`
    - If it exists: push to it (the PR should still be open)
    - If it was deleted (previous PR was merged/closed): create the branch fresh and open a new PR with \`gh pr create\`
11. Post a reply on the Trello card using the trello MCP \`add_comment\` tool (card ID: ${cardId})
    summarizing what you changed in response to the feedback.
    If visual verification was performed, you MUST attach the final screenshot(s) to the Trello card as visual evidence using:
    \`curl -s -X POST "https://api.trello.com/1/cards/${cardId}/attachments" -F "key=$TRELLO_API_KEY" -F "token=$TRELLO_TOKEN" -F "file=@/tmp/screenshot.jpeg;type=image/jpeg" -F "name=screenshot.jpeg"\`
${doneListId ? `12. Move the Trello card back to Done using the trello MCP \`move_card\` tool (card ID: ${cardId}, list ID: ${doneListId})` : ''}

## Important Rules

- Only make changes directly related to the feedback
- Push to the existing branch if it still exists; if the branch was deleted, create it fresh and open a new PR
- Post your summary comment on the Trello card only — do NOT comment on the GitHub PR
- Keep the response comment concise and factual
- Prefer Trello MCP tools for reading/writing card data (get_card, add_comment, move_card, etc.) — use curl only for file uploads (attachments)
${buildDockerNote(cardShortLink)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

// --- Jira-originated task prompts ---

interface JiraNewTaskPromptOptions {
  issueKey: string;
  issueUrl: string;
  issueSummary: string;
  /** Pre-converted from ADF to plain text */
  issueDescription: string;
  repos: string[];
  imageDir?: string;
  jiraHost: string;
  jiraDoneTransitionId?: string;
}

interface JiraFeedbackPromptOptions {
  issueKey: string;
  issueUrl: string;
  issueSummary: string;
  commentText: string;
  commenterName: string;
  repos: string[];
  imageDir?: string;
  jiraHost: string;
  jiraDoneTransitionId?: string;
}

/** Curl command to upload a screenshot to a Jira issue as an attachment */
function jiraUploadScreenshotCmd(issueKey: string): string {
  return `curl -s -X POST "$JIRA_HOST/rest/api/3/issue/${issueKey}/attachments" \\
  -H "Authorization: Basic $(echo -n $JIRA_EMAIL:$JIRA_API_TOKEN | base64)" \\
  -H "X-Atlassian-Token: no-check" \\
  -F "file=@/tmp/screenshot.jpeg;type=image/jpeg"`;
}

/** Curl command to post a plain-text comment on a Jira issue using the v3 ADF API */
function jiraPostCommentCmd(issueKey: string, messageVar: string): string {
  return `curl -s -X POST "$JIRA_HOST/rest/api/3/issue/${issueKey}/comment" \\
  -H "Authorization: Basic $(echo -n $JIRA_EMAIL:$JIRA_API_TOKEN | base64)" \\
  -H "Content-Type: application/json" \\
  -d '{"body":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"'"${messageVar}"'"}]}]}}'`;
}

/** Curl command to transition a Jira issue to a new status */
function jiraTransitionCmd(issueKey: string, transitionId: string): string {
  return `curl -s -X POST "$JIRA_HOST/rest/api/3/issue/${issueKey}/transitions" \\
  -H "Authorization: Basic $(echo -n $JIRA_EMAIL:$JIRA_API_TOKEN | base64)" \\
  -H "Content-Type: application/json" \\
  -d '{"transition":{"id":"${transitionId}"}}'`;
}

export function buildJiraPlanPrompt(opts: JiraNewTaskPromptOptions, additionalPrompt?: string): string {
  const { issueKey, issueUrl, issueSummary, issueDescription, repos, imageDir, jiraDoneTransitionId } = opts;

  const imageSection = imageDir
    ? `
## Issue Attachments

All attachments from the Jira issue have been downloaded to ${imageDir}/.
- **Images** (screenshots, mockups): study them carefully — they are the visual specification for this task.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements.
`
    : '';

  return `
You are a senior software architect planning a task for another AI agent to implement.

## Your Task

Jira issue: "${issueSummary}"
Issue URL: ${issueUrl}
Issue Key: ${issueKey}

## Issue Description

${issueDescription || '(No description provided)'}
${imageSection}
## Repository

${buildRepoSection(repos)}

## Available MCP Servers

You have one MCP server available:
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless.

There is no Jira MCP server — the issue description above is your full task specification.

## What You Must Do

1. Review the issue description above carefully — it is the complete specification
2. Clone the repo(s) into /workspace as described above
3. In each repo you will modify, create a new branch: \`git checkout -b claude/${issueKey}\`
4. Run \`mise install\` if a runtime config file exists, then install project dependencies:
   ${buildDepsInstallTable()}
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
   - **Visual Verification** (REQUIRED — skip ONLY for pure backend tasks in repos with zero frontend code):
     a. Find guide on how to run the app locally, through either repo(s) CLAUDE.md, README, or issue description
     b. Describe the steps to run the app locally, including database setup, backend, docker containers, etc.
     c. Include any authentication steps required to access the app, default credentials if available
     d. Specify exactly which pages/components to open in the browser, what interactions to perform, and what the result should look like
     e. The executor has a Playwright MCP server — write verification steps using \`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.
     f. Visual evidence is REQUIRED — the executor MUST upload final screenshot(s) to the Jira issue as proof. To upload, save with \`browser_take_screenshot\` then:
        \`\`\`bash
        ${jiraUploadScreenshotCmd(issueKey)}
        \`\`\`
        Do NOT plan for base64 encoding — it bloats the context window and causes timeouts.
     Include this upload step explicitly in the verification plan.
   - **Done Criteria**: Exact conditions that must be true for the task to be complete
   - **Completion Steps**: After the executor finishes, they should:
     ${jiraDoneTransitionId
       ? `- Transition the issue to Done: \`${jiraTransitionCmd(issueKey, jiraDoneTransitionId)}\``
       : '- Post all PR URLs as a comment on the Jira issue (see executor prompt for curl command)'}

## Critical Rules

- Do NOT write any implementation code — only the plan
- Do NOT open PRs or post Jira comments
- The plan must be specific enough that another agent can implement it without reading the issue again
- If anything in the description is ambiguous, document your interpretation in the plan
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildJiraExecutePrompt(opts: JiraNewTaskPromptOptions, additionalPrompt?: string): string {
  const { issueKey, issueUrl, issueSummary, imageDir, jiraDoneTransitionId } = opts;

  const imageSection = imageDir
    ? `
## Issue Attachments

All attachments from the Jira issue are in ${imageDir}/.
- **Images**: study them before implementing any UI changes — they are the visual specification.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements.
`
    : '';

  const doneStep = jiraDoneTransitionId
    ? `9. Transition the Jira issue to Done:
   \`\`\`bash
   ${jiraTransitionCmd(issueKey, jiraDoneTransitionId)}
   \`\`\``
    : `9. (No Done transition configured — issue will remain in its current status)`;

  return `
You are an autonomous software engineer implementing a planned task.

## Context

Jira issue: "${issueSummary}"
Issue URL: ${issueUrl}
Issue Key: ${issueKey}

The workspace is already prepared:
- The repo(s) have been cloned into /workspace (each in its own subdirectory)
- The branch \`claude/${issueKey}\` has been created and checked out in each repo that requires changes
- Runtime and dependencies have been installed
- A detailed implementation plan is at /workspace/.plan.md
${imageSection}
## Available MCP Servers

You have one MCP server available:
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless.

There is no Jira MCP server — use \`curl\` with Basic Auth to interact with the Jira API.
Credentials are available as environment variables: \`$JIRA_HOST\`, \`$JIRA_EMAIL\`, \`$JIRA_API_TOKEN\`.

${buildEnvironmentSection()}

## Steps to Complete

1. Read /workspace/.plan.md — this is your specification, follow it precisely
2. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions for code style, build commands, and conventions
3. Implement every change described in the plan
4. Run the test suite as specified in the plan — fix any failures before proceeding
5. Visual verification — follow the visual verification plan in /workspace/.plan.md. REQUIRED for any task touching frontend code, UI components, styles, or pages. Skip ONLY for purely backend tasks with zero frontend files changed:
   - Run the project locally as specified in the plan
   - Use the Playwright MCP tools (\`browser_navigate\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   - Take screenshots and verify the result looks correct
   - If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   - Do NOT commit until the UI looks right
   - **Visual evidence is REQUIRED**: after verification passes, upload the final screenshot(s) to the Jira issue:
     \`\`\`bash
     ${jiraUploadScreenshotCmd(issueKey)}
     \`\`\`
     Do NOT use base64 or browser_run_code for screenshots.
6. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
7. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "${issueSummary}" --body "<summary of changes>"\`
8. Post all PR URLs as a comment on the Jira issue:
   \`\`\`bash
   ${jiraPostCommentCmd(issueKey, 'PR: <url>')}
   \`\`\`
${doneStep}

## Important Rules

- Follow the plan — if you need to deviate, document why in the PR body
- Do NOT transition the issue to Done until all tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
${buildDockerNote(issueKey)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildJiraNewTaskPrompt(opts: JiraNewTaskPromptOptions, additionalPrompt?: string): string {
  const { issueKey, issueUrl, issueSummary, issueDescription, repos, imageDir, jiraDoneTransitionId } = opts;

  const imageSection = imageDir
    ? `
## Issue Attachments

All attachments from the Jira issue have been downloaded to ${imageDir}/.
- **Images** (screenshots, mockups): study them carefully before writing any code — they are the visual specification for this task.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements.
`
    : '';

  const doneStep = jiraDoneTransitionId
    ? `11. Transition the Jira issue to Done:
    \`\`\`bash
    ${jiraTransitionCmd(issueKey, jiraDoneTransitionId)}
    \`\`\``
    : `11. (No Done transition configured — issue will remain in its current status)`;

  return `
You are an autonomous software engineer working on a task from Jira.

## Your Task

Jira issue: "${issueSummary}"
Issue URL: ${issueUrl}
Issue Key: ${issueKey}

## Issue Description

${issueDescription || '(No description provided)'}
${imageSection}
## Available MCP Servers

You have one MCP server available:
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless.

There is no Jira MCP server — the issue description above is your full task specification.
Use \`curl\` with Basic Auth for any Jira API interactions (comments, attachments, transitions).
Credentials are available as environment variables: \`$JIRA_HOST\`, \`$JIRA_EMAIL\`, \`$JIRA_API_TOKEN\`.

## Repository

${buildRepoSection(repos)}

## Steps to Complete

1. Review the issue description above carefully — it is the complete specification
2. Clone the repo(s) into /workspace as described above
3. In each repo you will modify, create a new branch: \`git checkout -b claude/${issueKey}\`
4. In each repo, read \`CLAUDE.md\` in the root if it exists, then explore the codebase to understand its structure and conventions
5. Set up the runtime and install dependencies:
   - If a \`.mise.toml\`, \`.tool-versions\`, \`.nvmrc\`, or \`.python-version\` file exists,
     run \`mise install\` first to install the correct runtime version
   - Then install project dependencies based on what you find:
     ${buildDepsInstallTable()}
6. Implement the solution described in the issue
7. Run the project's test suite and fix any failures before proceeding
8. Visual verification — REQUIRED for any task that touches frontend code, UI components, styles, or pages. Skip ONLY if the task is purely backend with zero frontend files changed:
   a. Start the dev server (e.g. \`npm run dev\`)
   b. Use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   c. Take screenshots and verify the result looks correct
   d. If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   e. Fix, screenshot, compare — keep iterating until the UI is correct
   f. Do NOT move forward until the UI visually matches the expected result
   g. **Visual evidence is REQUIRED**: after verification passes, upload the final screenshot(s) to the Jira issue:
      \`\`\`bash
      ${jiraUploadScreenshotCmd(issueKey)}
      \`\`\`
      Do NOT use base64 or browser_run_code for screenshots.
9. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
10. For each repo with changes, push the branch and open a PR using the gh CLI:
    \`gh pr create --title "${issueSummary}" --body "<summary of changes>"\`
    Then post all PR URLs as a Jira comment:
    \`\`\`bash
    ${jiraPostCommentCmd(issueKey, 'PR: <url>')}
    \`\`\`
${doneStep}

## Important Rules

- Do NOT transition the issue to Done until tests pass
- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If anything is unclear, make a reasonable implementation choice and document it in the PR body
${buildDockerNote(issueKey)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

export function buildJiraFeedbackPrompt(opts: JiraFeedbackPromptOptions, additionalPrompt?: string): string {
  const { issueKey, issueUrl, issueSummary, commentText, commenterName, imageDir, jiraDoneTransitionId } = opts;

  const imageSection = imageDir
    ? `
## Attachments

Files from the Jira issue have been downloaded to ${imageDir}/.
- **Images**: visual specifications and reference screenshots.
- **Documents** (.md, .txt, .pdf, etc.): conventions, specs, or requirements — read them.
`
    : '';

  const doneStep = jiraDoneTransitionId
    ? `9. Transition the Jira issue back to Done:
   \`\`\`bash
   ${jiraTransitionCmd(issueKey, jiraDoneTransitionId)}
   \`\`\``
    : '';

  return `
You are an autonomous software engineer handling review feedback on a pull request.

## Feedback Received

Jira issue: "${issueSummary}"
Issue URL: ${issueUrl}
Issue Key: ${issueKey}
Reviewer: ${commenterName}
Latest comment: "${commentText}"
${imageSection}
## Available MCP Servers

You have one MCP server available:
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless.

There is no Jira MCP server — use \`curl\` with Basic Auth for Jira API interactions.
Credentials are available as environment variables: \`$JIRA_HOST\`, \`$JIRA_EMAIL\`, \`$JIRA_API_TOKEN\`.

${buildEnvironmentSection()}

## Steps to Complete

1. Read /workspace/.plan.md if it exists — it contains the original implementation plan and is essential context
2. Understand what change or fix the reviewer is asking for (the latest comment is shown above)
3. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions
4. Run \`mise install\` if a runtime config file exists, then install project dependencies
5. Implement the requested changes
6. Run the test suite and ensure all tests pass
7. Visual verification — REQUIRED for any changes that touch frontend code, UI components, styles, or pages. Skip ONLY if changes are purely backend with zero frontend files changed:
   a. Start the dev server and use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   b. Take screenshots and verify the updated UI looks correct
   c. Check /workspace/.card-images/ for any reference images and compare against them
   d. Iterate until the UI is correct — do NOT commit until it looks right
   e. **Visual evidence is REQUIRED**: after verification passes, upload the final screenshot(s) to the Jira issue:
      \`\`\`bash
      ${jiraUploadScreenshotCmd(issueKey)}
      \`\`\`
      Do NOT use base64 or browser_run_code for screenshots.
8. Commit and push your changes:
   - Check if the branch still exists on the remote: \`git ls-remote --heads origin claude/${issueKey}\`
   - If it exists: push to it (the PR should still be open)
   - If it was deleted (previous PR was merged/closed): create the branch fresh and open a new PR with \`gh pr create\`
   - Then post a summary as a Jira comment:
     \`\`\`bash
     ${jiraPostCommentCmd(issueKey, 'Done: <summary of changes>')}
     \`\`\`
${doneStep}

## Important Rules

- Only make changes directly related to the feedback
- Push to the existing branch if it still exists; if the branch was deleted, create it fresh and open a new PR
- Keep the Jira comment concise and factual — summarize what changed, nothing more
${buildDockerNote(issueKey)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

// --- Slack-originated task prompts ---

interface SlackNewTaskPromptOptions {
  taskId: string;
  taskDescription: string;
  repos: string[];
  imageDir?: string;
  trelloCardUrl?: string;
}

export function buildSlackNewTaskPrompt(opts: SlackNewTaskPromptOptions, additionalPrompt?: string): string {
  const { taskId, taskDescription, repos, imageDir, trelloCardUrl } = opts;

  const imageSection = imageDir
    ? `
## Attachments

Files shared in the Slack message have been downloaded to ${imageDir}/.
- **Images** (screenshots, mockups): study them carefully — they are the visual specification for this task.
- **Documents** (.md, .txt, .pdf, etc.): read them — they may contain conventions, specs, or requirements.
`
    : '';

  const trelloSection = trelloCardUrl
    ? `
## Linked Trello Card

A Trello card was linked in the Slack message: ${trelloCardUrl}
Use the trello MCP \`get_card\` tool to read the full card details (description, checklists, attachments) for additional context.
`
    : '';

  return `
You are an autonomous software engineer working on a task from Slack.

## Your Task

${taskDescription}
${trelloSection}${imageSection}
## Repository

${buildRepoSection(repos)}

## Available MCP Servers

You have two MCP servers available — use their tools throughout this task:
- **trello** — read cards, post comments, move cards (\`get_card\`, \`add_comment\`, \`move_card\`, etc.)${trelloCardUrl ? ' — use this to read the linked Trello card' : ' — only available if a Trello card was linked'}
- **playwright** — browser automation for visual verification (\`browser_navigate\`, \`browser_take_screenshot\`, \`browser_click\`, \`browser_type\`, \`browser_snapshot\`, etc.). Chromium is pre-installed and runs headless. Use this to verify any frontend changes.

## Steps to Complete

1. Clone the repo(s) into /workspace as described above
2. In each repo you will modify, create a new branch: \`git checkout -b claude/${taskId}\`
3. In each repo, read \`CLAUDE.md\` in the root if it exists, then explore the codebase to understand its structure and conventions
4. Set up the runtime and install dependencies:
   - If a \`.mise.toml\`, \`.tool-versions\`, \`.nvmrc\`, or \`.python-version\` file exists,
     run \`mise install\` first to install the correct runtime version
   - Then install project dependencies based on what you find:
     ${buildDepsInstallTable()}
5. Implement the solution described in the task
6. Run the project's test suite and fix any failures before proceeding
7. If this task involves any UI or frontend changes, do browser verification:
   a. Start the dev server (e.g. \`npm run dev\`)
   b. Use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   c. Take screenshots and verify the result looks correct
   d. If reference images exist in ${imageDir || '/workspace/.card-images'}/, compare against them and iterate until they match
   e. Fix, screenshot, compare — keep iterating until the UI is correct
   f. Do NOT move forward until the UI visually matches the expected result
   Skip this step only if the task is purely backend with zero UI impact.
8. Commit all changes with a clear, descriptive message (do this in each repo that has changes)
9. For each repo with changes, push the branch and open a PR using the gh CLI:
   \`gh pr create --title "<task name>" --body "<summary of changes>"\`
   If this involved UI changes, paste a final Playwright screenshot into the PR body as evidence
10. The orchestrator will post the PR URL(s) to the Slack thread — no need to post them yourself

## Important Rules

- Do NOT open a PR if there are failing tests
- Write clean, idiomatic code that matches the existing codebase style
- If anything is unclear, make a reasonable implementation choice and document it
${buildDockerNote(taskId)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}

interface SlackFeedbackPromptOptions {
  taskId: string;
  commentText: string;
  commenterName: string;
  repos: string[];
  imageDir?: string;
  trelloCardUrl?: string;
}

export function buildSlackFeedbackPrompt(opts: SlackFeedbackPromptOptions, additionalPrompt?: string): string {
  const { taskId, commentText, commenterName, imageDir, trelloCardUrl } = opts;

  const imageSection = imageDir
    ? `
## Attachments

Files from the Slack thread have been downloaded to ${imageDir}/.
- **Images**: visual specifications and reference screenshots.
- **Documents** (.md, .txt, .pdf, etc.): conventions, specs, or requirements — read them.
`
    : '';

  const trelloSection = trelloCardUrl
    ? `
## Linked Trello Card

${trelloCardUrl}
Use the trello MCP \`get_card\` and \`get_card_comments\` tools to read the card and its full comment history for additional context.
`
    : '';

  return `
You are an autonomous software engineer handling review feedback on a pull request.

## Feedback Received

Reviewer: ${commenterName}
Latest comment: "${commentText}"
${trelloSection}${imageSection}
${buildEnvironmentSection()}

## Steps to Complete

1. Read /workspace/.plan.md if it exists — it contains the original implementation plan
2. Understand what change or fix the reviewer is asking for
3. In each repo under /workspace, read \`CLAUDE.md\` in the root if it exists — it contains project-specific instructions
4. Run \`mise install\` if a runtime config file exists, then install project dependencies
5. Implement the requested changes
6. Run the test suite and ensure all tests pass
7. If this task involves any UI or frontend changes, do browser verification:
   a. Start the dev server and use the Playwright MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_take_screenshot\`, etc.) to open the relevant pages
   b. Take screenshots and verify the updated UI looks correct
   c. Check /workspace/.card-images/ for any reference images and compare against them
   d. Iterate until the UI is correct — do NOT commit until it looks right
   Skip this step only if the changes are purely backend with zero UI impact.
8. Commit and push your changes:
   - Check if the branch still exists on the remote: \`git ls-remote --heads origin claude/${taskId}\`
   - If it exists: push to it (the PR should still be open)
   - If it was deleted (previous PR was merged/closed): create the branch fresh and open a new PR with \`gh pr create\`
9. The orchestrator will post a summary reply to the Slack thread — no need to post it yourself

## Important Rules

- Only make changes directly related to the feedback
- Push to the existing branch if it still exists; if the branch was deleted, create it fresh and open a new PR
- Keep changes focused and minimal
${buildDockerNote(taskId)}
${additionalPrompt ? `\n## Additional Instructions\n\n${additionalPrompt}` : ''}`.trim();
}
