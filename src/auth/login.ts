import express, { type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { API_KEY_PREFIX, INVITE_PREFIX, createApiKey, redeemInvite, resolveApiKey, touchUser, type User } from '../services/members.js';
import { HiveError } from '../util.js';
import { errorPage, joinedPage, loginPage } from './pages.js';
import type { HiveAuthProvider } from './provider.js';

/** Handles the sign-in form posted from the page rendered by `HiveAuthProvider.authorize`. */
export function loginRouter(db: DB, cfg: Config, provider: HiveAuthProvider): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many sign-in attempts; try again in a few minutes.'
    })
  );

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const txn = provider.getTxn(body.txn);
    if (!txn) {
      res.status(400).type('html').send(errorPage('Sign-in link expired', 'Go back to Claude and start the connection again.'));
      return;
    }
    const credential = (body.credential ?? '').trim();
    const name = (body.name ?? '').trim();
    try {
      let user: User;
      let freshKey: string | undefined;
      if (credential.startsWith(API_KEY_PREFIX)) {
        const resolved = resolveApiKey(db, credential);
        if (!resolved) throw new HiveError('That API key is not recognised (or has been revoked).');
        user = resolved.user;
      } else if (credential.startsWith(INVITE_PREFIX)) {
        if (!name) throw new HiveError('Enter your name to join with an invite code.');
        user = redeemInvite(db, credential, name);
        freshKey = createApiKey(db, user.id, `created on join via ${txn.client_name ?? 'OAuth'}`).key;
      } else {
        throw new HiveError('Enter an invite code (hv_inv_…) or your personal API key (hv_key_…).');
      }
      touchUser(db, user.id);
      const continueUrl = provider.completeLogin(txn.id, user);
      if (freshKey) {
        res
          .status(200)
          .type('html')
          .send(joinedPage({ name: user.name, teamName: cfg.teamName, apiKey: freshKey, continueUrl, clientName: txn.client_name ?? 'Claude', mcpUrl: `${cfg.publicUrl}/mcp` }));
      } else {
        res.redirect(302, continueUrl);
      }
    } catch (err) {
      const message = err instanceof HiveError ? err.message : 'Sign-in failed. Please try again.';
      res
        .status(400)
        .type('html')
        .send(loginPage({ txn: txn.id, clientName: txn.client_name ?? txn.client_id, teamName: cfg.teamName, publicUrl: cfg.publicUrl, error: message, name }));
    }
  });

  return router;
}
