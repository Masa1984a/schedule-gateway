#!/usr/bin/env node
// @ts-nocheck
/**
 * 常駐 Discord Gateway Bot。
 *
 * 目的: Discord フォーラムチャネルのスレッドに「普通に投稿」されたメッセージを読み取り、
 *       schedule-gateway の /api/discord/message 経由で Claude Managed Agent に中継し、
 *       同じスレッドへ返信する。これにより slash command なしで自然な会話ができる。
 *
 * セッション分離:
 *   - スレッド（フォーラム投稿）の channel_id を user_key 化するのは gateway 側。
 *   - 同じスレッド → 会話継続 / 別スレッド → 独立、は gateway_sessions が担保する。
 *
 * 依存: Node 22+ の組み込み WebSocket / fetch のみ（外部パッケージ不要）。
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN          Bot トークン
 *   GATEWAY_BASE_URL           例: https://<your-app>.vercel.app （末尾スラッシュ不要）
 *   GATEWAY_TOKEN              /api/discord/message 認証用（Web と共通の GATEWAY_TOKEN）
 *   DISCORD_FORUM_CHANNEL_ID   （任意）監視するフォーラム親チャネルID。未設定なら全スレッドを対象。
 *   DISCORD_REQUIRE_MENTION    （任意）"1" なら Bot メンション時のみ反応（デフォルトは全投稿に反応）
 *
 * 注意: フォーラムスレッド本文を読むには Discord Developer Portal で
 *       「MESSAGE CONTENT INTENT」を ON にする必要がある。
 */

const API = "https://discord.com/api/v10";
const GATEWAY_QUERY = "?v=10&encoding=json";

const BOT_TOKEN = required("DISCORD_BOT_TOKEN");
const GATEWAY_BASE_URL = required("GATEWAY_BASE_URL").replace(/\/+$/, "");
const GATEWAY_TOKEN = required("GATEWAY_TOKEN");
const FORUM_CHANNEL_ID = (process.env.DISCORD_FORUM_CHANNEL_ID || "").trim();
const REQUIRE_MENTION = process.env.DISCORD_REQUIRE_MENTION === "1";

// Gateway Intents: GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | MESSAGE_CONTENT(1<<15)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

// op codes
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

const THREAD_TYPES = new Set([10, 11, 12]); // announcement / public / private thread

let ws = null;
let heartbeatTimer = null;
let seq = null;
let sessionId = null;
let resumeGatewayUrl = null;
let botUserId = null;
let acked = true;

// channel_id -> parent_id（フォーラム判定キャッシュ）
const channelParentCache = new Map();
// 同一スレッド内の投稿は順序どおりに処理し、別スレッドは並列に処理する。
// channel_id -> Promise chain
const channelQueues = new Map();

connect(`wss://gateway.discord.gg/${GATEWAY_QUERY}`);

function connect(url) {
  log(`connecting: ${url}`);
  ws = new WebSocket(url);

  ws.addEventListener("open", () => log("ws open"));
  ws.addEventListener("message", (e) => onMessage(e.data));
  ws.addEventListener("close", (e) => onClose(e.code, e.reason));
  ws.addEventListener("error", (e) => log(`ws error: ${e?.message ?? e}`));
}

function onClose(code, reason) {
  log(`ws closed: ${code} ${reason || ""}`);
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  // 1000/1001 や復帰不能コード以外は resume を試みる
  const canResume = sessionId && resumeGatewayUrl && code !== 1000 && code !== 4004 && code !== 4010 && code !== 4011 && code !== 4013 && code !== 4014;
  setTimeout(() => {
    if (canResume) connect(`${resumeGatewayUrl}${GATEWAY_QUERY}`);
    else { sessionId = null; seq = null; connect(`wss://gateway.discord.gg/${GATEWAY_QUERY}`); }
  }, 1500 + Math.random() * 2000);
}

function onMessage(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  const { op, d, s, t } = payload;
  if (s !== null && s !== undefined) seq = s;

  switch (op) {
    case OP.HELLO:
      startHeartbeat(d.heartbeat_interval);
      if (sessionId && seq !== null) resume();
      else identify();
      break;
    case OP.HEARTBEAT:
      sendHeartbeat();
      break;
    case OP.HEARTBEAT_ACK:
      acked = true;
      break;
    case OP.INVALID_SESSION:
      log("invalid session, re-identifying");
      sessionId = null; seq = null;
      setTimeout(() => identify(), 1000 + Math.random() * 2000);
      break;
    case OP.RECONNECT:
      log("server requested reconnect");
      try { ws.close(4000); } catch {}
      break;
    case OP.DISPATCH:
      onDispatch(t, d);
      break;
  }
}

function onDispatch(type, d) {
  if (type === "READY") {
    sessionId = d.session_id;
    resumeGatewayUrl = d.resume_gateway_url;
    botUserId = d.user?.id ?? null;
    log(`READY as ${d.user?.username} (${botUserId})`);
    return;
  }
  if (type === "RESUMED") { log("RESUMED"); return; }
  if (type === "MESSAGE_CREATE") { handleMessageCreate(d).catch((e) => log(`handle error: ${e?.message ?? e}`)); }
}

