// Discovery routes — public, no auth. Self-describes the service so an agent
// or developer can bootstrap without any out-of-band docs.
//
//   GET /v1/.well-known/agent-discovery   JSON descriptor (machine-readable)
//   GET /v1/discovery                      alias to the descriptor
//   GET /v1/discovery/agent-guide.md       raw markdown guide
//   GET /v1/discovery/agent-guide          HTML-wrapped markdown (renders via marked.js CDN)

const fs = require('fs');
const path = require('path');
const os = require('os');
const descriptor = require('./descriptor');

const GUIDE_FILE = path.join(__dirname, 'agent-guide.md');

function register(app) {
  app.route('GET', '/v1/.well-known/agent-discovery', (req, res) => {
    const port = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
    const host = (req.headers.host || '').split(':')[0] || os.hostname();
    app.json(res, 200, descriptor.build({ port, host }));
  });

  app.route('GET', '/v1/discovery', (req, res) => {
    const port = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
    const host = (req.headers.host || '').split(':')[0] || os.hostname();
    app.json(res, 200, descriptor.build({ port, host }));
  });

  app.route('GET', '/v1/discovery/agent-guide.md', (req, res) => {
    let body = 'agent-guide.md missing';
    try { body = fs.readFileSync(GUIDE_FILE, 'utf8'); } catch {}
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  });

  // Human view: tiny HTML shell that renders the markdown with marked.js.
  // Zero server-side markdown dep. CDN load is fine for an ops/docs page.
  app.route('GET', '/v1/discovery/agent-guide', (req, res) => {
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Meta Harness — Agent Guide</title>
<style>
  body { max-width: 840px; margin: 40px auto; padding: 0 20px 80px; font: 15px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #222; background: #fafbfc; }
  pre, code { font: 13px ui-monospace, Menlo, Consolas, monospace; }
  pre { background: #0e1628; color: #d4deea; padding: 12px 14px; border-radius: 5px; overflow-x: auto; }
  code { background: #eef2f7; padding: 1px 5px; border-radius: 3px; color: #0a3b6e; }
  pre code { background: none; color: inherit; padding: 0; }
  h1 { border-bottom: 2px solid #d4dae4; padding-bottom: 6px; margin-top: 30px; }
  h2 { border-bottom: 1px solid #e4e8ef; padding-bottom: 4px; margin-top: 26px; color: #18416e; }
  h3 { color: #18416e; margin-top: 22px; }
  table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  th, td { border: 1px solid #d4dae4; padding: 6px 10px; text-align: left; }
  th { background: #eef2f7; }
  a { color: #0a66c2; }
  blockquote { border-left: 4px solid #d4dae4; margin: 10px 0; padding: 4px 14px; color: #555; }
  .meta { color: #888; font-size: 12px; margin-bottom: 20px; }
</style>
</head><body>
<div class="meta">Rendered live from <a href="./agent-guide.md">/v1/discovery/agent-guide.md</a> · see also machine-readable <a href="../.well-known/agent-discovery">/v1/.well-known/agent-discovery</a></div>
<div id="body">Loading…</div>
<script src="https://cdn.jsdelivr.net/npm/marked@11/marked.min.js"></script>
<script>
  fetch('./agent-guide.md').then(r => r.text()).then(md => {
    document.getElementById('body').innerHTML = marked.parse(md);
  }).catch(e => {
    document.getElementById('body').textContent = 'Could not load guide: ' + e.message;
  });
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(html);
  });
}

module.exports = { register };
