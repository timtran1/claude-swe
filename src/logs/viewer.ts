function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLogViewer(cardName: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(cardName)} — Worker Logs</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;height:100vh;display:flex;flex-direction:column}
    header{padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px;min-height:42px}
    h1{font-size:13px;font-weight:600;color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:#1f6feb;color:#fff;white-space:nowrap;flex-shrink:0}
    #badge.done{background:#238636}
    #badge.error{background:#da3633}
    #log{flex:1;overflow-y:auto;padding:10px 16px;line-height:1.55}
    .line{white-space:pre-wrap;word-break:break-all;padding:1px 0}
    .line.dim{color:#6e7681}
  </style>
</head><body>
  <header>
    <h1>${escapeHtml(cardName)}</h1>
    <span id="badge">● Live</span>
  </header>
  <div id="log"></div>
  <script>
    const log = document.getElementById('log');
    const badge = document.getElementById('badge');
    let atBottom = true;

    log.addEventListener('scroll', () => {
      atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    });

    function append(text, dim) {
      const d = document.createElement('div');
      d.className = 'line' + (dim ? ' dim' : '');
      d.textContent = text;
      log.appendChild(d);
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    const es = new EventSource('/logs/${token}/stream');

    es.addEventListener('log', e => append(e.data, false));

    es.addEventListener('done', () => {
      badge.textContent = '✓ Completed';
      badge.className = 'done';
      append('— worker finished —', true);
      es.close();
    });

    es.onerror = () => {
      badge.textContent = '✗ Disconnected';
      badge.className = 'error';
    };
  </script>
</body></html>`;
}
