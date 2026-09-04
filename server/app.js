import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  loginUser,
  registerUser,
  clearSession,
  currentUser,
  requireAuth,
  requireAdmin,
  requireWorker,
  requireCron,
  signupOpen,
  requestPasswordReset,
  resetPassword,
  changePassword,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  refreshSession,
} from './auth.js';
import { limit as rateLimit, forgive } from './ratelimit.js';
import { publicUrlFor } from './util/net.js';
import { emailBackend } from './email.js';
import { summary as usageSummary, limitFor } from './usage.js';
import { getPrefs, setPrefs, setApiKey, addApiKey, removeApiKey, providerStatus } from './settings.js';
import { getStore, initStore, isServerless } from './store/index.js';
import { RUN_LEASE_STALE_MS } from './store/pg.js';
import { workerStatus, usesInProcessTools, handleIndexPayload } from './localTools.js';
import { publish, subscribe, poll, forget as forgetScreen } from './screenHub.js';
import { PROVIDERS } from './providers/catalog.js';
import {
  browse,
  refreshLibrary,
  refreshIfStale,
  addModelById,
  resolve as resolveModelId,
  auditCatalog,
} from './models.js';
import { resolveForUser } from './autoPick.js';
import { TOOLS, riskReason } from './tools/definitions.js';
import { executeTool } from './tools/execute.js';
import { runAgent, deriveTitle, needsApproval as pendingApproval } from './agent.js';
import { saveSkill } from './skills.js';
import { addSource } from './projects.js';
import {
  parseSchedule,
  runDueTasks,
  runDueTasksForUser,
  validZone,
  sweep,
} from './scheduler.js';
import { runDueWorkflows, runWorkflowNow, normaliseSteps } from './workflows.js';
import { connectedServices, connect, disconnect } from './connectors.js';
import { redactSecrets } from './redact.js';
import { withTrace, newTraceId, annotate, log, mark, since } from './util/trace.js';
import { mcpStatus, probeMcpServer, sealConfig, forgetMcp, slugify } from './mcp/registry.js';
import {
  withStorageShim,
  listArtifactStorage,
  getArtifactValue,
  setArtifactValue,
  deleteArtifactValue,
} from './artifactStorage.js';
import { searchCatalogue } from './mcp/catalogue.js';
import {
  startPairing,
  collectPairing,
  claimPairing,
  listDevices,
  revokeDevice,
  setDeviceWorkspace,
  localPairingCode,
  startEnrolment,
  previewEnrolment,
  redeemEnrolment,
} from './devices.js';
import { pendingAnnouncement, decideAnnouncement, markAnnouncementShown } from './modelNews.js';
import {
  saveUpload,
  verifyOwned,
  previewOf,
  mediaOf,
  keepStepShot,
  LIMITS as ATTACHMENT_LIMITS,
} from './attachments.js';
import { createDocument, extensionOf, RUNNABLE } from './office/index.js';
import { compact as compactChat, measure as measureContext } from './compact.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A provider's failure, in words rather than in JSON.
 *
 * What reached the screen was the raw body — `{"error":{"message":"{\n
 * \"error\": {\n \"code\": 404, …` — nested two deep because Google's SDK puts
 * the response text inside the message of its own error object. Somewhere in
 * there was the one sentence that mattered: *this model is no longer available
 * to new users*. Everything else was punctuation.
 *
 * So the JSON is unwrapped as far as it goes and the innermost message is what
 * is shown, with the model named where the provider named it. A person reading
 * this should be able to tell in one line whether to change the model, top up
 * the account, or wait.
 */
/**
 * Turn a provider failure into something a person can act on — with any
 * credential taken out of it first.
 *
 * The redaction is not belt-and-braces. A provider client that is handed a
 * malformed key reports it by quoting the value back: `Headers.append: "Bearer
 * sk-or-v1-…" is an invalid header value`. That string is emitted to the browser
 * over SSE, stored as a step's error, and read back to the model by
 * `workflow_status` — so one bad key would put itself in the conversation, in
 * the database, and in the next prompt.
 *
 * `redactSecrets` already knew every shape that matters; it was only ever wired
 * to memory writes, which is the one place a secret was *expected* to appear.
 * This is the place it appears by accident, which is the worse one.
 */
export function readableFailure(error) {
  let message = redactSecrets(String(error?.message || error || 'Something went wrong.')).text;

  // Unwrap as many layers of encoded JSON as the providers have nested.
  for (let depth = 0; depth < 4; depth += 1) {
    const start = message.indexOf('{');
    if (start === -1) break;
    let parsed;
    try {
      parsed = JSON.parse(message.slice(start));
    } catch {
      break;
    }
    const inner = parsed?.error?.message || parsed?.error?.detail || parsed?.message || parsed?.error;
    if (typeof inner !== 'string' || inner === message) break;
    message = inner;
  }

  message = message.replace(/\s+/g, ' ').trim();

  // The one failure worth rewriting: a model that is gone reads as a mistake
  // the user made, and it is not — it is a catalogue entry that expired.
  if (/no longer available|is not found|not found for api version|does not exist/i.test(message)) {
    const model = /models\/([\w.-]+)/.exec(message)?.[1];
    return (
      `${model ? `The model "${model}"` : 'That model'} is not available on this key. ` +
      `${message} — pick another model from the picker, or check Settings → Models → Check models.`
    );
  }

  return message;
}

