import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";

export const groupsRouter = Router();

const generateInviteCode = (name: string) => {
  const slug =
    name
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 4) || "AJO";
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AJO-${slug}-${rand}`;
};

const isGroupMember = async (groupId: string, userId: string) => {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2) AS exists",
    [groupId, userId],
  );
  return rows[0]?.exists ?? false;
};

groupsRouter.get("/", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { rows } = await pool.query(
    `
      SELECT
        g.*,
        gm.is_admin,
        gm.payout_position,
        COALESCE((
          SELECT SUM(c.amount)
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.status = 'confirmed'
        ), 0) AS total_contributed,
        COALESCE((
          SELECT SUM(c.amount)
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.member_id = gm.user_id
            AND c.status = 'confirmed'
        ), 0) AS my_contribution,
        COALESCE((
          SELECT COUNT(DISTINCT c.member_id)
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.status IN ('pending', 'confirmed')
        ), 0) AS paid_this_cycle,
        EXISTS (
          SELECT 1
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.member_id = gm.user_id
            AND c.status IN ('pending', 'confirmed')
        ) AS i_paid_this_cycle,
        (
          SELECT u2.full_name
          FROM group_members gm2
          JOIN users u2 ON u2.id = gm2.user_id
          WHERE gm2.group_id = g.id
            AND gm2.payout_position = ((g.current_cycle - 1) % g.total_members) + 1
          LIMIT 1
        ) AS next_payout_member,
        to_char(
          g.start_date +
            CASE
              WHEN g.frequency = 'Weekly' THEN ((g.current_cycle - 1) * INTERVAL '7 days')
              ELSE ((g.current_cycle - 1) * INTERVAL '1 month')
            END,
          'Dy, DD Mon'
        ) AS next_payout_date
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = $1
      ORDER BY g.created_at DESC
    `,
    [userId],
  );
  return res.json({ groups: rows });
});

const createGroupSchema = z.object({
  name: z.string().trim().min(3).max(50),
  amount: z.number().positive().max(10_000_000),
  frequency: z.enum(["Weekly", "Monthly"]),
  totalMembers: z.number().int().min(2).max(30),
  startDate: z.string().optional(),
  bankName: z.string().trim().max(60).optional(),
  bankAccountNumber: z.string().trim().max(20).optional(),
  bankAccountName: z.string().trim().max(80).optional(),
});

groupsRouter.post("/", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const inviteCode = generateInviteCode(parsed.data.name);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `
        INSERT INTO groups (
          name, amount, frequency, total_members, invite_code, start_date,
          bank_name, bank_account_number, bank_account_name, created_by
        )
        VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8,$9,$10)
        RETURNING id
      `,
      [
        parsed.data.name,
        parsed.data.amount,
        parsed.data.frequency,
        parsed.data.totalMembers,
        inviteCode,
        parsed.data.startDate ?? null,
        parsed.data.bankName ?? null,
        parsed.data.bankAccountNumber ?? null,
        parsed.data.bankAccountName ?? null,
        userId,
      ],
    );
    const groupId = rows[0]!.id;
    await client.query(
      `
        INSERT INTO group_members (group_id, user_id, payout_position, is_admin)
        VALUES ($1, $2, 1, true)
      `,
      [groupId, userId],
    );
    await client.query("COMMIT");
    return res.status(201).json({ groupId, inviteCode });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(409).json({ error: "duplicate" });
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

const joinSchema = z.object({
  inviteCode: z.string().trim().min(4).max(60),
});

groupsRouter.post("/join", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { rows: groups } = await pool.query<{ id: string; total_members: number }>(
    "SELECT id, total_members FROM groups WHERE invite_code = $1",
    [parsed.data.inviteCode],
  );
  const group = groups[0];
  if (!group) return res.status(404).json({ error: "group_not_found" });

  if (await isGroupMember(group.id, userId)) return res.status(409).json({ error: "already_member" });

  const { rows: counts } = await pool.query<{ count: string; max: number | null }>(
    "SELECT COUNT(*)::text AS count, MAX(payout_position) AS max FROM group_members WHERE group_id = $1",
    [group.id],
  );
  const currentCount = Number(counts[0]?.count ?? 0);
  const maxPos = counts[0]?.max ?? 0;
  if (currentCount >= group.total_members) return res.status(409).json({ error: "group_full" });

  try {
    await pool.query(
      "INSERT INTO group_members (group_id, user_id, payout_position, is_admin) VALUES ($1,$2,$3,false)",
      [group.id, userId, maxPos + 1],
    );
    return res.status(201).json({ groupId: group.id });
  } catch (err: unknown) {
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(409).json({ error: "conflict" });
    return res.status(500).json({ error: "server_error" });
  }
});

groupsRouter.get("/:groupId/members", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  if (!(await isGroupMember(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const { rows: groupRows } = await pool.query<{ current_cycle: number }>(
    "SELECT current_cycle FROM groups WHERE id = $1",
    [groupId],
  );
  const currentCycle = groupRows[0]?.current_cycle;
  if (!currentCycle) return res.status(404).json({ error: "group_not_found" });

  const { rows } = await pool.query(
    `
      SELECT
        gm.user_id,
        gm.payout_position,
        gm.is_admin,
        gm.joined_at,
        u.full_name,
        u.phone,
        EXISTS (
          SELECT 1
          FROM contributions c
          WHERE c.group_id = gm.group_id
            AND c.member_id = gm.user_id
            AND c.cycle_number = $2
            AND c.status IN ('pending', 'confirmed')
        ) AS paid,
        EXISTS (
          SELECT 1
          FROM payouts p
          WHERE p.group_id = gm.group_id
            AND p.recipient_id = gm.user_id
        ) AS received_payout
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY gm.payout_position ASC
    `,
    [groupId, currentCycle],
  );
  return res.json({ members: rows });
});

const contributionSchema = z.object({
  transactionReference: z.string().trim().min(4).max(60),
  receiptUrl: z.string().trim().min(1).max(2_000_000).optional(),
});

groupsRouter.post("/:groupId/contributions", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  if (!(await isGroupMember(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const parsed = contributionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { rows: groups } = await pool.query<{ amount: string; current_cycle: number }>(
    "SELECT amount::text, current_cycle FROM groups WHERE id = $1",
    [groupId],
  );
  const group = groups[0];
  if (!group) return res.status(404).json({ error: "group_not_found" });

  const { rows } = await pool.query<{ id: string }>(
    `
      INSERT INTO contributions (group_id, member_id, cycle_number, amount, transaction_reference, receipt_url, status)
      VALUES ($1,$2,$3,$4,$5,$6,'pending')
      RETURNING id
    `,
    [groupId, userId, group.current_cycle, group.amount, parsed.data.transactionReference, parsed.data.receiptUrl ?? null],
  );
  return res.status(201).json({ contributionId: rows[0]!.id });
});
