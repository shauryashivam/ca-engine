// api/db.mjs — Upstash Redis-backed persistence for GET/POST /api/db
//
// Setup (one-time):
//   1. Vercel dashboard → Integrations → Add → search "Upstash Redis" → Create & link.
//   2. Vercel auto-injects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
//   3. For local Vercel dev: `vercel env pull .env.local` then `vercel dev`.
//      (For plain `node server.mjs`, local dev uses db.json instead — no Redis needed.)

import { Redis } from "@upstash/redis";

const STATE_KEY = "cae:v1";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const data = await getRedis().get(STATE_KEY);
      return res.status(200).json(data ?? {});
    } catch (err) {
      console.error("Redis GET error:", err);
      return res.status(200).json({});   // degrade gracefully
    }
  }

  if (req.method === "POST") {
    try {
      const body = req.body ?? {};
      await getRedis().set(STATE_KEY, body);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Redis SET error:", err);
      return res.status(500).json({ error: "Failed to save state" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
