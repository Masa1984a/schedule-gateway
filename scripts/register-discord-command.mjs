#!/usr/bin/env node

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const commandName = process.env.DISCORD_COMMAND_NAME || "schedule";

if (!applicationId) fail("DISCORD_APPLICATION_ID is not set");
if (!botToken) fail("DISCORD_BOT_TOKEN is not set");

const command = {
  name: commandName,
  description: "Claude Managed Agent にスケジュール相談を送ります",
  dm_permission: false,
  options: [
    {
      type: 3,
      name: "message",
      description: "Agent に送るメッセージ",
      required: true,
    },
  ],
};

const route = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;

const res = await fetch(`https://discord.com/api/v10${route}`, {
  method: "POST",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(command),
});

const body = await res.text();
if (!res.ok) {
  console.error(body);
  fail(`Discord command registration failed: HTTP ${res.status}`);
}

console.log(`Registered /${commandName} ${guildId ? `for guild ${guildId}` : "globally"}`);
console.log(body);

function fail(message) {
  console.error(message);
  process.exit(1);
}
