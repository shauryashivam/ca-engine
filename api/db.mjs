// api/db.mjs — Upstash Redis persistence for GET/POST /api/db
import { Redis } from "@upstash/redis";

const STATE_KEY = "cae:v1";
const CONFIGURED = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis;
function getRedis() {
  if (!redis) redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  return redis;
}

export default async function handler(req, res) {
  // Return a clear 503 so the client knows DB isn't wired up yet
  if (!CONFIGURED) {
    return res.status(503).json({ error: "Redis not configured — add Upstash Redis integration in Vercel dashboard" });
  }

  if (req.method === "GET") {
    try {
      const data = await getRedis().get(STATE_KEY);
      return res.status(200).json(data ?? {});
    } catch (err) {
      console.error("Redis GET error:", err.message);
      return res.status(503).json({ error: "Redis read failed" });
    }
  }

  if (req.method === "POST") {
    try {
      await getRedis().set(STATE_KEY, req.body ?? {});
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Redis SET error:", err.message);
      return res.status(503).json({ error: "Redis write failed" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
