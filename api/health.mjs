// api/health.mjs — diagnostic endpoint to debug Redis connectivity
// Visit /api/health in your browser to see exactly what's failing.
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  // Vercel Upstash integration can set either naming convention depending on
  // how the database was connected — check both
  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const kvUrl        = process.env.KV_REST_API_URL;
  const kvToken      = process.env.KV_REST_API_TOKEN;

  const url   = upstashUrl   || kvUrl;
  const token = upstashToken || kvToken;

  const envReport = {
    UPSTASH_REDIS_REST_URL:   upstashUrl   ? `set (${upstashUrl.slice(0, 40)}…)`   : "NOT SET",
    UPSTASH_REDIS_REST_TOKEN: upstashToken ? "set (hidden)"                        : "NOT SET",
    KV_REST_API_URL:          kvUrl        ? `set (${kvUrl.slice(0, 40)}…)`        : "NOT SET",
    KV_REST_API_TOKEN:        kvToken      ? "set (hidden)"                        : "NOT SET",
  };

  if (!url || !token) {
    return res.status(503).json({
      status: "NO_CREDENTIALS",
      message: "No Redis credentials found in environment. Add Upstash Redis via Vercel dashboard → Storage → Create Database, then redeploy.",
      env: envReport,
    });
  }

  // Test the connection
  try {
    const redis = new Redis({ url, token });
    await redis.set("__health_check", "ok", { ex: 60 });
    const val = await redis.get("__health_check");

    return res.status(200).json({
      status: val === "ok" ? "OK" : "READ_MISMATCH",
      message: val === "ok" ? "Redis is connected and working." : "Write succeeded but read returned unexpected value.",
      usingVars: upstashUrl ? "UPSTASH_REDIS_REST_*" : "KV_REST_API_*",
      env: envReport,
    });
  } catch (err) {
    return res.status(503).json({
      status: "CONNECTION_FAILED",
      message: err.message,
      env: envReport,
    });
  }
}
