import { escapeHtml } from '../util.js';

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f1; --fg: #1b1b1b; --muted: #5f5e5a; --card: #ffffff; --line: #dedbd3; --accent: #b4532a; --accent-fg: #fff; --err-bg: #fbe9e4; --err-fg: #8a2f12; --ok-bg: #e8f3e8; --ok-fg: #1f5a2a; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ecebe6; --muted: #a4a29b; --card: #211f1c; --line: #3a3732; --accent: #e07a4f; --accent-fg: #161513; --err-bg: #3a1d15; --err-fg: #f3b8a4; --ok-bg: #1d2f20; --ok-fg: #b6e2bd; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 440px; margin: 8vh auto; padding: 0 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 22px; margin: 0 0 4px; }
p { margin: 8px 0; } .muted { color: var(--muted); font-size: 14px; }
label { display: block; font-weight: 600; margin: 18px 0 6px; font-size: 14px; }
input[type=text], input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
button, a.button { display: inline-block; margin-top: 22px; width: 100%; padding: 11px 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; }
.alert { padding: 10px 12px; border-radius: 8px; margin: 14px 0 0; font-size: 14px; }
.alert.err { background: var(--err-bg); color: var(--err-fg); } .alert.ok { background: var(--ok-bg); color: var(--ok-fg); }
code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
ul { padding-left: 20px; } li { margin: 4px 0; }
`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function loginPage(p: { txn: string; clientName: string; teamName: string; publicUrl: string; error?: string; name?: string }): string {
  return layout(
    `Sign in · ${p.teamName}`,
    `<div class="card">
      <h1>${escapeHtml(p.teamName)}</h1>
      <p class="muted"><strong>${escapeHtml(p.clientName)}</strong> wants to connect to this shared workspace on your behalf.</p>
      ${p.error ? `<div class="alert err">${escapeHtml(p.error)}</div>` : ''}
      <form method="post" action="${escapeHtml(p.publicUrl)}/login" autocomplete="off">
        <input type="hidden" name="txn" value="${escapeHtml(p.txn)}">
        <label for="credential">Invite code or personal API key</label>
        <input id="credential" name="credential" type="password" required placeholder="hv_inv_… or hv_key_…">
        <label for="name">Your name <span class="muted">(only when joining with an invite code)</span></label>
        <input id="name" name="name" type="text" maxlength="40" value="${escapeHtml(p.name ?? '')}" placeholder="e.g. Dana">
        <button type="submit">Continue</button>
      </form>
      <p class="muted" style="margin-top:18px">Members: the first time you join you get a personal API key; use it to sign in again or to connect other tools. Keep it secret.</p>
    </div>`
  );
}

export function joinedPage(p: { name: string; teamName: string; apiKey: string; continueUrl: string; clientName: string }): string {
  return layout(
    `Welcome · ${p.teamName}`,
    `<div class="card">
      <h1>Welcome, ${escapeHtml(p.name)}</h1>
      <div class="alert ok">You have joined <strong>${escapeHtml(p.teamName)}</strong>.</div>
      <p>This is your personal API key. It is shown <strong>once</strong>; save it in a password manager. Use it to sign in again later, or to connect Claude Code and scripts.</p>
      <pre>${escapeHtml(p.apiKey)}</pre>
      <a class="button" href="${escapeHtml(p.continueUrl)}">Continue to ${escapeHtml(p.clientName)}</a>
    </div>`
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`);
}

export function landingPage(p: { teamName: string; publicUrl: string; version: string }): string {
  const mcpUrl = `${p.publicUrl}/mcp`;
  return layout(
    `${p.teamName} · shared workspace`,
    `<div class="card">
      <h1>${escapeHtml(p.teamName)}</h1>
      <p class="muted">A shared knowledge base, log stream and task queue for a team of Claude agents. Server version ${escapeHtml(p.version)}.</p>
      <h2 style="font-size:16px;margin:20px 0 6px">Connect from Claude (web, desktop, mobile)</h2>
      <p>Customize → Connectors → <em>Add custom connector</em>, then paste:</p>
      <pre>${escapeHtml(mcpUrl)}</pre>
      <p class="muted">Choose "Sign in now". You will be asked for an invite code (first time) or your personal API key.</p>
      <h2 style="font-size:16px;margin:20px 0 6px">Connect from Claude Code</h2>
      <pre>claude mcp add --transport http hive ${escapeHtml(mcpUrl)}
# then inside Claude Code run /mcp and sign in, or pass a key directly:
claude mcp add --transport http hive ${escapeHtml(mcpUrl)} \\
  --header "Authorization: Bearer hv_key_…"</pre>
      <p class="muted">Need an invite? Ask a workspace admin to run the <code>invite_create</code> tool.</p>
    </div>`
  );
}
