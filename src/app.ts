import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import authRouter from "./modules/auth/auth.routes";
import { errorHandler } from "./middleware/errorHandler";

export const app = express();


// Helmet sets secure HTTP headers (X-Frame-Options, HSTS, CSP, etc.)
app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use("/auth", authRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(errorHandler);
