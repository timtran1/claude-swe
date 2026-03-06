/**
 * CLI script: download all attachments (and inline description images) from a Trello card.
 * Usage: node download-images.mjs <cardId> <destDir>
 *
 * Reads TRELLO_API_KEY and TRELLO_TOKEN from environment.
 * Saves files to <destDir>; creates the directory if it doesn't exist.
 * Silently skips attachments that fail to download so one bad attachment
 * doesn't abort the whole job.
 */

import fs from 'fs';
import path from 'path';

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
const BASE = 'https://api.trello.com/1';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function authParams() {
  return `key=${API_KEY ?? ''}&token=${TOKEN ?? ''}`;
}

async function trelloFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}${authParams()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
  return res.json();
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Download a URL to destPath. Returns false if skipped (too large, error, etc.). */
async function downloadFile(url, destPath) {
  try {
    // Trello download URLs require OAuth Authorization header; query-param auth returns 401.
    const headers = url.includes('trello.com')
      ? { Authorization: `OAuth oauth_consumer_key="${API_KEY}", oauth_token="${TOKEN}"` }
      : {};
    const res = await fetch(url, { headers });
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
    console.error(`Failed to download ${url}:`, err);
    return false;
  }
}

/** Parse inline file URLs from a Trello card description or comment text. */
function extractInlineUrls(text) {
  const urls = [];

  // Markdown image links: ![alt](url)
  for (const m of text.matchAll(/!\[.*?\]\((https?:\/\/[^)]+)\)/g)) {
    urls.push(m[1]);
  }

  // Markdown regular links: [text](url) — capture Trello download URLs
  for (const m of text.matchAll(/\[.*?\]\((https?:\/\/trello\.com\/1\/cards\/[^)]+\/download\/[^)]+)\)/g)) {
    urls.push(m[1]);
  }

  // Bare Trello URLs with file extensions
  for (const m of text.matchAll(/https?:\/\/trello\.com\/\S+/g)) {
    const url = m[0].replace(/[)>.,]+$/, '');
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      if (ext) {
        urls.push(url);
      }
    } catch { /* ignore malformed URLs */ }
  }

  return [...new Set(urls)];
}

/** Download images from each comment into <commentImagesDir>/<commentId>/<filename>. */
async function downloadCommentImages(cardId, commentImagesDir) {
  const actions = await trelloFetch(`/cards/${cardId}/actions?filter=commentCard&limit=50`);
  console.log(`Found ${actions.length} comment(s) to scan for images`);

  for (const action of actions) {
    const commentId = action.id;
    const text = action.data?.text ?? '';
    const urls = extractInlineUrls(text);

    if (urls.length === 0) continue;

    const commentDir = path.join(commentImagesDir, commentId);
    fs.mkdirSync(commentDir, { recursive: true });

    let downloaded = 0;
    for (const url of urls) {
      const rawName = path.basename(new URL(url).pathname);
      const filename = sanitizeFilename(rawName) || `file-${downloaded + 1}`;
      const destPath = path.join(commentDir, filename);

      const ok = await downloadFile(url, destPath);
      if (ok) {
        console.log(`  Comment ${commentId}: downloaded ${filename}`);
        downloaded++;
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --comments <dir> flag
  let commentImagesDir = null;
  const commentsFlagIdx = args.indexOf('--comments');
  if (commentsFlagIdx !== -1) {
    commentImagesDir = args[commentsFlagIdx + 1];
    args.splice(commentsFlagIdx, 2);
  }

  const [cardId, destDir] = args;

  if (!cardId || !destDir) {
    console.error('Usage: download-images.mjs <cardId> <destDir> [--comments <commentImagesDir>]');
    process.exit(1);
  }

  if (!API_KEY || !TOKEN) {
    console.error('TRELLO_API_KEY and TRELLO_TOKEN must be set');
    process.exit(1);
  }

  console.log(`Credentials: key=${API_KEY.slice(0, 4)}... token=${TOKEN.slice(0, 4)}...`);

  fs.mkdirSync(destDir, { recursive: true });

  const [card, attachments] = await Promise.all([
    trelloFetch(`/cards/${cardId}?fields=desc`),
    trelloFetch(`/cards/${cardId}/attachments`),
  ]);

  // Download comment images into per-comment subdirectories if requested
  if (commentImagesDir) {
    fs.mkdirSync(commentImagesDir, { recursive: true });
    await downloadCommentImages(cardId, commentImagesDir);
  }

  let downloaded = 0;

  console.log(`Found ${attachments.length} attachment(s) on card`);
  for (const att of attachments) {
    const filename = sanitizeFilename(att.name) || `attachment-${downloaded + 1}`;
    const destPath = path.join(destDir, filename);

    const ok = await downloadFile(att.url, destPath);
    if (ok) {
      console.log(`Downloaded attachment: ${filename}`);
      downloaded++;
    }
  }

  const descImageUrls = extractInlineUrls(card.desc ?? '');
  let descIndex = 1;

  for (const url of descImageUrls) {
    const rawName = path.basename(new URL(url).pathname);
    const filename = sanitizeFilename(rawName) || `desc-file-${descIndex}`;
    const destPath = path.join(destDir, filename);

    const ok = await downloadFile(url, destPath);
    if (ok) {
      console.log(`Downloaded description file: ${filename}`);
      downloaded++;
      descIndex++;
    }
  }

  console.log(`Done. Downloaded ${downloaded} file(s) to ${destDir}`);
}

main().catch((err) => {
  console.error('download-images failed:', err);
  process.exit(1);
});
