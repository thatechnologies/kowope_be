import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { createNotification, notifyGroupAdmins, notifyGroupMembers } from "../lib/notifications";

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

const isGroupAdmin = async (groupId: string, userId: string) => {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_admin = true) AS exists",
    [groupId, userId],
  );
  return rows[0]?.exists ?? false;
};

const requireKycVerified = async (userId: string) => {
  const { rows } = await pool.query<{ status: "unverified" | "verified" | "rejected" }>(
    "SELECT status FROM user_kyc WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.status === "verified";
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
        COALESCE((
          SELECT COUNT(DISTINCT c.member_id)
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.status = 'confirmed'
        ), 0) AS confirmed_this_cycle,
        EXISTS (
          SELECT 1
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.member_id = gm.user_id
            AND c.status IN ('pending', 'confirmed')
        ) AS i_paid_this_cycle,
        (
          SELECT gm2.user_id
          FROM group_members gm2
          WHERE gm2.group_id = g.id
            AND gm2.payout_position = ((g.current_cycle - 1) % g.total_members) + 1
          LIMIT 1
        ) AS next_payout_member_id,
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

groupsRouter.get("/:groupId", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
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
        COALESCE((
          SELECT COUNT(DISTINCT c.member_id)
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.status = 'confirmed'
        ), 0) AS confirmed_this_cycle,
        EXISTS (
          SELECT 1
          FROM contributions c
          WHERE c.group_id = g.id
            AND c.cycle_number = g.current_cycle
            AND c.member_id = gm.user_id
            AND c.status IN ('pending', 'confirmed')
        ) AS i_paid_this_cycle,
        (
          SELECT gm2.user_id
          FROM group_members gm2
          WHERE gm2.group_id = g.id
            AND gm2.payout_position = ((g.current_cycle - 1) % g.total_members) + 1
          LIMIT 1
        ) AS next_payout_member_id,
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
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
      WHERE g.id = $2
      LIMIT 1
    `,
    [userId, groupId],
  );
  const group = rows[0];
  if (!group) return res.status(404).json({ error: "not_found" });
  return res.json({ group });
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
  if (!(await requireKycVerified(userId))) return res.status(403).json({ error: "kyc_required" });
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

const updateBankSchema = z.object({
  bankName: z.string().trim().max(60).nullable().optional(),
  bankAccountNumber: z.string().trim().max(20).nullable().optional(),
  bankAccountName: z.string().trim().max(80).nullable().optional(),
});

groupsRouter.patch("/:groupId/bank", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  const parsed = updateBankSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!(await isGroupAdmin(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  await pool.query(
    "UPDATE groups SET bank_name = $1, bank_account_number = $2, bank_account_name = $3 WHERE id = $4",
    [parsed.data.bankName ?? null, parsed.data.bankAccountNumber ?? null, parsed.data.bankAccountName ?? null, groupId],
  );
  return res.json({ ok: true });
});

const joinSchema = z.object({
  inviteCode: z.string().trim().min(4).max(60),
});

groupsRouter.post("/join", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  if (!(await requireKycVerified(userId))) return res.status(403).json({ error: "kyc_required" });
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { rows: groups } = await pool.query<{ id: string; total_members: number; name: string }>(
    "SELECT id, total_members, name FROM groups WHERE invite_code = $1",
    [parsed.data.inviteCode],
  );
  const group = groups[0];
  if (!group) return res.status(404).json({ error: "group_not_found" });

  if (await isGroupMember(group.id, userId)) return res.status(409).json({ error: "already_member" });

  const { rows: counts } = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM group_members WHERE group_id = $1",
    [group.id],
  );
  const currentCount = Number(counts[0]?.count ?? 0);
  if (currentCount >= group.total_members) return res.status(409).json({ error: "group_full" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{ status: "pending" | "approved" | "rejected" }>(
      "SELECT status FROM group_join_requests WHERE group_id = $1 AND user_id = $2",
      [group.id, userId],
    );
    const existing = existingRows[0];
    if (existing?.status === "pending") {
      await client.query("COMMIT");
      return res.status(202).json({ groupId: group.id, status: "pending" });
    }
    if (existing?.status === "rejected") {
      await client.query(
        "UPDATE group_join_requests SET status = 'pending', requested_at = now(), reviewed_at = null, reviewed_by = null WHERE group_id = $1 AND user_id = $2",
        [group.id, userId],
      );
      await client.query("COMMIT");
      return res.status(202).json({ groupId: group.id, status: "pending" });
    }

    await client.query(
      "INSERT INTO group_join_requests (group_id, user_id, status) VALUES ($1,$2,'pending')",
      [group.id, userId],
    );
    await client.query("COMMIT");
    const { rows: uRows } = await pool.query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1", [userId]);
    const requesterName = uRows[0]?.full_name ?? "Someone";
    await notifyGroupAdmins(
      group.id,
      {
        type: "join_request_created",
        title: "New join request",
        message: `${requesterName} requested to join ${group.name}.`,
        actorId: userId,
        metadata: { groupId: group.id, requesterId: userId },
      },
      { excludeUserId: userId },
    );
    return res.status(202).json({ groupId: group.id, status: "pending" });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(202).json({ groupId: group.id, status: "pending" });
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

groupsRouter.get("/:groupId/join-requests", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  const status = String(req.query.status ?? "pending");
  if (!["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  if (!(await isGroupAdmin(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const { rows } = await pool.query(
    `
      SELECT
        r.id,
        r.group_id,
        r.user_id,
        r.status,
        r.requested_at,
        u.full_name,
        u.phone,
        u.email
      FROM group_join_requests r
      JOIN users u ON u.id = r.user_id
      WHERE r.group_id = $1 AND r.status = $2
      ORDER BY r.requested_at DESC
    `,
    [groupId, status],
  );
  return res.json({ requests: rows });
});

const reviewJoinSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

groupsRouter.patch("/:groupId/join-requests/:requestId", requireAuth, async (req, res) => {
  const adminId = req.user!.id;
  const groupId = req.params.groupId!;
  const requestId = req.params.requestId!;
  const parsed = reviewJoinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  if (!(await isGroupAdmin(groupId, adminId))) return res.status(403).json({ error: "forbidden" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: reqRows } = await client.query<{ user_id: string; status: "pending" | "approved" | "rejected" }>(
      "SELECT user_id, status FROM group_join_requests WHERE id = $1 AND group_id = $2 FOR UPDATE",
      [requestId, groupId],
    );
    const found = reqRows[0];
    if (!found) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    if (found.status !== "pending") {
      await client.query("COMMIT");
      return res.json({ ok: true });
    }

    if (parsed.data.status === "rejected") {
      await client.query(
        "UPDATE group_join_requests SET status = 'rejected', reviewed_at = now(), reviewed_by = $1 WHERE id = $2",
        [adminId, requestId],
      );
      await client.query("COMMIT");
      const { rows: gRows } = await pool.query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [groupId]);
      const groupName = gRows[0]?.name ?? "the group";
      await createNotification({
        userId: found.user_id,
        type: "join_request_rejected",
        title: "Join request rejected",
        message: `Your request to join ${groupName} was rejected.`,
        groupId,
        actorId: adminId,
        metadata: { groupId },
      });
      return res.json({ ok: true });
    }

    const { rows: grpRows } = await client.query<{ total_members: number }>("SELECT total_members FROM groups WHERE id = $1", [groupId]);
    const totalMembers = grpRows[0]?.total_members;
    if (!totalMembers) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "group_not_found" });
    }

    const { rows: counts } = await client.query<{ count: string; max: number | null }>(
      "SELECT COUNT(*)::text AS count, MAX(payout_position) AS max FROM group_members WHERE group_id = $1",
      [groupId],
    );
    const currentCount = Number(counts[0]?.count ?? 0);
    const maxPos = counts[0]?.max ?? 0;
    if (currentCount >= totalMembers) {
      await client.query(
        "UPDATE group_join_requests SET status = 'rejected', reviewed_at = now(), reviewed_by = $1 WHERE id = $2",
        [adminId, requestId],
      );
      await client.query("COMMIT");
      return res.status(409).json({ error: "group_full" });
    }

    await client.query(
      "INSERT INTO group_members (group_id, user_id, payout_position, is_admin) VALUES ($1,$2,$3,false) ON CONFLICT (group_id, user_id) DO NOTHING",
      [groupId, found.user_id, maxPos + 1],
    );
    await client.query(
      "UPDATE group_join_requests SET status = 'approved', reviewed_at = now(), reviewed_by = $1 WHERE id = $2",
      [adminId, requestId],
    );

    await client.query("COMMIT");
    const { rows: gRows } = await pool.query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [groupId]);
    const groupName = gRows[0]?.name ?? "the group";
    await createNotification({
      userId: found.user_id,
      type: "join_request_approved",
      title: "Join request approved",
      message: `You were approved to join ${groupName}.`,
      groupId,
      actorId: adminId,
      metadata: { groupId },
    });
    return res.json({ ok: true });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
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
        c.status AS contribution_status,
        COALESCE(c.status IN ('pending', 'confirmed'), false) AS paid,
        EXISTS (
          SELECT 1
          FROM payouts p
          WHERE p.group_id = gm.group_id
            AND p.recipient_id = gm.user_id
        ) AS received_payout
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      LEFT JOIN contributions c
        ON c.group_id = gm.group_id
        AND c.member_id = gm.user_id
        AND c.cycle_number = $2
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
  const contributionId = rows[0]!.id;
  const [{ rows: nameRows }, { rows: gNameRows }] = await Promise.all([
    pool.query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1", [userId]),
    pool.query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [groupId]),
  ]);
  const memberName = nameRows[0]?.full_name ?? "A member";
  const groupName = gNameRows[0]?.name ?? "your group";
  await notifyGroupAdmins(
    groupId,
    {
      type: "contribution_submitted",
      title: "Payment submitted",
      message: `${memberName} submitted a payment for ${groupName} (cycle ${group.current_cycle}).`,
      actorId: userId,
      metadata: { groupId, contributionId, memberId: userId, cycle: group.current_cycle, amount: Number(group.amount) },
    },
    { excludeUserId: userId },
  );
  return res.status(201).json({ contributionId });
});

groupsRouter.get("/:groupId/contributions", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  if (!(await isGroupMember(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const cycleRaw = req.query.cycle;
  const cycle = typeof cycleRaw === "string" && cycleRaw.trim() ? Number(cycleRaw) : undefined;
  if (cycleRaw !== undefined && (!Number.isFinite(cycle) || (cycle as number) < 1)) {
    return res.status(400).json({ error: "invalid_cycle" });
  }

  const admin = await isGroupAdmin(groupId, userId);
  const params: unknown[] = [groupId];
  let where = "c.group_id = $1";
  if (cycle) {
    params.push(cycle);
    where += ` AND c.cycle_number = $${params.length}`;
  }
  if (!admin) {
    params.push(userId);
    where += ` AND c.member_id = $${params.length}`;
  }

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
        c.reviewed_at,
        c.reviewed_by,
        u.full_name AS member_name
      FROM contributions c
      JOIN users u ON u.id = c.member_id
      WHERE ${where}
      ORDER BY c.submitted_at DESC
      LIMIT 200
    `,
    params as any[],
  );

  return res.json({ contributions: rows, isAdmin: admin });
});

