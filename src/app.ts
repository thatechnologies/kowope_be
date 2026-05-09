import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env";
import { authRouter } from "./routes/auth";
import { groupsRouter } from "./routes/groups";
import { adminRouter } from "./routes/admin";
import { notificationsRouter } from "./routes/notifications";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: "https://kowope.vercel.app",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


app.options(/.*/, cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/groups", groupsRouter);
app.use("/admin", adminRouter);
app.use("/notifications", notificationsRouter);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
