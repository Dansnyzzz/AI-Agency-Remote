import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split schema.sql into individual statements.
 *
 * Comments are stripped first: a naive split on ';' breaks the moment a comment
 * contains one, which is exactly the kind of failure that only shows up on a
 * fresh database. Quote state is tracked so a ';' or '--' inside a string
 * literal is left alone.
 */
function splitStatements(sql) {
  let stripped = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (inString) {
      stripped += char;
      // '' is an escaped quote inside a Postgres string literal.
      if (char === "'") inString = sql[i + 1] === "'" ? (stripped += sql[++i], true) : false;
      continue;
    }
    if (char === "'") {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      stripped += '\n';
      continue;
    }
    stripped += char;
  }
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Neon/Postgres store. Uses the HTTP driver, which is what you want on Vercel:
 * no connection pool to leak across serverless invocations.
 *
 * Every user-owned query takes `userId` and filters on it. That parameter is
 * the tenancy boundary — it always comes from the verified session, never from
 * anything the client sent.
 */
export function createPgStore(connectionString) {
  // Accepts a driver object instead of a URL so the tenancy-isolation tests can
  // run the real SQL against an in-process Postgres.
  const sql =
    typeof connectionString === 'object' && connectionString?.query
      ? connectionString
      : neon(connectionString);

  /**
   * Bumped whenever schema.sql changes. A database already stamped with this
   * value skips the DDL entirely.
   *
   * The statements are all idempotent, so running them was never *wrong* — but
   * on a serverless deployment every cold start paid for thirty HTTP round-trips
   * to discover there was nothing to do. One cheap SELECT answers the same
   * question.
   *
   * **Adding anything to schema.sql without bumping this does nothing at all on
   * a database that already exists**, and nothing catches it: every test starts
   * from an empty folder, where the DDL runs regardless of the stamp. It is
   * only the machine that has been running the app for a while — which is
   * everybody's, eventually — that gets a missing column and a query that
   * fails. `test/schema.test.mjs` exists to make that impossible to miss again.
   *
   *   7  projects, project_files, chats.project_id
   *   8  doc_chunks — the indexed-document store behind search_docs
   *   9  projects.pinned, projects.archived_at
   *  10  attachment_versions — the history behind the version switcher
   *  11  shared_models.max_output — the real output cap, so a request stops
   *      asking every model for 32000 tokens it may not produce
   *  12  mcp_servers — the Model Context Protocol servers an account plugs in,
   *      which is what makes the tool list open rather than fixed
   */
  const SCHEMA_VERSION = 12;

  let schemaReady = null;
  async function ready() {
    if (!schemaReady) {
      schemaReady = (async () => {
        try {
          const rows = await sql.query('SELECT value FROM settings WHERE key = $1', ['schema_version']);
          if (Number(rows[0]?.value) === SCHEMA_VERSION) return;
        } catch {
          // No `settings` table yet: this is a fresh database, so fall through
          // and build it.
        }

        const ddl = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
        // The HTTP driver runs one statement per call.
        for (const stmt of splitStatements(ddl)) {
          await sql.query(stmt);
        }
        await sql.query(
          `INSERT INTO settings (key, value) VALUES ('schema_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(SCHEMA_VERSION)],
        );
      })();
    }
    return schemaReady;
  }

  const q = async (text, params = []) => {
    await ready();
    return sql.query(text, params);
  };

  return {
    kind: 'postgres',
    multiUser: true,

    async init() {
      await ready();
    },

    // ── users ───────────────────────────────────────────────────────
    async countUsers() {
      const rows = await q('SELECT COUNT(*)::int AS n FROM users');
      return rows[0]?.n ?? 0;
    },
    async createUser(user) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, user.email, user.name ?? null, user.passwordHash, user.role],
      );
      return this.getUserById(user.id);
    },
    async getUserByEmail(email) {
      const rows = await q('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
      return rows[0] ?? null;
    },
    async getUserById(id) {
      const rows = await q('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
    async listUsers() {
      return q(
        `SELECT u.id, u.email, u.name, u.role, u.created_at, u.last_seen_at,
                u.email_verified_at, u.suspended_at, u.monthly_token_limit,
                (u.worker_token IS NOT NULL) AS has_worker,
                (SELECT COUNT(*)::int FROM chats c WHERE c.user_id = u.id) AS chat_count,
                COALESCE((SELECT SUM(e.input_tokens + e.output_tokens) FROM usage_events e
                           WHERE e.user_id = u.id
                             AND e.created_at >= date_trunc('month', NOW())), 0)::bigint AS tokens_this_month
           FROM users u ORDER BY u.created_at ASC`,
      );
    },
    async touchUser(id) {
      await q('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [id]);
    },
    async setUserRole(id, role) {
      if (role !== 'admin' && role !== 'user') throw new Error(`Unknown role "${role}".`);
      await q('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
    },
    /**
     * Change the password, and make that mean what people assume it means.
     *
     * Bumping `session_epoch` invalidates every cookie already issued for this
     * account, because the epoch is signed into the cookie and compared on every
     * request. Without it a stolen session survived the one action taken to stop
     * it — for thirty days.
     */
    async setUserPassword(id, passwordHash) {
      await q(
        'UPDATE users SET password_hash = $2, session_epoch = session_epoch + 1 WHERE id = $1',
        [id, passwordHash],
      );
      // Also a session-independent way to lock out anyone holding an old reset link.
      await q("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'reset'", [id]);
    },
    async updateUser(id, patch) {
      const columns = { name: 'name', role: 'role', monthlyTokenLimit: 'monthly_token_limit' };
      const fields = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in patch)) continue;
        values.push(patch[key]);
        fields.push(`${column} = $${values.length}`);
      }
      if ('suspended' in patch) {
        fields.push(`suspended_at = ${patch.suspended ? 'NOW()' : 'NULL'}`);
      }
      if (!fields.length) return this.getUserById(id);
      values.push(id);
      await q(`UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
      return this.getUserById(id);
    },
    async markEmailVerified(id) {
      await q('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [id]);
    },

    // ── two-factor ──────────────────────────────────────────────────
    /** Stage a secret before it is confirmed; `enabled` stays null until then. */
    async setTotpSecret(id, encryptedSecret) {
      await q(
        'UPDATE users SET totp_secret = $2, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = $1',
        [id, encryptedSecret],
      );
    },
    async enableTotp(id, codeHashes) {
      await q(
        'UPDATE users SET totp_enabled_at = NOW(), recovery_codes = $2 WHERE id = $1',
        [id, JSON.stringify(codeHashes)],
      );
    },
    async disableTotp(id) {
      await q(
        `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL,
                          recovery_codes = NULL, totp_last_step = NULL
          WHERE id = $1`,
        [id],
      );
    },
    /**
     * Spend one 30-second TOTP step, and refuse to spend it twice.
     *
     * The comparison runs in SQL for the same reason the recovery codes do: two
     * simultaneous attempts with the same code must not both succeed. `>` rather
     * than `<>` also rejects an older step, so a replay cannot walk backwards.
     */
    async consumeTotpStep(id, step) {
      const rows = await q(
        `UPDATE users SET totp_last_step = $2
          WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
      RETURNING id`,
        [id, String(step)],
      );
      return rows.length > 0;
    },
    /**
     * Spend one recovery code. The filter runs in SQL so two simultaneous
     * attempts cannot both succeed with the same code.
     */
    async consumeRecoveryCode(id, codeHash) {
      const rows = await q(
        `UPDATE users
            SET recovery_codes = COALESCE(
                  (SELECT jsonb_agg(c) FROM jsonb_array_elements(recovery_codes) AS c
                    WHERE c <> to_jsonb($2::text)),
                  '[]'::jsonb)
          WHERE id = $1 AND recovery_codes @> to_jsonb(ARRAY[$2::text])
      RETURNING id`,
        [id, codeHash],
      );
      return rows.length > 0;
    },
    async deleteUser(id) {
      await q('DELETE FROM users WHERE id = $1', [id]);
    },

    // ── one-time links ──────────────────────────────────────────────
    async createAuthToken({ tokenHash, codeHash, userId, kind, expiresAt }) {
      // Only one live link per purpose: issuing a new one retires the old.
      await q('DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2', [userId, kind]);
      await q(
        `INSERT INTO auth_tokens (token_hash, code_hash, user_id, kind, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenHash, codeHash ?? null, userId, kind, expiresAt],
      );
    },
    /**
     * Claim by typed code. Scoped to one account, so a six-digit code only has
     * to be unguessable for that account within its short lifetime.
     */
    async consumeAuthCode(userId, codeHash, kind) {
      const rows = await q(
        `UPDATE auth_tokens SET used_at = NOW()
          WHERE user_id = $1 AND code_hash = $2 AND kind = $3
            AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
        [userId, codeHash, kind],
      );
      return rows[0]?.user_id ?? null;
    },
    /**
     * Claim a link atomically. The UPDATE ... RETURNING only matches an unused,
     * unexpired row, so a replayed link finds nothing rather than racing.
     */
    async consumeAuthToken(tokenHash, kind) {
      const rows = await q(
        `UPDATE auth_tokens SET used_at = NOW()
          WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
        [tokenHash, kind],
      );
      return rows[0]?.user_id ?? null;
    },

    // ── usage ───────────────────────────────────────────────────────
    async recordUsage(userId, event) {
      await q(
        `INSERT INTO usage_events (id, user_id, chat_id, model, input_tokens, output_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event.id,
          userId,
          event.chatId ?? null,
          event.model,
          event.inputTokens || 0,
          event.outputTokens || 0,
          event.costUsd || 0,
        ],
      );
    },
    /** Totals since the start of the current calendar month, UTC. */
    async usageThisMonth(userId) {
      const rows = await q(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COUNT(*)::int AS calls
           FROM usage_events
          WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [userId],
      );
      const r = rows[0] || {};
      return { tokens: Number(r.tokens || 0), cost: Number(r.cost || 0), calls: Number(r.calls || 0) };
    },
    async usageByModel(userId, days = 30) {
      return q(
        `SELECT model,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(cost_usd)              AS cost,
                COUNT(*)::int              AS calls
           FROM usage_events
          WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC`,
        [userId, String(days)],
      );
    },

    // ── per-user settings ───────────────────────────────────────────
    async getUserSetting(userId, key) {
      const rows = await q('SELECT value FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
      return rows[0]?.value ?? null;
    },
    async setUserSetting(userId, key, value) {
      await q(
        `INSERT INTO user_settings (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [userId, key, JSON.stringify(value)],
      );
      return value;
    },

    // ── deployment-wide settings ────────────────────────────────────
    async getSetting(key) {
      const rows = await q('SELECT value FROM settings WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await q(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
      return value;
    },

    // ── chats ───────────────────────────────────────────────────────
    /**
     * The conversations worth listing — the ones something was said in.
     *
     * A conversation nobody has spoken in is not history, it is a blank page
     * somebody opened and walked away from. They used to accumulate in the
     * sidebar as a column of identical "New chat" rows. The client no longer
     * creates one until the first message, and this covers the ones already
     * stored, plus the case where a send fails after the row exists.
     */
    async listChats(userId) {
      return q(
        `SELECT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at,
                (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count
           FROM chats c
          WHERE c.user_id = $1
            AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
          ORDER BY c.pinned DESC, c.updated_at DESC
          LIMIT 200`,
        [userId],
      );
    },
    async createChat(userId, chat) {
      await q('INSERT INTO chats (id, user_id, title, model, project_id) VALUES ($1, $2, $3, $4, $5)', [
        chat.id,
        userId,
        chat.title,
        chat.model,
        // A conversation started inside a project belongs to it for good: the
        // instructions and sources it was answered under are part of what the
        // transcript means.
        chat.projectId ?? null,
      ]);
      return this.getChat(userId, chat.id);
    },
    /**
     * Find conversations by title or by anything said in them.
     *
     * Message bodies are JSONB, so the text is matched against the whole
     * serialised value rather than a column — crude, but it means a search hits
     * what somebody typed, what the assistant replied, and what a tool returned,
     * without a second index to keep in step. Scoped by `user_id` in the same
     * query as everything else: a search must never reach across accounts.
     */
    async searchChats(userId, query, limit = 40) {
      const like = `%${String(query).trim()}%`;
      return q(
        `SELECT c.id, c.title, c.updated_at, c.pinned,
                (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count,
                (SELECT LEFT(m.content::text, 300)
                   FROM messages m
                  WHERE m.chat_id = c.id AND m.content::text ILIKE $2
                  ORDER BY m.seq LIMIT 1) AS snippet
           FROM chats c
          WHERE c.user_id = $1
            AND (c.title ILIKE $2
                 OR EXISTS (SELECT 1 FROM messages m
                             WHERE m.chat_id = c.id AND m.content::text ILIKE $2))
          ORDER BY c.updated_at DESC
          LIMIT $3`,
        [userId, like, limit],
      );
    },

    async getChat(userId, id) {
      const rows = await q('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
      return rows[0] ?? null;
    },
    async updateChat(userId, id, patch) {
      const fields = [];
      const values = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!['title', 'model', 'pinned'].includes(k)) continue;
        values.push(v);
        fields.push(`${k} = $${values.length}`);
      }
      if (fields.length) {
        values.push(id, userId);
        await q(
          `UPDATE chats SET ${fields.join(', ')}, updated_at = NOW()
            WHERE id = $${values.length - 1} AND user_id = $${values.length}`,
          values,
        );
      }
      return this.getChat(userId, id);
    },
    async touchChat(userId, id) {
      await q('UPDATE chats SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    /**
     * Claim the right to run the agent loop on this conversation.
     *
     * The whole claim is one conditional UPDATE, so it is atomic between two
     * browser tabs and between two serverless instances alike — exactly the two
     * ways a transcript used to get shredded by interleaved turns.
     *
     * The lock is a lease, not a latch: a run cut off mid-flight (which is the
     * normal way a serverless invocation ends) leaves a stale row behind, and
     * refusing forever because of that would be worse than the race. `staleMs`
     * is how long a silent holder keeps it — comfortably longer than the 15s
     * heartbeat that renews it, and short enough that an abandoned tab frees the
     * conversation in about a minute.
     *
     * Re-entrant by design: the same `runId` may reclaim its own lease, which is
     * how a browser resuming a run the host cut short continues rather than
     * being locked out by the mechanism meant to protect it.
     */
    /**
     * `<=`, not `<`, and the difference is a flaky test.
     *
     * `NOW()` is the transaction start time, so two adjacent statements on a fast
     * machine can carry the identical timestamp. With `staleMs = 0` — which means
     * "no grace at all, take the lease" — a strict `<` then read a lease claimed
     * microseconds ago as still live and refused, intermittently, depending only
     * on how quickly the two statements ran. At 75 seconds the boundary is
     * meaningless either way; at zero it is the whole behaviour.
     */
    async claimChatRun(userId, chatId, runId, staleMs = 75_000) {
      const rows = await q(
        `UPDATE chats SET run_lock_at = NOW(), run_lock_by = $3
          WHERE id = $1 AND user_id = $2
            AND (run_lock_at IS NULL
                 OR run_lock_at <= NOW() - ($4 || ' milliseconds')::interval
                 OR run_lock_by = $3)
      RETURNING run_lock_by`,
        [chatId, userId, runId, String(staleMs)],
      );
      return rows.length > 0;
    },
    /** Keep a long run's lease alive while it is genuinely still working. */
    async touchChatRun(userId, chatId, runId) {
      await q(
        'UPDATE chats SET run_lock_at = NOW() WHERE id = $1 AND user_id = $2 AND run_lock_by = $3',
        [chatId, userId, runId],
      );
    },
    /** Only the holder may release, so a late finisher cannot free someone else's lock. */
    async releaseChatRun(userId, chatId, runId) {
      await q(
        `UPDATE chats SET run_lock_at = NULL, run_lock_by = NULL
          WHERE id = $1 AND user_id = $2 AND run_lock_by = $3`,
        [chatId, userId, runId],
      );
    },
    async deleteChat(userId, id) {
      // The files go with it. `attachments.chat_id` carries no foreign key — it
      // is set after the fact, when a message is sent — so nothing would cascade,
      // and deleting a conversation would leave its photographs and documents in
      // the database with nothing pointing at them. "Delete this conversation"
      // has to mean what it says.
      await q('DELETE FROM attachments WHERE user_id = $1 AND chat_id = $2', [userId, id]);
      await q('DELETE FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    // ── messages ────────────────────────────────────────────────────
    // Joined against chats so a guessed chat id from another account reads back
    // as an empty conversation rather than someone else's.
    async listMessages(userId, chatId) {
      const rows = await q(
        `SELECT m.id, m.role, m.content, m.seq, m.created_at
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.chat_id = $1 AND c.user_id = $2
          ORDER BY m.seq ASC`,
        [chatId, userId],
      );
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        ...r.content,
        seq: Number(r.seq),
        createdAt: r.created_at,
      }));
    },
    async appendMessage(userId, chatId, message) {
      const { id, role, ...rest } = message;
      const rows = await q(
        `INSERT INTO messages (id, chat_id, seq, role, content)
         SELECT $1, $2,
                COALESCE((SELECT MAX(seq) + 1 FROM messages WHERE chat_id = $2), 0),
                $3, $4
          WHERE EXISTS (SELECT 1 FROM chats WHERE id = $2 AND user_id = $5)
      RETURNING id`,
        [id, chatId, role, JSON.stringify(rest), userId],
      );
      if (!rows.length) throw new Error('Chat not found.');
      await this.touchChat(userId, chatId);
      return message;
    },

    /**
     * Change what somebody said, and drop everything that followed it.
     *
     * Editing a message is really asking the conversation to take a different
     * turn from that point, so the answers that came after it cannot stay: they
     * are replies to a question that no longer exists, and leaving them would
     * produce a transcript nobody ever had. The conversation is then re-run
     * from the edited message, which is what makes it feel like changing your
     * mind rather than tampering with the record.
     *
     * Only user turns. An assistant message is a record of what a model
     * actually said, and editing that is forging evidence.
     */
    async editUserMessage(userId, chatId, messageId, text) {
      const rows = await q(
        `SELECT m.seq, m.content, m.role
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.id = $1 AND m.chat_id = $2 AND c.user_id = $3`,
        [messageId, chatId, userId],
      );
      const found = rows[0];
      if (!found) return null;
      if (found.role !== 'user') {
        throw Object.assign(new Error('Only your own messages can be edited.'), { status: 400 });
      }

      // The attachments travel with the message: editing the words does not
      // detach the photograph they were about.
      const content = { ...found.content, text };
      await q('UPDATE messages SET content = $1 WHERE id = $2', [JSON.stringify(content), messageId]);
      await q('DELETE FROM messages WHERE chat_id = $1 AND seq > $2', [chatId, found.seq]);
      await this.touchChat(userId, chatId);

      return { id: messageId, role: 'user', ...content, seq: Number(found.seq) };
    },

    // ── attachments ─────────────────────────────────────────────────
    async createAttachment(userId, file) {
      const rows = await q(
        `INSERT INTO attachments (id, user_id, name, mime, kind, bytes, data, origin, source, chat_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, mime, kind, bytes, origin, created_at`,
        [
          file.id,
          userId,
          file.name,
          file.mime,
          file.kind,
          file.bytes,
          file.data,
          file.origin || 'upload',
          file.source ?? null,
          file.chatId ?? null,
        ],
      );
      return rows[0];
    },
    /** Metadata only — the bytes are the expensive part and rarely the point. */
    async listAttachments(userId, ids) {
      if (!ids?.length) return [];
      return q(
        `SELECT id, name, mime, kind, bytes, origin FROM attachments
          WHERE user_id = $1 AND id = ANY($2::text[])`,
        [userId, ids],
      );
    },
    async getAttachment(userId, id) {
      const rows = await q(
        `SELECT id, name, mime, kind, bytes, data, origin, source, chat_id, created_at
           FROM attachments WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return rows[0] ?? null;
    },
    /**
     * Everything the assistant made in one conversation, newest first.
     *
     * Without the bytes: this answers "what did we produce here", which is a
     * list of names and sizes, not megabytes of base64.
     */
    async listGeneratedFiles(userId, chatId) {
      return q(
        `SELECT id, name, mime, kind, bytes, origin, created_at FROM attachments
          WHERE user_id = $1 AND chat_id = $2 AND origin = 'generated'
       ORDER BY created_at DESC`,
        [userId, chatId],
      );
    },
    /**
     * Everything the assistant has made on this account.
     *
     * Across conversations rather than within one: the artifacts shelf is a
     * place to find the thing you made on Tuesday, and remembering which
     * conversation that was is the problem it exists to remove.
     */
    async listAllGeneratedFiles(userId, limit = 200) {
      return q(
        // The opening of the source, so the shelf can show a window onto each
        // artifact rather than a row of identical file icons. Clipped in SQL
        // because the alternative is moving every document to the browser to
        // throw away all but the first few lines of each.
        `SELECT a.id, a.name, a.mime, a.kind, a.bytes, a.origin, a.chat_id, a.created_at,
                c.title AS chat_title, left(a.source, 400) AS peek
           FROM attachments a
      LEFT JOIN chats c ON c.id = a.chat_id
          WHERE a.user_id = $1 AND a.origin = 'generated'
       ORDER BY a.created_at DESC
          LIMIT $2`,
        [userId, Math.min(Math.max(Number(limit) || 200, 1), 500)],
      );
    },
    /** Throw one away. Only ever something the assistant made. */
    async deleteGeneratedFile(userId, id) {
      const rows = await q(
        `DELETE FROM attachments WHERE id = $1 AND user_id = $2 AND origin = 'generated' RETURNING id`,
        [id, userId],
      );
      return rows.length > 0;
    },
    /** Replace a generated file's bytes in place, keeping its id and its link. */
    /**
     * Rewrite a file the assistant made, keeping its id — and keeping what it
     * used to be.
     *
     * The outgoing copy is filed as a version before the new one lands, so the
     * two writes are ordered: history first, then the file. If the second fails
     * the worst case is a version identical to the current file, which is
     * harmless; the other order can lose a document.
     */
    async replaceAttachment(userId, id, { data, bytes, source, name, mime }) {
      const current = (await q('SELECT * FROM attachments WHERE id = $1 AND user_id = $2', [id, userId]))[0];
      if (!current || current.origin !== 'generated') return null;

      const seen = await q(
        'SELECT COALESCE(MAX(revision), 0)::int AS n FROM attachment_versions WHERE attachment_id = $1',
        [id],
      );
      // The first rewrite files two rows: what was there originally becomes
      // revision 1. Without that the history would start at the second draft
      // and "go back to the first one" would be impossible.
      await q(
        `INSERT INTO attachment_versions (id, attachment_id, user_id, revision, name, mime, kind, bytes, data, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `${id}-v${seen[0].n + 1}`,
          id,
          userId,
          seen[0].n + 1,
          current.name,
          current.mime,
          current.kind,
          current.bytes,
          current.data,
          current.source ?? null,
          current.created_at,
        ],
      );

      const rows = await q(
        `UPDATE attachments
            SET data = $3, bytes = $4, source = $5,
                name = COALESCE($6, name), mime = COALESCE($7, mime), created_at = NOW()
          WHERE id = $1 AND user_id = $2 AND origin = 'generated'
      RETURNING id, name, mime, kind, bytes, origin, created_at`,
        [id, userId, data, bytes, source ?? null, name ?? null, mime ?? null],
      );
      return rows[0] ?? null;
    },

    /** Every earlier copy, newest first. Metadata only — the bytes are big. */
    async listAttachmentVersions(userId, attachmentId) {
      return q(
        `SELECT id, revision, name, mime, kind, bytes, created_at
           FROM attachment_versions
          WHERE user_id = $1 AND attachment_id = $2
          ORDER BY revision DESC`,
        [userId, attachmentId],
      );
    },

    /** One earlier copy, with its bytes — for showing it, or putting it back. */
    async getAttachmentVersion(userId, attachmentId, revision) {
      const rows = await q(
        `SELECT * FROM attachment_versions
          WHERE user_id = $1 AND attachment_id = $2 AND revision = $3`,
        [userId, attachmentId, Number(revision)],
      );
      return rows[0] ?? null;
    },
    /** Bind loose uploads to the conversation they were sent in. */
    async attachToChat(userId, chatId, ids) {
      if (!ids?.length) return;
      await q('UPDATE attachments SET chat_id = $3 WHERE user_id = $1 AND id = ANY($2::text[])', [
        userId,
        ids,
        chatId,
      ]);
    },
    /**
     * Sweep uploads that were never sent.
     *
     * Somebody attaches three photos, changes their mind and closes the tab. The
     * rows are already written, and nothing else would ever look at them again.
     */
    async pruneOrphanAttachments(olderThanHours = 24) {
      await q(
        `DELETE FROM attachments
          WHERE chat_id IS NULL AND created_at < NOW() - ($1 || ' hours')::interval`,
        [String(olderThanHours)],
      );
    },

    // ── worker relay ────────────────────────────────────────────────
    async enqueueJob(userId, job) {
      await q(
        `INSERT INTO tool_jobs (id, user_id, chat_id, tool, input, device_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          job.id,
          userId,
          job.chatId ?? null,
          job.tool,
          JSON.stringify(job.input ?? {}),
          job.deviceId ?? null,
        ],
      );
      return job;
    },
    /**
     * Hand a worker one job.
     *
     * Scoped by `userId`, which is the tenancy boundary, and then by device: a
     * job addressed to the laptop must not be answered by the desktop just
     * because the desktop polled first. A job with no device named is for
     * whoever is available, which is what a single-machine account always sees.
     */
    async claimJob(userId, deviceId = null) {
      const rows = await q(
        `UPDATE tool_jobs SET status = 'running', claimed_at = NOW()
          WHERE id = (
            SELECT id FROM tool_jobs
             WHERE status = 'pending' AND user_id = $1
               AND (device_id IS NULL OR device_id = $2)
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
      RETURNING id, chat_id, tool, input`,
        [userId, deviceId],
      );
      const r = rows[0];
      return r ? { id: r.id, chatId: r.chat_id, tool: r.tool, input: r.input } : null;
    },
    async completeJob(userId, id, { status, result }) {
      await q(
        `UPDATE tool_jobs SET status = $3, result = $4, done_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [id, userId, status, JSON.stringify(result ?? null)],
      );
    },
    /**
     * Fail everything queued for a machine that has just been unplugged.
     *
     * Without this those rows stay pending for a worker that will never poll
     * again, and the agent waits out the full timeout on every one of them
     * before reporting a failure it could have known about immediately.
     */
    async cancelJobsForDevice(userId, deviceId) {
      await q(
        `UPDATE tool_jobs SET status = 'error', done_at = NOW(),
                              result = '{"error":"That computer was unpaired."}'::jsonb
          WHERE user_id = $1 AND device_id = $2 AND status IN ('pending', 'running')`,
        [userId, deviceId],
      );
    },
    /**
     * Forget finished jobs.
     *
     * Nothing ever deleted these. Every tool call writes a row carrying its
     * arguments and its entire output as JSONB — a `grep` across a repository,
     * a directory listing, sixty kilobytes of build log — and they stayed
     * forever. On a machine used daily that is the fastest-growing table in the
     * database, holding data whose only reader finished with it seconds later.
     *
     * The transcript is the record; this is a queue.
     */
    async pruneFinishedJobs(olderThanHours = 24) {
      await q(
        `DELETE FROM tool_jobs
          WHERE status IN ('done', 'error')
            AND done_at IS NOT NULL
            AND done_at < NOW() - ($1 || ' hours')::interval`,
        [String(olderThanHours)],
      );
    },
    async getJob(userId, id) {
      const rows = await q('SELECT id, status, result FROM tool_jobs WHERE id = $1 AND user_id = $2', [
        id,
        userId,
      ]);
      return rows[0] ?? null;
    },

    // ── worker presence ─────────────────────────────────────────────
    async heartbeat(userId, workerId, info) {
      await q(
        `INSERT INTO workers (id, user_id, last_seen, info) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), info = EXCLUDED.info, user_id = EXCLUDED.user_id`,
        [workerId, userId, JSON.stringify(info ?? {})],
      );
    },
    async activeWorker(userId, withinMs = 45_000) {
      const rows = await q(
        `SELECT id, info, last_seen FROM workers
          WHERE user_id = $1 AND last_seen > NOW() - ($2 || ' milliseconds')::interval
          ORDER BY last_seen DESC LIMIT 1`,
        [userId, String(withinMs)],
      );
      return rows[0] ?? null;
    },
    /**
     * Every computer of this account's that is currently answering.
     *
     * The name of a paired device comes from `devices`; a worker paired before
     * devices existed has no row there and is listed under its own id, which is
     * what it has always been called.
     */
    async activeWorkers(userId, withinMs = 45_000) {
      return q(
        `SELECT w.id, w.info, w.last_seen, d.name
           FROM workers w
           LEFT JOIN devices d ON d.id = w.id AND d.revoked_at IS NULL
          WHERE w.user_id = $1 AND w.last_seen > NOW() - ($2 || ' milliseconds')::interval
          ORDER BY w.last_seen DESC`,
        [userId, String(withinMs)],
      );
    },

    // ── projects ────────────────────────────────────────────────────

    /**
     * The shelf, with the two counts that make a project card worth reading:
     * how many sources are on it and how many conversations came out of it.
     *
     * Archived projects are a separate shelf, never mixed in — `archived: true`
     * asks for that one instead. Pinned projects float to the top of whichever
     * shelf you are looking at.
     */
    async listProjects(userId, { archived = false } = {}) {
      return q(
        `SELECT p.id, p.name, p.instructions, p.grounded, p.pinned, p.archived_at,
                p.created_at, p.updated_at,
                (SELECT COUNT(*)::int FROM project_files f WHERE f.project_id = p.id) AS file_count,
                (SELECT COUNT(*)::int FROM chats c WHERE c.project_id = p.id) AS chat_count
           FROM projects p
          WHERE p.user_id = $1
            AND p.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
          ORDER BY p.pinned DESC, p.updated_at DESC
          LIMIT 200`,
        [userId],
      );
    },
    async getProject(userId, id) {
      const rows = await q('SELECT * FROM projects WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async createProject(userId, { id, name, instructions = '', grounded = true }) {
      const rows = await q(
        `INSERT INTO projects (id, user_id, name, instructions, grounded)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, userId, name, instructions, grounded],
      );
      return rows[0];
    },
    /**
     * Every field is optional; a `null` argument means "leave it". `archived`
     * is a boolean on the way in but a timestamp in the table, so it gets a
     * CASE rather than a COALESCE — un-archiving has to be able to write NULL,
     * which COALESCE would read as "no change".
     */
    async updateProject(userId, id, patch) {
      const rows = await q(
        `UPDATE projects SET
           name         = COALESCE($3, name),
           instructions = COALESCE($4, instructions),
           grounded     = COALESCE($5, grounded),
           pinned       = COALESCE($6, pinned),
           archived_at  = CASE WHEN $7::boolean IS NULL THEN archived_at
                               WHEN $7::boolean THEN COALESCE(archived_at, NOW())
                               ELSE NULL END,
           updated_at   = NOW()
         WHERE user_id = $1 AND id = $2 RETURNING *`,
        [
          userId,
          id,
          patch.name ?? null,
          patch.instructions ?? null,
          patch.grounded ?? null,
          patch.pinned ?? null,
          patch.archived ?? null,
        ],
      );
      return rows[0] ?? null;
    },
    async deleteProject(userId, id) {
      await q('DELETE FROM projects WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    /** Metadata only. The text is the big column and is rarely what a list wants. */
    async listProjectFiles(userId, projectId) {
      return q(
        `SELECT id, name, mime, bytes, pages, chars, created_at
           FROM project_files WHERE user_id = $1 AND project_id = $2
          ORDER BY created_at`,
        [userId, projectId],
      );
    },
    /** With the text, for the turn that is about to be grounded in it. */
    async readProjectFiles(userId, projectId) {
      return q(
        `SELECT id, name, mime, pages, chars, text
           FROM project_files WHERE user_id = $1 AND project_id = $2
          ORDER BY created_at`,
        [userId, projectId],
      );
    },
    async addProjectFile(userId, projectId, file) {
      const rows = await q(
        `INSERT INTO project_files (id, project_id, user_id, name, mime, bytes, pages, text, chars)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, name, mime, bytes, pages, chars, created_at`,
        [file.id, projectId, userId, file.name, file.mime, file.bytes, file.pages ?? null, file.text, file.text.length],
      );
      await q('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
      return rows[0];
    },
    async deleteProjectFile(userId, id) {
      await q('DELETE FROM project_files WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    /** The conversations belonging to one project, newest first. */
    async listProjectChats(userId, projectId) {
      return q(
        `SELECT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at,
                (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count
           FROM chats c
          WHERE c.user_id = $1 AND c.project_id = $2
            AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
          ORDER BY c.updated_at DESC
          LIMIT 200`,
        [userId, projectId],
      );
    },

    // ── skills ──────────────────────────────────────────────────────
    async listSkills(userId, onlyEnabled = false) {
      return q(
        `SELECT * FROM skills WHERE user_id = $1 ${onlyEnabled ? 'AND enabled' : ''}
          ORDER BY lower(name)`,
        [userId],
      );
    },
    async getSkill(userId, id) {
      const rows = await q('SELECT * FROM skills WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    /** Upsert by name, so teaching the same thing twice refines it rather than duplicating it. */
    async saveSkill(userId, { id, name, description, instructions }) {
      const rows = await q(
        `INSERT INTO skills (id, user_id, name, description, instructions)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET
           description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           updated_at = NOW()
      RETURNING *`,
        [id, userId, name, description, instructions],
      );
      return rows[0];
    },
    async setSkillEnabled(userId, id, enabled) {
      const rows = await q(
        'UPDATE skills SET enabled = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *',
        [userId, id, enabled],
      );
      return rows[0] ?? null;
    },
    async noteSkillUsed(userId, name) {
      await q(
        'UPDATE skills SET used_count = used_count + 1 WHERE user_id = $1 AND lower(name) = lower($2)',
        [userId, name],
      );
    },
    async deleteSkill(userId, id) {
      await q('DELETE FROM skills WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    // ── indexed documents ───────────────────────────────────────────
    //
    // Every one of these filters on user_id. Documents are the most personal
    // thing in the database — somebody's contracts, their notes, their medical
    // letters — so this is the boundary that matters most, not the least.

    /** What is already indexed under a source, so a re-index can skip it. */
    async docStamps(userId, source) {
      return q(
        'SELECT path, MAX(mtime) AS mtime, MAX(model) AS model FROM doc_chunks WHERE user_id = $1 AND source = $2 GROUP BY path',
        [userId, source],
      );
    },

    /**
     * Replace one file's chunks wholesale.
     *
     * Delete-then-insert rather than upsert by ordinal: an edited file usually
     * has a *different number* of chunks, and upserting would leave the tail of
     * the previous version behind as text that is no longer in any document.
     */
    async replaceDocChunks(userId, path, rows) {
      await q('DELETE FROM doc_chunks WHERE user_id = $1 AND path = $2', [userId, path]);
      for (const row of rows) {
        await q(
          `INSERT INTO doc_chunks (id, user_id, source, path, ordinal, heading, text, embedding, dims, model, mtime)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            row.id,
            userId,
            row.source,
            path,
            row.ordinal,
            row.heading ?? null,
            row.text,
            row.embedding,
            row.dims,
            row.model,
            row.mtime ?? null,
          ],
        );
      }
    },

    /**
     * Just enough to rank by: id, vector, and where it came from.
     *
     * The text is deliberately left behind — it is by far the largest column, and
     * pulling every chunk's prose across the wire to score it and throw all but
     * eight away is the difference between a search that feels instant and one
     * that does not.
     */
    async docVectors(userId, model) {
      return q(
        'SELECT id, path, embedding FROM doc_chunks WHERE user_id = $1 AND model = $2',
        [userId, model],
      );
    },

    async docChunks(userId, ids) {
      if (!ids.length) return [];
      const params = ids.map((_, i) => `$${i + 2}`).join(', ');
      return q(`SELECT * FROM doc_chunks WHERE user_id = $1 AND id IN (${params})`, [userId, ...ids]);
    },

    async docSources(userId) {
      return q(
        `SELECT source, COUNT(*)::int AS chunks, COUNT(DISTINCT path)::int AS files,
                MAX(model) AS model, MAX(created_at) AS indexed_at
           FROM doc_chunks WHERE user_id = $1 GROUP BY source ORDER BY MAX(created_at) DESC`,
        [userId],
      );
    },

    async deleteDocs(userId, source) {
      const rows = await q(
        'DELETE FROM doc_chunks WHERE user_id = $1 AND ($2::text IS NULL OR source = $2) RETURNING id',
        [userId, source ?? null],
      );
      return rows.length;
    },

    // ── scheduled tasks ─────────────────────────────────────────────
    async listTasks(userId) {
      return q('SELECT * FROM scheduled_tasks WHERE user_id = $1 ORDER BY next_run_at', [userId]);
    },
    async createTask(userId, task) {
      const rows = await q(
        `INSERT INTO scheduled_tasks (id, user_id, title, prompt, model, cron, next_run_at, tz)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          task.id,
          userId,
          task.title,
          task.prompt,
          task.model ?? null,
          task.cron ?? null,
          task.nextRunAt,
          task.tz ?? null,
        ],
      );
      return rows[0];
    },
    async setTaskEnabled(userId, id, enabled) {
      const rows = await q(
        'UPDATE scheduled_tasks SET enabled = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
        [userId, id, enabled],
      );
      return rows[0] ?? null;
    },
    async deleteTask(userId, id) {
      await q('DELETE FROM scheduled_tasks WHERE user_id = $1 AND id = $2', [userId, id]);
    },
    /**
     * Claim one due task atomically.
     *
     * The update *is* the claim: pushing `next_run_at` forward in the same
     * statement that selects it means two schedulers — or two serverless
     * invocations — cannot both pick up the same task and run it twice.
     */
    async claimDueTask(now = new Date().toISOString(), userId = null) {
      const rows = await q(
        `UPDATE scheduled_tasks SET next_run_at = next_run_at + INTERVAL '1 hour',
                                    last_run_at = NOW()
          WHERE id = (SELECT id FROM scheduled_tasks
                       WHERE enabled AND next_run_at <= $1
                         AND ($2::text IS NULL OR user_id = $2)
                       ORDER BY next_run_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
      RETURNING *`,
        [now, userId],
      );
      return rows[0] ?? null;
    },
    /** Record the outcome and set the real next run, or retire a one-shot. */
    async finishTask(id, { status, chatId, nextRunAt }) {
      if (nextRunAt) {
        await q('UPDATE scheduled_tasks SET last_status = $2, last_chat = $3, next_run_at = $4 WHERE id = $1', [
          id,
          status,
          chatId ?? null,
          nextRunAt,
        ]);
      } else {
        await q('UPDATE scheduled_tasks SET last_status = $2, last_chat = $3, enabled = FALSE WHERE id = $1', [
          id,
          status,
          chatId ?? null,
        ]);
      }
    },

    // ── connectors ──────────────────────────────────────────────────
    async listConnectors(userId) {
      // Never the token itself — the browser has no use for it and every
      // reason not to have it.
      return q('SELECT service, account, created_at FROM connectors WHERE user_id = $1 ORDER BY service', [
        userId,
      ]);
    },
    async getConnector(userId, service) {
      const rows = await q('SELECT * FROM connectors WHERE user_id = $1 AND service = $2', [userId, service]);
      return rows[0] ?? null;
    },
    async saveConnector(userId, service, token, account) {
      await q(
        `INSERT INTO connectors (user_id, service, token, account) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, service) DO UPDATE SET token = EXCLUDED.token, account = EXCLUDED.account`,
        [userId, service, token, account ?? null],
      );
    },
    async deleteConnector(userId, service) {
      await q('DELETE FROM connectors WHERE user_id = $1 AND service = $2', [userId, service]);
    },

    // ── shared model library ────────────────────────────────────────
    /**
     * Upsert a batch from the daily refresh. `added_by` and `created_at` are
     * preserved so "who first added this" and the original discovery date
     * survive every refresh.
     */
    async upsertModels(models) {
      for (const m of models) {
        await q(
          `INSERT INTO shared_models
             (id, provider, model, family, label, description, context,
              price_in, price_out, is_free, released_at, added_by, vision,
              max_output, refreshed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW())
           ON CONFLICT (id) DO UPDATE SET
             provider    = EXCLUDED.provider,
             model       = EXCLUDED.model,
             family      = EXCLUDED.family,
             label       = EXCLUDED.label,
             description = EXCLUDED.description,
             context     = EXCLUDED.context,
             price_in    = EXCLUDED.price_in,
             price_out   = EXCLUDED.price_out,
             is_free     = EXCLUDED.is_free,
             released_at = EXCLUDED.released_at,
             vision      = EXCLUDED.vision,
             max_output  = EXCLUDED.max_output,
             refreshed_at = NOW()`,
          [
            m.id,
            m.provider,
            m.model,
            m.family,
            m.label,
            m.description ?? null,
            m.context ?? null,
            m.priceIn ?? null,
            m.priceOut ?? null,
            !!m.isFree,
            m.releasedAt ?? null,
            m.addedBy ?? null,
            !!m.vision,
            m.maxOutput ?? null,
          ],
        );
      }
      return models.length;
    },

    /**
     * Search and filter the library. Sorting defaults to newest-first by the
     * vendor's release date, which is what people actually want when scanning
     * for something new to try.
     */
    async listSharedModels({ query, family, tier, sort = 'new', limit = 300 } = {}) {
      const where = [];
      const values = [];

      if (query) {
        values.push(`%${String(query).toLowerCase()}%`);
        where.push(`(LOWER(id) LIKE $${values.length} OR LOWER(label) LIKE $${values.length}
                     OR LOWER(COALESCE(description, '')) LIKE $${values.length})`);
      }
      if (family && family !== 'all') {
        values.push(family);
        where.push(`family = $${values.length}`);
      }
      if (tier === 'free') where.push('is_free = TRUE');
      else if (tier === 'paid') where.push('is_free = FALSE');

      const order =
        {
          new: 'released_at DESC NULLS LAST, created_at DESC',
          old: 'released_at ASC NULLS LAST, created_at ASC',
          name: 'label ASC',
          cheap: 'is_free DESC, price_in ASC NULLS LAST',
          context: 'context DESC NULLS LAST',
        }[sort] || 'released_at DESC NULLS LAST';

      values.push(Math.min(Number(limit) || 300, 1000));
      return q(
        `SELECT * FROM shared_models
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY ${order}
          LIMIT $${values.length}`,
        values,
      );
    },

    // ── MCP servers ─────────────────────────────────────────────────
    //
    // Every one of these is scoped by user_id, and that is the whole security
    // story: a stdio server is a program that runs on the machine, so one account
    // being able to read or write another's row would be one account choosing what
    // another account executes.
    async listMcpServers(userId) {
      return q('SELECT * FROM mcp_servers WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    },
    async getMcpServer(userId, id) {
      const rows = await q('SELECT * FROM mcp_servers WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async saveMcpServer(userId, server) {
      await q(
        `INSERT INTO mcp_servers (id, user_id, name, config, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, config = EXCLUDED.config, enabled = EXCLUDED.enabled`,
        [server.id, userId, server.name, JSON.stringify(server.config ?? {}), server.enabled !== false],
      );
      return this.getMcpServer(userId, server.id);
    },
    async setMcpServerEnabled(userId, id, enabled) {
      await q('UPDATE mcp_servers SET enabled = $3 WHERE user_id = $1 AND id = $2', [userId, id, !!enabled]);
      return this.getMcpServer(userId, id);
    },
    async deleteMcpServer(userId, id) {
      await q('DELETE FROM mcp_servers WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    async getSharedModel(id) {
      const rows = await q('SELECT * FROM shared_models WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async deleteSharedModel(id) {
      await q('DELETE FROM shared_models WHERE id = $1', [id]);
    },

    /** Drives the "is the library stale?" check and the freshness label. */
    async modelLibraryStatus() {
      const rows = await q(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_free)::int AS free,
                MAX(refreshed_at) AS refreshed_at
           FROM shared_models`,
      );
      const r = rows[0] || {};
      return {
        total: Number(r.total || 0),
        free: Number(r.free || 0),
        refreshedAt: r.refreshed_at ?? null,
      };
    },

    /** Families present in the library, for the filter chips. */
    async modelFamilies() {
      return q(
        `SELECT family, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE is_free)::int AS free
           FROM shared_models GROUP BY family ORDER BY COUNT(*) DESC`,
      );
    },

    // ── the live screen ─────────────────────────────────────────────
    // Deliberately leaves watched_at alone — a new frame must not clear the
    // record of someone watching, or the stream throttles itself to a stop.
    async putScreen(userId, { frame, meta }) {
      await q(
        `INSERT INTO screens (user_id, frame, meta, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET frame = EXCLUDED.frame, meta = EXCLUDED.meta, updated_at = NOW()`,
        [userId, frame, JSON.stringify(meta ?? {})],
      );
    },
    async getScreen(userId) {
      const rows = await q('SELECT frame, meta, updated_at FROM screens WHERE user_id = $1', [userId]);
      return rows[0] ?? null;
    },
    /** Records that a browser is actually looking, so the worker can idle down. */
    async markWatching(userId) {
      await q(
        `INSERT INTO screens (user_id, watched_at, updated_at) VALUES ($1, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET watched_at = NOW()`,
        [userId],
      );
    },
    async isWatched(userId, withinMs = 12_000) {
      const rows = await q(
        `SELECT watched_at > NOW() - ($2 || ' milliseconds')::interval AS watching
           FROM screens WHERE user_id = $1`,
        [userId, String(withinMs)],
      );
      return rows[0]?.watching === true;
    },
    /**
     * Drop the stored frame.
     *
     * A frame is a photograph of somebody's actual desktop, and the row was only
     * ever overwritten — so the last thing the assistant saw sat in the database
     * indefinitely after the sandbox closed and after they signed out. Signing
     * out, closing the sandbox and deleting the account all clear it now.
     */
    async clearScreen(userId) {
      await q('UPDATE screens SET frame = NULL, meta = $2 WHERE user_id = $1', [userId, '{}']);
    },

    // ── throttling ──────────────────────────────────────────────────
    /**
     * Count one attempt against a bucket and say whether it is over the line.
     *
     * A single upsert does the whole job: an expired window is reset in the same
     * statement that increments it, so there is no read-then-write race between
     * two simultaneous guesses at the same password.
     */
    async hitRateLimit(bucket, limit, windowMs) {
      const rows = await q(
        `INSERT INTO rate_limits (bucket, count, expires_at)
         VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval)
         ON CONFLICT (bucket) DO UPDATE SET
           count = CASE WHEN rate_limits.expires_at < NOW() THEN 1 ELSE rate_limits.count + 1 END,
           expires_at = CASE WHEN rate_limits.expires_at < NOW()
                             THEN NOW() + ($2 || ' milliseconds')::interval
                             ELSE rate_limits.expires_at END
      RETURNING count, expires_at`,
        [bucket, String(windowMs)],
      );
      const row = rows[0] || {};
      const count = Number(row.count || 0);
      return {
        allowed: count <= limit,
        count,
        retryAfterMs: Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
      };
    },
    /** Forget a bucket — called on success, so one good login clears the tally. */
    async clearRateLimit(bucket) {
      await q('DELETE FROM rate_limits WHERE bucket = $1', [bucket]);
    },
    /** Housekeeping, so the table cannot grow without bound. */
    async pruneRateLimits() {
      await q('DELETE FROM rate_limits WHERE expires_at < NOW() - INTERVAL \'1 day\'');
    },

    // ── worker tokens ───────────────────────────────────────────────
    //
    // The `users.worker_token` column is the old one-token-per-account scheme.
    // It is still honoured so a worker paired before the upgrade keeps working,
    // but nothing writes to it any more — new machines get a row in `devices`.
    async setWorkerToken(userId, tokenHash) {
      await q('UPDATE users SET worker_token = $2 WHERE id = $1', [userId, tokenHash]);
    },
    /**
     * Resolve a worker token to its owner, and say which machine it was.
     *
     * Checks `devices` first and falls back to the legacy column, so both
     * generations of token authenticate through one path.
     */
    async getUserByWorkerToken(tokenHash) {
      const rows = await q(
        `SELECT u.id, u.email, d.id AS device_id, d.name AS device_name
           FROM devices d JOIN users u ON u.id = d.user_id
          WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
        [tokenHash],
      );
      if (rows[0]) return rows[0];

      const legacy = await q('SELECT id, email FROM users WHERE worker_token = $1', [tokenHash]);
      return legacy[0] ? { ...legacy[0], device_id: null, device_name: null } : null;
    },

    // ── devices ─────────────────────────────────────────────────────
    async createDevice(userId, { id, tokenHash, name, info }) {
      const rows = await q(
        `INSERT INTO devices (id, user_id, token_hash, name, info)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, created_at`,
        [id, userId, tokenHash, name, JSON.stringify(info ?? {})],
      );
      return rows[0];
    },
    /** Never the token hash: the browser has no use for it. */
    async listDevices(userId) {
      return q(
        `SELECT d.id, d.name, d.info, d.workspace, d.created_at, d.last_seen, d.revoked_at,
                (d.last_seen > NOW() - INTERVAL '45 seconds') AS online
           FROM devices d
          WHERE d.user_id = $1 AND d.revoked_at IS NULL
          ORDER BY d.last_seen DESC NULLS LAST, d.created_at DESC`,
        [userId],
      );
    },
    async getDevice(userId, deviceId) {
      const rows = await q(
        'SELECT id, name, info, workspace FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [deviceId, userId],
      );
      return rows[0] ?? null;
    },
    /**
     * Ask a computer to work somewhere else.
     *
     * Stored rather than sent, because the machine may be asleep: it is the
     * desired root, and the worker adopts it the next time it checks in. Null
     * hands it back whatever it was started with.
     */
    async setDeviceWorkspace(userId, deviceId, workspace) {
      const rows = await q(
        `UPDATE devices SET workspace = $3
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id, name, workspace`,
        [deviceId, userId, workspace ?? null],
      );
      return rows[0] ?? null;
    },
    async touchDevice(userId, deviceId, info) {
      if (!deviceId) return;
      await q(
        'UPDATE devices SET last_seen = NOW(), info = $3 WHERE id = $1 AND user_id = $2',
        [deviceId, userId, JSON.stringify(info ?? {})],
      );
    },
    /** Revoking is scoped by user, so nobody can unplug somebody else's machine. */
    async revokeDevice(userId, deviceId) {
      const rows = await q(
        `UPDATE devices SET revoked_at = NOW()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id, name`,
        [deviceId, userId],
      );
      return rows[0] ?? null;
    },

    // ── pairing a computer ──────────────────────────────────────────
    async createPairing({ id, codeHash, deviceName, info, expiresAt }) {
      await q(
        `INSERT INTO pairings (id, code_hash, device_name, info, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, codeHash, deviceName, JSON.stringify(info ?? {}), expiresAt],
      );
      return { id };
    },
    /**
     * Attach a waiting computer to an account.
     *
     * One statement, so two people typing the same code at the same moment
     * cannot both claim it — `claimed_at IS NULL` is part of the match.
     */
    async claimPairing(userId, codeHash, secret) {
      const rows = await q(
        `UPDATE pairings SET user_id = $1, claimed_at = NOW(), secret = $3
          WHERE code_hash = $2 AND claimed_at IS NULL AND expires_at > NOW()
      RETURNING id, device_name, info`,
        [userId, codeHash, secret],
      );
      return rows[0] ?? null;
    },
    async getPairing(id) {
      const rows = await q(
        'SELECT id, user_id, device_name, secret, claimed_at, expires_at FROM pairings WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },
    /** The token is collected exactly once; the row goes with it. */
    async consumePairing(id) {
      const rows = await q(
        `DELETE FROM pairings WHERE id = $1 AND claimed_at IS NOT NULL
      RETURNING user_id, secret, device_name`,
        [id],
      );
      return rows[0] ?? null;
    },
    async prunePairings() {
      await q("DELETE FROM pairings WHERE expires_at < NOW() - INTERVAL '1 hour'");
    },
  };
}
