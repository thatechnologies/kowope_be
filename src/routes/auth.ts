import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { signAccessToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import crypto from "node:crypto";

export const authRouter = Router();

const ninHash = (nin: string) => {
  const normalized = nin.replace(/\D/g, "");
  const salt = process.env.KYC_SALT || process.env.JWT_SECRET || "kowope";
  return crypto.createHash("sha256").update(`${salt}:${normalized}`).digest("hex");
};

const kycStatusForUser = async (userId: string) => {
  const { rows } = await pool.query<{ status: "unverified" | "verified" | "rejected" }>(
    "SELECT status FROM user_kyc WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.status ?? "unverified";
};

const signupSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
  fullName: z.string().trim().min(2).max(60),
  phone: z.string().trim().min(7).max(30),
});

authRouter.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  try {
    const { rows } = await pool.query<{
      id: string;
      email: string;
      full_name: string;
      phone: string;
    }>(
      `
        INSERT INTO users (email, password_hash, full_name, phone)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, full_name, phone
      `,
      [email, passwordHash, parsed.data.fullName, parsed.data.phone],
    );
    const user = rows[0]!;
    const token = signAccessToken({ userId: user.id });
    return res.status(201).json({ token, user: { ...user, kyc_status: "unverified" } });
  } catch (err: unknown) {
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(409).json({ error: "email_taken" });
    return res.status(500).json({ error: "server_error" });
  }
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  const { rows } = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    phone: string;
  }>("SELECT id, email, password_hash, full_name, phone FROM users WHERE email = $1", [email]);

  const found = rows[0];
  if (!found) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await bcrypt.compare(parsed.data.password, found.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = signAccessToken({ userId: found.id });
  const status = await kycStatusForUser(found.id);
  return res.json({ token, user: { id: found.id, email: found.email, full_name: found.full_name, phone: found.phone, kyc_status: status } });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { rows } = await pool.query<{ id: string; email: string; full_name: string; phone: string; kyc_status: "unverified" | "verified" | "rejected" }>(
    `
      SELECT
        u.id,
        u.email,
        u.full_name,
        u.phone,
        COALESCE(k.status, 'unverified') AS kyc_status
      FROM users u
      LEFT JOIN user_kyc k ON k.user_id = u.id
      WHERE u.id = $1
    `,
    [userId],
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "not_found" });
  return res.json({ user });
});

const submitKycSchema = z.object({
  nin: z.string().trim().min(11).max(20),
  dob: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  ninCardDataUrl: z.string().trim().min(1).max(2_000_000),
});

authRouter.get("/kyc", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { rows } = await pool.query<{ status: "unverified" | "verified" | "rejected"; submitted_at: string; verified_at: string | null }>(
    "SELECT status, submitted_at, verified_at FROM user_kyc WHERE user_id = $1",
    [userId],
  );
  const kyc = rows[0] ?? { status: "unverified", submitted_at: null, verified_at: null };
  return res.json({ kyc });
});

authRouter.post("/kyc", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const parsed = submitKycSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const ninDigits = parsed.data.nin.replace(/\D/g, "");
  if (ninDigits.length !== 11) return res.status(400).json({ error: "invalid_nin" });
  const hash = ninHash(ninDigits);
  const last4 = ninDigits.slice(-4);

  try {
    await pool.query(
      `
        INSERT INTO user_kyc (user_id, status, nin_hash, nin_last4, dob, nin_card_data_url, submitted_at, verified_at)
        VALUES ($1, 'verified', $2, $3, $4::date, $5, now(), now())
        ON CONFLICT (user_id) DO UPDATE SET
          status = 'verified',
          nin_hash = EXCLUDED.nin_hash,
          nin_last4 = EXCLUDED.nin_last4,
          dob = EXCLUDED.dob,
          nin_card_data_url = EXCLUDED.nin_card_data_url,
          submitted_at = now(),
          verified_at = now(),
          rejected_at = null,
          rejection_reason = null
      `,
      [userId, hash, last4, parsed.data.dob, parsed.data.ninCardDataUrl],
    );
    return res.json({ ok: true });
  } catch (err: unknown) {
    const pgCode =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (pgCode === "23505") return res.status(409).json({ error: "nin_already_used" });
    return res.status(500).json({ error: "server_error" });
  }
});
