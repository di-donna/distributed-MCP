import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inviteShareMessage } from '../../onboarding.js';
import { createApiKey, createInvite, listApiKeys, listInvites, listUsers, revokeApiKey, setUserRole } from '../../services/members.js';
import { defineTool, requireAdmin, type ToolContext } from '../context.js';

export function registerAdminTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    'invite_create',
    {
      title: 'Create invite',
      description:
        'ADMIN. Create an invite code a new teammate pastes on the sign-in page (Claude → Connectors → this connector → Sign in) to join the workspace. Returns share_message: complete join instructions including the code, to send to the teammate privately (show it to the user verbatim). Codes are shown once.',
      input: {
        note: z.string().optional().describe('Who this is for, e.g. "Bob"'),
        role: z.enum(['member', 'admin']).optional().describe('Default member'),
        max_uses: z.number().int().min(1).max(1000).optional().describe('Default 1'),
        expires_in_hours: z.number().positive().optional().describe('Default 168 (7 days)')
      }
    },
    ({ note, role, max_uses, expires_in_hours }) => {
      requireAdmin(ctx);
      const { invite, code } = createInvite(ctx.db, { createdBy: ctx.user.id, role, maxUses: max_uses, expiresInHours: expires_in_hours ?? 168, note });
      return {
        invite_code: code,
        invite_id: invite.id,
        role: invite.role,
        max_uses: invite.max_uses,
        expires_at: invite.expires_at,
        share_message: inviteShareMessage({ teamName: ctx.cfg.teamName, publicUrl: ctx.cfg.publicUrl, code, maxUses: invite.max_uses, expiresAt: invite.expires_at })
      };
    }
  );

  defineTool(
    server,
    'invite_list',
    { title: 'List invites', description: 'ADMIN. List invite codes (ids and usage only; the codes themselves are never shown again).', input: {}, readOnly: true, idempotent: true },
    () => {
      requireAdmin(ctx);
      return listInvites(ctx.db);
    }
  );

  defineTool(
    server,
    'member_list',
    { title: 'List members', description: 'List workspace members, their roles and when they were last active.', input: {}, readOnly: true, idempotent: true },
    () => listUsers(ctx.db)
  );

  defineTool(
    server,
    'member_set_role',
    {
      title: 'Set member role',
      description: 'ADMIN. Promote a member to admin or demote to member.',
      input: { member_id: z.string(), role: z.enum(['member', 'admin']) },
      idempotent: true
    },
    ({ member_id, role }) => {
      requireAdmin(ctx);
      setUserRole(ctx.db, member_id, role);
      return { member_id, role };
    }
  );

  defineTool(
    server,
    'apikey_create',
    {
      title: 'Create API key',
      description:
        'Create a personal API key for yourself (admins may pass member_id for someone else). Use it as "Authorization: Bearer <key>" from Claude Code, scripts or the Claude API MCP connector, or paste it on the sign-in page. Shown once.',
      input: { label: z.string().optional().describe('What this key is for, e.g. "laptop claude code"'), member_id: z.string().optional() }
    },
    ({ label, member_id }) => {
      if (member_id && member_id !== ctx.user.id) requireAdmin(ctx);
      return createApiKey(ctx.db, member_id ?? ctx.user.id, label);
    }
  );

  defineTool(
    server,
    'apikey_list',
    { title: 'List API keys', description: 'List your API keys (admins: all keys). Secrets are not included.', input: {}, readOnly: true, idempotent: true },
    () => listApiKeys(ctx.db, ctx.user.role === 'admin' ? undefined : ctx.user.id)
  );

  defineTool(
    server,
    'apikey_revoke',
    { title: 'Revoke API key', description: 'Revoke one of your API keys by id (admins: any key).', input: { key_id: z.string() }, destructive: true, idempotent: true },
    ({ key_id }) => {
      revokeApiKey(ctx.db, key_id, ctx.user.role === 'admin' ? undefined : ctx.user.id);
      return { revoked: key_id };
    }
  );
}
