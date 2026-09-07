import { connectedServices, connect, disconnect } from '../connectors.js';
import { limit as rateLimit } from '../ratelimit.js';

/**
 * Connecting a third-party account — GitHub, Notion, Slack and the rest.
 *
 * These sat physically after the workflow routes in app.js and travelled with
 * them when that group was lifted out, which put connector routes in a file
 * called workflows.js. They have nothing to do with workflows, so they are
 * their own module: a filename that lies is worse than one more file.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function }} ctx
 */
export function mountConnectorRoutes(api, { wrap }) {
    api.get(
      '/connectors',
      wrap(async (req, res) => {
        res.json({ connectors: await connectedServices(req.user.id) });
      }),
    );

    api.post(
      '/connectors/:service',
      // Each attempt makes an outbound call to a third party to verify the token;
      // without a ceiling this endpoint is a free proxy for hammering their API.
      rateLimit('connect', (req) => req.user?.id),
      wrap(async (req, res) => {
        try {
          res.json(await connect(req.user.id, req.params.service, req.body?.token));
        } catch (err) {
          res.status(400).json({ error: err.message });
        }
      }),
    );

    api.delete(
      '/connectors/:service',
      wrap(async (req, res) => {
        await disconnect(req.user.id, req.params.service);
        res.json({ ok: true });
      }),
    );
}
