require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Web server voor Render (anders stopt hij)
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

client.once(Events.ClientReady, () => {
  console.log(`Bot online als ${client.user.tag}`);
});

// Bericht posten → log maken
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.NEWS_CHANNEL_ID) return;

  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  if (!logChannel || !logChannel.isTextBased()) return;

  const lines = message.content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');

  let title = 'Geen titel gevonden';

  for (const line of lines) {
    if (
      line.startsWith('*') &&
      line.endsWith('*') &&
      !line.includes('Leeuwarder Courant') &&
      !line.startsWith('***')
    ) {
      title = line.replace(/^\*+|\*+$/g, '');
      break;
    }
  }

  const log = `**Artikel gepubliceerd**
Mention: ${message.author}
Titel: ${title}
Link naar artikel: ${message.url}
Nagekeken door: Nog niet ingevuld`;

  await logChannel.send(log);
});

// Reactie → meerdere mensen bij nagekeken door (werkt ook op oude logs)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  // Fetch partials (voor oude berichten)
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

  let newContent = message.content;

  // Eerste checker
  if (newContent.includes('Nog niet ingevuld')) {
    newContent = newContent.replace(
      'Nog niet ingevuld',
      user.toString()
    );
  } else {
    // Extra checkers toevoegen (geen duplicates)
    if (!newContent.includes(user.toString())) {
      newContent = newContent.replace(
        /Nagekeken door: (.*)/,
        (match, p1) => `Nagekeken door: ${p1}, ${user}`
      );
    }
  }

  await message.edit(newContent);
});

client.login(process.env.TOKEN);