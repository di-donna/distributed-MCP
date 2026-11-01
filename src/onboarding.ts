/** Copy-paste text that gets a teammate from an invite code to a connected Claude. */

/** The `claude mcp add` command for this workspace, optionally with a personal API key baked in. */
export function claudeCodeAddCommand(mcpUrl: string, apiKey?: string): string {
  const base = `claude mcp add --transport http distributed-mcp ${mcpUrl}`;
  return apiKey ? `${base} --header "Authorization: Bearer ${apiKey}"` : base;
}

function formatUtc(epochSec: number): string {
  return `${new Date(epochSec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A message the admin can send as-is (privately: it contains the invite code). */
export function inviteShareMessage(p: { teamName: string; publicUrl: string; code: string; maxUses: number; expiresAt: number | null }): string {
  const mcpUrl = `${p.publicUrl}/mcp`;
  const uses = p.maxUses === 1 ? 'single use' : `${p.maxUses} uses`;
  const expiry = p.expiresAt ? `expires ${formatUtc(p.expiresAt)}` : 'does not expire';
  return [
    `You're invited to ${p.teamName}, a shared workspace for our Claude agents.`,
    '',
    `Invite code (${uses}, ${expiry}): ${p.code}`,
    '',
    'Claude (web, desktop or mobile):',
    '  1. Customize → Connectors → Add custom connector',
    `  2. Name it "${p.teamName}" and paste the URL: ${mcpUrl}`,
    '  3. Sign in, then paste the invite code and your name',
    '  4. Save the personal API key you are shown; it signs you in next time',
    '  (On a Team or Enterprise plan where an owner already added it: open Connectors, click Connect, then step 3.)',
    '',
    'Claude Code:',
    `  ${claudeCodeAddCommand(mcpUrl)}`,
    '  then run /mcp inside Claude Code and sign in with the invite code',
    '',
    'Nothing is shared automatically. To contribute a conversation, tell Claude in it:',
    '  "share this conversation with project <name>". Your other conversations stay private.',
    '',
    `Workspace page: ${p.publicUrl}/`
  ].join('\n');
}
