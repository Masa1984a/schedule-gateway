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
  const chunks = splitDiscordContent(content || "（応答がありませんでした）");
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
