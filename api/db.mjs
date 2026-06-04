// api/db.mjs — Upstash Redis persistence
// Supports both env var naming conventions Vercel may inject:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (new Upstash integration)
//   KV_REST_API_URL        / KV_REST_API_TOKEN         (legacy Vercel KV → Upstash migration)
import { Redis } from "@upstash/redis";

const REST_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const CONFIGURED = !!(REST_URL && REST_TOKEN);

const STATE_KEY = "cae:v1";

let redis;
function getRedis() {
  if (!redis) redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  return redis;
}

export default async function handler(req, res) {
  if (!CONFIGURED) {
    return res.status(503).json({
      error: "Redis not configured",
      hint: "Visit /api/health for a full diagnostic. Add Upstash Redis via Vercel dashboard → Storage → Create Database, then redeploy."
    });
  }

  if (req.method === "GET") {
    try {
      const data = await getRedis().get(STATE_KEY);
      return res.status(200).json(data ?? {});
    } catch (err) {
      console.error("Redis GET error:", err.message);
      return res.status(503).json({ error: "Redis read failed: " + err.message });
    }
  }

  if (req.method === "POST") {
    try {
      await getRedis().set(STATE_KEY, req.body ?? {});
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Redis SET error:", err.message);
      return res.status(503).json({ error: "Redis write failed: " + err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
