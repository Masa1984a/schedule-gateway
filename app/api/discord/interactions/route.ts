import { after } from "next/server";
import { askAgentText } from "@/lib/gateway-chat";
import {
  DiscordInteraction,
  DiscordInteractionType,
  discordDeferredResponse,
  discordMessageResponse,
  discordPongResponse,
  discordThreadSessionKey,
  ensureAllowedForumThread,
  getDiscordCommandMessage,
  jsonDiscordResponse,
  sendDiscordInteractionError,
  sendDiscordInteractionResult,
  verifyDiscordSignature,
} from "@/lib/discord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Discord Interactions endpoint.
 *
 * Discord Developer Portal の Interactions Endpoint URL に
 *   https://<your-app>/api/discord/interactions
 * を設定する。
 *
 * フォーラム投稿（=スレッド）内で `/schedule message:<本文>` を実行すると、
 * Discord の channel_id（フォーラム投稿スレッドID）を userKey にして Managed Agent セッションを再利用する。
 */
export async function POST(req: Request) {
  const rawBody = await req.text();

  try {
    if (!verifyDiscordSignature(rawBody, req)) {
      return jsonDiscordResponse({ error: "invalid request signature" }, 401);
    }
  } catch (err) {
    return jsonDiscordResponse({ error: errMsg(err) }, 500);
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return jsonDiscordResponse({ error: "invalid JSON body" }, 400);
  }

  if (interaction.type === DiscordInteractionType.Ping) {
    return discordPongResponse();
  }

  if (interaction.type !== DiscordInteractionType.ApplicationCommand) {
    return discordMessageResponse("未対応のDiscord Interactionです。", true);
  }

  const commandName = process.env.DISCORD_COMMAND_NAME || "schedule";
  if (interaction.data?.name !== commandName) {
    return discordMessageResponse(`未対応のコマンドです。/${commandName} を使ってください。`, true);
  }

  const message = getDiscordCommandMessage(interaction);
  if (!message) {
    return discordMessageResponse("message を指定してください。", true);
  }

  try {
    await ensureAllowedForumThread(interaction);
  } catch (err) {
    return discordMessageResponse(errMsg(err), true);
  }

  // Discord は3秒以内の応答が必要なため、まず deferred response を返し、
  // Agent 呼び出しの完了後に Interaction の original response を編集する。
  after(async () => {
    try {
      const userKey = discordThreadSessionKey(interaction);
      const result = await askAgentText(userKey, message);
      await sendDiscordInteractionResult(
        interaction.application_id,
        interaction.token,
        result.text || "（応答がありませんでした）",
      );
    } catch (err) {
      await sendDiscordInteractionError(interaction.application_id, interaction.token, err);
    }
  });

  return discordDeferredResponse(false);
}

export async function GET() {
  return jsonDiscordResponse({ ok: true, endpoint: "discord-interactions" });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
