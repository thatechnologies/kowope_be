import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const unread = String(req.query.unread ?? "0") === "1";

  const { rows } = await pool.query(
    `
      SELECT
        id,
        type,
        title,
        message,
        group_id,
        actor_id,
        metadata,
        created_at,
        read_at
      FROM notifications
      WHERE user_id = $1
        AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [userId, unread, limit],
  );

  const unreadCountRes = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId],
  );
  const unreadCount = Number(unreadCountRes.rows[0]?.count ?? 0);

  return res.json({ notifications: rows, unreadCount });
});

notificationsRouter.patch("/:id/read", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const id = req.params.id!;
  await pool.query("UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2", [id, userId]);
  return res.json({ ok: true });
});

const markSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

notificationsRouter.patch("/read", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const parsed = markSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  await pool.query(
    "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1 AND id = ANY($2::uuid[])",
    [userId, parsed.data.ids],
  );
  return res.json({ ok: true });
});

notificationsRouter.post("/read-all", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  await pool.query("UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1", [userId]);
  return res.json({ ok: true });
});
