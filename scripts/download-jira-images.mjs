/**
 * CLI script: download all attachments and inline description images from a Jira issue.
 * Usage: node download-jira-images.mjs <issueKey> <destDir>
 *
 * Reads JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN from environment.
 * Saves files to <destDir>; creates the directory if it doesn't exist.
 * Silently skips attachments that fail to download so one bad attachment
 * doesn't abort the whole job.
 */

import fs from 'fs';
import path from 'path';

const JIRA_HOST = process.env.JIRA_HOST ?? '';
const JIRA_EMAIL = process.env.JIRA_EMAIL ?? '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? '';

/** 10 MB — same limit as the Trello download script */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Build the Basic Auth header value from email + API token */
function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

/** Fetch a Jira REST API v3 path and return parsed JSON. Throws on non-2xx. */
async function jiraFetch(apiPath) {
  const url = `${JIRA_HOST}/rest/api/3${apiPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Jira API ${res.status} for ${apiPath}: ${await res.text()}`);
  return res.json();
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Download a URL (with Basic Auth) to destPath. Returns false if skipped or errored. */
async function downloadFile(url, destPath) {
  try {
    const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
    if (!res.ok) {
      console.error(`Download failed for ${path.basename(destPath)}: HTTP ${res.status} ${url}`);
      return false;
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_BYTES) {
      console.error(`Skipping ${path.basename(destPath)}: too large (${contentLength} bytes)`);
      return false;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_FILE_BYTES) {
      console.error(`Skipping ${path.basename(destPath)}: too large after download`);
      return false;
    }

    fs.writeFileSync(destPath, buffer);
    return true;
  } catch (err) {
    console.error(`Failed to download ${url}:`, err.message);
    return false;
  }
}

/**
 * Walk an ADF (Atlassian Document Format) tree and collect external image URLs.
 * Only handles type="external" media nodes — Jira-hosted media (type="file") requires
 * a separate authenticated media API and is skipped here.
 */
function extractAdfImageUrls(node) {
  if (!node || typeof node !== 'object') return [];
  const urls = [];

  if (node.type === 'media' && node.attrs?.type === 'external' && node.attrs?.url) {
    urls.push(node.attrs.url);
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      urls.push(...extractAdfImageUrls(child));
    }
  }

  return urls;
}

async function main() {
  const [issueKey, destDir] = process.argv.slice(2);

  if (!issueKey || !destDir) {
    console.error('Usage: download-jira-images.mjs <issueKey> <destDir>');
    process.exit(1);
  }

  if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error('JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN must be set');
    process.exit(1);
  }

  console.log(`Downloading attachments for Jira issue ${issueKey} → ${destDir}`);
  fs.mkdirSync(destDir, { recursive: true });

  let issue;
  try {
    issue = await jiraFetch(`/issue/${issueKey}?fields=attachment,description`);
  } catch (err) {
    console.error(`Failed to fetch Jira issue ${issueKey}:`, err.message);
    process.exit(1);
  }

  let downloaded = 0;

  // Download explicit attachments (files attached to the issue)
  const attachments = issue.fields.attachment ?? [];
  console.log(`Found ${attachments.length} attachment(s) on issue`);

  for (const att of attachments) {
    const filename = sanitizeFilename(att.filename) || `attachment-${downloaded + 1}`;
    const destPath = path.join(destDir, filename);

    const ok = await downloadFile(att.content, destPath);
    if (ok) {
      console.log(`Downloaded attachment: ${filename}`);
      downloaded++;
    }
  }

  // Extract and download external images embedded in the ADF description
  const descriptionAdf = issue.fields.description;
  if (descriptionAdf) {
    const imageUrls = extractAdfImageUrls(descriptionAdf);
    if (imageUrls.length > 0) {
      console.log(`Found ${imageUrls.length} inline image(s) in description`);
    }
    let descIndex = 1;
    for (const url of imageUrls) {
      let rawName;
      try {
        rawName = path.basename(new URL(url).pathname);
      } catch {
        rawName = '';
      }
      const filename = sanitizeFilename(rawName) || `desc-image-${descIndex}`;
      const destPath = path.join(destDir, filename);

      const ok = await downloadFile(url, destPath);
      if (ok) {
        console.log(`Downloaded description image: ${filename}`);
        downloaded++;
        descIndex++;
      }
    }
  }

  console.log(`Done. Downloaded ${downloaded} file(s) to ${destDir}`);
}

main().catch((err) => {
  console.error('download-jira-images failed:', err);
  process.exit(1);
});
