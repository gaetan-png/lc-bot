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

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const AFMELD_CHANNEL_ID = process.env.AFMELD_CHANNEL_ID;
const AFMELDINGEN_LOG_THREAD_ID = process.env.AFMELDINGEN_LOG_THREAD_ID;

const DATA_FILE = path.join(__dirname, 'articleData.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { loggedMessages: {}, loggedAfmeldingen: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.loggedMessages) data.loggedMessages = {};
    if (!data.loggedAfmeldingen) data.loggedAfmeldingen = {};
    return data;
  } catch {
    return { loggedMessages: {}, loggedAfmeldingen: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const db = loadData();

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

const commands = [
  new SlashCommandBuilder()
    .setName('artikelen')
    .setDescription('Toon hoeveel artikelen iedereen deze maand heeft gemaakt'),

  new SlashCommandBuilder()
    .setName('nagekeken')
    .setDescription('Toon hoeveel artikelen iedereen deze maand heeft nagekeken')
].map(cmd => cmd.toJSON());

function extractChecked(content) {
  const line = content.split('\n').find(l => l.toLowerCase().startsWith('nagekeken door:'));
  if (!line) return [];
  return [...line.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
}

function updateCheckedLine(content, users) {
  const newLine = users.length
    ? `Nagekeken door: ${users.map(id => `<@${id}>`).join(', ')}`
    : 'Nagekeken door: -';

  if (/^Nagekeken door:.*$/im.test(content)) {
    return content.replace(/^Nagekeken door:.*$/im, newLine);
  }

  return `${content}\n${newLine}`;
}

function extractAfmeldingInfo(content) {
  const lines = content.split('\n').map(l => l.trim());

  let mention, startdatum, einddatum, reden;

  for (const line of lines) {
    if (line.toLowerCase().startsWith('mention:')) {
      const match = line.match(/<@!?(\d+)>/);
      if (match) mention = match[1];
    }
    if (line.toLowerCase().startsWith('start')) {
      startdatum = line.split(':')[1]?.trim();
    }
    if (line.toLowerCase().startsWith('eind')) {
      einddatum = line.split(':')[1]?.trim();
    }
    if (line.toLowerCase().startsWith('reden')) {
      reden = line.split(':').slice(1).join(':').trim();
    }
  }

  return { mention, startdatum, einddatum, reden };
}

async function makeLog(message) {
  const channel = await message.guild.channels.fetch(LOG_CHANNEL_ID);
  if (!channel) return;
  if (db.loggedMessages[message.id]) return;

  const content =
    `**Artikel gepubliceerd**\n` +
    `Mention: <@${message.author.id}>\n` +
    `Link: ${message.url}\n` +
    `Nagekeken door: -`;

  const sent = await channel.send({ content });

  db.loggedMessages[message.id] = { id: sent.id };
  saveData(db);
}

async function makeAfmeldingLog(message, user) {
  const thread = await message.guild.channels.fetch(AFMELDINGEN_LOG_THREAD_ID).catch(() => null);

  if (!thread || !thread.isThread()) {
    console.error('Thread niet gevonden');
    return;
  }

  if (db.loggedAfmeldingen[message.id]) return;

  const info = extractAfmeldingInfo(message.content);

  const content =
    `**Afmelding goedgekeurd**\n` +
    `Mention: ${info.mention ? `<@${info.mention}>` : 'Onbekend'}\n` +
    `Startdatum: ${info.startdatum || 'Onbekend'}\n` +
    `Einddatum: ${info.einddatum || 'Onbekend'}\n` +
    `Reden: ${info.reden || 'Geen reden opgegeven'}\n` +
    `Goedgekeurd door: <@${user.id}>`;

  const sent = await thread.send({ content });

  db.loggedAfmeldingen[message.id] = { id: sent.id };
  saveData(db);
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channel.id !== NEWS_CHANNEL_ID) return;

  await makeLog(message);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const msg = reaction.message;
  if (reaction.emoji.name !== '✅') return;

  if (msg.channel.id === AFMELD_CHANNEL_ID) {
    await makeAfmeldingLog(msg, user);
    return;
  }

  if (msg.channel.id !== LOG_CHANNEL_ID) return;

  let checked = extractChecked(msg.content);

  if (!checked.includes(user.id)) {
    if (checked.length >= 2) return;
    checked.push(user.id);
  }

  await msg.edit(updateCheckedLine(msg.content, checked));
});

client.once(Events.ClientReady, async () => {
  console.log(`Bot online`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
});

client.login(TOKEN);