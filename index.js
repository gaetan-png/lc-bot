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

const DATA_FILE = path.join(__dirname, 'articleData.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { loggedMessages: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.loggedMessages || typeof data.loggedMessages !== 'object') {
      data.loggedMessages = {};
    }
    return data;
  } catch {
    return { loggedMessages: {} };
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
    .setDescription('Toon aantal artikelen deze maand')
].map(cmd => cmd.toJSON());

function getArticleTitle(message) {
  const lines = (message.content || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^\*+|\*+$/g, '').trim());

  for (const line of lines) {
    if (line === 'Leeuwarder Courant ©') continue;
    if (line.startsWith('Geschreven door:')) continue;
    if (line.startsWith('Beeld:')) continue;
    if (/^\d{2}-\d{2}-\d{4}, \d{2}:\d{2}$/.test(line)) continue;

    return line;
  }

  return 'Geen titel';
}

function extractChecked(content) {
  const line = content.split('\n').find(l => l.startsWith('Nagekeken door:'));
  if (!line) return [];

  return [...line.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
}

function updateCheckedLine(content, users) {
  const checkedLine = users.length
    ? `Nagekeken door: ${users.map(id => `<@${id}>`).join(', ')}`
    : 'Nagekeken door: -';

  if (content.includes('Nagekeken door:')) {
    return content.replace(/^Nagekeken door:.*$/m, checkedLine);
  }

  return `${content}\n${checkedLine}`;
}

async function fetchAllMessages(channel, limit = 2000) {
  let allMessages = [];
  let lastId;

  while (allMessages.length < limit) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(lastId ? { before: lastId } : {})
    });

    if (!batch.size) break;

    const messages = [...batch.values()];
    allMessages.push(...messages);
    lastId = messages[messages.length - 1].id;

    if (batch.size < 100) break;
  }

  return allMessages;
}

async function makeLog(message) {
  const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  if (!db.loggedMessages) {
    db.loggedMessages = {};
  }

  if (db.loggedMessages[message.id]) return;

  const title = getArticleTitle(message);

  const content =
    `**Artikel gepubliceerd**\n` +
    `Mention: <@${message.author.id}>\n` +
    `Titel: ${title}\n` +
    `Link naar artikel: ${message.url}\n` +
    `Nagekeken door: -`;

  await logChannel.send({ content });

  db.loggedMessages[message.id] = true;
  saveData(db);
}

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== NEWS_CHANNEL_ID) return;

    await makeLog(message);
  } catch (error) {
    console.error('Fout bij messageCreate:', error);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

    const msg = reaction.message;
    if (!msg) return;
    if (reaction.emoji.name !== '✅') return;
    if (msg.channel.id !== LOG_CHANNEL_ID) return;

    let checked = extractChecked(msg.content);

    if (!checked.includes(user.id)) {
      if (checked.length >= 2) return;
      checked.push(user.id);
    }

    await msg.edit(updateCheckedLine(msg.content, checked));
  } catch (error) {
    console.error('Fout bij messageReactionAdd:', error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

    const msg = reaction.message;
    if (!msg) return;
    if (reaction.emoji.name !== '✅') return;
    if (msg.channel.id !== LOG_CHANNEL_ID) return;

    let checked = extractChecked(msg.content);
    checked = checked.filter(id => id !== user.id);

    await msg.edit(updateCheckedLine(msg.content, checked));
  } catch (error) {
    console.error('Fout bij messageReactionRemove:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'artikelen') {
      await interaction.deferReply();

      const channel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply('Logkanaal niet gevonden.');
        return;
      }

      const messages = await fetchAllMessages(channel, 2000);
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      const counts = {};

      messages.forEach(msg => {
        if (msg.createdAt.getMonth() !== currentMonth || msg.createdAt.getFullYear() !== currentYear) {
          return;
        }

        const mentionLine = msg.content.split('\n').find(line => line.startsWith('Mention:'));
        if (!mentionLine) return;

        const match = mentionLine.match(/<@!?(\d+)>/);
        if (!match) return;

        const id = match[1];
        counts[id] = (counts[id] || 0) + 1;
      });

      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

      if (!entries.length) {
        await interaction.editReply('Er zijn deze maand nog geen artikelen gevonden.');
        return;
      }

      let reply = '📰 **Artikelen deze maand**\n\n';
      for (const [id, amount] of entries) {
        reply += `<@${id}> — ${amount}\n`;
      }

      await interaction.editReply(reply);
    }
  } catch (error) {
    console.error('Fout bij interactionCreate:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Er ging iets mis bij het uitvoeren van dit commando.');
    } else {
      await interaction.reply({
        content: 'Er ging iets mis bij het uitvoeren van dit commando.',
        ephemeral: true
      });
    }
  }
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Bot online als ${readyClient.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log('Slash commands geregistreerd.');
  } catch (error) {
    console.error('Fout bij registreren slash commands:', error);
  }
});

client.login(TOKEN);