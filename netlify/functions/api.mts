/**
 * WALL GO II — Netlify Functions + Netlify Database (@netlify/database) Ranked Lobby API
 *
 * Route: /api/wallgo
 * Full parity with api.php:
 *   - GET  /api/wallgo?action=state&name=...
 *   - POST /api/wallgo?action=auth
 *   - POST /api/wallgo?action=heartbeat
 *   - POST /api/wallgo?action=report_match
 *   - POST /api/wallgo?action=save_replay
 */

import crypto from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";

const PRESENCE_TTL_MS = 16_000;
const MATCH_TTL_MS = 60_000;
const ACTIVE_MATCH_MAX_MS = 3_600_000;
const ACTIVE_MATCH_GRACE_MS = 6_000;
const MAX_HISTORY = 5;
const MAX_EVENTS = 30;
const MAX_PROCESSED_MATCHES = 80;
const ADVISORY_LOCK_KEY = 774_901;

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

interface SeedAiPro {
  id: string;
  name: string;
  rp: number;
  wins: number;
  losses: number;
  draws: number;
  aiLevel: string;
  skill: number;
  sortOrder: number;
}

const SEED_AI_PROS: SeedAiPro[] = [
  { id: "r_kyu",   name: "KyuMaster",     rp: 1790, wins: 48, losses: 11, draws: 2, aiLevel: "hard",   skill: 0.96, sortOrder: 1 },
  { id: "r_orbit", name: "幽影壁壘",       rp: 1645, wins: 39, losses: 14, draws: 3, aiLevel: "hard",   skill: 0.89, sortOrder: 2 },
  { id: "r_seok",  name: "絕境圍城",       rp: 1530, wins: 34, losses: 16, draws: 2, aiLevel: "hard",   skill: 0.80, sortOrder: 3 },
  { id: "r_hyun",  name: "HyunGyu_Pro",   rp: 1445, wins: 29, losses: 16, draws: 1, aiLevel: "hard",   skill: 0.74, sortOrder: 4 },
  { id: "r_nova",  name: "赤藍策士",       rp: 1350, wins: 25, losses: 17, draws: 2, aiLevel: "medium", skill: 0.64, sortOrder: 5 },
  { id: "r_tin",   name: "Tinno_99",      rp: 1270, wins: 21, losses: 16, draws: 1, aiLevel: "medium", skill: 0.56, sortOrder: 6 },
  { id: "r_zen",   name: "深藍封鎖線",     rp: 1165, wins: 16, losses: 15, draws: 2, aiLevel: "medium", skill: 0.48, sortOrder: 7 },
  { id: "r_kuro",  name: "黑曜棋手",       rp: 1085, wins: 12, losses: 14, draws: 1, aiLevel: "easy",   skill: 0.40, sortOrder: 8 },
  { id: "r_rook",  name: "新手試煉者",     rp: 980,  wins: 7,  losses: 13, draws: 0, aiLevel: "easy",   skill: 0.32, sortOrder: 9 },
];

interface PgClientLike {
  query: <T = Record<string, any>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  release: () => void;
}

interface EntryRow {
  id: string;
  norm_key: string;
  name: string;
  is_ai: boolean;
  rp: number;
  wins: number;
  losses: number;
  draws: number;
  ai_level: string | null;
  skill: number | null;
  last_delta: number;
  sort_order: number;
}

