require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.send('Bot is running');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

const DATA_FILE = path.join(__dirname, 'articleData.json');

// ===== DATA =====
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { loggedMessages: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.loggedMessages) data.loggedMessages = {};
    return data;
  } catch {
    return { loggedMessages: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const db = loadData();

// ===== CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
});

// ===== COMMAND =====
const commands = [
  new SlashCommandBuilder()
    .setName('artikelen')
    .setDescription('Toon aantal artikelen deze maand')
].map(cmd => cmd.toJSON());

// ===== HELPERS =====
function getArticleTitle(message) {
  const lines = (message.content || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const filtered = lines.filter(l => l !== 'Leeuwarder Courant ©');

  return filtered[0] || 'Geen titel';
}

function extractChecked(content) {
  const line = content.split('\n').find(l => l.startsWith('Nagekeken door:'));
  if (!line) return [];
  return [...line.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
}

function updateCheckedLine(content, users) {
  const line = users.length
    ? `Nagekeken door: ${users.map(id => `<@${id}>`).join(', ')}`
    : 'Nagekeken door: -';

  if (content.includes('Nagekeken door:')) {
    return content.replace(/Nagekeken door:.*/g, line);
  }

  return content + '\n' + line;
}

// ===== LOG =====
async function makeLog(message) {
  const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID);

  if (db.loggedMessages[message.id]) return;

  const title = getArticleTitle(message);

  const content =
    `Artikel gepubliceerd\n` +
    `Mention: <@${message.author.id}>\n` +
    `Titel: ${title}\n` +
    `Link naar artikel: ${message.url}\n` +
    `Nagekeken door: -`;

  await logChannel.send(content);

  db.loggedMessages[message.id] = true;
  saveData(db);
}

// ===== EVENTS =====

// Nieuw artikel (bericht of forum post)
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channel.id !== NEWS_CHANNEL_ID) return;

  await makeLog(message);
});

// Reactie toevoegen
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '✅') return;

  const msg = reaction.message;
  if (msg.channel.id !== LOG_CHANNEL_ID) return;

  let checked = extractChecked(msg.content);

  if (!checked.includes(user.id)) {
    if (checked.length >= 2) return;
    checked.push(user.id);
  }

  await msg.edit(updateCheckedLine(msg.content, checked));
});

// Reactie verwijderen
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '✅') return;

  const msg = reaction.message;
  if (msg.channel.id !== LOG_CHANNEL_ID) return;

  let checked = extractChecked(msg.content);
  checked = checked.filter(id => id !== user.id);

  await msg.edit(updateCheckedLine(msg.content, checked));
});

// Command
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'artikelen') {
    const channel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 100 });

    const counts = {};

    messages.forEach(msg => {
      const match = msg.content.match(/<@!?(\d+)>/);
      if (!match) return;

      const id = match[1];
      counts[id] = (counts[id] || 0) + 1;
    });

    let reply = '📰 **Artikelen:**\n\n';
    for (const id in counts) {
      reply += `<@${id}> — ${counts[id]}\n`;
    }

    interaction.reply(reply);
  }
});

// Ready
client.once(Events.ClientReady, async clientReady => {
  console.log(`Bot online als ${clientReady.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
});

client.login(TOKEN);