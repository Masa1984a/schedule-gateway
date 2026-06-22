import { createPublicKey, verify } from "node:crypto";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export const DiscordInteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export const DiscordInteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
} as const;

export const DiscordMessageFlags = {
  Ephemeral: 1 << 6,
} as const;

export const DiscordChannelType = {
  GuildText: 0,
  Dm: 1,
  GuildVoice: 2,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: DiscordChannel;
  data?: {
    id?: string;
    name?: string;
    type?: number;
    options?: DiscordCommandOption[];
  };
  member?: {
    user?: DiscordUser;
  };
  user?: DiscordUser;
}

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface DiscordCommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
}

export interface DiscordChannel {
  id: string;
  type: number;
  parent_id?: string | null;
  name?: string;
}

export function verifyDiscordSignature(rawBody: string, req: Request): boolean {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex) throw new Error("DISCORD_PUBLIC_KEY is not set");

  const signatureHex = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";
  if (!signatureHex || !timestamp) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  const key = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: hexToBase64Url(publicKeyHex),
    },
    format: "jwk",
  });

  return verify(null, Buffer.from(timestamp + rawBody), key, signature);
}

export function discordThreadSessionKey(interaction: DiscordInteraction): string {
  const channelId = interaction.channel_id;
  if (!channelId) throw new Error("Discord channel_id is missing");
  return buildDiscordThreadKey(interaction.guild_id, channelId);
}

/**
 * Discord の guild_id / channel_id（フォーラム投稿スレッドID）から
 * gateway_sessions 用の user_key を組み立てる。
 *
 * - 同じスレッド → 同じ user_key → 同じ Managed Agent セッションを再利用（会話継続）
 * - 別スレッド   → 別の user_key → 別セッション（スレッド間で独立）
 *
 * slash command 経路（discordThreadSessionKey）と常駐Bot経路（/api/discord/message）の
 * 両方が同じキー規則を共有するため、同一スレッドなら入口が違ってもセッションが一致する。
 */
export function buildDiscordThreadKey(guildId: string | undefined, channelId: string): string {
  if (!channelId) throw new Error("Discord channel_id is missing");
  const guildPart = guildId ? `guild:${guildId}` : "dm";
  return `discord:${guildPart}:thread:${channelId}`;
}

export function getDiscordCommandMessage(interaction: DiscordInteraction): string {
  const options = interaction.data?.options ?? [];
  const message = findOption(options, "message")?.value;
  return typeof message === "string" ? message.trim() : "";
}

export function getDiscordActorName(interaction: DiscordInteraction): string {
  const user = interaction.member?.user ?? interaction.user;
  return user?.global_name || user?.username || user?.id || "Discord user";
}

export function jsonDiscordResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function discordMessageResponse(content: string, ephemeral = false): Response {
  return jsonDiscordResponse({
    type: DiscordInteractionResponseType.ChannelMessageWithSource,
    data: {
      content,
      flags: ephemeral ? DiscordMessageFlags.Ephemeral : undefined,
      allowed_mentions: { parse: [] },
    },
  });
}

export function discordDeferredResponse(ephemeral = false): Response {
  return jsonDiscordResponse({
    type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
    data: {
      flags: ephemeral ? DiscordMessageFlags.Ephemeral : undefined,
    },
  });
}

export function discordPongResponse(): Response {
  return jsonDiscordResponse({ type: DiscordInteractionResponseType.Pong });
}

/**
 * Discord は GitHub Flavored Markdown の table を表として描画しないため、
 * Agent が返した Markdown table を Discord で読みやすい箇条書きへ変換する。
 *
 * 例:
 *   | 日付 | 時間 | タイトル | 場所 | 種別 |
 *   |---|---|---|---|---|
 *   | 6/22 | 14:30 | 登壇 | オンライン | lecture |
 *
 * 変換後:
 *   🗓️ **6/22 14:30**
 *   　登壇
 *   　場所: オンライン
 *   　種別: lecture
 *
 * code fence 内の表っぽい文字列は変換しない。
 */
export function formatDiscordContent(content: string): string {
  const text = content.trim() || "（応答がありませんでした）";
  return convertMarkdownTablesToDiscordLists(text).trim() || text;
}

export async function ensureAllowedForumThread(interaction: DiscordInteraction): Promise<void> {
  const expectedForumId = process.env.DISCORD_FORUM_CHANNEL_ID?.trim();
  if (!expectedForumId) return;

  const channelId = interaction.channel_id;
  if (!channelId) throw new Error("Discord channel_id is missing");

  let channel = interaction.channel;
  if (!channel || channel.parent_id === undefined) {
    channel = await fetchDiscordChannel(channelId).catch(() => channel);
  }

  const isInConfiguredForum =
    channelId === expectedForumId || channel?.parent_id === expectedForumId;
  const isThread =
    channel?.type === DiscordChannelType.PublicThread ||
    channel?.type === DiscordChannelType.PrivateThread ||
    channel?.type === DiscordChannelType.AnnouncementThread;

  if (!isInConfiguredForum || !isThread) {
    throw new Error("このコマンドは設定されたDiscordフォーラムチャネルのスレッド内で実行してください。");
  }
}

