import type { RequestHandler } from "express";
import { verifyAccessToken } from "./jwt.js";

export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.header("authorization") ?? "";
  const [, token] = header.split(" ");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.userId };
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
};

