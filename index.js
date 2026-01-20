// Discord Moderation Bot
// Spam protection and automated moderation

const Discord = require('discord.js');
const jsonfile = require('jsonfile');
const fs = require('fs');

// Configuration
const configFile = './config.json';
const config = jsonfile.readFileSync(configFile);

const discordToken = config["discord-token"];

// State management
const stateFile = './state.json';
let state = {};

if (!fs.existsSync(stateFile)) {
  jsonfile.writeFileSync(stateFile, state);
} else {
  state = jsonfile.readFileSync(stateFile);
}

// Discord Bot Setup
const botIntents = [
  Discord.GatewayIntentBits.Guilds,
  Discord.GatewayIntentBits.GuildMembers,
  Discord.GatewayIntentBits.GuildMessages,
  Discord.GatewayIntentBits.MessageContent
];

const bot = new Discord.Client({ intents: botIntents });

// Spam tracking
let botSpamCheck = [];
let botSpamScreenShotCheckObj = {};
let memberFetching = false;

// Constants
const autoBan = true;

// Bot ready event
bot.on('clientReady', () => {
  console.log('Logged in as %s - %s', bot.user.username, bot.user.id);

  // Register commands for all guilds
  bot.guilds.cache.forEach(guild => {
    registerSlashCommands(guild);
  });
});

bot.on('guildCreate', guild => {
  console.log(`Joined new guild: ${guild.name} (${guild.id})`);
  registerSlashCommands(guild);
});

