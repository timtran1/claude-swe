import { config } from '../config.js';

/** Jira REST API v3 path prefix */
const API_V3 = '/rest/api/3';

/** Build Basic Auth header value from Jira email + API token */
function basicAuthHeader(): string {
  const email = config.jira.email ?? '';
  const token = config.jira.apiToken ?? '';
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

/**
 * Generic Jira REST API fetch helper with Basic Auth.
 * Throws on non-2xx responses. Returns undefined for 204 No Content.
 */
async function jiraFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const host = config.jira.host;
  if (!host) throw new Error('Jira host is not configured');

  const url = `${host}${API_V3}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': basicAuthHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Jira API error ${res.status} for ${path}: ${await res.text()}`);
  }
  // 204 No Content responses have no body
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

/**
 * Convert plain text to Atlassian Document Format (ADF) for Jira comments.
 * Jira's REST API v3 requires ADF for all rich text fields.
 */
export function textToAdf(text: string): object {
  return {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    ],
  };
}

/** File attachment metadata as returned by the Jira issue fields */
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Download URL (requires auth) */
  content: string;
}

/** Full Jira issue object with the fields we request */
export interface JiraIssueFull {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: unknown;
    status: { id: string; name: string };
    assignee: { accountId: string; displayName: string } | null;
    project: { id: string; key: string; name: string };
    attachment: JiraAttachment[];
  };
}

/**
 * Fetch a Jira issue by ID or key.
 * Requests only the fields needed by the bot to minimize payload size.
 */
export async function fetchJiraIssue(issueIdOrKey: string): Promise<JiraIssueFull> {
  return jiraFetch<JiraIssueFull>(
    `/issue/${issueIdOrKey}?fields=summary,description,status,assignee,project,attachment`,
  );
}

/**
 * Post a plain-text comment on a Jira issue.
 * Text is converted to ADF before sending, as required by the v3 API.
 */
export async function addJiraComment(issueIdOrKey: string, text: string): Promise<void> {
  await jiraFetch<void>(`/issue/${issueIdOrKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: textToAdf(text) }),
  });
}

/**
 * Transition a Jira issue to a new status using the given transition ID.
 * Use getJiraTransitions to discover valid transition IDs for an issue.
 */
export async function transitionJiraIssue(issueIdOrKey: string, transitionId: string): Promise<void> {
  await jiraFetch<void>(`/issue/${issueIdOrKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
}

/**
 * Get all available transitions for a Jira issue.
 * Transitions are issue-specific — the list depends on the current status and workflow.
 */
export async function getJiraTransitions(issueIdOrKey: string): Promise<Array<{ id: string; name: string }>> {
  const res = await jiraFetch<{ transitions: Array<{ id: string; name: string }> }>(
    `/issue/${issueIdOrKey}/transitions`,
  );
  return res.transitions;
}

/**
 * Get attachments for a Jira issue.
 * Fetches the full issue and extracts the attachment field to avoid a separate API call.
 */
export async function fetchJiraIssueAttachments(issueIdOrKey: string): Promise<JiraAttachment[]> {
  const issue = await fetchJiraIssue(issueIdOrKey);
  return issue.fields.attachment ?? [];
}

/**
 * Get the currently authenticated Jira user.
 * Used at startup to resolve the bot's account ID when not explicitly configured.
 */
export async function getJiraCurrentUser(): Promise<{ accountId: string; displayName: string; emailAddress: string }> {
  return jiraFetch<{ accountId: string; displayName: string; emailAddress: string }>('/myself');
}

/**
 * List Jira projects accessible to the authenticated user (up to 50, ordered by name).
 * Uses the paginated /project/search endpoint introduced in Jira Cloud v3.
 */
export async function getJiraProjects(): Promise<Array<{ id: string; key: string; name: string }>> {
  const res = await jiraFetch<{ values: Array<{ id: string; key: string; name: string }> }>(
    '/project/search?maxResults=50&orderBy=name',
  );
  return res.values;
}

/**
 * Get all statuses for a Jira project, deduplicated across all issue types.
 * Jira returns statuses grouped by issue type — this flattens and deduplicates them.
 */
export async function getJiraProjectStatuses(
  projectKey: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await jiraFetch<Array<{ statuses: Array<{ id: string; name: string }> }>>(
    `/project/${projectKey}/statuses`,
  );
  // Flatten statuses from all issue types, deduplicating by ID
  const seen = new Set<string>();
  const statuses: Array<{ id: string; name: string }> = [];
  for (const issueType of res) {
    for (const status of issueType.statuses) {
      if (!seen.has(status.id)) {
        seen.add(status.id);
        statuses.push(status);
      }
    }
  }
  return statuses;
}
