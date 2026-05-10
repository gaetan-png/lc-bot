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
const TIMEZONE = 'Europe/Brussels';

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

const HOOFDREDACTIE_ROLE_ID = process.env.HOOFDREDACTIE_ROLE_ID;

const DATA_FILE = path.join(__dirname, 'articleData.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      loggedMessages: {},
      loggedAfmeldingen: {}
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    if (!data.loggedMessages) data.loggedMessages = {};
    if (!data.loggedAfmeldingen) data.loggedAfmeldingen = {};

    return data;
  } catch (error) {
    console.error('Fout bij laden articleData.json:', error);

    return {
      loggedMessages: {},
      loggedAfmeldingen: {}
    };
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
    .setDescription('Toon hoeveel artikelen iedereen in een bepaalde maand heeft gemaakt')
    .addIntegerOption(option =>
      option
        .setName('maand')
        .setDescription('Maandnummer')
        .setMinValue(1)
        .setMaxValue(12)
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option
        .setName('jaar')
        .setDescription('Jaar')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('nagekeken')
    .setDescription('Toon hoeveel artikelen iedereen in een bepaalde maand heeft nagekeken')
    .addIntegerOption(option =>
      option
        .setName('maand')
        .setDescription('Maandnummer')
        .setMinValue(1)
        .setMaxValue(12)
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option
        .setName('jaar')
        .setDescription('Jaar')
        .setRequired(false)
    )
].map(cmd => cmd.toJSON());

function hasHoofdredactieRole(interaction) {
  return interaction.member.roles.cache.has(HOOFDREDACTIE_ROLE_ID);
}

function getBrusselsDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);

  const get = type => Number(parts.find(part => part.type === type)?.value);

  return {
    day: get('day'),
    month: get('month'),
    year: get('year')
  };
}

function getRequestedMonthYear(interaction) {
  const nowParts = getBrusselsDateParts(new Date());

  return {
    month: interaction.options.getInteger('maand') ?? nowParts.month,
    year: interaction.options.getInteger('jaar') ?? nowParts.year
  };
}

function getDutchMonthName(month) {
  const names = [
    'januari',
    'februari',
    'maart',
    'april',
    'mei',
    'juni',
    'juli',
    'augustus',
    'september',
    'oktober',
    'november',
    'december'
  ];

  return names[month - 1];
}

function getMonthStartEnd(month, year) {
  return {
    start: new Date(year, month - 1, 1),
    end: new Date(year, month, 1)
  };
}

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

    return line;
  }

  return 'Geen titel';
}

function extractAuthorsFromArticle(content) {
  const lines = content.split('\n').map(line => line.trim());

  const line = lines.find(line =>
    line.toLowerCase().startsWith('geschreven door:')
  );

  if (!line) return [];

  const ids = [...line.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);

  return [...new Set(ids)];
}

function extractChecked(content) {
  const lines = content.split('\n').map(line => line.trim());

  const line = lines.find(line =>
    line.toLowerCase().startsWith('nagekeken door:')
  );

  if (!line) return [];

  return [...line.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
}

function updateCheckedLine(content, users) {
  const checkedLine = users.length
    ? `Nagekeken door: ${users.map(id => `<@${id}>`).join(', ')}`
    : 'Nagekeken door: -';

  if (/^Nagekeken door:.*$/im.test(content)) {
    return content.replace(/^Nagekeken door:.*$/im, checkedLine);
  }

  return `${content}\n${checkedLine}`;
}

function extractAuthorIdsFromLog(content) {
  const lines = content.split('\n').map(line => line.trim());

  const mentionLine = lines.find(line =>
    line.toLowerCase().startsWith('mention:')
  );

  if (!mentionLine) return [];

  return [...mentionLine.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
}

function extractAfmeldingInfo(content) {
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let mention = null;
  let startdatum = null;
  let einddatum = null;
  let reden = null;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.startsWith('mention:')) {
      const match = line.match(/<@!?(\d+)>/);
      if (match) mention = match[1];
    }

    if (lower.startsWith('start')) {
      startdatum = line.split(':').slice(1).join(':').trim();
    }

    if (lower.startsWith('eind')) {
      einddatum = line.split(':').slice(1).join(':').trim();
    }

    if (lower.startsWith('reden')) {
      reden = line.split(':').slice(1).join(':').trim();
    }
  }

  return { mention, startdatum, einddatum, reden };
}

async function fetchMessagesForMonth(channel, month, year) {
  const { start, end } = getMonthStartEnd(month, year);

  let allMessages = [];
  let lastId;
  let keepFetching = true;

  while (keepFetching) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(lastId ? { before: lastId } : {})
    });

    if (!batch.size) break;

    const messages = [...batch.values()];

    for (const msg of messages) {
      if (msg.createdAt >= start && msg.createdAt < end) {
        allMessages.push(msg);
      }

      if (msg.createdAt < start) {
        keepFetching = false;
      }
    }

    lastId = messages[messages.length - 1].id;

    if (batch.size < 100) break;
  }

  return allMessages;
}

