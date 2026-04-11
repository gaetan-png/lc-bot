require('dotenv').config();

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Web server voor hosting
app.get('/', (_req, res) => {
  res.send('Bot is running');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// Discord bot
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

// Slash commands registreren
const commands = [
  new SlashCommandBuilder()
    .setName('artikelen')
    .setDescription('Toon hoeveel artikelen iedereen deze maand heeft geschreven')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log('Slash commands geregistreerd');
  } catch (error) {
    console.error('Fout bij registreren slash commands:', error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot online als ${client.user.tag}`);
  await registerCommands();
});

// Helpers
function extractTitle(content) {
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');

  for (const line of lines) {
    if (
      line.startsWith('*') &&
      line.endsWith('*') &&
      !line.includes('Leeuwarder Courant') &&
      !line.startsWith('***')
    ) {
      return line.replace(/^\*+|\*+$/g, '');
    }
  }

  return 'Geen titel gevonden';
}

function extractAuthors(content, fallbackAuthorMention) {
  // Zoek lijn "Geschreven door:"
  const authorLine = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line.toLowerCase().startsWith('geschreven door:'));

  if (!authorLine) {
    return [fallbackAuthorMention];
  }

  const mentions = authorLine.match(/<@!?\d+>/g);

  if (!mentions || mentions.length === 0) {
    return [fallbackAuthorMention];
  }

  // Dubbels verwijderen
  return [...new Set(mentions)];
}

function parseReviewersFromLog(content) {
  const match = content.match(/Nagekeken door:\s*(.*)/);
  if (!match) return [];

  const raw = match[1].trim();
  if (!raw || raw === 'Nog niet ingevuld') return [];

  const mentions = raw.match(/<@!?\d+>/g);
  return mentions ? [...new Set(mentions)] : [];
}

// Bericht posten → log maken
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.NEWS_CHANNEL_ID) return;

  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  if (!logChannel || !logChannel.isTextBased()) return;

  const title = extractTitle(message.content);
  const authors = extractAuthors(message.content, message.author.toString());

  const log = `**Artikel gepubliceerd**
Mention: ${message.author}
Auteurs: ${authors.join(', ')}
Titel: ${title}
Link naar artikel: ${message.url}
Nagekeken door: Nog niet ingevuld`;

  await logChannel.send(log);
});

// Reactie toevoegen → reviewers toevoegen
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Kon reactie niet ophalen:', error);
      return;
    }
  }

  const message = reaction.message;

  if (message.partial) {
    try {
      await message.fetch();
    } catch (error) {
      console.error('Kon bericht niet ophalen:', error);
      return;
    }
  }

  if (reaction.emoji.name !== '✅') return;
  if (!message.content.includes('Artikel gepubliceerd')) return;

  const currentReviewers = parseReviewersFromLog(message.content);
  const userMention = user.toString();

  if (currentReviewers.includes(userMention)) return;

  const newReviewers = [...currentReviewers, userMention];
  const replacement = newReviewers.length > 0
    ? newReviewers.join(', ')
    : 'Nog niet ingevuld';

  const newContent = message.content.replace(
    /Nagekeken door: .*/,
    `Nagekeken door: ${replacement}`
  );

  await message.edit(newContent);
});

// Reactie verwijderen → reviewer verwijderen
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Kon reactie niet ophalen:', error);
      return;
    }
  }

  const message = reaction.message;

  if (message.partial) {
    try {
      await message.fetch();
    } catch (error) {
      console.error('Kon bericht niet ophalen:', error);
      return;
    }
  }

  if (reaction.emoji.name !== '✅') return;
  if (!message.content.includes('Artikel gepubliceerd')) return;

  const userMention = user.toString();
  const currentReviewers = parseReviewersFromLog(message.content);
  const newReviewers = currentReviewers.filter(r => r !== userMention);

  const replacement = newReviewers.length > 0
    ? newReviewers.join(', ')
    : 'Nog niet ingevuld';

  const newContent = message.content.replace(
    /Nagekeken door: .*/,
    `Nagekeken door: ${replacement}`
  );

  await message.edit(newContent);
});

// Slash command /artikelen
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'artikelen') return;

  await interaction.deferReply();

  try {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (!logChannel || !logChannel.isTextBased()) {
      return interaction.editReply('Logkanaal niet gevonden.');
    }

    const now = new Date();
    const counts = {};
    let lastId;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await logChannel.messages.fetch(options);
      if (messages.size === 0) break;

      for (const msg of messages.values()) {
        if (!msg.content.includes('Artikel gepubliceerd')) continue;

        const createdAt = msg.createdAt;
        if (
          createdAt.getMonth() !== now.getMonth() ||
          createdAt.getFullYear() !== now.getFullYear()
        ) {
          continue;
        }

        // Eerst Auteurs-lijn proberen
        const authorsMatch = msg.content.match(/Auteurs:\s*(.*)/);
        let authors = [];

        if (authorsMatch) {
          const foundMentions = authorsMatch[1].match(/<@!?\d+>/g);
          if (foundMentions) {
            authors = [...new Set(foundMentions)];
          }
        }

        // Fallback naar Mention als Auteurs ontbreekt
        if (authors.length === 0) {
          const mentionMatch = msg.content.match(/Mention:\s*(<@!?\d+>)/);
          if (mentionMatch) {
            authors = [mentionMatch[1]];
          }
        }

        for (const author of authors) {
          counts[author] = (counts[author] || 0) + 1;
        }
      }

      lastId = messages.last().id;
    }

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      return interaction.editReply('Geen artikelen gevonden deze maand.');
    }

    let reply = '📊 **Artikelen deze maand**\n\n';

    entries.forEach(([user, count], index) => {
      reply += `${index + 1}. ${user} — ${count}\n`;
    });

    await interaction.editReply(reply);
  } catch (error) {
    console.error('Fout bij /artikelen:', error);
    await interaction.editReply('Er ging iets fout bij het ophalen van de statistieken.');
  }
});

client.login(process.env.TOKEN);