// `public/` is also what Vercel serves straight from its CDN in a zero-config
// project, so on a deployment these static routes are only a local fallback.
const WEB_DIR = path.resolve(here, '../public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  /**
   * Trust exactly one proxy, not the whole chain.
   *
   * `true` trusts every hop in `X-Forwarded-For`, and the leftmost entry of that
   * header is whatever the *client* put there — so `req.ip` became a value the
   * caller chose. That is harmless for logging and fatal for a rate limiter: a
   * new forged address per attempt is an unlimited number of attempts.
   *
   * One hop is the truth for both deployments this app has: Vercel's edge, or a
   * Cloudflare tunnel. With nothing in front, `req.ip` is the socket address and
   * this setting changes nothing.
   */
  app.set('trust proxy', 1);
  // Attachments arrive as base64 inside the JSON body, and base64 costs a third
  // more than the bytes it carries. Six files at the 5MB-each limit is the worst
  // case this has to accept without a confusing 413.
  app.use(express.json({ limit: '48mb' }));

  /**
   * Baseline response headers.
   *
   * The app has no build step and no third-party scripts, so a strict policy
   * costs nothing here and closes the usual holes: an injected `<script>` has
   * nowhere to load from, the page cannot be framed, and a URL is never leaked
   * to another origin through the referrer.
   *
   * `'unsafe-inline'` covers the inline `style=` attributes the UI sets for
   * layout measurements; script-src has no such escape hatch, which is the half
   * that matters.
   */
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
    // Only over TLS: sending HSTS from a plain-HTTP LAN address would make the
    // phone that saw it refuse to reach the app at all.
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  /**
   * Whether a turn is live in this conversation right now.
   *
   * Measured against the same staleness the lease itself uses, so a route that
   * refuses mid-run and the claim that decides who is running can never
   * disagree — they did, by 45 seconds, and in that window a chat could be
   * claimed by a new run while still refusing message edits.
   */
  const isRunning = (chat) =>
    !!chat?.run_lock_at && Date.now() - new Date(chat.run_lock_at).getTime() < RUN_LEASE_STALE_MS;

  /** `req.body` is undefined in Express 5 when no JSON arrived — never assume it. */
  const body = (req) => req.body || {};

  /**
   * One id, in scope for everything this request goes on to do.
   *
   * An agent turn fans out through the loop, the provider adapters, the tool
   * executor, a queue the user's own machine reads, and back — and until this
   * there was nothing to join those records on. Held in `AsyncLocalStorage` so
   * no function underneath has to accept it as a parameter; threading it through
   * forty signatures is how this kind of thing gets half done and abandoned.
   *
   * A caller's own `x-request-id` is honoured so a browser can correlate its
   * side too, but never trusted verbatim: it lands in log lines, and a header is
   * whatever the caller typed.
   */
  app.use((req, res, next) => {
    const supplied = String(req.headers['x-request-id'] || '').replace(/[^\w-]/g, '').slice(0, 64);
    const requestId = supplied || newTraceId();
    res.setHeader('X-Request-Id', requestId);
    withTrace({ requestId, method: req.method, path: req.path }, () => next());
  });

  // Every request waits for the schema to be ready. On Vercel each invocation
  // may be a cold one, so this cannot happen once at startup.
  app.use(wrap(async (req, res, next) => {
    await initStore();
    next();
  }));

  /** The subset of a user row the browser is allowed to see. */
  const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: !!user.email_verified_at,
    twoFactor: !!user.totp_enabled_at,
    recoveryCodesLeft: Array.isArray(user.recovery_codes) ? user.recovery_codes.length : 0,
  });

  // ── session ─────────────────────────────────────────────────────────
  app.get(
    '/api/session',
    wrap(async (req, res) => {
      const store = getStore();
      const user = await currentUser(req).catch(() => null);
      res.json({
        authed: !!user,
        user: user ? publicUser(user) : null,
        // Drives whether the gate offers "create the first account".
        needsSetup: (await store.countUsers()) === 0,
        signupOpen: signupOpen(),
        emailBackend: emailBackend(),
      });
    }),
  );

  // Throttled on two axes at once — the caller's address and the email being
  // tried — so one person grinding one account cannot lock out an office behind
  // the same address, and a botnet spread across addresses still hits the
  // per-account ceiling.
  app.post(
    '/api/login',
    rateLimit('login', (req) => req.body?.email),
    wrap(async (req, res) => {
      try {
        const user = await loginUser(body(req), req, res);
        if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
        // A correct sign-in clears the tally, so a forgetful morning does not
        // cost somebody their afternoon.
        await forgive(req, 'login', req.body?.email);
        res.json({ user: publicUser(user) });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code });
      }
    }),
  );

  // ── password reset ──────────────────────────────────────────────────
  app.post(
    '/api/password/forgot',
    rateLimit('forgot', (req) => req.body?.email),
    wrap(async (req, res) => {
      // Always the same answer, so this cannot be used to discover who has an
      // account here.
      await requestPasswordReset(req.body?.email, req);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/password/reset',
    rateLimit('reset', (req) => req.body?.email),
    wrap(async (req, res) => {
      try {
        await resetPassword({
          token: req.body?.token,
          code: req.body?.code,
          email: req.body?.email,
          password: req.body?.password,
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── daily model-library refresh ─────────────────────────────────────
  // Called by Vercel Cron, not a browser, so it authenticates with a secret.
  app.get(
    '/api/cron/refresh-models',
    requireCron,
    wrap(async (req, res) => {
      res.json(await refreshLibrary());
    }),
  );

  // Scheduled work, for a deployment with no long-lived process to hold a
  // timer. A local run polls for itself; see server/scheduler.js.
  app.get(
    '/api/cron/run-tasks',
    requireCron,
    wrap(async (req, res) => {
      // Also the deployment's only chance to take the bins out: the local
      // scheduler sweeps on its minute tick, and a deployment has no minute
      // tick. Without this, four tables grow without bound.
      // The 300s ceiling is for the whole invocation, not per phase. Sweeping
      // and then running up to five full agent turns can spend most of it, so
      // what workflows get is what is *left* — handing them a fresh budget is
      // how the function gets killed with a run in mid-step, which is the exact
      // failure workflows exist to avoid.
      const started = Date.now();
      const remaining = () => Math.max(0, 240_000 - (Date.now() - started));

      await sweep().catch(() => {});
      // Tasks get a budget too. Without one they ran until the invocation was
      // killed, which both left a task marked mid-run and guaranteed workflows
      // inherited nothing — the very thing `remaining()` was written to prevent.
      // Two thirds to tasks, so a long queue cannot starve the workflows below.
      const ran = await runDueTasks({ budgetMs: Math.floor(remaining() * 0.66) });

      // Workflows share this heartbeat rather than adding a second cron: the
      // free tier allows one a day, and spending it twice is not an option. A
      // run that does not finish is resumed by the next nudge, not restarted.
      const workflows = await runDueWorkflows({ budgetMs: remaining() }).catch((err) => ({
        started: [],
        advanced: [],
        error: String(err?.message || err).slice(0, 200),
      }));
      res.json({ ran, workflows });
    }),
  );

  app.post(
    '/api/register',
    rateLimit('register'),
    wrap(async (req, res) => {
      try {
        const user = await registerUser(body(req), req, res);
        res.status(201).json({ user: publicUser(user), emailBackend: emailBackend() });
      } catch (err) {
        // A closed deployment is a 403, not a bad request — the client can tell
        // "you may not" from "you got that wrong" and say something useful.
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  app.post(
    '/api/logout',
    wrap(async (req, res) => {
      // Drop the stored frame on the way out. It is a photograph of the person's
      // actual desktop, and leaving it in the database for the next sign-in to
      // find is not something anybody asked for.
      const user = await currentUser(req).catch(() => null);
      if (user) {
        forgetScreen(user.id);
        await getStore().clearScreen(user.id).catch(() => {});
      }
      clearSession(res);
      res.json({ ok: true });
    }),
  );

  // ── worker relay (bearer token identifies whose computer is calling) ─
  const workerApi = express.Router();
  workerApi.use(requireWorker);

  workerApi.post(
    '/heartbeat',
    wrap(async (req, res) => {
      const { workerId, info } = req.body || {};
      const store = getStore();

      // A paired machine is identified by its device row, so the id it reports
      // is ignored in favour of the one its token proves. Only a legacy worker,
      // paired before devices existed, still names itself.
      const id = req.workerDevice?.id || workerId;
      if (!id) return res.status(400).json({ error: 'workerId is required' });

      await store.heartbeat(req.workerUser.id, id, info || {});
      await store.touchDevice(req.workerUser.id, req.workerDevice?.id, info || {});

      // The reply is how a setting made in the app reaches the machine. There is
      // no inbound connection to push it down, and there does not need to be:
      // the worker is already asking every fifteen seconds.
      const device = req.workerDevice?.id
        ? await store.getDevice(req.workerUser.id, req.workerDevice.id)
        : null;

      res.json({
        ok: true,
        account: req.workerUser.email,
        device: req.workerDevice?.name || null,
        /**
         * Which row this token belongs to.
         *
         * The worker cannot know: it only learns an id during pairing, and a
         * machine that starts with a token already saved skips pairing entirely
         * and keeps the random placeholder it generated at boot. That
         * placeholder was then what it told the browser it was — an id matching
         * no device on the account, so "work on the computer I am sitting at"
         * matched nothing and quietly did nothing at all.
         */
        deviceId: req.workerDevice?.id || null,
        config: { workspace: device?.workspace ?? null },
      });
    }),
  );

  /**
   * Long-poll so the worker reacts in well under a second without hammering the
   * database. Jobs are claimed for this worker's owner only, and — once an
   * account can hold several computers — only those addressed to this one or to
   * no one in particular.
   *
   * **How long to hold depends on whether anybody is waiting.**
   *
   * Holding a request open for 25 seconds is free on a machine you own, and it
   * is the reason a tool call feels instant. On a serverless deployment it is 25
   * seconds of billed execution — and a worker left running overnight repeats it
   * roughly 3,400 hours a month, which is not a rounding error against a free
   * tier, it is the whole allowance spent on an idle laptop.
   *
   * So an account with recent work gets the full hold, because somebody is
   * sitting there watching. An idle account is answered immediately with a
   * `sleepMs` the worker honours, and the function stops running in between.
   *
   * The cost is stated plainly rather than hidden: the *first* tool call after a
   * quiet spell can wait up to `sleepMs` extra. Every call after it is at full
   * speed, since by then the account counts as busy. Set WORKER_IDLE_SLEEP_MS=0
   * to switch the behaviour off entirely.
   */
  const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
  const IDLE_SLEEP_MS = Math.max(
    0,
    Number(process.env.WORKER_IDLE_SLEEP_MS ?? (isServerless() ? 4000 : 0)) || 0,
  );

  workerApi.get(
    '/jobs',
    wrap(async (req, res) => {
      const store = getStore();
      const deviceId = req.workerDevice?.id || null;

      if (IDLE_SLEEP_MS > 0) {
        const lastAt = await store.recentJobAt(req.workerUser.id).catch(() => null);
        const busy = lastAt && Date.now() - lastAt.getTime() < ACTIVE_WINDOW_MS;
        if (!busy) {
          // One claim before sleeping, so a job queued in the gap is not made to
          // wait for the sleep it just missed.
          const job = await store.claimJob(req.workerUser.id, deviceId);
          return res.json(job ? { job } : { job: null, sleepMs: IDLE_SLEEP_MS });
        }
      }

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !req.socket.destroyed) {
        const job = await store.claimJob(req.workerUser.id, deviceId);
        if (job) return res.json({ job });
        await new Promise((r) => setTimeout(r, 600));
      }
      res.json({ job: null });
    }),
  );

  // A frame from the account's browser sandbox or desktop mirror. The reply
  // tells the worker whether anyone actually has the panel open, so an
  // unwatched machine stops burning bandwidth on nobody.
  workerApi.post(
    '/screen',
    wrap(async (req, res) => {
      const { frame, ...meta } = req.body || {};
      const { watching } = await publish(req.workerUser.id, frame, meta);
      res.json({ ok: true, watching });
    }),
  );

  // Chunked documents from the machine, on their way to being embedded. The
  // token says whose files these are, and that is the only account they can ever
  // be stored under or searched from.
  workerApi.post(
    '/index',
    wrap(async (req, res) => {
      try {
        res.json(await handleIndexPayload(req.workerUser.id, req.body || {}));
      } catch (err) {
        // The worker turns this into the tool's error text, so it has to say
        // something a person can act on — "add an OpenAI key", not "HTTP 500".
        res.status(400).json({ error: err.message });
      }
    }),
  );

  workerApi.post(
    '/jobs/:id/result',
    wrap(async (req, res) => {
      const { output, error, shot } = req.body || {};
      await getStore().completeJob(req.workerUser.id, req.params.id, {
        status: error ? 'error' : 'done',
        // The picture is stored as an attachment and referenced by id — never
        // written into this row. A browsing session is dozens of these, and
        // inlining them would put megabytes of base64 into the transcript that
        // gets read back on every reload.
        result: error ? { error } : { output, ...(shot ? { shot: await keepStepShot(req.workerUser.id, shot) } : {}) },
      });
      res.json({ ok: true });
    }),
  );

  app.use('/api/worker', workerApi);

  // ── pairing a computer ──────────────────────────────────────────────
  //
  // These two are deliberately unauthenticated, because a computer that has
  // never been paired has nothing to authenticate with. They are also the only
  // unauthenticated endpoints that write anything, so be precise about what they
  // can do: ask to be adopted, and ask whether anyone has adopted them. Neither
  // names an account, reads anything, or has any effect until somebody who *is*
  // signed in types the code into the app.
  app.post(
    '/api/pair/start',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { id, code, expiresInSec } = await startPairing({
        deviceName: req.body?.name,
        info: req.body?.info,
      });
      res.status(201).json({ id, code, expiresInSec });
    }),
  );

  app.get(
    '/api/pair/poll',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const outcome = await collectPairing(req.query.id);
      // The token is in here exactly once, on the one poll that follows the
      // claim. After that the pairing row is gone and this answers 'unknown'.
      res.json(outcome);
    }),
  );

  /**
   * Redeem a setup link. Unauthenticated because the token *is* the credential —
   * the same reasoning as the two routes above, and the same rate limit.
   *
   * Two phases through one endpoint, and the split is the security design rather
   * than an API convenience. Without `confirm` it answers "this token belongs to
   * someone@example.com" and spends nothing, so the installer can put that name
   * in front of a human before anything happens. An enrolment token travels
   * *toward* a machine, which means it can be handed to somebody who was told it
   * does something else — and the only defence against that is making sure the
   * person at the keyboard is told exactly whose account is about to be given
   * the run of their computer. Answering "no" must not cost them the token.
   */
  app.post(
    '/api/pair/enrol',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { token, confirm, name, info } = req.body || {};
      try {
        if (!confirm) return res.json(await previewEnrolment(token));

        const { device, token: deviceToken } = await redeemEnrolment(token, { name, info });
        res.status(201).json({ token: deviceToken, deviceId: device.id, name: device.name });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── everything below requires a session ─────────────────────────────
  const api = express.Router();
  api.use(requireAuth);

  api.get(
    '/bootstrap',
    wrap(async (req, res) => {
      const store = getStore();
      const prefs = await getPrefs(req.user.id);

      /**
       * Remember which clock this person keeps.
       *
       * `schedule_task` and `workflow_write` run inside an agent turn, where
       * there is no request carrying a zone, so they fell back to the server's —
       * UTC on a deployment, and seven hours wrong for anyone in Vietnam.
       * Written only when it has actually changed, so the common case is a read.
       */
      const zone = validZone(req.query?.tz) ? String(req.query.tz) : null;
      if (zone && zone !== prefs.timezone) {
        prefs.timezone = zone;
        await setPrefs(req.user.id, { timezone: zone }).catch(() => {});
      }

      const [providers, worker, usage, library] = await Promise.all([
        providerStatus(req.user.id),
        workerStatus(req.user, prefs),
        usageSummary(req.user.id),
        store.modelLibraryStatus(),
      ]);
      res.json({
        user: publicUser(req.user),
        usage: { ...usage, limit: limitFor(req.user) },
        prefs,
        providers,
        providerMeta: PROVIDERS,
        library,
        tools: TOOLS.map(({ name, scope, readOnly, description }) => ({
          name,
          scope,
          readOnly,
          description,
        })),
        worker,
        // So the browser can refuse an oversized file before spending a minute
        // uploading it, and word the refusal the same way the server would.
        attachments: ATTACHMENT_LIMITS,
        runtime: {
          storage: store.kind,
          serverless: isServerless(),
          localMachine: !!store.local,
          // So the Computers tab can print the one command that actually works
          // on this deployment, with its address already filled in.
          publicUrl: publicUrlFor(req),
        },
      });
    }),
  );

  /**
   * Just the worker indicator.
   *
   * The browser polls this every twenty seconds to keep one dot honest. It used
   * to poll `/bootstrap` for that — five queries, the provider table and the
   * model-library status, to decide the colour of a circle.
   *
   * Note the path. Anything under `/api/worker/` belongs to the relay router
   * mounted above, whose first act is to demand a bearer token — so a
   * session-authenticated route living there answers 401 to a browser that is
   * perfectly well signed in, and no route below it is ever reached.
   */
  api.get(
    '/devices/status',
    wrap(async (req, res) => {
      res.json({ worker: await workerStatus(req.user, await getPrefs(req.user.id)) });
    }),
  );

  api.put(
    '/prefs',
    wrap(async (req, res) => {
      const allowed = [
        'defaultModel',
        'effort',
        'maxSteps',
        'toolPolicy',
        'systemPrompt',
        'activeDevice',
        'autoCompact',
        'autoPreview',
        'language',
        'onboarded',
      ];
      const patch = {};
      for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
      if ('autoPreview' in patch) patch.autoPreview = !!patch.autoPreview;
      if (patch.maxSteps != null) patch.maxSteps = Math.min(Math.max(Number(patch.maxSteps) || 30, 1), 100);
      try {
        res.json(await setPrefs(req.user.id, patch));
      } catch (err) {
        // A rejected language is the caller's mistake, not a server fault.
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.put(
    '/providers/:provider/key',
    wrap(async (req, res) => {
      await setApiKey(req.user.id, req.params.provider, String(req.body?.apiKey || '').trim());
      res.json(await providerStatus(req.user.id));
    }),
  );

  /**
   * A spare key, behind the ones already there.
   *
   * Several keys per provider is not a convenience — it is what keeps a turn
   * from failing when one of them runs out mid-afternoon. They are tried in
   * order; see `streamCompletion`.
   */
  api.post(
    '/providers/:provider/keys',
    wrap(async (req, res) => {
      try {
        await addApiKey(req.user.id, req.params.provider, String(req.body?.apiKey || '').trim());
        res.status(201).json(await providerStatus(req.user.id));
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/providers/:provider/keys/:position',
    wrap(async (req, res) => {
      try {
        // The interface counts from one, the store counts from zero.
        // `Number.parseInt`, not `Number`: `Number('undefined') - 1` is NaN, and
        // NaN passes every range check below it before `splice(NaN, 1)` coerces
        // to `splice(0, 1)` — silently destroying the account's *first* key and
        // answering 200. See the matching guard in `removeApiKey`.
        await removeApiKey(req.user.id, req.params.provider, Number.parseInt(req.params.position, 10) - 1);
        res.json(await providerStatus(req.user.id));
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── the model library ───────────────────────────────────────────────
  api.get(
    '/models',
    wrap(async (req, res) => {
      // Self-healing: if the daily refresh has not landed, catch up quietly
      // rather than showing a stale or empty list.
      await refreshIfStale();
      res.json(
        await browse({
          query: req.query.q,
          family: req.query.family,
          tier: req.query.tier,
          sort: req.query.sort,
          limit: req.query.limit,
          provider: req.query.provider,
        }),
      );
    }),
  );

  api.post(
    '/models',
    wrap(async (req, res) => {
      try {
        // Verified against OpenRouter's live catalogue before it is stored, so
        // a typo cannot poison the shared list for everyone else.
        const model = await addModelById(req.body?.id, req.user.id);
        res.status(201).json({ model });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * What one model can do, for the interface to warn with.
   *
   * The composer needs to know whether the chosen model can be shown a picture
   * *before* somebody attaches one — because about half the catalogue cannot,
   * and sending one anyway does not produce a worse answer, it makes the
   * provider reject the whole request.
   */
  api.get(
    '/models/resolve',
    wrap(async (req, res) => {
      try {
        const entry = await resolveModelId(String(req.query.id || ''));
        res.json({
          model: {
            id: entry.id,
            label: entry.label,
            context: entry.context ?? null,
            vision: entry.vision !== false,
            // So the chip can say "free" and offer the swap. A free model is the
            // default for a new account now, and somebody whose long job stalls
            // on a rate limit deserves to know which kind of model they are on
            // rather than concluding the app is broken.
            isFree: !!entry.tags?.includes('free') || (entry.price?.in === 0 && entry.price?.out === 0),
            maxOutput: entry.maxOutput ?? null,
          },
        });
      } catch (err) {
        res.status(404).json({ error: err.message });
      }
    }),
  );

  /**
   * "There is a new model." Answered on every page load, so it is deliberately
   * cheap and deliberately quiet: null unless there is genuinely something this
   * account has not already been told about and turned down.
   */
  api.get(
    '/models/news',
    wrap(async (req, res) => {
      // The library refreshing itself is what makes this daily. If the cron has
      // not landed, catch up first rather than announcing yesterday's news.
      await refreshIfStale().catch(() => {});
      res.json({ model: await pendingAnnouncement(req.user.id) });
    }),
  );

  api.post(
    '/models/news',
    wrap(async (req, res) => {
      try {
        /**
         * "It is on their screen now" — not a decision, just an acknowledgement.
         *
         * The quiet period used to start when the announcement was *fetched*, so
         * a response nobody saw spent it and the account was never told. The
         * browser reports back once the dialog is actually up.
         */
        if (req.body?.action === 'shown') {
          await markAnnouncementShown(req.user.id);
          return res.json({ ok: true, shown: true });
        }
        const outcome = await decideAnnouncement(req.user.id, req.body?.id, req.body?.action);
        // Taking it means using it — being told about a model and then having to
        // go and find it in a picker is a half-finished feature.
        const prefs = outcome.applied
          ? await setPrefs(req.user.id, { defaultModel: outcome.model.id })
          : await getPrefs(req.user.id);
        res.json({ ...outcome, prefs });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * Which built-in models this account can actually use.
   *
   * Listing is not enough: Google still lists `gemini-2.5-flash` and answers a
   * call to it with "no longer available to new users", which is how a dead
   * model reaches somebody as a wall of JSON halfway through a sentence. So
   * every entry is called with the smallest request the provider accepts —
   * one token in, one token out — with this account's own key.
   */
  api.post(
    '/models/audit',
    wrap(async (req, res) => {
      res.json({ checked: await auditCatalog(req.user.id) });
    }),
  );

  api.post(
    '/models/refresh',
    wrap(async (req, res) => {
      try {
        res.json(await refreshLibrary());
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    }),
  );

  // ── account ─────────────────────────────────────────────────────────
  api.patch(
    '/account',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      const updated = await getStore().updateUser(req.user.id, { name });
      res.json({ user: publicUser(updated) });
    }),
  );

  api.post(
    '/account/password',
    wrap(async (req, res) => {
      try {
        await changePassword(req.user, { current: req.body?.current, next: req.body?.next });
        // The change signed out every session, including this one. Re-issue the
        // cookie for the browser that did it, so doing the right thing does not
        // bounce you to the sign-in screen.
        await refreshSession(req, res, req.user.id);
        res.json({ ok: true, signedOutOtherDevices: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.get(
    '/account/usage',
    wrap(async (req, res) => {
      res.json({ ...(await usageSummary(req.user.id)), limit: limitFor(req.user) });
    }),
  );

  // ── two-factor ──────────────────────────────────────────────────────
  api.post(
    '/account/2fa/setup',
    wrap(async (req, res) => {
      const { secret, uri, qr } = await beginTotpSetup(req.user);
      // The secret is returned once so it can be typed in by hand when a camera
      // is not an option; it is stored encrypted either way.
      res.json({ secret, uri, qr });
    }),
  );

  api.post(
    '/account/2fa/confirm',
    rateLimit('totp', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const codes = await confirmTotpSetup(req.user, req.body?.code);
        res.json({ ok: true, recoveryCodes: codes });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.post(
    '/account/2fa/disable',
    rateLimit('totp', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        await disableTotp(req.user, { password: req.body?.password, code: req.body?.code });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── the live screen ─────────────────────────────────────────────────
  //
  // Held open, one connection per watching tab. Frames are pushed as they are
  // captured rather than fetched on a timer, which is what lets a video look
  // like a video instead of a slideshow.
  //
  // `hd` is the panel asking for more pixels because it is showing them full
  // screen. It travels back to the worker on the reply to the next frame, which
  // is the one channel that already exists in that direction.
  const wantsHd = (req) => req.query.hd === '1';

  api.get('/screen/live', (req, res) => {
    subscribe(req.user.id, req, res, { hd: wantsHd(req) });
  });

  // The fallback, for serverless (where the frame came from another instance)
  // and for anything without EventSource.
  api.get(
    '/screen',
    wrap(async (req, res) => {
      res.json(await poll(req.user.id, { hd: wantsHd(req) }));
    }),
  );

  /**
   * The user's own click, forwarded into the sandbox.
   *
   * Watching something go wrong and being unable to touch it is worse than not
   * watching, so the panel is not a photograph — you can reach through it.
   * Coordinates are normalised, so a phone showing a scaled mirror still lands
   * where you tapped.
   *
   * Local runs only: reaching the sandbox through the job queue would take a
   * second per click, which is not a pointer, it is a telegram.
   */
  api.post(
    '/screen/input',
    wrap(async (req, res) => {
      if (!usesInProcessTools(req.user)) {
        return res.status(400).json({
          error: 'Driving the sandbox by hand needs the server on the same machine as the browser.',
        });
      }
      try {
        const { userInput } = await import('../worker/browser.js');
        res.json({ ok: true, did: await userInput(req.body || {}) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // Shut the sandbox from the panel. The assistant closing it when it is done
  // is the normal path; this is for when the user simply wants it gone, without
  // having to ask and wait for a turn.
  api.post(
    '/screen/close',
    wrap(async (req, res) => {
      try {
        const output = await executeTool({
          user: req.user,
          name: 'browser_close',
          input: {},
          chatId: null,
        });
        // Nothing is being mirrored any more, so the last frame is not a live
        // view — it is a stale photograph of a page. Drop it.
        forgetScreen(req.user.id);
        await getStore().clearScreen(req.user.id).catch(() => {});
        res.json({ ok: !output.isError, message: output.content });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── worker pairing ──────────────────────────────────────────────────
  /**
   * ── the computers on this account ───────────────────────────────────
   *
   * There used to be a second way in here: generate an account-wide token, paste
   * it into a file on the machine, restart. It is gone. One token per account
   * meant adding a second computer silently cut off the first, it took six steps
   * and a text editor, and every one of those steps was a place to give up.
   * Pairing does the same job in eight characters.
   *
   * Tokens issued under the old scheme still authenticate — see
   * `getUserByWorkerToken` — so nothing that was working stops.
   */
  api.get(
    '/devices',
    wrap(async (req, res) => {
      res.json({
        devices: await listDevices(req.user.id),
        // Present only when the app and an unpaired worker are the same machine,
        // which is the ordinary case for somebody who just ran `npm start`. It
        // saves reading eight characters off a terminal and mistyping them.
        localCode: localPairingCode(),
      });
    }),
  );

  /** Adopt the computer showing this code. */
  api.post(
    '/devices/pair',
    rateLimit('pair', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const { device } = await claimPairing(req.user.id, req.body?.code, { name: req.body?.name });
        // The token itself goes to the computer, never to the browser — it is
        // the machine's credential, not the page's.
        res.status(201).json({ device: { id: device.id, name: device.name } });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * Where this computer should work.
   *
   * Changed from the app rather than by editing a file on the machine and
   * restarting it, which is what it used to take — absurd for a thing whose
   * point is being driven from a phone. The worker adopts it on its next
   * heartbeat, within fifteen seconds.
   */
  api.put(
    '/devices/:id/workspace',
    wrap(async (req, res) => {
      try {
        const device = await setDeviceWorkspace(req.user.id, req.params.id, req.body?.path);
        res.json({ device: { id: device.id, name: device.name, wanted: device.workspace } });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * A setup link for a computer that is not paired yet.
   *
   * Returns the whole command rather than just the token, because the command is
   * what somebody actually needs — it contains this deployment's address, and
   * asking a person to assemble it from parts is how the old instructions went
   * wrong in the first place.
   *
   * The token goes in an environment variable, never interpolated into the
   * script body. A script assembled by string-joining a parameter and then piped
   * into `iex` runs whatever that parameter contains.
   */
  api.post(
    '/devices/enrolment',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { token, expiresInSec } = await startEnrolment(req.user.id);
      const base = publicUrlFor(req);
      // Where the machine gets the code from. Deployments are forks, so this is
      // a setting rather than a constant — but it is the operator's setting, not
      // anything a request can influence.
      const repo = process.env.REPO_URL || 'https://github.com/Dansnyzzz/AI-remote.git';

      res.status(201).json({
        expiresInSec,
        windows:
          `$env:AIR_TOKEN='${token}'; $env:AIR_SERVER='${base}'; $env:AIR_REPO='${repo}'; ` +
          `irm ${base}/setup.ps1 | iex`,
        unix:
          `AIR_TOKEN='${token}' AIR_SERVER='${base}' AIR_REPO='${repo}' ` +
          `bash -c "$(curl -fsSL ${base}/setup.sh)"`,
      });
    }),
  );

  api.delete(
    '/devices/:id',
    wrap(async (req, res) => {
      try {
        const gone = await revokeDevice(req.user.id, req.params.id);
        // Its jobs would otherwise sit pending for a machine that can no longer
        // collect them, and the agent would wait out the full timeout on each.
        await getStore().cancelJobsForDevice(req.user.id, req.params.id);
        res.json({ ok: true, name: gone.name });
      } catch (err) {
        res.status(404).json({ error: err.message });
      }
    }),
  );

  // ── projects ────────────────────────────────────────────────────────
  //
  // Every route resolves the project through the signed-in account, so an id
  // guessed or borrowed from somewhere else finds nothing rather than finding
  // somebody's documents.
  api.get(
    '/projects',
    wrap(async (req, res) => {
      // `?archived=1` asks for the other shelf. Archived projects are never
      // folded into the main list — that is the whole point of archiving one.
      const archived = req.query.archived === '1' || req.query.archived === 'true';
      res.json({ projects: await getStore().listProjects(req.user.id, { archived }) });
    }),
  );

  api.post(
    '/projects',
    wrap(async (req, res) => {
      const name = String(req.body?.name || '').trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: 'A project needs a name.' });
      const project = await getStore().createProject(req.user.id, {
        id: crypto.randomUUID(),
        name,
        instructions: String(req.body?.instructions || '').slice(0, 20_000),
        grounded: req.body?.grounded !== false,
      });
      res.status(201).json({ project });
    }),
  );

  /** The project, its sources and its conversations — one round trip. */
  api.get(
    '/projects/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const project = await store.getProject(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      const [files, chats] = await Promise.all([
        store.listProjectFiles(req.user.id, project.id),
        store.listProjectChats(req.user.id, project.id),
      ]);
      /**
       * The notes the assistant has saved for this account.
       *
       * Shown on a project page, and labelled as what it is: memory here is
       * per *account*, not per project — one set of durable notes that every
       * conversation reads, whichever project it belongs to. A card promising
       * project memory that quietly showed account memory would be the kind of
       * small lie nobody catches until it matters.
       */
      const notes = (await store.getUserSetting(req.user.id, 'memory')) || {};
      const memory = Object.entries(notes)
        .map(([key, note]) => ({ key, content: String(note?.content ?? ''), updatedAt: note?.updatedAt || null }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 12);

      res.json({ project, files, chats, memory });
    }),
  );

  api.patch(
    '/projects/:id',
    wrap(async (req, res) => {
      const patch = {};
      if (req.body?.name != null) {
        const name = String(req.body.name).trim().slice(0, 120);
        if (!name) return res.status(400).json({ error: 'A project needs a name.' });
        patch.name = name;
      }
      if (req.body?.instructions != null) patch.instructions = String(req.body.instructions).slice(0, 20_000);
      if (req.body?.grounded != null) patch.grounded = !!req.body.grounded;
      if (req.body?.pinned != null) patch.pinned = !!req.body.pinned;
      if (req.body?.archived != null) patch.archived = !!req.body.archived;

      const project = await getStore().updateProject(req.user.id, req.params.id, patch);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      res.json({ project });
    }),
  );

  api.delete(
    '/projects/:id',
    wrap(async (req, res) => {
      // The conversations survive: they are a record of work, and deleting a
      // folder should not delete what was said inside it. `ON DELETE SET NULL`
      // simply returns them to the ordinary list.
      await getStore().deleteProject(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  api.post(
    '/projects/:id/files',
    wrap(async (req, res) => {
      try {
        const file = await addSource(req.user.id, req.params.id, req.body || {});
        res.status(201).json({ file });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/projects/:id/files/:fileId',
    wrap(async (req, res) => {
      await getStore().deleteProjectFile(req.user.id, req.params.fileId);
      res.json({ ok: true });
    }),
  );

  // ── skills, schedules, connectors ───────────────────────────────────
  api.get(
    '/skills',
    wrap(async (req, res) => {
      res.json({ skills: await getStore().listSkills(req.user.id) });
    }),
  );

  api.post(
    '/skills',
    wrap(async (req, res) => {
      try {
        res.status(201).json({ skill: await saveSkill(req.user.id, req.body || {}) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.patch(
    '/skills/:id',
    wrap(async (req, res) => {
      const skill = await getStore().setSkillEnabled(req.user.id, req.params.id, !!req.body?.enabled);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      res.json({ skill });
    }),
  );

  api.delete(
    '/skills/:id',
    wrap(async (req, res) => {
      await getStore().deleteSkill(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  api.get(
    '/tasks',
    wrap(async (req, res) => {
      res.json({ tasks: await getStore().listTasks(req.user.id) });
    }),
  );

  /**
   * Run this account's overdue tasks now.
   *
   * Called by the browser on load, on a deployment only, and deliberately not
   * awaited by it — see `runDueTasksForUser`. The request is held open for as
   * long as the work takes because that is precisely what stops a serverless
   * host freezing the instance halfway through a task.
   *
   * Scoped to the caller. A user request must never sweep everybody's queue:
   * that is the cron endpoint's job, and it has its own secret.
   */
  api.post(
    '/tasks/run-due',
    wrap(async (req, res) => {
      if (!isServerless()) {
        // A local run has a timer of its own ticking every minute.
        return res.json({ ran: [], skipped: 'the local scheduler handles this' });
      }
      const ran = await runDueTasksForUser(req.user.id);
      // Same reasoning, scoped to the caller: this is the only thing that moves
      // a half-finished workflow along between one daily cron and the next.
      const workflows = await runDueWorkflows({ userId: req.user.id, limit: 2 }).catch(() => null);
      res.json({ ran, workflows });
    }),
  );

  api.post(
    '/tasks',
    wrap(async (req, res) => {
      try {
        // Check before writing, not after: the old order created the row and
        // *then* returned 400, leaving an empty task scheduled to run forever.
        const prompt = String(req.body?.prompt || '').trim();
        if (!prompt) return res.status(400).json({ error: 'Say what the task should do.' });

        // The browser sends its own zone, because "17:00" means the user's five
        // o'clock. Without it the server's clock decided, which on a deployment
        // is UTC — seven hours out for anyone in Vietnam, silently.
        const tz = validZone(req.body?.tz) ? req.body.tz : null;
        const { cron, nextRunAt } = parseSchedule(req.body?.when, {
          once: req.body?.repeat === false,
          tz,
        });
        const prefs = await getPrefs(req.user.id);
        const task = await getStore().createTask(req.user.id, {
          id: crypto.randomUUID(),
          title: String(req.body?.title || '').trim() || 'Scheduled task',
          prompt,
          model: req.body?.model || prefs.defaultModel,
          cron,
          nextRunAt,
          tz,
        });
        res.status(201).json({ task });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.patch(
    '/tasks/:id',
    wrap(async (req, res) => {
      const task = await getStore().setTaskEnabled(req.user.id, req.params.id, !!req.body?.enabled);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ task });
    }),
  );

  api.delete(
    '/tasks/:id',
    wrap(async (req, res) => {
      await getStore().deleteTask(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  /* ── workflows ──────────────────────────────────────────────────────
   *
   * Session auth throughout, scoped to `req.user.id` on every store call. An id
   * in the path is never trusted to say whose row it is — it only narrows the
   * query that is already scoped, which is what makes a missing row a 404
   * rather than a leak that it exists for somebody else.
   */

  api.get(
    '/workflows',
    wrap(async (req, res) => {
      // One query, not one per workflow. "Which step is it on" is the question
      // this page exists to answer, so the last run has to come with the list —
      // and fetching them in a loop is the N+1 CLAUDE.md §7 names by name.
      const rows = await getStore().listWorkflowsWithLastRun(req.user.id);
      const workflows = rows.map(({ run_id: runId, run_status, run_steps, run_chat_id, run_cursor, run_started_at, run_finished_at, ...wf }) => ({
        ...wf,
        lastRun: runId
          ? {
              id: runId,
              status: run_status,
              steps: run_steps,
              chat_id: run_chat_id,
              cursor: run_cursor,
              started_at: run_started_at,
              finished_at: run_finished_at,
            }
          : null,
      }));
      res.json({ workflows });
    }),
  );

  api.get(
    '/workflows/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const workflow = await store.getWorkflow(req.user.id, req.params.id);
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
      res.json({ workflow, runs: await store.listWorkflowRuns(req.user.id, workflow.id, 10) });
    }),
  );

  api.post(
    '/workflows',
    wrap(async (req, res) => {
      try {
        // Validate before writing. The task route learned this the hard way: the
        // old order created the row and then returned 400, leaving something
        // empty scheduled to run forever.
        const steps = normaliseSteps(req.body?.steps);
        const tz = validZone(req.body?.tz) ? req.body.tz : null;

        // A workflow with no schedule is legitimate — it is one you run by hand.
        let cron = null;
        let nextRunAt = null;
        if (req.body?.when) {
          ({ cron, nextRunAt } = parseSchedule(req.body.when, { once: req.body?.repeat === false, tz }));
        }

        const prefs = await getPrefs(req.user.id);
        const workflow = await getStore().createWorkflow(req.user.id, {
          id: crypto.randomUUID(),
          title: String(req.body?.title || '').trim() || 'Workflow',
          steps,
          model: req.body?.model || prefs.defaultModel,
          cron,
          tz,
          nextRunAt,
        });
        res.status(201).json({ workflow });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.patch(
    '/workflows/:id',
    wrap(async (req, res) => {
      try {
        const patch = {};
        if (req.body?.title !== undefined) patch.title = String(req.body.title).trim() || 'Workflow';
        if (req.body?.steps !== undefined) patch.steps = normaliseSteps(req.body.steps);
        if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
        if (req.body?.model !== undefined) patch.model = req.body.model || null;

        if (req.body?.when !== undefined) {
          const tz = validZone(req.body?.tz) ? req.body.tz : null;
          if (req.body.when) {
            const { cron, nextRunAt } = parseSchedule(req.body.when, {
              once: req.body?.repeat === false,
              tz,
            });
            Object.assign(patch, { cron, tz, nextRunAt });
          } else {
            // Clearing the schedule leaves the workflow, and it is run by hand.
            Object.assign(patch, { cron: null, nextRunAt: null });
          }
        }

        const workflow = await getStore().updateWorkflow(req.user.id, req.params.id, patch);
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
        res.json({ workflow });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/workflows/:id',
    wrap(async (req, res) => {
      await getStore().deleteWorkflow(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  /**
   * Run one now, and carry it as far as this invocation can.
   *
   * The request is held open while steps execute, for the same reason
   * `/tasks/run-due` is: on a serverless host the instance is frozen once the
   * response is sent, and a workflow abandoned mid-step is exactly the state
   * this whole feature exists to avoid. What does not fit in the budget is left
   * durably at its cursor for the next nudge.
   */
  api.post(
    '/workflows/:id/run',
    wrap(async (req, res) => {
      try {
        const run = await runWorkflowNow(req.user.id, req.params.id);
        res.json({ run });
      } catch (err) {
        // 409 for "already running" — the client can say something true about
        // it, which a flat 400 would not let it do.
        res.status(err.status || (err.message === 'No such workflow.' ? 404 : 400)).json({ error: err.message });
      }
    }),
  );

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

  /* ── MCP servers ──────────────────────────────────────────────────────
   *
   * The one thing to keep in mind reading these: a stdio MCP server is an
   * arbitrary program, and these routes are how it gets named. So the command
   * comes from a signed-in person typing it into their own settings, every row is
   * scoped by `req.user.id`, and nothing the model produces reaches here. A model
   * that could add an MCP server would have a shell with no prompt in front of it.
   */
  /**
   * Servers worth suggesting.
   *
   * The panel asks for a command, and somebody who has never seen an MCP server
   * has nothing to type. This is the list that turns that into a button — every
   * entry a real install command, several of them read off this machine's own
   * Claude Code plugin cache rather than remembered from documentation.
   */
  api.get(
    '/mcp/catalogue',
    wrap(async (req, res) => {
      res.json({ servers: searchCatalogue(req.query.q, Number(req.query.limit) || 12) });
    }),
  );

  api.get(
    '/mcp',
    wrap(async (req, res) => {
      const rows = await getStore().listMcpServers(req.user.id);
      // `config` may hold encrypted secrets; the browser gets the shape and never
      // the ciphertext, the same rule the provider keys follow.
      const servers = rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled !== false,
        transport: row.config?.transport === 'http' ? 'http' : 'stdio',
        command: row.config?.command ?? null,
        args: row.config?.args ?? [],
        url: row.config?.url ?? null,
        hasHeaders: !!row.config?.headersCipher,
        hasEnv: !!row.config?.envCipher,
        createdAt: row.created_at,
      }));

      // What is actually reachable right now, and why not when it is not. Asked
      // for here rather than remembered, because "it worked when I added it" is
      // exactly the state that goes stale.
      const status = await mcpStatus(req.user.id).catch(() => ({ servers: [] }));
      res.json({ servers, status: status.servers });
    }),
  );

  api.post(
    '/mcp',
    wrap(async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Give the server a name.' });

      /**
       * Two servers must not slug to the same prefix.
       *
       * Tools are advertised as `mcp__<slug>__<tool>`, so "Figma" and "Figma!"
       * both become `figma` — and the registry connects both, stores both under
       * one key, and pushes both sets of tools with identical names. A tool list
       * containing duplicate names is rejected outright by Anthropic and OpenAI,
       * so **every message in every conversation** then failed until one server
       * was removed. `callMcpTool` routes by the same slug, so whichever
       * connection survived also received calls meant for the other.
       *
       * Checked here because this is where a person can still be told why.
       */
      const slug = slugify(name);
      if (!slug) {
        return res.status(400).json({ error: 'That name has no letters or digits in it — give it a plain name.' });
      }
      const existing = await getStore().listMcpServers(req.user.id);
      const clash = existing.find((row) => slugify(row.name) === slug);
      if (clash) {
        return res.status(400).json({
          error: `"${name}" and the server you already have called "${clash.name}" would both be addressed as "${slug}", and their tools would collide. Pick a name that differs by more than punctuation.`,
        });
      }

      const transport = req.body?.transport === 'http' ? 'http' : 'stdio';

      /**
       * A stdio server is administrator-only, whatever ALLOW_MCP_STDIO says.
       *
       * `api.use(requireAuth)` is the only guard on this router, so this route
       * was reachable by *any* signed-in account — and a stdio server is not a
       * URL, it is "spawn this program on the server". The child inherits the
       * server's whole environment, ENCRYPTION_KEY included, which is the key
       * every account's stored provider keys are encrypted under. One ordinary
       * account could therefore read every other account's credentials.
       *
       * The env flag was carrying this alone, and it is the wrong shape for it:
       * it answers "is this machine allowed to spawn things", not "is this
       * person allowed to decide what". Both questions have to be yes.
       *
       * Nothing is lost on the deployment the flag was written for. .env.example
       * says to set it only on a single-owner machine you trust, and on such a
       * machine the owner is the administrator. http servers are unaffected:
       * they are screened for private addresses and spawn nothing.
       */
      if (transport === 'stdio' && req.user?.role !== 'admin') {
        return res.status(403).json({
          error:
            'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can add one. An http server works for any account.',
        });
      }

      const config = { transport };
      if (transport === 'stdio') {
        config.command = String(req.body?.command || '').trim();
        if (!config.command) return res.status(400).json({ error: 'Give the command that starts the server.' });
        config.args = Array.isArray(req.body?.args) ? req.body.args.map(String) : [];
        if (req.body?.env && typeof req.body.env === 'object') config.env = req.body.env;
      } else {
        config.url = String(req.body?.url || '').trim();
        try {
          const parsed = new URL(config.url);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
        } catch {
          return res.status(400).json({ error: 'Give an http(s) URL for the server.' });
        }
        if (req.body?.headers && typeof req.body.headers === 'object') config.headers = req.body.headers;
      }

      /**
       * Try it before storing it.
       *
       * Saving a server that cannot start puts a permanent error into somebody's
       * settings for them to discover later, mid-task. Failing here means the
       * message arrives while they are still looking at the thing they typed.
       */
      let probe;
      try {
        probe = await probeMcpServer(config);
      } catch (err) {
        return res.status(400).json({ error: `That server did not start: ${err.message}` });
      }

      const saved = await getStore().saveMcpServer(req.user.id, {
        id: req.body?.id || crypto.randomUUID(),
        name,
        config: sealConfig(config),
        enabled: req.body?.enabled !== false,
      });
      // The cached connections are keyed by slug, and the set has changed.
      forgetMcp(req.user.id);

      return res.status(201).json({
        server: { id: saved.id, name: saved.name, enabled: saved.enabled },
        found: probe,
      });
    }),
  );

  api.patch(
    '/mcp/:id',
    wrap(async (req, res) => {
      const existing = await getStore().getMcpServer(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: 'No such MCP server.' });

      /**
       * Switching a stdio server back on is the same act as adding one — only a
       * server that is enabled is ever connected (see registry.js) — so it needs
       * the same check. Without it, a row created before that rule existed could
       * be disabled and re-enabled straight past it.
       */
      const enabling = req.body?.enabled !== false;
      if (enabling && existing.config?.transport !== 'http' && req.user?.role !== 'admin') {
        return res.status(403).json({
          error:
            'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can switch one on.',
        });
      }

      const updated = await getStore().setMcpServerEnabled(req.user.id, req.params.id, req.body?.enabled !== false);
      forgetMcp(req.user.id);
      return res.json({ server: { id: updated.id, name: updated.name, enabled: updated.enabled } });
    }),
  );

  api.delete(
    '/mcp/:id',
    wrap(async (req, res) => {
      await getStore().deleteMcpServer(req.user.id, req.params.id);
      forgetMcp(req.user.id);
      res.json({ ok: true });
    }),
  );

  // ── photos and files ────────────────────────────────────────────────
  api.post(
    '/attachments',
    wrap(async (req, res) => {
      try {
        const saved = await saveUpload(req.user.id, {
          name: req.body?.name,
          mime: req.body?.mime,
          data: req.body?.data,
        });
        // The bytes are never echoed back — the browser already has the file it
        // just picked, and a round trip of the same megabytes helps nobody.
        res.status(201).json({ attachment: saved });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * The bytes: a thumbnail, a PDF in the viewer's frame, or a download.
   *
   * Three things are decided here rather than by the file itself.
   *
   * **What it is served as.** An uploaded .html or .svg served back with its own
   * content type is a script running on this origin, with this session's cookie
   * — a stored cross-site scripting hole with the app's own hands on it. Only
   * the types that are safe to render are echoed; everything else is served as
   * `application/octet-stream` and forced to download, which is what a person
   * wanted from a .docx anyway.
   *
   * **Whether it may be framed.** The app-wide headers forbid framing entirely,
   * which is right for pages and wrong for the PDF viewer — so this response
   * relaxes `frame-ancestors` to same-origin, and nothing else.
   *
   * **`?download=1`** switches the disposition to an attachment and turns off
   * the inline rendering, which is the Save button in the viewer.
   */
  const INLINE_SAFE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;

  /**
   * A filename for the `Content-Disposition` header.
   *
   * The plain `filename=` parameter is bytes, not Unicode, so "Báo cáo.docx"
   * either mangles or breaks the header depending on the client. The ASCII
   * fallback goes there and the real name goes in `filename*`, which every
   * browser released this decade prefers.
   */
  const asciiFilename = (name) =>
    String(name)
      .replace(/[\\"]/g, '')
      .replace(/[^ -~]/g, '_') || 'file';

  api.get(
    '/attachments/:id',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const wantsDownload = req.query.download === '1' || req.query.download === 'true';
      const inline = !wantsDownload && INLINE_SAFE.test(file.mime);

      res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
      /**
       * An upload never changes, so a browser that has it never needs to ask
       * again. A document the assistant wrote does change — `update_file`
       * rewrites it in place, keeping its id — and `immutable` on that is how
       * somebody downloads yesterday's quotation from today's link and never
       * finds out.
       */
      res.setHeader(
        'Cache-Control',
        file.origin === 'generated'
          ? 'private, no-cache, must-revalidate'
          : 'private, max-age=31536000, immutable',
      );
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      // Replaces the page policy for this response: a binary asset has no
      // scripts, styles or images of its own, and the viewer needs to frame it.
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(Buffer.from(file.data, 'base64'));
    }),
  );

  /**
   * An artifact, running.
   *
   * This is the one route in the application that deliberately serves something
   * executable, so it is worth being precise about what stops it reaching
   * anything: the response carries `Content-Security-Policy: sandbox
   * allow-scripts` and **not** `allow-same-origin`. That single omission is the
   * whole security model. The page runs in an opaque origin — it has no access
   * to this app's cookies, storage, or API, and a `fetch` from it arrives
   * unauthenticated as a cross-origin request from `null`. It can compute and
   * draw; it cannot reach the account that made it.
   *
   * Everything else is belt and braces: no network at all (`connect-src 'none'`),
   * no framing by anyone but this app, and the viewer sandboxes the iframe a
   * second time from its side.
   *
   * Only files the assistant generated are runnable. An uploaded page is
   * somebody else's HTML and is never executed — see the download route.
   */
  /**
   * Storage for a running artifact.
   *
   * Reached by the *page* through `postMessage` to its parent, never directly —
   * the frame has an opaque origin and `connect-src 'none'`, so it could not call
   * this if it tried. The browser makes the call on its behalf, which is what puts
   * the session cookie on it.
   *
   * The artifact id comes from the URL, and the interface supplies it from the
   * frame it created rather than from anything the page said. A page naming its own
   * storage bucket would be a page that can read another artifact's data.
   */
  api.get(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const all = await listArtifactStorage(req.user.id, req.params.id);
      if (req.query.key == null) {
        // The whole bucket, decoded, for `storage.list()`.
        const out = {};
        for (const [key, encoded] of Object.entries(all)) {
          try {
            out[key] = JSON.parse(encoded);
          } catch {
            out[key] = null;
          }
        }
        return res.json({ values: out });
      }
      const raw = await getArtifactValue(req.user.id, req.params.id, String(req.query.key));
      try {
        return res.json({ value: raw == null ? null : JSON.parse(raw) });
      } catch {
        return res.json({ value: null });
      }
    }),
  );

  api.put(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      try {
        const count = await setArtifactValue(req.user.id, req.params.id, req.body?.key, req.body?.value);
        return res.json({ ok: true, keys: count });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      // No key means clear the artifact's whole bucket.
      const count = await deleteArtifactValue(req.user.id, req.params.id, req.query.key ?? null);
      res.json({ ok: true, keys: count });
    }),
  );

  api.get(
    '/attachments/:id/run',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      if (file.origin !== 'generated' || !RUNNABLE.has(extensionOf(file.name))) {
        return res.status(400).json({
          error: 'Only a page the assistant wrote can be run. Uploaded files are shown as source.',
        });
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          // Inline is the point: an artifact is one self-contained file.
          "script-src 'unsafe-inline' 'unsafe-eval' blob:",
          "style-src 'unsafe-inline'",
          "img-src data: blob:",
          "font-src data:",
          // It computes and draws. It does not call anything.
          "connect-src 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
          // No `allow-same-origin`: an opaque origin with no way back here.
          'sandbox allow-scripts allow-modals allow-popups-to-escape-sandbox',
        ].join('; '),
      );
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(withStorageShim(Buffer.from(file.data, 'base64').toString('utf8')));
    }),
  );

  /**
   * Rewrite an artifact by hand.
   *
   * The same road `update_file` takes, opened to the person rather than only to
   * the assistant — because "change that one number" should not require asking
   * for it in prose and waiting for a turn.
   */
  api.patch(
    '/attachments/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const file = await store.getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      if (file.origin !== 'generated') {
        return res.status(400).json({ error: 'That file was uploaded, so there is no source to rewrite.' });
      }

      try {
        const built = createDocument({
          format: extensionOf(file.name),
          name: String(req.body?.name || file.name),
          content: String(req.body?.content ?? ''),
        });
        const saved = await store.replaceAttachment(req.user.id, req.params.id, {
          data: built.buffer.toString('base64'),
          bytes: built.buffer.length,
          source: built.source,
          name: built.name,
          mime: built.mime,
        });
        res.json({ file: saved });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/attachments/:id',
    wrap(async (req, res) => {
      const removed = await getStore().deleteGeneratedFile(req.user.id, req.params.id);
      if (!removed) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    }),
  );

  /* ── the workspace, from the interface ──────────────────────────────
   *
   * The assistant has been able to read, write and edit files on the user's
   * machine since the beginning; the person sitting in front of it could only
   * ask. These routes close that gap, and they close it through exactly the
   * same door: every one runs a worker tool, so the workspace confinement, the
   * symlink resolution and the per-account queue scoping are inherited rather
   * than reimplemented. There is no second path to somebody's disk.
   *
   * What is deliberately *not* inherited is the approval policy. That exists to
   * gate what the assistant does on its own initiative; a person pressing Save
   * in their own file browser has already decided.
   */
  const workspaceTool = async (req, name, input) => {
    const { content, isError } = await executeTool({ user: req.user, name, input });
    if (isError) throw Object.assign(new Error(content), { status: 400 });
    return content;
  };

  /** A worker tool that answers in JSON, parsed. */
  const workspaceJson = async (req, name, input) => {
    const raw = await workspaceTool(req, name, input);
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(raw || 'The worker returned something unreadable.'), { status: 502 });
    }
  };

  const workspaceRoute = (handler) =>
    wrap(async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    });

  api.get(
    '/workspace',
    workspaceRoute(async (req, res) => {
      res.json(await workspaceJson(req, 'fs_browse', { path: String(req.query.path || '.') }));
    }),
  );

  api.get(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      res.json(await workspaceJson(req, 'fs_read_text', { path: String(req.query.path || '') }));
    }),
  );

  /** Save, or create — `write_file` makes the parent folders either way. */
  api.put(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      const path = String(req.body?.path || '').trim();
      if (!path) throw Object.assign(new Error('Which file?'), { status: 400 });
      const message = await workspaceTool(req, 'write_file', { path, content: String(req.body?.content ?? '') });
      res.json({ ok: true, message });
    }),
  );

  /** Rename, or move — the same operation, and the same tool. */
  api.post(
    '/workspace/move',
    workspaceRoute(async (req, res) => {
      const from = String(req.body?.from || '').trim();
      const to = String(req.body?.to || '').trim();
      if (!from || !to) throw Object.assign(new Error('Move what, and where to?'), { status: 400 });
      const message = await workspaceTool(req, 'move_file', { from, to, overwrite: !!req.body?.overwrite });
      res.json({ ok: true, message });
    }),
  );

  /** Search across the files, grouped by the file each hit is in. */
  api.get(
    '/workspace/search',
    workspaceRoute(async (req, res) => {
      const query = String(req.query.q || '').trim();
      if (!query) throw Object.assign(new Error('Search for what?'), { status: 400 });
      res.json(
        await workspaceJson(req, 'fs_search', {
          query,
          path: String(req.query.path || '.'),
          glob: req.query.glob ? String(req.query.glob) : undefined,
        }),
      );
    }),
  );

  api.delete(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      const path = String(req.query.path || '').trim();
      if (!path) throw Object.assign(new Error('Which file?'), { status: 400 });
      const message = await workspaceTool(req, 'delete_file', {
        path,
        recursive: req.query.recursive === '1',
      });
      res.json({ ok: true, message });
    }),
  );

  /** Everything the assistant has made on this account, newest first. */
  api.get(
    '/files',
    wrap(async (req, res) => {
      res.json({ files: await getStore().listAllGeneratedFiles(req.user.id, 200) });
    }),
  );

  /**
   * A file as something the browser can draw.
   *
   * Word, Excel and PowerPoint are read on the server and handed over as
   * structure — headings and runs, sheets of cells, slides of bullets — rather
   * than as a file the browser has no way to open. It is the same reading the
   * model is given, which is the point: what you can see and what it knows are
   * one thing, so "it says something different from what I am looking at" cannot
   * happen quietly.
   */
  api.get(
    '/attachments/:id/preview',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const meta = {
        id: file.id,
        name: file.name,
        mime: file.mime,
        kind: file.kind,
        bytes: file.bytes,
        origin: file.origin || 'upload',
        createdAt: file.created_at,
        // Only for something the assistant wrote: the Markdown it was built
        // from, so the viewer can show and edit the source rather than a
        // rendering of it.
        source: file.origin === 'generated' ? file.source || null : null,
      };

      try {
        res.json({ file: meta, preview: await previewOf(file) });
      } catch (err) {
        // A corrupt or password-protected document is an answer, not a 500 —
        // the viewer says what happened and still offers the download.
        res.json({ file: meta, preview: { kind: 'unreadable', message: err.message } });
      }
    }),
  );

  /**
   * Open a conversation's file on the machine, or show it in a folder.
   *
   * A document the assistant made lives here, not on anybody's disk, so the
   * worker is asked to write it out first and then hand it to the desktop —
   * which is what "Open in Word" has to mean when the file was never local.
   *
   * The approval policy is deliberately not consulted: that gates what the
   * assistant does on its own initiative, and this is a person pressing a
   * button about a file already open in front of them. What *is* enforced,
   * on the worker, is that a program is never handed to the shell.
   */
  api.post(
    '/attachments/:id/open',
    workspaceRoute(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const how = req.body?.how === 'folder' ? 'folder' : 'open';
      res.json(
        // `data` is already base64 in the store, which is what the worker wants.
        await workspaceJson(req, 'fs_reveal', { name: file.name, data: file.data, how }),
      );
    }),
  );

  /**
   * One picture out of a document.
   *
   * The preview's `<img src>` points here. Same ownership check as everything
   * else — an id from somebody else's account finds nothing — and the same
   * locked-down policy as the other binary route: a figure out of a stranger's
   * .docx is served as bytes with no scripts, styles or frames of its own.
   */
  api.get(
    '/attachments/:id/media/:index',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const picture = mediaOf(file, req.params.index);
      if (!picture) return res.status(404).json({ error: 'No such picture in this document.' });

      res.setHeader('Content-Type', picture.contentType);
      // The document itself may be rewritten, but picture *n* of the copy that
      // produced this preview never changes — and the preview is re-fetched
      // whenever it does.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(picture.data);
    }),
  );

  /**
   * The earlier drafts of a file the assistant wrote.
   *
   * Listed newest-first with the current one at the top, so the switcher can be
   * drawn from a single response. `?revision=` shows one of them; POST restores
   * it, which is itself a rewrite and so files the current copy as yet another
   * version — going back is never destructive.
   */
  api.get(
    '/attachments/:id/versions',
    wrap(async (req, res) => {
      const store = getStore();
      const file = await store.getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const past = await store.listAttachmentVersions(req.user.id, file.id);
      res.json({
        // `revision` counts drafts, so the live file is one past the last saved
        // one. Numbering it separately would put two different "v3"s on screen.
        current: past.length + 1,
        versions: [
          { revision: past.length + 1, name: file.name, bytes: file.bytes, createdAt: file.created_at, live: true },
          ...past.map((v) => ({
            revision: v.revision,
            name: v.name,
            bytes: v.bytes,
            createdAt: v.created_at,
            live: false,
          })),
        ],
      });
    }),
  );

  api.get(
    '/attachments/:id/versions/:revision',
    wrap(async (req, res) => {
      const past = await getStore().getAttachmentVersion(req.user.id, req.params.id, req.params.revision);
      if (!past) return res.status(404).json({ error: 'There is no such version of this file.' });

      const meta = {
        id: past.attachment_id,
        name: past.name,
        mime: past.mime,
        kind: past.kind,
        bytes: past.bytes,
        origin: 'generated',
        createdAt: past.created_at,
        source: past.source || null,
        revision: past.revision,
      };
      try {
        // A distinct id for the parse cache. Sharing the live file's id would
        // leave an old draft's text cached against it, and the next question
        // about the document would be answered from the version somebody
        // happened to look at.
        res.json({ file: meta, preview: await previewOf({ ...past, id: `${past.attachment_id}#v${past.revision}` }) });
      } catch (err) {
        res.json({ file: meta, preview: { kind: 'unreadable', message: err.message } });
      }
    }),
  );

  /** Put an earlier draft back, as a new one. Nothing is lost either way. */
  api.post(
    '/attachments/:id/versions/:revision/restore',
    wrap(async (req, res) => {
      const store = getStore();
      const past = await store.getAttachmentVersion(req.user.id, req.params.id, req.params.revision);
      if (!past) return res.status(404).json({ error: 'There is no such version of this file.' });

      const file = await store.replaceAttachment(req.user.id, req.params.id, {
        data: past.data,
        bytes: past.bytes,
        source: past.source,
        name: past.name,
        mime: past.mime,
      });
      if (!file) return res.status(404).json({ error: 'Not found' });
      res.json({ file });
    }),
  );

  /** Which application would open it — so the button can say so beforehand. */
  api.get(
    '/attachments/:id/opener',
    workspaceRoute(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      res.json(await workspaceJson(req, 'fs_describe', { name: file.name }));
    }),
  );

  // ── chats ───────────────────────────────────────────────────────────
  api.get(
    '/chats',
    wrap(async (req, res) => {
      res.json({ chats: await getStore().listChats(req.user.id) });
    }),
  );

  api.post(
    '/chats',
    wrap(async (req, res) => {
      const prefs = await getPrefs(req.user.id);
      const store = getStore();

      // A conversation may only be filed under a project of your own — the id
      // comes from a browser, and an id is a thing somebody can type.
      const projectId = req.body?.projectId ? String(req.body.projectId) : null;
      if (projectId && !(await store.getProject(req.user.id, projectId))) {
        return res.status(404).json({ error: 'No such project.' });
      }

      const chat = await store.createChat(req.user.id, {
        id: crypto.randomUUID(),
        title: req.body?.title || 'New chat',
        model: req.body?.model || prefs.defaultModel,
        projectId,
      });
      res.status(201).json({ chat });
    }),
  );

  // Declared before `/chats/:id`, or Express reads "search" as a chat id.
  api.get(
    '/chats/search',
    wrap(async (req, res) => {
      const query = String(req.query.q || '').trim();
      if (query.length < 2) return res.json({ chats: [] });
      res.json({ chats: await getStore().searchChats(req.user.id, query) });
    }),
  );

  api.get(
    '/chats/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });

      const messages = await store.listMessages(req.user.id, req.params.id);

      /**
       * Whether reopening this conversation should show the approval bar.
       *
       * The browser used to decide this on its own and got it wrong: it marked
       * every trailing tool call as needing a yes, including under policies
       * where the server would never have asked. The risk rules live on the
       * server, so the answer does too.
       */
      const last = messages[messages.length - 1];
      let pending = null;
      if (last?.role === 'assistant' && last.toolCalls?.length) {
        const prefs = await getPrefs(req.user.id);
        const gated = pendingApproval(last.toolCalls, prefs.toolPolicy);
        if (gated.length) {
          pending = last.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            input: c.input,
            needsApproval: gated.some((p) => p.id === c.id),
            reason: riskReason(c.name, c.input),
          }));
        }
      }

      // How full the window is, so the gauge is right the moment a conversation
      // opens rather than only after the next turn.
      let context = null;
      try {
        // The account's model, not the one stored on the conversation — the gauge
        // has to be measured against the window the next turn will actually use.
        const entry = await resolveForUser(req.user.id, (await getPrefs(req.user.id)).defaultModel);
        context = measureContext(messages, entry);
      } catch {
        /* an unresolvable model is the model picker's problem, not the gauge's */
      }

      // Which project this conversation answers under. The header says so:
      // "grounded in six documents" is not something to have to remember.
      let project = null;
      if (chat.project_id) {
        const found = await store.getProject(req.user.id, chat.project_id);
        if (found) {
          const files = await store.listProjectFiles(req.user.id, found.id);
          project = { id: found.id, name: found.name, grounded: found.grounded, files: files.length };
        }
      }

      // Everything the assistant made here, so reopening a conversation brings
      // the documents back with it rather than leaving them buried in the
      // transcript at the point they were written.
      const files = await store.listGeneratedFiles(req.user.id, req.params.id);

      res.json({ chat, messages, pendingApproval: pending, context, project, files });
    }),
  );

  /** Just the files, for refreshing the shelf without reloading a conversation. */
  api.get(
    '/chats/:id/files',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      res.json({ files: await store.listGeneratedFiles(req.user.id, req.params.id) });
    }),
  );

  api.patch(
    '/chats/:id',
    wrap(async (req, res) => {
      const patch = {};
      for (const key of ['title', 'model', 'pinned']) if (key in (req.body || {})) patch[key] = req.body[key];

      const chat = await getStore().updateChat(req.user.id, req.params.id, patch);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      res.json({ chat });
    }),
  );

  api.delete(
    '/chats/:id',
    wrap(async (req, res) => {
      await getStore().deleteChat(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  api.post(
    '/chats/:id/messages',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;
      const chat = await store.getChat(req.user.id, chatId);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });

      const text = String(req.body?.text || '').trim();

      let files;
      try {
        // Ownership checked here, not trusted: the ids come from the browser.
        files = await verifyOwned(req.user.id, req.body?.attachments);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // A photo on its own is a perfectly good message — "what is this?" is
      // implied, and demanding a caption first would be pedantry.
      if (!text && !files.length) {
        return res.status(400).json({ error: 'Type something, or attach a file.' });
      }

      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        text,
        ...(files.length ? { attachments: files } : {}),
      };
      await store.appendMessage(req.user.id, chatId, message);
      await store.attachToChat(req.user.id, chatId, files.map((f) => f.id));

      // The first message doubles as the title until the user renames it.
      const existing = await store.listMessages(req.user.id, chatId);
      if (existing.length === 1 || chat.title === 'New chat') {
        const title = text || files.map((f) => f.name).join(', ');
        await store.updateChat(req.user.id, chatId, { title: deriveTitle(title) });
      }
      res.status(201).json({ message });
    }),
  );

  /**
   * Edit something you said, and ask again from there.
   *
   * Refused mid-run: the messages after this one are about to be deleted, and
   * deleting them out from under a run in progress would leave the agent
   * writing into a conversation that no longer has a place for it.
   */
  api.patch(
    '/chats/:id/messages/:messageId',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (isRunning(chat)) {
        return res.status(409).json({ error: 'This conversation is running. Stop it first.' });
      }

      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'A message cannot be empty.' });

      try {
        const message = await store.editUserMessage(req.user.id, req.params.id, req.params.messageId, text);
        if (!message) return res.status(404).json({ error: 'Message not found' });
        res.json({ message });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  /**
   * Fold the older turns up now, rather than waiting for the ceiling.
   *
   * The automatic one runs when the window is nearly full; this is for choosing
   * the moment yourself — finishing one piece of work and wanting a clean slate
   * without losing what was decided.
   */
  api.post(
    '/chats/:id/compact',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;
      const chat = await store.getChat(req.user.id, chatId);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      /**
       * Not while a turn is running.
       *
       * The message-edit route has always refused mid-run, for exactly the
       * reason this one needed to and did not: writing a summary between an
       * assistant turn and the tool message answering it means the next turn's
       * `activeTranscript` slices from the summary, and that assistant turn plus
       * its results vanish from what the model sees.
       */
      if (isRunning(chat)) {
        return res.status(409).json({ error: 'This conversation is running. Stop it first.' });
      }

      const prefs = await getPrefs(req.user.id);
      const messages = await store.listMessages(req.user.id, chatId);
      // The account's model. Folding a conversation up has to be measured and
      // performed against the window the next turn will run in. Through
      // resolveForUser so Auto expands to the free model it would actually pick.
      const entry = await resolveForUser(req.user.id, prefs.defaultModel);

      try {
        const summary = await compactChat({
          userId: req.user.id,
          chatId,
          entry,
          prefs,
          messages,
        });
        if (!summary) {
          return res.status(400).json({ error: 'There is not enough here yet to be worth folding up.' });
        }
        res.json({
          summary: { id: summary.id, text: summary.text, replaced: summary.replaced },
          context: measureContext([...messages, summary], entry),
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── the agent stream ────────────────────────────────────────────────
  /**
   * Stop whatever is running in this conversation.
   *
   * The browser already aborts its own fetch, which closes the socket and ends
   * the run through `res.on('close')`. This exists because that path is not
   * guaranteed: a proxy that buffers, or a host that holds the connection open
   * after the client has gone, can delay the close indefinitely — and a stop
   * that only *usually* stops is not a stop. It is also the only way to end a
   * run started by a tab that has since been closed.
   *
   * Clearing the lease is the signal. The invocation doing the work finds out on
   * its next heartbeat (15s at the outside) and aborts; a second press is
   * harmless, and so is pressing it when nothing is running.
   */
  api.post(
    '/chats/:id/stop',
    wrap(async (req, res) => {
      const store = getStore();
      if (!(await store.getChat(req.user.id, req.params.id))) {
        return res.status(404).json({ error: 'Chat not found' });
      }
      res.json({ stopped: await store.stopChatRun(req.user.id, req.params.id) });
    }),
  );

  api.post(
    '/chats/:id/run',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;

      // Checked before the lock, so somebody else's conversation reads as
      // missing rather than as busy — "already running" would be a small,
      // needless confirmation that it exists.
      if (!(await store.getChat(req.user.id, chatId))) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      /**
       * One agent loop per conversation at a time.
       *
       * Two tabs on the same chat used to start two loops that both appended to
       * the same transcript, and the result was a conversation with its turns
       * shuffled together. The lock is a lease in the database, so it holds
       * across serverless instances as well as tabs.
       *
       * The id comes from the *client*, and that detail is what makes this work
       * on a deployment at all. A hosted run is routinely killed at the function
       * timeout, which means the `finally` below never runs and the lease is
       * still held when the browser reconnects a moment later to continue. With
       * a fresh id per request that reconnect is refused by the lock meant to
       * protect it; with a stable one per *run*, the browser re-enters its own
       * lease and a second tab is still kept out.
       */
      const runId = /^[0-9a-f-]{36}$/i.test(String(req.body?.runId || ''))
        ? req.body.runId
        : crypto.randomUUID();

      /**
       * Which holding of the lease this invocation is.
       *
       * A reconnection with the same `runId` is allowed back in — that is what
       * makes resuming work — but it now *supersedes* the invocation it is
       * replacing rather than joining it. The one it replaced fails its next
       * heartbeat and aborts, so only one loop is ever appending to the
       * transcript. See `claimChatRun`.
       */
      const runSeq = await store.claimChatRun(req.user.id, chatId, runId);
      if (!runSeq) {
        return res.status(409).json({
          error: 'This conversation is already running somewhere else. Wait for it, or stop it there.',
          code: 'already_running',
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Stops Vercel's edge and nginx from buffering the stream into one blob.
        'X-Accel-Buffering': 'no',
      });

      // Watch the *response* for close, not the request: `req` emits 'close'
      // as soon as its body has been consumed, which would abort every run
      // the moment it started.
      const controller = new AbortController();
      res.on('close', () => controller.abort());

      const emit = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      };

      /**
       * Idle SSE connections get culled by proxies. The same tick renews the run
       * lease, so a genuinely long turn keeps its claim while a dead one lets go.
       *
       * It is also how a stop becomes certain rather than likely. Aborting the
       * browser's fetch closes the socket, and `res.on('close')` above catches
       * that — most of the time. Behind a buffering proxy, or on a host that
       * keeps the connection open after the client has gone, it can arrive late
       * or never, and the loop carries on spending money on an answer nobody
       * will read. `/stop` takes the lease away instead; this notices within one
       * tick and aborts for a fact.
       */
      const ping = setInterval(() => {
        emit('ping', { t: Date.now() });
        store
          .touchChatRun(req.user.id, chatId, runId, runSeq)
          .then((held) => {
            if (held === false) controller.abort();
          })
          .catch(() => {});
      }, 15_000);

      // Whose turn this is, and which one, on every line the loop emits from
      // here down — including the ones written from inside a tool call.
      annotate({ userId: req.user.id, chatId, runId });
      const started = mark();
      log.info('turn started', { model: req.body?.model || 'default' });

      try {
        await runAgent({
          userId: req.user.id,
          user: req.user,
          chatId,
          modelId: req.body?.model,
          decision: req.body?.decision,
          // Which computer the browser is sitting at, learned from the worker on
          // that machine. Per request rather than stored: preferences belong to
          // the account, so two machines with the app open would take turns
          // overwriting each other's answer, and both would be wrong half the
          // time. Verified against this account's machines before it is used.
          deviceHint: req.body?.deviceHint,
          emit,
          signal: controller.signal,
        });
      } catch (err) {
        log.error('turn failed', err, { ms: since(started) });
        emit('error', { message: readableFailure(err) });
        emit('done', { stopReason: 'error' });
      } finally {
        log.info('turn ended', { ms: since(started) });
        clearInterval(ping);
        // Released whatever happened, including an abort — holding the lock
        // after the loop has stopped would lock the user out of their own chat.
        // With the sequence, so a superseded invocation finishing late cannot
        // release the lease the reconnection that replaced it now holds.
        await store.releaseChatRun(req.user.id, chatId, runId, runSeq).catch(() => {});
        if (!res.writableEnded) res.end();
      }
    }),
  );


  // ── admin ───────────────────────────────────────────────────────────
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get(
    '/users',
    wrap(async (req, res) => {
      res.json({ users: await getStore().listUsers() });
    }),
  );


  admin.patch(
    '/users/:id',
    wrap(async (req, res) => {
      // Express 5 leaves `req.body` undefined when no JSON body arrived, and
      // `'suspended' in undefined` is a TypeError, not a false — which turned a
      // bodyless PATCH into a 500 rather than a no-op.
      const patchBody = body(req);

      // Guard against an admin locking themselves out or demoting the last one.
      if (req.params.id === req.user.id && ('suspended' in patchBody || patchBody.role === 'user')) {
        return res.status(400).json({ error: 'You cannot suspend or demote yourself.' });
      }
      const patch = {};
      if ('name' in patchBody) patch.name = String(patchBody.name).trim();
      if ('suspended' in patchBody) patch.suspended = !!patchBody.suspended;
      if (patchBody.role === 'admin' || patchBody.role === 'user') patch.role = patchBody.role;
      if ('monthlyTokenLimit' in patchBody) {
        const limit = Number(patchBody.monthlyTokenLimit);
        // 0 or blank means "no limit for this person".
        patch.monthlyTokenLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
      }
      const updated = await getStore().updateUser(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'No such account.' });
      res.json({ ok: true });
    }),
  );

  admin.delete(
    '/users/:id',
    wrap(async (req, res) => {
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot delete your own account.' });
      }
      await getStore().deleteUser(req.params.id);
      res.json({ ok: true });
    }),
  );

  api.use('/admin', admin);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ── static frontend ─────────────────────────────────────────────────
  /**
   * Revalidate rather than cache blind.
   *
   * There is no build step here, so no filename hashing to make a stale asset
   * impossible. With a flat one-hour cache the browser would happily pair a
   * freshly-fetched index.html with an hour-old app.js — and a script wiring an
   * element the new markup no longer has throws at load, leaving a blank page.
   * ETags make each request a cheap 304 instead, and a mismatch cannot happen.
   *
   * On Vercel this code does not serve the frontend at all: `public/` goes to
   * the CDN, where each deployment is atomic and immutable.
   */
  app.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: 0, etag: true }));
  app.get(/.*/, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });

  // Four arguments, and `next` is unused on purpose: Express identifies an error
  // handler by its arity, so dropping the parameter turns this into ordinary
  // middleware that never runs.
  app.use((err, req, res, next) => {
    /**
     * Through the trace logger, not straight to the console.
     *
     * This is the last place an unhandled failure is seen, and it was the one
     * place that threw away the request id. Every other record in a request
     * carries it — `emit` reads it out of the AsyncLocalStorage this file sets
     * up at the top — so the 500 was the single line you could not join to the
     * turn that produced it, which is exactly the line you are looking for.
     *
     * `log.error` also unpacks the error rather than stringifying it, so the
     * name, the status and the first line of the stack are separately
     * searchable instead of buried in one string.
     */
    log.error('unhandled error', err, { method: req.method, path: req.path });
    if (res.headersSent) return res.end();
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  return app;
}