async function makeLog(message) {
  const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

  if (!logChannel || !logChannel.isTextBased()) {
    console.error('Logkanaal niet gevonden.');
    return;
  }

  if (db.loggedMessages[message.id]) return;

  const title = getArticleTitle(message);

  const authors = extractAuthorsFromArticle(message.content || '');

  const mentionLine = authors.length
    ? authors.map(id => `<@${id}>`).join(', ')
    : `<@${message.author.id}>`;

  const content =
    `**Artikel gepubliceerd**\n` +
    `Mention: ${mentionLine}\n` +
    `Titel: ${title}\n` +
    `Link naar artikel: ${message.url}\n` +
    `Nagekeken door: -`;

  const sentMessage = await logChannel.send({ content });

  db.loggedMessages[message.id] = {
    logMessageId: sentMessage.id
  };

  saveData(db);
}

async function makeAfmeldingLog(message, approvedByUser) {
  const thread = await message.guild.channels.fetch(AFMELDINGEN_LOG_THREAD_ID).catch(() => null);

  if (!thread || !thread.isThread()) {
    console.error('Afmeldingen-logthread niet gevonden.');
    return;
  }

  if (db.loggedAfmeldingen[message.id]) return;

  const info = extractAfmeldingInfo(message.content || '');

  const content =
    `**Afmelding goedgekeurd**\n` +
    `Mention: ${info.mention ? `<@${info.mention}>` : 'Onbekend'}\n` +
    `Startdatum: ${info.startdatum || 'Onbekend'}\n` +
    `Einddatum: ${info.einddatum || 'Onbekend'}\n` +
    `Reden: ${info.reden || 'Geen reden opgegeven'}\n` +
    `Goedgekeurd door: <@${approvedByUser.id}>`;

  const sentMessage = await thread.send({ content });

  db.loggedAfmeldingen[message.id] = {
    logMessageId: sentMessage.id
  };

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

client.on('threadCreate', async thread => {
  try {
    if (thread.parentId !== NEWS_CHANNEL_ID) return;

    const starterMessage = await thread.fetchStarterMessage().catch(() => null);

    if (!starterMessage) return;
    if (starterMessage.author.bot) return;

    await makeLog(starterMessage);
  } catch (error) {
    console.error('Fout bij threadCreate:', error);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      await reaction.fetch().catch(() => null);
    }

    if (reaction.message.partial) {
      await reaction.message.fetch().catch(() => null);
    }

    const msg = reaction.message;

    if (!msg) return;
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
  } catch (error) {
    console.error('Fout bij messageReactionAdd:', error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      await reaction.fetch().catch(() => null);
    }

    if (reaction.message.partial) {
      await reaction.message.fetch().catch(() => null);
    }

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

  if (
    (interaction.commandName === 'artikelen' ||
      interaction.commandName === 'nagekeken') &&
    !hasHoofdredactieRole(interaction)
  ) {
    await interaction.reply({
      content: 'Alleen Hoofdredactie kan dit commando gebruiken.',
      ephemeral: true
    });

    return;
  }

  try {
    if (interaction.commandName === 'artikelen') {
      await interaction.deferReply();

      const channel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply('Logkanaal niet gevonden.');
        return;
      }

      const { month, year } = getRequestedMonthYear(interaction);

      const messages = await fetchMessagesForMonth(channel, month, year);

      const counts = {};

      for (const msg of messages) {
        const authorIds = extractAuthorIdsFromLog(msg.content);

        for (const authorId of authorIds) {
          counts[authorId] = (counts[authorId] || 0) + 1;
        }
      }

      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

      if (!entries.length) {
        await interaction.editReply('Geen artikelen gevonden.');
        return;
      }

      let reply = `📰 **Artikelen in ${getDutchMonthName(month)} ${year}**\n\n`;

      for (const [id, amount] of entries) {
        reply += `<@${id}> — ${amount}\n`;
      }

      await interaction.editReply(reply);
    }

    if (interaction.commandName === 'nagekeken') {
      await interaction.deferReply();

      const channel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply('Logkanaal niet gevonden.');
        return;
      }

      const { month, year } = getRequestedMonthYear(interaction);

      const messages = await fetchMessagesForMonth(channel, month, year);

      const counts = {};

      for (const msg of messages) {
        const checkedUsers = extractChecked(msg.content);

        for (const userId of checkedUsers) {
          counts[userId] = (counts[userId] || 0) + 1;
        }
      }

      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

      if (!entries.length) {
        await interaction.editReply('Geen nagekeken artikelen gevonden.');
        return;
      }

      let reply = `✅ **Nagekeken in ${getDutchMonthName(month)} ${year}**\n\n`;

      for (const [id, amount] of entries) {
        reply += `<@${id}> — ${amount}\n`;
      }

      await interaction.editReply(reply);
    }
  } catch (error) {
    console.error('Fout bij interactionCreate:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Er ging iets mis.');
      } else {
        await interaction.reply({
          content: 'Er ging iets mis.',
          ephemeral: true
        });
      }
    } catch {}
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