async function handleMessageCreate(msg) {
  // 自分自身/他Bot/システムは無視
  if (!msg || msg.author?.bot) return;
  if (botUserId && msg.author?.id === botUserId) return;
  // 通常のテキスト投稿のみ（type 0=default, 19=reply, 21=thread starter）
  if (msg.type !== undefined && ![0, 19, 21].includes(msg.type)) return;

  const channelId = msg.channel_id;
  if (!channelId) return;

  // フォーラム配下スレッドか判定（DISCORD_FORUM_CHANNEL_ID 設定時のみ厳格化）
  const parentId = await getParentId(channelId);
  if (!parentId || !THREAD_TYPES.has(parentId.channelType)) return; // スレッドでなければ無視
  if (FORUM_CHANNEL_ID && parentId.parentId !== FORUM_CHANNEL_ID) return;

  let content = (msg.content || "").trim();
  if (REQUIRE_MENTION) {
    const mentioned = (msg.mentions || []).some((u) => u.id === botUserId);
    if (!mentioned) return;
    content = stripMention(content, botUserId);
  }
  if (!content) return;

  enqueueForChannel(channelId, () => processUserMessage(msg, content));
}

function enqueueForChannel(channelId, task) {
  const previous = channelQueues.get(channelId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
    });
  channelQueues.set(channelId, next);
}

async function processUserMessage(msg, content) {
  const channelId = msg.channel_id;
  await safeTyping(channelId);

  try {
    const res = await fetch(`${GATEWAY_BASE_URL}/api/discord/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ guild_id: msg.guild_id, channel_id: channelId, message: content }),
    });
    const text = await res.text();
    let answer;
    try { answer = JSON.parse(text); } catch { answer = { error: text }; }

    if (!res.ok) {
      await reply(channelId, msg.id, `エラー: ${answer.error || res.status}`);
      return;
    }
    await reply(channelId, msg.id, answer.text || "（応答がありませんでした）");
  } catch (err) {
    await reply(channelId, msg.id, `通信エラー: ${err?.message ?? err}`);
  }
}

async function getParentId(channelId) {
  if (channelParentCache.has(channelId)) return channelParentCache.get(channelId);
  try {
    const res = await discordRest(`/channels/${channelId}`, { method: "GET" });
    const ch = await res.json();
    const info = { parentId: ch.parent_id ?? null, channelType: ch.type };
    channelParentCache.set(channelId, info);
    return info;
  } catch {
    return null;
  }
}

async function reply(channelId, messageId, content) {
  const chunks = splitContent(content);
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      content: chunks[i],
      allowed_mentions: { parse: [] },
    };
    if (i === 0) body.message_reference = { message_id: messageId, fail_if_not_exists: false };
    await discordRest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }).catch((e) => log(`reply error: ${e?.message ?? e}`));
  }
}

async function safeTyping(channelId) {
  await discordRest(`/channels/${channelId}/typing`, { method: "POST" }).catch(() => {});
}

async function safeReact(channelId, messageId, emoji) {
  await discordRest(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: "PUT" }).catch(() => {});
}

async function discordRest(path, init) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${BOT_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "1");
    await sleep((retry + 0.2) * 1000);
    return discordRest(path, init);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Discord REST ${res.status}: ${t || res.statusText}`);
  }
  return res;
}

function startHeartbeat(interval) {
  clearInterval(heartbeatTimer);
  acked = true;
  // 初回は jitter
  setTimeout(() => {
    sendHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!acked) { log("missed heartbeat ACK, reconnecting"); try { ws.close(4000); } catch {} return; }
      sendHeartbeat();
    }, interval);
  }, interval * Math.random());
}

function sendHeartbeat() {
  acked = false;
  send({ op: OP.HEARTBEAT, d: seq });
}

function identify() {
  send({
    op: OP.IDENTIFY,
    d: {
      token: BOT_TOKEN,
      intents: INTENTS,
      properties: { os: process.platform, browser: "schedule-gateway", device: "schedule-gateway" },
    },
  });
}

function resume() {
  log("resuming session");
  send({ op: OP.RESUME, d: { token: BOT_TOKEN, session_id: sessionId, seq } });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function stripMention(content, id) {
  return content.replace(new RegExp(`<@!?${id}>`, "g"), "").trim();
}

function splitContent(text) {
  const max = 1900;
  const out = [];
  let rest = (text || "").trim() || "（応答がありませんでした）";
  while (rest.length > max) {
    let idx = rest.lastIndexOf("\n", max);
    if (idx < max * 0.5) idx = rest.lastIndexOf("。", max);
    if (idx < max * 0.5) idx = max;
    out.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(m) { console.log(`[discord-bot] ${new Date().toISOString()} ${m}`); }
function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`${name} is not set`); process.exit(1); }
  return v;
}

process.on("SIGINT", () => { log("shutting down"); try { ws?.close(1000); } catch {} process.exit(0); });
process.on("SIGTERM", () => { log("shutting down"); try { ws?.close(1000); } catch {} process.exit(0); });
