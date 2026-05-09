import { pool } from "../db/pool.js";

export type NotificationType =
  | "join_request_created"
  | "join_request_approved"
  | "join_request_rejected"
  | "contribution_submitted"
  | "contribution_confirmed"
  | "contribution_rejected"
  | "payout_recorded";

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  groupId?: string | null;
  actorId?: string | null;
  metadata?: unknown;
};

export const createNotification = async (input: CreateNotificationInput) => {
  await pool.query(
    `
      INSERT INTO notifications (user_id, type, title, message, group_id, actor_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))
    `,
    [
      input.userId,
      input.type,
      input.title,
      input.message,
      input.groupId ?? null,
      input.actorId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
};

export const notifyUsers = async (userIds: string[], input: Omit<CreateNotificationInput, "userId">) => {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return;
  await Promise.all(unique.map((userId) => createNotification({ ...input, userId })));
};

export const notifyGroupAdmins = async (
  groupId: string,
  input: Omit<CreateNotificationInput, "userId" | "groupId">,
  opts?: { excludeUserId?: string },
) => {
  const { rows } = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM group_members WHERE group_id = $1 AND is_admin = true",
    [groupId],
  );
  const ids = rows.map((r) => r.user_id).filter((id) => id !== opts?.excludeUserId);
  await notifyUsers(ids, { ...input, groupId });
};

export const notifyGroupMembers = async (
  groupId: string,
  input: Omit<CreateNotificationInput, "userId" | "groupId">,
  opts?: { excludeUserId?: string },
) => {
  const { rows } = await pool.query<{ user_id: string }>("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
  const ids = rows.map((r) => r.user_id).filter((id) => id !== opts?.excludeUserId);
  await notifyUsers(ids, { ...input, groupId });
};
