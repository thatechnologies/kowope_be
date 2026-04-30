import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { createNotification } from "../lib/notifications";

export const adminRouter = Router();

const isGroupAdmin = async (groupId: string, userId: string) => {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_admin = true) AS exists",
    [groupId, userId],
  );
  return rows[0]?.exists ?? false;
};

adminRouter.get("/contributions", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const status = String(req.query.status ?? "pending");
  if (!["pending", "confirmed", "rejected"].includes(status)) return res.status(400).json({ error: "invalid_status" });

  const { rows } = await pool.query(
    `
      SELECT
        c.id,
        c.group_id,
        c.member_id,
        c.cycle_number,
        c.amount,
        c.transaction_reference,
        c.receipt_url,
        c.status,
        c.submitted_at,
        u.full_name AS member_name,
        u.phone AS member_phone,
        g.name AS group_name
      FROM contributions c
      JOIN groups g ON g.id = c.group_id
      JOIN users u ON u.id = c.member_id
      JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = $1 AND gm.is_admin = true
      WHERE c.status = $2
      ORDER BY c.submitted_at DESC
    `,
    [userId, status],
  );

  return res.json({ contributions: rows });
});

const reviewSchema = z.object({
  status: z.enum(["confirmed", "rejected"]),
});

adminRouter.patch("/contributions/:id", requireAuth, async (req, res) => {
  const reviewerId = req.user!.id;
  const id = req.params.id!;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { rows: foundRows } = await pool.query<{ group_id: string; member_id: string; amount: string; cycle_number: number }>(
    "SELECT group_id, member_id, amount::text, cycle_number FROM contributions WHERE id = $1",
    [id],
  );
  const found = foundRows[0];
  if (!found) return res.status(404).json({ error: "not_found" });
  if (!(await isGroupAdmin(found.group_id, reviewerId))) return res.status(403).json({ error: "forbidden" });

  await pool.query(
    "UPDATE contributions SET status = $1, reviewed_at = now(), reviewed_by = $2 WHERE id = $3",
    [parsed.data.status, reviewerId, id],
  );

  const { rows: gRows } = await pool.query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [found.group_id]);
  const groupName = gRows[0]?.name ?? "your group";
  await createNotification({
    userId: found.member_id,
    type: parsed.data.status === "confirmed" ? "contribution_confirmed" : "contribution_rejected",
    title: parsed.data.status === "confirmed" ? "Payment confirmed" : "Payment rejected",
    message:
      parsed.data.status === "confirmed"
        ? `Your payment was confirmed in ${groupName}.`
        : `Your payment was rejected in ${groupName}.`,
    groupId: found.group_id,
    actorId: reviewerId,
    metadata: { groupId: found.group_id, contributionId: id, cycle: found.cycle_number, amount: Number(found.amount) },
  });

  return res.json({ ok: true });
});
