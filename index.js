require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`Bot online als ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
console.log("Bericht gezien:", message.channel.id, message.author.tag, message.content);
  if (message.author.bot) return;
  if (message.channel.id !== process.env.NEWS_CHANNEL_ID) return;

  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);

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
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  if (reaction.emoji.name !== '✅') return;

  const message = reaction.message;

  if (!message.content.includes('Artikel gepubliceerd')) return;

  let newContent = message.content;

  newContent = newContent.replace(
    'Nog niet ingevuld',
    user.toString()
  );

  await message.edit(newContent);
});
client.login(process.env.TOKEN);