export async function sendDiscordInteractionResult(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const chunks = splitDiscordContent(formatDiscordContent(content));
  const [first, ...rest] = chunks.length ? chunks : ["（応答がありませんでした）"];

  await discordFetch(
    `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      body: JSON.stringify(discordMessageBody(first)),
    },
    false,
  );

  for (const chunk of rest) {
    await discordFetch(
      `/webhooks/${applicationId}/${interactionToken}`,
      {
        method: "POST",
        body: JSON.stringify(discordMessageBody(chunk)),
      },
      false,
    );
  }
}

export async function sendDiscordInteractionError(
  applicationId: string,
  interactionToken: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sendDiscordInteractionResult(applicationId, interactionToken, `エラー: ${message}`);
}

async function fetchDiscordChannel(channelId: string): Promise<DiscordChannel> {
  const res = await discordFetch(`/channels/${channelId}`, { method: "GET" }, true);
  return (await res.json()) as DiscordChannel;
}

async function discordFetch(path: string, init: RequestInit, withBotToken: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");

  if (withBotToken) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) throw new Error("DISCORD_BOT_TOKEN is not set");
    headers.set("authorization", `Bot ${botToken}`);
  }

  const res = await fetch(`${DISCORD_API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API error ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

function discordMessageBody(content: string): Record<string, unknown> {
  return {
    content,
    allowed_mentions: { parse: [] },
  };
}

function convertMarkdownTablesToDiscordLists(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      i += 1;
      continue;
    }

    if (
      !inFence &&
      i + 1 < lines.length &&
      isMarkdownTableRow(lines[i]) &&
      isMarkdownTableSeparator(lines[i + 1])
    ) {
      const headers = parseMarkdownTableRow(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;

      while (j < lines.length && isMarkdownTableRow(lines[j]) && !isMarkdownTableSeparator(lines[j])) {
        const cells = parseMarkdownTableRow(lines[j]);
        if (cells.some((cell) => cell.trim())) rows.push(cells);
        j += 1;
      }

      if (headers.length >= 2 && rows.length > 0) {
        out.push(formatMarkdownTableAsDiscordList(headers, rows));
        i = j;
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|")) return false;
  return parseMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(cleanMarkdownTableCell(current));
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(cleanMarkdownTableCell(current));
  return cells;
}

function cleanMarkdownTableCell(cell: string): string {
  return cell
    .trim()
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ");
}

function formatMarkdownTableAsDiscordList(headers: string[], rows: string[][]): string {
  const indices = detectScheduleColumns(headers);

  if (indices.date >= 0 || indices.time >= 0 || indices.title >= 0) {
    return rows
      .map((row) => formatScheduleRow(headers, row, indices))
      .filter(Boolean)
      .join("\n\n");
  }

  return rows
    .map((row) =>
      headers
        .map((header, index) => {
          const value = row[index]?.trim();
          return value ? `**${header}:** ${value}` : "";
        })
        .filter(Boolean)
        .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

function detectScheduleColumns(headers: string[]) {
  return {
    date: findHeaderIndex(headers, /日付|date/i),
    time: findHeaderIndex(headers, /時間|時刻|time/i),
    title: findHeaderIndex(headers, /タイトル|件名|予定|内容|title|event/i),
    place: findHeaderIndex(headers, /場所|会場|location|place/i),
    type: findHeaderIndex(headers, /種別|種類|カテゴリ|category|type/i),
  };
}

function findHeaderIndex(headers: string[], pattern: RegExp): number {
  return headers.findIndex((header) => pattern.test(header.replace(/\s+/g, "")));
}

function formatScheduleRow(
  headers: string[],
  row: string[],
  indices: { date: number; time: number; title: number; place: number; type: number },
): string {
  const date = cellAt(row, indices.date);
  const time = cellAt(row, indices.time);
  const title = cellAt(row, indices.title);
  const place = cellAt(row, indices.place);
  const type = cellAt(row, indices.type);

  const when = [date, time].filter(Boolean).join(" ");
  const emoji = scheduleEmoji(type || title || place);
  const lines = [`${emoji} **${when || title || "予定"}**`];

  if (title && title !== when) lines.push(`　${title}`);
  if (place) lines.push(`　場所: ${place}`);
  if (type) lines.push(`　種別: ${type}`);

  const used = new Set([indices.date, indices.time, indices.title, indices.place, indices.type].filter((x) => x >= 0));
  for (let i = 0; i < headers.length; i += 1) {
    const value = row[i]?.trim();
    if (!value || used.has(i)) continue;
    lines.push(`　${headers[i]}: ${value}`);
  }

  return lines.join("\n");
}

function cellAt(row: string[], index: number): string {
  return index >= 0 ? row[index]?.trim() ?? "" : "";
}

function scheduleEmoji(value: string): string {
  const normalized = value.toLowerCase();
  if (/social|懇親|交流|会食|食事|飲み/.test(normalized)) return "📍";
  if (/lecture|登壇|授業|講演|研修|セミナー/.test(normalized)) return "🟦";
  if (/internal|面接|会議|mtg|meeting/.test(normalized)) return "💻";
  if (/travel|移動|出張|flight|train/.test(normalized)) return "🚅";
  return "🗓️";
}

function splitDiscordContent(text: string): string[] {
  const max = 1900;
  const chunks: string[] = [];
  let rest = text.trim() || "（応答がありませんでした）";

  while (rest.length > max) {
    let idx = rest.lastIndexOf("\n", max);
    if (idx < max * 0.5) idx = rest.lastIndexOf("。", max);
    if (idx < max * 0.5) idx = max;
    chunks.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function findOption(options: DiscordCommandOption[], name: string): DiscordCommandOption | undefined {
  for (const option of options) {
    if (option.name === name) return option;
    const nested = option.options ? findOption(option.options, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function hexToBase64Url(hex: string): string {
  const normalized = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("DISCORD_PUBLIC_KEY must be a 32-byte hex encoded Ed25519 public key");
  }
  const buf = Buffer.from(normalized, "hex");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