// Register slash commands per guild
async function registerSlashCommands(guild) {
  const commands = [
    new Discord.SlashCommandBuilder()
      .setName('monitor-channel')
      .setDescription('Set the channel for moderation event notifications')
      .addChannelOption(option =>
        option.setName('channel')
          .setDescription('The channel to send moderation logs')
          .setRequired(true)
      ),
    new Discord.SlashCommandBuilder()
      .setName('banned-extensions')
      .setDescription('Manage detected file extensions')
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription('Add a file extension to the ban list')
          .addStringOption(option =>
            option.setName('extension')
              .setDescription('The file extension to add (e.g., .exe)')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('remove')
          .setDescription('Remove a file extension from the ban list')
          .addStringOption(option =>
            option.setName('extension')
              .setDescription('The file extension to remove')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('list')
          .setDescription('List all banned file extensions')),
    new Discord.SlashCommandBuilder()
      .setName('modbot-help')
      .setDescription('Show available commands and usage')
  ];

  try {
    if (guild) {
      await guild.commands.set(commands.map(cmd => cmd.toJSON()));
      console.log(`Slash commands registered successfully for guild: ${guild.name}`);
    }
  } catch (error) {
    console.error(`Error registering slash commands for guild ${guild.id}:`, error);
  }
}

// Handle slash command interactions
bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Ensure guild state exists
  if (!state[interaction.guildId]) {
    state[interaction.guildId] = {
      moderationChannelId: "",
      bannedExtensions: []
    };
    commitState();
  }

  const guildState = state[interaction.guildId];

  if (interaction.commandName === 'modbot-help') {
    const helpEmbed = {
      title: "ZSR ModBot Help",
      description: "Here are the available commands for managing the bot:",
      color: 0x0099ff,
      fields: [
        {
          name: "1. Setup Moderation Logging",
          value: "`/monitor-channel <channel>`\nSets the text channel where the bot will log moderation actions (bans, warnings, etc.).\n*Requires 'Manage Server' permission.*"
        },
        {
          name: "2. Manage Banned Extensions",
          value: "`/banned-extensions add <extension>` - Ban a file type (e.g., .exe)\n`/banned-extensions remove <extension>` - Unban a file type\n`/banned-extensions list` - View all banned extensions\n*Requires 'Manage Server' permission.*"
        }
      ],
      footer: {
        text: "ZSR ModBot"
      }
    };

    await interaction.reply({
      embeds: [helpEmbed],
      flags: Discord.MessageFlags.Ephemeral
    });
  } else if (interaction.commandName === 'monitor-channel') {
    // Check if user has permission
    if (!interaction.member.permissions.has(Discord.PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need Manage Server permission to use this command.',
        flags: Discord.MessageFlags.Ephemeral
      });
      return;
    }

    const channel = interaction.options.getChannel('channel');

    if (channel.type !== Discord.ChannelType.GuildText) {
      await interaction.reply({
        content: 'Please select a text channel.',
        flags: Discord.MessageFlags.Ephemeral
      });
      return;
    }

    guildState.moderationChannelId = channel.id;
    commitState();

    await interaction.reply({
      content: `Moderation events will now be logged to ${channel}`,
      flags: Discord.MessageFlags.Ephemeral
    });
  } else if (interaction.commandName === 'banned-extensions') {
    if (!interaction.member.permissions.has(Discord.PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need Manage Server permission to use this command.',
        flags: Discord.MessageFlags.Ephemeral
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const extensions = guildState.bannedExtensions;
      const listText = extensions.length > 0 ? extensions.join(', ') : 'None';
      await interaction.reply({
        content: `Currently banned extensions: ${listText}`,
        flags: Discord.MessageFlags.Ephemeral
      });
    } else if (subcommand === 'add') {
      let ext = interaction.options.getString('extension').toLowerCase();
      if (!ext.startsWith('.')) ext = '.' + ext;

      if (!guildState.bannedExtensions.includes(ext)) {
        guildState.bannedExtensions.push(ext);
        commitState();
        await interaction.reply({
          content: `Added ${ext} to banned extensions list.`,
          flags: Discord.MessageFlags.Ephemeral
        });
      } else {
        await interaction.reply({
          content: `${ext} is already in the banned extensions list.`,
          flags: Discord.MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === 'remove') {
      let ext = interaction.options.getString('extension').toLowerCase();
      if (!ext.startsWith('.')) ext = '.' + ext;

      const index = guildState.bannedExtensions.indexOf(ext);
      if (index > -1) {
        guildState.bannedExtensions.splice(index, 1);
        commitState();
        await interaction.reply({
          content: `Removed ${ext} from banned extensions list.`,
          flags: Discord.MessageFlags.Ephemeral
        });
      } else {
        await interaction.reply({
          content: `${ext} is not in the banned extensions list.`,
          flags: Discord.MessageFlags.Ephemeral
        });
      }
    }
  }
});

// Message handling
bot.on('messageCreate', message => {
  // Ignore DMs and unknown channels
  if (!message.guild || (message.channel && (message.channel.type === Discord.ChannelType.DM))) {
    return;
  }

  // Ensure guild state exists
  if (!state[message.guild.id]) {
    // Don't auto-create state here if we want to avoid clutter, 
    // but for simplicity let's rely on commands creating it or create it on first moderation action need?
    // Actually, needed for banned extensions check.
    state[message.guild.id] = {
      moderationChannelId: "",
      bannedExtensions: []
    };
    commitState();
  }

  // Handle broken member objects
  if (!message.member && message.content.startsWith("!")) {
    message.reply("Couldn't grab your server membership data via API. A reindex has been triggered. Please try again in a minute.");
    console.log("Broken message object detected - User: " + message.author.username);

    if (!memberFetching) {
      memberFetching = true;
      message.guild.members.fetch()
        .then(() => {
          memberFetching = false;
          console.log("Refetched Server members");
        })
        .catch(e => {
          console.error("Error during member fetching: " + e);
          memberFetching = false;
        });
    }
    return;
  }

  // Mass screenshots spam detection
  const attachRe = /<?https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\/attachments\/\d+\/\d+\/[^\s>]+(?=>|\s|$)>?/g;
  const matches = message.content.match(attachRe) || [];

  // Remove attachment links and common spam prefixes/formatting
  let remainder = message.content.replace(attachRe, "").trim();
  // Remove Discord spoiler tags ||
  remainder = remainder.replace(/\|\|/g, "").trim();
  // Remove markdown formatting (bold **, italic *, underline __, strikethrough ~~)
  remainder = remainder.replace(/\*\*/g, "").replace(/__/g, "").replace(/~~/g, "").replace(/\*/g, "").trim();

  const isOnlyAttachmentsThreePlus = matches.length >= 3 && remainder.length === 0;

  // Check for markdown link spam (e.g., [1.jpg](https://imgur.com/a/xyz))
  const markdownLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const markdownMatches = message.content.match(markdownLinkRe) || [];
  const markdownRemainder = message.content.replace(markdownLinkRe, "").trim();
  const isOnlyMarkdownLinksFour = markdownMatches.length === 4 && markdownRemainder.length === 0;

  // Check for actual file attachments (uploaded files, not URLs in content)
  let fileAttachmentRemainder = message.content.trim();
  // Remove Discord spoiler tags ||
  fileAttachmentRemainder = fileAttachmentRemainder.replace(/\|\|/g, "").trim();
  // Remove markdown formatting (bold **, italic *, underline __, strikethrough ~~)
  fileAttachmentRemainder = fileAttachmentRemainder.replace(/\*\*/g, "").replace(/__/g, "").replace(/~~/g, "").replace(/\*/g, "").trim();
  const isOnlyFileAttachmentsFourPlus = message.attachments.size ==4 && fileAttachmentRemainder.length <= 2;

  if (isOnlyAttachmentsThreePlus || isOnlyMarkdownLinksFour || isOnlyFileAttachmentsFourPlus) {
    const uid = message.author.id;
    if (uid in botSpamScreenShotCheckObj && botSpamScreenShotCheckObj[uid] !== message.channel.id) {
      message.delete().catch(() => { });
      message.member.ban({
        deleteMessageSeconds: 43200,
        reason: "Spam Bot with mass screenshots, auto banned!"
      })
        .then(() => console.log(`Spam Bot with mass screenshots banned! Username: ${message.author.username}`))
        .catch(error => console.log("Couldn't ban bot (mass screenshots) because of the following error: \n" + error));

      delete botSpamScreenShotCheckObj[uid];

      logModerationAction({
        user: message.author.username,
        channel: { name: message.channel.name, id: message.channel.id },
        guildId: message.guild.id,
        offense: "Mass Screenshots spam",
        action: "Message Deleted & User Banned",
        messageObj: { id: message.id, content: message.content }
      });
    } else {
      botSpamScreenShotCheckObj[uid] = message.channel.id;
      setTimeout(() => {
        if (uid in botSpamScreenShotCheckObj)
          delete botSpamScreenShotCheckObj[uid];
      }, 180000);
    }
  }

  // Early returns for non-members and bots
  if (!message.member) return;
  if (message.member.bot) return;

  // Check for banned file extensions
  let forbiddenMessageDeleted = false;
  if (state[message.guild.id].bannedExtensions.length > 0 && message.attachments.size > 0) {
    forbiddenMessageDeleted = bannedAttachmentCheck(message);
  }

  if (forbiddenMessageDeleted) return;

  // Everyone/Here ping detection
  if (message.member && !message.member.permissions.has(Discord.PermissionFlagsBits.MentionEveryone) &&
    (message.content.includes("@everyone") || message.content.includes("@here"))) {

    if (botSpamCheck.includes(message.member.displayName)) {
      message.delete();
      message.member.ban({
        deleteMessageSeconds: 43200,
        reason: "Spam Bot with mass pings, auto banned!"
      })
        .then(() => console.log("Spam Bot with mass pings banned! Username: " + message.member.displayName))
        .catch(error => console.log("Couldn't ban bot (everyone spam) because of the following error: \n" + error));

      botSpamCheck.splice(botSpamCheck.indexOf(message.member.displayName), 1);

      logModerationAction({
        user: message.author.username,
        channel: { name: message.channel.name, id: message.channel.id },
        guildId: message.guild.id,
        offense: "Repeated unauthorized Everyone/Here Ping",
        action: "Message Deleted & User Banned",
        messageObj: { id: message.id, content: message.content }
      });
    } else {
      message.reply("Hey there. You have tried to ping everyone in this server. While disabled and thus without effect, we still do not appreciate the attempt. Repeated attempts to mass ping will be met with a ban.\nIn the event of important notifications or alerts that we need to be aware of, please contact staff.")
        .then(disclaimer => {
          message.delete();
          setTimeout(() => {
            disclaimer.delete();
          }, 15000);
        });

      botSpamCheck.push(message.member.displayName);

      logModerationAction({
        user: message.author.username,
        channel: { name: message.channel.name, id: message.channel.id },
        guildId: message.guild.id,
        offense: "Unauthorized Everyone/Here Ping",
        action: "Message Deleted & Warning issued",
        messageObj: { id: message.id, content: message.content }
      });

      setTimeout(() => {
        if (message.member) {
          if (botSpamCheck.includes(message.member.displayName))
            botSpamCheck.splice(botSpamCheck.indexOf(message.member.displayName), 1);
        }
      }, 45000);
    }
  }

  // Mass ping detection (users with few roles)
  if (autoBan && message.member && message.member.roles.cache.size < 2 && message.mentions.members.size > 6) {
    console.log("Banning user for mass pings", message.content, message.member.displayName);
    message.member.ban({
      deleteMessageSeconds: 43200,
      reason: "Spam Bot with mass pings, auto banned!"
    })
      .then(() => {
        console.log("Spam Bot with mass pings banned! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Mass Ping from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (mass pings) because of the following error: \n" + error));
  }

  // Nitro scam detection
  if (autoBan && message.member && message.content.toLowerCase().includes("nitro for free") && message.member.roles.cache.size < 2) {
    message.member.ban({ deleteMessageSeconds: 43200, reason: "Malware Bot, auto banned!" })
      .then(() => {
        console.log("Malware Spam Bot banned (nitro for free)! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (nitro for free) because of the following error: \n" + error));
  }

  if (autoBan && message.member && message.content.toLowerCase().includes("free discord nitro") && message.member.roles.cache.size < 2) {
    message.member.ban({ deleteMessageSeconds: 43200, reason: "Malware Bot, auto banned!" })
      .then(() => {
        console.log("Malware Spam Bot banned (free discord nitro)! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (free discord nitro) because of the following error: \n" + error));
  }

  // Discord phishing link detection
  if (autoBan && message.member && message.member.roles.cache.size < 2 &&
    (/[\b\/]d(?!isc)[0-9a-zA-Z]{1,}ord-g[0-9a-zA-Z]{1,}\./g.test(message.content.toLowerCase()) ||
      /[\b\/]d(?!isc)[0-9a-zA-Z]{1,4}ord\./g.test(message.content.toLowerCase()) ||
      /[\b\/]dis(?!cord)[0-9a-zA-Z]{1,}\.gift\//g.test(message.content.toLowerCase()) ||
      /[\b\/]dis(?!cord)[0-9a-zA-Z]{1,}app\.com\//g.test(message.content.toLowerCase()))) {
    message.member.ban({ deleteMessageSeconds: 43200, reason: "Malware Bot, auto banned!" })
      .then(() => {
        console.log("Spam Bot (discord gift variant) banned! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (discord look-a-like regex) because of the following error: \n" + error));
  }

  // Arabic character spam
  if (autoBan && message.member && message.content.includes("﷽") && message.member.roles.cache.size < 2) {
    message.member.ban({
      deleteMessageSeconds: 43200,
      reason: "Spam Bot, auto banned!"
    })
      .then(() => {
        console.log("Malware Spam Bot (Arabic letters) banned! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (arabic spam) because of the following error: \n" + error));
  }

  // Adult content spam
  if (autoBan && message.member && message.member.roles.cache.size < 2 &&
    (message.content.startsWith("Sex Dating > http://") || message.content.includes("discord.amazingsexdating.com"))) {
    message.member.ban({
      deleteMessageSeconds: 43200,
      reason: "Sex Dating Bot, auto banned!"
    })
      .then(() => {
        console.log("Malware Spam Bot (Porn) banned! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (sex dating links) because of the following error: \n" + error));
  }

  // Gambling spam
  if (autoBan && message.member && message.member.roles.cache.size < 2 &&
    (message.content.startsWith("Best Casino Online > http://") || message.content.includes("gambldiscord.bestoffersx.com"))) {
    message.member.ban({
      deleteMessageSeconds: 43200,
      reason: "Betting Site Bot, auto banned!"
    })
      .then(() => {
        console.log("Malware Spam Bot (Gambling) banned! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam (Betting) from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (online casino links) because of the following error: \n" + error));
  }
});

// Check for banned file attachments
function bannedAttachmentCheck(message) {
  const author = message.author;
  const attachmentCollection = message.attachments;
  let bannedAttachmentTypeFound = false;

  const guildExtensions = state[message.guild.id] ? state[message.guild.id].bannedExtensions : [];

  attachmentCollection.forEach(att => {
    guildExtensions.forEach(ext => {
      if (att.name.toLowerCase().endsWith(ext))
        bannedAttachmentTypeFound = true;
    });
  });

  if (bannedAttachmentTypeFound) {
    let actionObj = {
      user: author.username,
      channel: {
        name: message.channel.name,
        id: message.channel.id
      },
      guildId: message.guild.id,
      offense: "Banned File Extension",
      action: "Message Deleted & User warned",
      messageObj: {
        id: message.id,
        content: (message.content.length > 0) ? message.content : "####No message included####",
        att: Array.from(attachmentCollection.values()).map(val => val.name).join(", ")
      }
    };

    message.delete()
      .catch(ex => {
        console.error(`Cannot delete message with banned ext from ${author.username} in ${message.channel.name}: ${ex}`);
      });

    let warningMsg = `Hey there, ${author.username}!\nYou just sent a message containing a forbidden file in our discord. The message has been deleted automatically.\
\nPlease refrain from sending a file of the following types in the future: ${guildExtensions.join(", ")}\
\nPlease refer to our server rules - please make sure to read them again and follow them to ensure every community member can have a good time.\
\n\n**Your moderation team**`;

    message.author.send(warningMsg)
      .catch(ex => {
        console.error(`Cannot send warning DM to user ${author.username} for sending banned file attachment: ${ex}`);
      });

    logModerationAction(actionObj);
    return true;
  }
  return false;
}

// Log moderation actions
function logModerationAction(actionObj) {
  const guildId = actionObj.guildId;

  if (!state[guildId] || !state[guildId].moderationChannelId) {
    // console.log("No moderation channel set for guild " + guildId);
    return;
  }

  const channel = bot.guilds.cache.get(guildId)?.channels.cache.get(state[guildId].moderationChannelId);
  if (!channel) {
    console.log("Moderation channel not found.");
    return;
  }

  const postDate = new Date().toISOString();

  const embed = {
    title: "Bot Moderation Action: " + actionObj.action,
    description: "Reason: " + actionObj.offense,
    url: `https://discord.com/channels/${guildId}/${actionObj.channel.id}/${actionObj.messageObj.id}`,
    color: 0xFF0000,
    timestamp: postDate,
    footer: {
      text: "Moderation Bot"
    },
    fields: [
      {
        name: "User",
        value: actionObj.user,
        inline: true
      },
      {
        name: "Channel",
        value: actionObj.channel.name,
        inline: true
      },
      {
        name: "Original Message",
        value: actionObj.messageObj.content.substring(0, 1024), // Discord field limit
        inline: true
      }
    ]
  };

  if (actionObj.messageObj.att && actionObj.messageObj.att.length > 0) {
    embed.fields.push({
      name: "Message Attachment(s)",
      value: actionObj.messageObj.att,
      inline: true
    });
  }

  channel.send({ embeds: [embed] }).catch((e) => {
    console.error("Error sending moderation log:", e);
  });
}

// Save state to file
function commitState() {
  jsonfile.writeFile(stateFile, state, { spaces: 2 }, function (err) {
    if (err) console.error(err);
  });
}

// Bot connection error handling
bot.on('error', (error) => {
  console.error("The bot encountered a connection error!!");
  console.error(error);

  setTimeout(() => {
    bot.login(discordToken).catch(console.error);
  }, 5000);
});

bot.on('shardDisconnect', () => {
  console.error("The bot disconnected!!");

  setTimeout(() => {
    bot.login(discordToken).catch(console.error);
  }, 5000);
});

// Login
bot.login(discordToken).catch(err => {
  console.error("Failed to login:", err);
});