let seededOnce = false;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  let s = String(raw);
  s = s.replace(/\s*\(\d+\)\s*$/u, "");
  s = s.replace(/[<>&"']/gu, "");
  s = s.trim();
  return Array.from(s).slice(0, 14).join("");
}

function normKey(name: string): string {
  return cleanName(name).toLowerCase();
}

function hashPin(key: string, pin: string): string {
  return crypto
    .createHash("sha256")
    .update(`wallgo_dp_pin_v1|${key}|${pin}`, "utf8")
    .digest("hex");
}

function safeHashEquals(known: string, user: string): boolean {
  const a = Buffer.from(known, "utf8");
  const b = Buffer.from(user, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function genMatchCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "RK";
  for (let i = 0; i < 4; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

function isAiName(key: string): boolean {
  return SEED_AI_PROS.some((ai) => normKey(ai.name) === key);
}

function humanEntryId(key: string): string {
  const md5 = crypto.createHash("md5").update(key, "utf8").digest("hex");
  return `human_${md5.slice(0, 10)}`;
}

async function readJsonBody(req: Request): Promise<Record<string, any>> {
  if (req.method !== "POST") return {};
  try {
    const raw = await req.text();
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function withTx<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
  const db = getDatabase();
  const client = (await db.pool.connect()) as unknown as PgClientLike;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

async function ensureSeeded(client: PgClientLike, now: number): Promise<void> {
  if (seededOnce) return;
  await client.query(
    `INSERT INTO wallgo_meta (id, version, updated_at)
     VALUES (1, 1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [now]
  );
  for (const ai of SEED_AI_PROS) {
    await client.query(
      `INSERT INTO wallgo_entries
         (id, norm_key, name, is_ai, rp, wins, losses, draws, ai_level, skill, last_delta, sort_order)
       VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, $9, 0, $10)
       ON CONFLICT (id) DO NOTHING`,
      [ai.id, normKey(ai.name), ai.name, ai.rp, ai.wins, ai.losses, ai.draws, ai.aiLevel, ai.skill, ai.sortOrder]
    );
  }
  seededOnce = true;
}

async function bumpMeta(client: PgClientLike, now: number): Promise<void> {
  await client.query(
    `UPDATE wallgo_meta SET version = version + 1, updated_at = $1 WHERE id = 1`,
    [now]
  );
}

async function ensureHumanEntry(
  client: PgClientLike,
  name: string,
  initialRp = 1200
): Promise<EntryRow> {
  const clean = cleanName(name);
  const key = normKey(clean);
  const existing = await client.query<EntryRow>(
    `SELECT * FROM wallgo_entries WHERE is_ai = FALSE AND norm_key = $1 LIMIT 1`,
    [key]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }
  const rp = initialRp >= 800 ? Math.trunc(initialRp) : 1200;
  const id = humanEntryId(key);
  const inserted = await client.query<EntryRow>(
    `INSERT INTO wallgo_entries
       (id, norm_key, name, is_ai, rp, wins, losses, draws, last_delta, sort_order)
     VALUES ($1, $2, $3, FALSE, $4, 0, 0, 0, 0, 100)
     ON CONFLICT (norm_key) DO UPDATE SET name = wallgo_entries.name
     RETURNING *`,
    [id, key, clean, rp]
  );
  return inserted.rows[0];
}

async function appendEvent(
  client: PgClientLike,
  type: string,
  name: string,
  now: number
): Promise<void> {
  await client.query(
    `INSERT INTO wallgo_events (type, name, at) VALUES ($1, $2, $3)`,
    [type, name, now]
  );
  await client.query(
    `DELETE FROM wallgo_events
     WHERE id NOT IN (
       SELECT id FROM wallgo_events ORDER BY id DESC LIMIT $1
     )`,
    [MAX_EVENTS]
  );
}

async function recordProcessedMatch(
  client: PgClientLike,
  matchId: string,
  now: number
): Promise<void> {
  if (!matchId) return;
  await client.query(
    `INSERT INTO wallgo_processed_matches (match_id, processed_at)
     VALUES ($1, $2)
     ON CONFLICT (match_id) DO NOTHING`,
    [matchId, now]
  );
  await client.query(
    `DELETE FROM wallgo_processed_matches
     WHERE match_id NOT IN (
       SELECT match_id FROM wallgo_processed_matches ORDER BY processed_at DESC LIMIT $1
     )`,
    [MAX_PROCESSED_MATCHES]
  );
}

async function isMatchProcessed(client: PgClientLike, matchId: string): Promise<boolean> {
  if (!matchId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM wallgo_processed_matches WHERE match_id = $1 LIMIT 1`,
    [matchId]
  );
  return rows.length > 0;
}

async function simulateIdleAiPros(client: PgClientLike, excludeAiId: string): Promise<void> {
  const { rows } = await client.query<EntryRow>(
    `SELECT * FROM wallgo_entries WHERE is_ai = TRUE AND id <> $1`,
    [excludeAiId]
  );
  if (rows.length === 0) return;

  // Fisher-Yates shuffle
  const list = rows.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }

  for (let i = 0; i + 1 < list.length; i += 2) {
    const a = list[i];
    const b = list[i + 1];
    const sa = typeof a.skill === "number" ? a.skill : 0.55;
    const sb = typeof b.skill === "number" ? b.skill : 0.55;
    const winProbA = Math.max(0.18, Math.min(0.82, 0.5 + (sa - sb) * 0.72));

    let actualA: number;
    let winsA = Number(a.wins) || 0;
    let lossesA = Number(a.losses) || 0;
    let drawsA = Number(a.draws) || 0;
    let winsB = Number(b.wins) || 0;
    let lossesB = Number(b.losses) || 0;
    let drawsB = Number(b.draws) || 0;

    const roll = crypto.randomInt(0, 10001) / 10000;
    if (roll < 0.06) {
      actualA = 0.5;
      drawsA += 1;
      drawsB += 1;
    } else if (crypto.randomInt(0, 10001) / 10000 < winProbA) {
      actualA = 1.0;
      winsA += 1;
      lossesB += 1;
    } else {
      actualA = 0.0;
      winsB += 1;
      lossesA += 1;
    }

    const rpA = Number(a.rp) || 1200;
    const rpB = Number(b.rp) || 1200;
    const expectedA = 1.0 / (1.0 + Math.pow(10.0, (rpB - rpA) / 400.0));
    let deltaA = Math.round(34.0 * (actualA - expectedA));
    if (actualA === 1.0 && deltaA < 12) deltaA = 12;
    if (actualA === 0.0 && deltaA > -10) deltaA = -10;

    const newRpA = Math.max(800, rpA + deltaA);
    const newRpB = Math.max(800, rpB - deltaA);

    await client.query(
      `UPDATE wallgo_entries
       SET rp = $1, wins = $2, losses = $3, draws = $4, last_delta = $5
       WHERE id = $6`,
      [newRpA, winsA, lossesA, drawsA, deltaA, a.id]
    );
    await client.query(
      `UPDATE wallgo_entries
       SET rp = $1, wins = $2, losses = $3, draws = $4, last_delta = $5
       WHERE id = $6`,
      [newRpB, winsB, lossesB, drawsB, -deltaA, b.id]
    );
  }

  if (list.length % 2 === 1) {
    const s = list[list.length - 1];
    const skill = typeof s.skill === "number" ? s.skill : 0.55;
    const won = crypto.randomInt(0, 10001) / 10000 < skill;
    const delta = won ? crypto.randomInt(14, 25) : -crypto.randomInt(12, 22);
    const rpS = Number(s.rp) || 1200;
    const newRpS = Math.max(800, rpS + delta);
    const winsS = (Number(s.wins) || 0) + (won ? 1 : 0);
    const lossesS = (Number(s.losses) || 0) + (won ? 0 : 1);

    await client.query(
      `UPDATE wallgo_entries
       SET rp = $1, wins = $2, losses = $3, last_delta = $4
       WHERE id = $5`,
      [newRpS, winsS, lossesS, delta, s.id]
    );
  }
}

async function settleHumanForfeit(
  client: PgClientLike,
  leaverName: string,
  winnerName: string,
  matchCode: string,
  now: number
): Promise<boolean> {
  const matchId = `p2p_${matchCode}_forfeit`;
  if (await isMatchProcessed(client, matchId)) {
    return false;
  }

  const entryL = await ensureHumanEntry(client, leaverName, 1200);
  const entryW = await ensureHumanEntry(client, winnerName, 1200);

  await client.query(
    `UPDATE wallgo_entries SET last_delta = 0 WHERE is_ai = FALSE AND id <> $1 AND id <> $2`,
    [entryL.id, entryW.id]
  );

  const rpL = Number(entryL.rp) || 1200;
  const rpW = Number(entryW.rp) || 1200;
  const expectedW = 1.0 / (1.0 + Math.pow(10.0, (rpL - rpW) / 400.0));
  let deltaW = Math.round(34.0 * (1.0 - expectedW));
  if (deltaW < 12) deltaW = 12;

  const newRpW = Math.max(800, rpW + deltaW);
  const newRpL = Math.max(800, rpL - deltaW);

  await client.query(
    `UPDATE wallgo_entries SET rp = $1, last_delta = $2, wins = wins + 1 WHERE id = $3`,
    [newRpW, deltaW, entryW.id]
  );
  await client.query(
    `UPDATE wallgo_entries SET rp = $1, last_delta = $2, losses = losses + 1 WHERE id = $3`,
    [newRpL, -deltaW, entryL.id]
  );

  await simulateIdleAiPros(client, "");

  const keyW = normKey(winnerName);
  await client.query(
    `INSERT INTO wallgo_forfeit_notices (norm_key, match_id, left_name, rp_delta, new_rp, at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (norm_key) DO UPDATE SET
       match_id = EXCLUDED.match_id,
       left_name = EXCLUDED.left_name,
       rp_delta = EXCLUDED.rp_delta,
       new_rp = EXCLUDED.new_rp,
       at = EXCLUDED.at`,
    [keyW, matchId, leaverName, deltaW, newRpW, now]
  );

  await recordProcessedMatch(client, matchId, now);
  await bumpMeta(client, now);
  return true;
}

async function checkAbandonedActiveMatches(client: PgClientLike, now: number): Promise<boolean> {
  const { rows } = await client.query<{
    code: string;
    player_a: string;
    player_b: string;
    key_a: string;
    key_b: string;
    started_at: string;
  }>(`SELECT code, player_a, player_b, key_a, key_b, started_at FROM wallgo_active_matches`);

  if (rows.length === 0) return false;

  const presenceRes = await client.query<{ norm_key: string; status: string }>(
    `SELECT norm_key, status FROM wallgo_presence`
  );
  const statusByKey = new Map<string, string>();
  for (const r of presenceRes.rows) {
    statusByKey.set(r.norm_key, r.status);
  }

  let changed = false;
  for (const m of rows) {
    const started = Number(m.started_at) || 0;
    if (now - started > ACTIVE_MATCH_MAX_MS) {
      await client.query(`DELETE FROM wallgo_active_matches WHERE code = $1`, [m.code]);
      changed = true;
      continue;
    }
    // 6-second grace window while both matched players connect P2P
    if (now - started < ACTIVE_MATCH_GRACE_MS) {
      continue;
    }

    const stA = statusByKey.get(m.key_a) ?? "offline";
    const stB = statusByKey.get(m.key_b) ?? "offline";

    if (stA !== "playing" && stB === "playing") {
      await settleHumanForfeit(client, m.player_a, m.player_b, m.code, now);
      await client.query(`DELETE FROM wallgo_active_matches WHERE code = $1`, [m.code]);
      changed = true;
    } else if (stB !== "playing" && stA === "playing") {
      await settleHumanForfeit(client, m.player_b, m.player_a, m.code, now);
      await client.query(`DELETE FROM wallgo_active_matches WHERE code = $1`, [m.code]);
      changed = true;
    } else if (stA !== "playing" && stB !== "playing") {
      await client.query(`DELETE FROM wallgo_active_matches WHERE code = $1`, [m.code]);
      changed = true;
    }
  }
  return changed;
}

async function clearActiveMatchForPair(
  client: PgClientLike,
  nameA: string,
  nameB: string
): Promise<void> {
  const kA = normKey(nameA);
  const kB = normKey(nameB);
  await client.query(
    `DELETE FROM wallgo_active_matches
     WHERE (key_a = $1 AND key_b = $2) OR (key_a = $2 AND key_b = $1)`,
    [kA, kB]
  );
}

async function prunePresenceAndMatches(client: PgClientLike, now: number): Promise<void> {
  await client.query(`DELETE FROM wallgo_presence WHERE last_seen < $1`, [now - PRESENCE_TTL_MS]);
  await client.query(`DELETE FROM wallgo_pending_matches WHERE created_at < $1`, [now - MATCH_TTL_MS]);
  await client.query(`DELETE FROM wallgo_forfeit_notices WHERE at < $1`, [now - MATCH_TTL_MS]);
  await checkAbandonedActiveMatches(client, now);
}

async function tryMatchQueue(
  client: PgClientLike,
  now: number,
  triggerKey = ""
): Promise<boolean> {
  const { rows: waiters } = await client.query<{
    norm_key: string;
    name: string;
    queued_at: string;
  }>(
    `SELECT norm_key, name, queued_at
     FROM wallgo_presence
     WHERE status = 'queuing' AND name <> ''
     ORDER BY queued_at ASC, norm_key ASC
     LIMIT 2`
  );

  if (waiters.length < 2) return false;
  const a = waiters[0];
  const b = waiters[1];
  if (a.norm_key === b.norm_key) return false;

  // Assign the player whose heartbeat triggered this match as HOST so they open the
  // PeerJS room IMMEDIATELY (T=0s) before the waiting player's next poll receives GUEST!
  const host = triggerKey !== "" && b.norm_key === triggerKey ? b : a;
  const guest = host === b ? a : b;

  const code = genMatchCode();

  await client.query(
    `UPDATE wallgo_presence SET status = 'playing', queued_at = 0 WHERE norm_key IN ($1, $2)`,
    [host.norm_key, guest.norm_key]
  );

  const entryHost = await ensureHumanEntry(client, host.name, 1200);
  const entryGuest = await ensureHumanEntry(client, guest.name, 1200);
  const rpHost = Number(entryHost.rp) || 1200;
  const rpGuest = Number(entryGuest.rp) || 1200;

  await client.query(
    `INSERT INTO wallgo_pending_matches
       (norm_key, role, match_code, opponent_name, opponent_rp, created_at)
     VALUES ($1, 'host', $2, $3, $4, $5)
     ON CONFLICT (norm_key) DO UPDATE SET
       role = EXCLUDED.role,
       match_code = EXCLUDED.match_code,
       opponent_name = EXCLUDED.opponent_name,
       opponent_rp = EXCLUDED.opponent_rp,
       created_at = EXCLUDED.created_at`,
    [host.norm_key, code, guest.name, rpGuest, now]
  );

  await client.query(
    `INSERT INTO wallgo_pending_matches
       (norm_key, role, match_code, opponent_name, opponent_rp, created_at)
     VALUES ($1, 'guest', $2, $3, $4, $5)
     ON CONFLICT (norm_key) DO UPDATE SET
       role = EXCLUDED.role,
       match_code = EXCLUDED.match_code,
       opponent_name = EXCLUDED.opponent_name,
       opponent_rp = EXCLUDED.opponent_rp,
       created_at = EXCLUDED.created_at`,
    [guest.norm_key, code, host.name, rpHost, now]
  );

  await client.query(
    `INSERT INTO wallgo_active_matches (code, player_a, player_b, key_a, key_b, started_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE SET
       player_a = EXCLUDED.player_a,
       player_b = EXCLUDED.player_b,
       key_a = EXCLUDED.key_a,
       key_b = EXCLUDED.key_b,
       started_at = EXCLUDED.started_at`,
    [code, host.name, guest.name, host.norm_key, guest.norm_key, now]
  );

  return true;
}

async function saveReplayForAccount(
  client: PgClientLike,
  name: string,
  record: Record<string, any>
): Promise<void> {
  if (!record || typeof record !== "object" || !record.id) return;
  const key = normKey(name);
  const { rows } = await client.query<{ recent_matches: unknown }>(
    `SELECT recent_matches FROM wallgo_accounts WHERE norm_key = $1 LIMIT 1`,
    [key]
  );
  if (rows.length === 0) return;

  const existing = Array.isArray(rows[0].recent_matches) ? rows[0].recent_matches : [];
  const filtered = existing.filter((m: any) => !m || m.id !== record.id);
  filtered.unshift(record);
  const sliced = filtered.slice(0, MAX_HISTORY);

  await client.query(
    `UPDATE wallgo_accounts SET recent_matches = $1::jsonb WHERE norm_key = $2`,
    [JSON.stringify(sliced), key]
  );
}

async function buildPublicState(client: PgClientLike, forName = ""): Promise<Record<string, any>> {
  const [metaRes, accRes, entryRes, presRes, evRes] = await Promise.all([
    client.query<{ version: number; updated_at: string }>(
      `SELECT version, updated_at FROM wallgo_meta WHERE id = 1`
    ),
    client.query<{ name: string }>(`SELECT name FROM wallgo_accounts ORDER BY created_at ASC`),
    client.query<EntryRow>(`SELECT * FROM wallgo_entries ORDER BY sort_order ASC, id ASC`),
    client.query<{ name: string; status: string }>(
      `SELECT name, status FROM wallgo_presence WHERE status <> 'offline'`
    ),
    client.query<{ max_id: number | null }>(`SELECT MAX(id) AS max_id FROM wallgo_events`),
  ]);

  const version = metaRes.rows[0] ? Number(metaRes.rows[0].version) : 1;
  const updatedAt = metaRes.rows[0] ? Number(metaRes.rows[0].updated_at) : Date.now();
  const registeredIds = accRes.rows.map((r) => r.name).filter(Boolean);

  const entries = entryRes.rows.map((e) => {
    if (e.is_ai) {
      return {
        id: e.id,
        name: e.name,
        isAI: true,
        rp: Number(e.rp),
        wins: Number(e.wins),
        losses: Number(e.losses),
        draws: Number(e.draws),
        aiLevel: e.ai_level || "medium",
        skill: typeof e.skill === "number" ? e.skill : 0.55,
        lastDelta: Number(e.last_delta) || 0,
      };
    }
    return {
      id: e.id,
      name: e.name,
      isAI: false,
      rp: Number(e.rp),
      wins: Number(e.wins),
      losses: Number(e.losses),
      draws: Number(e.draws),
      lastDelta: Number(e.last_delta) || 0,
    };
  });

  const presenceMap: Record<string, string> = {};
  let onlineCount = 0;
  for (const p of presRes.rows) {
    if (p.name && p.status && p.status !== "offline") {
      presenceMap[p.name] = p.status;
      onlineCount++;
    }
  }

  const latestEventId = evRes.rows[0]?.max_id ? Number(evRes.rows[0].max_id) : 0;

  const out: Record<string, any> = {
    shared: {
      version,
      updatedAt,
      registeredIds,
      entries,
    },
    presenceMap,
    onlineCount: Math.max(1, onlineCount),
    latestEventId,
  };

  if (forName) {
    const k = normKey(forName);
    const { rows } = await client.query<{ recent_matches: unknown }>(
      `SELECT recent_matches FROM wallgo_accounts WHERE norm_key = $1 LIMIT 1`,
      [k]
    );
    if (rows.length > 0 && Array.isArray(rows[0].recent_matches)) {
      out.myHistory = rows[0].recent_matches.slice(0, MAX_HISTORY);
    }
  }

  return out;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "state";
  const body = await readJsonBody(req);

  try {
    // ==================== ACTION: STATE ====================
    if (action === "state") {
      const name = cleanName(url.searchParams.get("name") || "");
      const payload = await withTx(async (client) => {
        const now = Date.now();
        await ensureSeeded(client, now);
        await prunePresenceAndMatches(client, now);
        return { ok: true, ...(await buildPublicState(client, name)) };
      });
      return jsonRes(payload);
    }

    // ==================== ACTION: AUTH ====================
    if (action === "auth") {
      const name = cleanName(body.name);
      const pin = String(body.pin ?? "").trim();

      if (!name) {
        return jsonRes({ ok: false, reason: "請輸入玩家 ID（請勿只輸入特殊符號）" });
      }
      if (!/^\d{4}$/.test(pin)) {
        return jsonRes({ ok: false, reason: "請輸入 4 位數字密碼（例如 1234）" });
      }

      const key = normKey(name);
      if (isAiName(key)) {
        return jsonRes({ ok: false, reason: "此 ID 與天梯固定 AI 選手重複，請換一個稱號！" });
      }

      const calcHash = hashPin(key, pin);

      const payload = await withTx(async (client) => {
        const now = Date.now();
        await ensureSeeded(client, now);
        await prunePresenceAndMatches(client, now);

        const existing = await client.query<{ name: string; pin_hash: string }>(
          `SELECT name, pin_hash FROM wallgo_accounts WHERE norm_key = $1 LIMIT 1`,
          [key]
        );

        if (existing.rows.length > 0) {
          const acc = existing.rows[0];
          const storedHash = acc.pin_hash || "";
          const accName = acc.name || name;

          if (storedHash !== "" && !safeHashEquals(storedHash, calcHash)) {
            return {
              ok: false,
              code: "wrong_pin",
              reason: `ID「${accName}」已被註冊！若這是你的帳號請輸入正確的 4 位數密碼，否則請換一個新 ID。`,
            };
          }

          await client.query(
            `UPDATE wallgo_accounts
             SET last_login_at = $1, pin_hash = CASE WHEN pin_hash = '' THEN $2 ELSE pin_hash END
             WHERE norm_key = $3`,
            [now, calcHash, key]
          );
          await ensureHumanEntry(client, accName, 1200);
          return {
            ok: true,
            mode: "login",
            name: accName,
            ...(await buildPublicState(client, accName)),
          };
        }

        // Brand-new account registration
        await client.query(
          `INSERT INTO wallgo_accounts (norm_key, name, pin_hash, created_at, last_login_at, recent_matches)
           VALUES ($1, $2, $3, $4, $4, '[]'::jsonb)`,
          [key, name, calcHash, now]
        );
        await ensureHumanEntry(client, name, 1200);
        await bumpMeta(client, now);

        return {
          ok: true,
          mode: "register",
          name,
          ...(await buildPublicState(client, name)),
        };
      });

      return jsonRes(payload);
    }

    // ==================== ACTION: HEARTBEAT ====================
    if (action === "heartbeat") {
      const clientId = String(body.clientId ?? "").trim();
      const name = cleanName(body.name);
      const rawStatus = String(body.status ?? "offline");
      const status = ["online", "queuing", "playing", "offline"].includes(rawStatus)
        ? rawStatus
        : "online";
      const justLoggedIn = Boolean(body.justLoggedIn);
      const sinceEventId = Number.isFinite(Number(body.sinceEventId))
        ? Math.trunc(Number(body.sinceEventId))
        : 0;

      const payload = await withTx(async (client) => {
        const now = Date.now();
        await ensureSeeded(client, now);
        await prunePresenceAndMatches(client, now);

        let matched: Record<string, any> | null = null;
        let forfeitNotice: Record<string, any> | null = null;

        if (name) {
          const key = normKey(name);
          const prevRes = await client.query<{ status: string; queued_at: string }>(
            `SELECT status, queued_at FROM wallgo_presence WHERE norm_key = $1 LIMIT 1`,
            [key]
          );
          const prev = prevRes.rows[0] || null;
          const prevStatus = prev ? prev.status : "offline";
          const wasOffline = !prev || prevStatus === "offline";

          if (status === "offline") {
            await client.query(`DELETE FROM wallgo_presence WHERE norm_key = $1`, [key]);
          } else {
            let queuedAt = 0;
            if (status === "queuing") {
              queuedAt =
                prev && prevStatus === "queuing" && Number(prev.queued_at) > 0
                  ? Number(prev.queued_at)
                  : now;
            }
            await client.query(
              `INSERT INTO wallgo_presence (norm_key, client_id, name, status, last_seen, queued_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (norm_key) DO UPDATE SET
                 client_id = EXCLUDED.client_id,
                 name = EXCLUDED.name,
                 status = EXCLUDED.status,
                 last_seen = EXCLUDED.last_seen,
                 queued_at = EXCLUDED.queued_at`,
              [key, clientId, name, status, now, queuedAt]
            );
            await ensureHumanEntry(client, name, 1200);

            if (justLoggedIn || wasOffline) {
              await appendEvent(client, "user_joined", name, now);
            }

            if (status === "queuing") {
              await tryMatchQueue(client, now, key);
            }

            const pmRes = await client.query<{
              role: string;
              match_code: string;
              opponent_name: string;
              opponent_rp: number;
              created_at: string;
            }>(
              `DELETE FROM wallgo_pending_matches
               WHERE norm_key = $1
               RETURNING role, match_code, opponent_name, opponent_rp, created_at`,
              [key]
            );
            if (pmRes.rows.length > 0) {
              const pm = pmRes.rows[0];
              matched = {
                role: pm.role,
                matchCode: pm.match_code,
                opponentName: pm.opponent_name,
                opponentRp: Number(pm.opponent_rp),
                createdAt: Number(pm.created_at),
              };
            }
          }

          await checkAbandonedActiveMatches(client, now);

          const fnRes = await client.query<{
            match_id: string;
            left_name: string;
            rp_delta: number;
            new_rp: number;
            at: string;
          }>(
            `DELETE FROM wallgo_forfeit_notices
             WHERE norm_key = $1
             RETURNING match_id, left_name, rp_delta, new_rp, at`,
            [key]
          );
          if (fnRes.rows.length > 0) {
            const fn = fnRes.rows[0];
            forfeitNotice = {
              matchId: fn.match_id,
              leftName: fn.left_name,
              rpDelta: Number(fn.rp_delta),
              newRp: Number(fn.new_rp),
              at: Number(fn.at),
            };
          }
        }

        let newEvents: Array<{ id: number; type: string; name: string; at: number }> = [];
        if (sinceEventId > 0) {
          const evRows = await client.query<{ id: number; type: string; name: string; at: string }>(
            `SELECT id, type, name, at FROM wallgo_events WHERE id > $1 ORDER BY id ASC`,
            [sinceEventId]
          );
          newEvents = evRows.rows.map((ev) => ({
            id: Number(ev.id),
            type: ev.type,
            name: ev.name,
            at: Number(ev.at),
          }));
        }

        const pub = await buildPublicState(client, name);
        return {
          ...pub,
          ok: true,
          events: newEvents,
          matched,
          forfeitNotice,
        };
      });

      return jsonRes(payload);
    }

    // ==================== ACTION: REPORT RANKED MATCH ====================
    if (action === "report_match") {
      const matchId = String(body.matchId ?? "").trim();
      const playerAName = cleanName(body.playerAName);
      const playerBName = cleanName(body.playerBName);
      const bIsAI = Boolean(body.bIsAI);
      const rivalId = String(body.rivalId ?? "");
      const rawOutcome = String(body.outcomeForA ?? "draw");
      const outcomeForA = ["win", "loss", "draw"].includes(rawOutcome) ? rawOutcome : "draw";
      const isForfeit = Boolean(body.isForfeit);
      const replayRecord =
        body.replayRecord && typeof body.replayRecord === "object" && !Array.isArray(body.replayRecord)
          ? { ...body.replayRecord }
          : null;

      if (!playerAName || !playerBName) {
        return jsonRes({ ok: false, reason: "對局雙方名稱不可為空" });
      }

      const payload = await withTx(async (client) => {
        const now = Date.now();
        await ensureSeeded(client, now);
        await prunePresenceAndMatches(client, now);

        if (matchId && (await isMatchProcessed(client, matchId))) {
          return {
            ok: true,
            duplicate: true,
            rpDeltaA: 0,
            rpDeltaB: 0,
            ...(await buildPublicState(client, playerAName)),
          };
        }

        const entryA = await ensureHumanEntry(client, playerAName, 1200);
        let entryB: EntryRow | null = null;

        if (bIsAI) {
          if (rivalId) {
            const byId = await client.query<EntryRow>(
              `SELECT * FROM wallgo_entries WHERE id = $1 LIMIT 1`,
              [rivalId]
            );
            if (byId.rows.length > 0) entryB = byId.rows[0];
          }
          if (!entryB) {
            const byName = await client.query<EntryRow>(
              `SELECT * FROM wallgo_entries WHERE is_ai = TRUE AND norm_key = $1 LIMIT 1`,
              [normKey(playerBName)]
            );
            if (byName.rows.length > 0) entryB = byName.rows[0];
          }
        } else {
          entryB = await ensureHumanEntry(client, playerBName, 1200);
        }

        if (!entryB) {
          return {
            ok: false,
            reason: "找不到對手紀錄",
            ...(await buildPublicState(client, playerAName)),
          };
        }

        await client.query(
          `UPDATE wallgo_entries SET last_delta = 0 WHERE is_ai = FALSE AND id <> $1 AND id <> $2`,
          [entryA.id, entryB.id]
        );

        const rpA = Number(entryA.rp) || 1200;
        const rpB = Number(entryB.rp) || 1200;
        const expectedA = 1.0 / (1.0 + Math.pow(10.0, (rpB - rpA) / 400.0));
        const actualA = outcomeForA === "win" ? 1.0 : outcomeForA === "draw" ? 0.5 : 0.0;
        let deltaA = Math.round(34.0 * (actualA - expectedA));
        if (outcomeForA === "win" && deltaA < 12) deltaA = 12;
        if (outcomeForA === "loss" && deltaA > -10) deltaA = -10;

        const newRpA = Math.max(800, rpA + deltaA);
        const newRpB = Math.max(800, rpB - deltaA);

        const winA = outcomeForA === "win" ? 1 : 0;
        const lossA = outcomeForA === "loss" ? 1 : 0;
        const drawA = outcomeForA === "draw" ? 1 : 0;

        await client.query(
          `UPDATE wallgo_entries
           SET rp = $1, last_delta = $2, wins = wins + $3, losses = losses + $4, draws = draws + $5
           WHERE id = $6`,
          [newRpA, deltaA, winA, lossA, drawA, entryA.id]
        );
        await client.query(
          `UPDATE wallgo_entries
           SET rp = $1, last_delta = $2, wins = wins + $3, losses = losses + $4, draws = draws + $5
           WHERE id = $6`,
          [newRpB, -deltaA, lossA, winA, drawA, entryB.id]
        );

        await simulateIdleAiPros(client, bIsAI ? entryB.id : "");

        if (replayRecord) {
          replayRecord.rpDelta = deltaA;
          await saveReplayForAccount(client, playerAName, replayRecord);
        }

        if (!bIsAI) {
          await clearActiveMatchForPair(client, playerAName, playerBName);
        }

        if (!bIsAI && isForfeit && outcomeForA === "loss") {
          const keyB = normKey(playerBName);
          await client.query(
            `INSERT INTO wallgo_forfeit_notices (norm_key, match_id, left_name, rp_delta, new_rp, at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (norm_key) DO UPDATE SET
               match_id = EXCLUDED.match_id,
               left_name = EXCLUDED.left_name,
               rp_delta = EXCLUDED.rp_delta,
               new_rp = EXCLUDED.new_rp,
               at = EXCLUDED.at`,
            [keyB, matchId, playerAName, -deltaA, newRpB, now]
          );
        }

        await recordProcessedMatch(client, matchId, now);
        await bumpMeta(client, now);

        return {
          ok: true,
          rpDeltaA: deltaA,
          rpDeltaB: -deltaA,
          newRpA,
          newRpB,
          ...(await buildPublicState(client, playerAName)),
        };
      });

      return jsonRes(payload);
    }

    // ==================== ACTION: SAVE REPLAY ====================
    if (action === "save_replay") {
      const name = cleanName(body.name);
      const record =
        body.record && typeof body.record === "object" && !Array.isArray(body.record)
          ? body.record
          : null;

      if (!name || !record) {
        return jsonRes({ ok: false, reason: "無效的演練紀錄" });
      }

      const payload = await withTx(async (client) => {
        const now = Date.now();
        await ensureSeeded(client, now);
        await saveReplayForAccount(client, name, record);
        return { ok: true, ...(await buildPublicState(client, name)) };
      });

      return jsonRes(payload);
    }

    return jsonRes({ ok: false, reason: "未知的 API 指令" });
  } catch (err) {
    console.error("[wallgo api error]", err);
    return jsonRes(
      {
        ok: false,
        reason: "雲端資料庫連線異常，請稍後重試",
      },
      500
    );
  }
};

export const config: Config = {
  path: "/api/wallgo",
};
