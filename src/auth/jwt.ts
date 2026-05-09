import jwt from "jsonwebtoken";
import { env } from "../env.js";

export const signAccessToken = (payload: { userId: string }) => {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
};

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, env.JWT_SECRET) as { userId: string; iat: number; exp: number };
};