const payoutSchema = z.object({
  recipientId: z.string().uuid().optional(),
  notes: z.string().trim().max(300).optional(),
});

groupsRouter.get("/:groupId/payouts", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  if (!(await isGroupMember(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const { rows } = await pool.query(
    `
      SELECT
        p.id,
        p.group_id,
        p.recipient_id,
        p.cycle_number,
        p.amount,
        p.paid_at,
        p.recorded_by,
        p.notes,
        u.full_name AS recipient_name
      FROM payouts p
      JOIN users u ON u.id = p.recipient_id
      WHERE p.group_id = $1
      ORDER BY p.cycle_number DESC
      LIMIT 200
    `,
    [groupId],
  );

  return res.json({ payouts: rows });
});

groupsRouter.post("/:groupId/payouts", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const groupId = req.params.groupId!;
  if (!(await isGroupAdmin(groupId, userId))) return res.status(403).json({ error: "forbidden" });

  const parsed = payoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: groupRows } = await client.query<{ current_cycle: number; total_members: number; amount: string; frequency: string }>(
      "SELECT current_cycle, total_members, amount::text, frequency FROM groups WHERE id = $1 FOR UPDATE",
      [groupId],
    );
    const group = groupRows[0];
    if (!group) return res.status(404).json({ error: "group_not_found" });

    const potAmount = Number(group.amount) * group.total_members;

    let recipientId = parsed.data.recipientId ?? null;
    if (!recipientId) {
      const { rows: recRows } = await client.query<{ user_id: string }>(
        `
          SELECT user_id
          FROM group_members
          WHERE group_id = $1
            AND payout_position = (($2 - 1) % $3) + 1
          LIMIT 1
        `,
        [groupId, group.current_cycle, group.total_members],
      );
      recipientId = recRows[0]?.user_id ?? null;
      if (!recipientId) return res.status(500).json({ error: "recipient_not_found" });
    }

    const { rows: existing } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM payouts WHERE group_id = $1 AND cycle_number = $2) AS exists",
      [groupId, group.current_cycle],
    );
    if (existing[0]?.exists) return res.status(409).json({ error: "payout_already_recorded" });

    const { rows: payoutRows } = await client.query<{ id: string }>(
      `
        INSERT INTO payouts (group_id, recipient_id, cycle_number, amount, recorded_by, notes)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
      `,
      [groupId, recipientId, group.current_cycle, potAmount, userId, parsed.data.notes ?? null],
    );

    const nextCycle = group.current_cycle + 1 > group.total_members ? 1 : group.current_cycle + 1;
    await client.query("UPDATE groups SET current_cycle = $1 WHERE id = $2", [nextCycle, groupId]);

    await client.query("COMMIT");
    const { rows: gRows } = await pool.query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [groupId]);
    const groupName = gRows[0]?.name ?? "the group";
    const { rows: rRows } = await pool.query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1", [recipientId]);
    const recipientName = rRows[0]?.full_name ?? "a member";
    await notifyGroupMembers(
      groupId,
      {
        type: "payout_recorded",
        title: "Payout recorded",
        message: `${recipientName} received a payout in ${groupName}.`,
        actorId: userId,
        metadata: { groupId, payoutId: payoutRows[0]!.id, recipientId, cycle: group.current_cycle, amount: potAmount },
      },
      { excludeUserId: userId },
    );
    return res.status(201).json({ payoutId: payoutRows[0]!.id, advancedToCycle: nextCycle });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(409).json({ error: "conflict" });
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});
