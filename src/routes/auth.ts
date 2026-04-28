import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool";
import { signAccessToken } from "../auth/jwt";
import { requireAuth } from "../auth/middleware";

export const authRouter = Router();

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
    return res.status(201).json({ token, user });
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
  return res.json({ token, user: { id: found.id, email: found.email, full_name: found.full_name, phone: found.phone } });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { rows } = await pool.query<{ id: string; email: string; full_name: string; phone: string }>(
    "SELECT id, email, full_name, phone FROM users WHERE id = $1",
    [userId],
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "not_found" });
  return res.json({ user });
});
