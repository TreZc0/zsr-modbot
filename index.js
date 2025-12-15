// Discord Moderation Bot
// Spam protection and automated moderation

const Discord = require('discord.js');
const jsonfile = require('jsonfile');
const fs = require('fs');

// Configuration
const configFile = './config.json';
const config = jsonfile.readFileSync(configFile);

const discordToken = config["discord-token"];
const activeGuild = config["discord-server-id"];
const bannedFileExtensions = config["discord-banned-file-ext"] || [];

// State management
const stateFile = './state.json';
let state = {
  "moderationChannelId": ""
};

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
bot.on('ready', () => {
  console.log('Logged in as %s - %s', bot.user.username, bot.user.id);
  registerSlashCommands();
});

// Register slash commands
async function registerSlashCommands() {
  const commands = [
    new Discord.SlashCommandBuilder()
      .setName('monitor-channel')
      .setDescription('Set the channel for moderation event notifications')
      .addChannelOption(option =>
        option.setName('channel')
          .setDescription('The channel to send moderation logs')
          .setRequired(true)
      )
  ];

  try {
    const guild = bot.guilds.cache.get(activeGuild);
    if (guild) {
      await guild.commands.set(commands.map(cmd => cmd.toJSON()));
      console.log('Slash commands registered successfully');
    }
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
}

// Handle slash command interactions
bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'monitor-channel') {
    // Check if user has permission
    if (!interaction.member.permissions.has(Discord.PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need Manage Server permission to use this command.',
        ephemeral: true
      });
      return;
    }

    const channel = interaction.options.getChannel('channel');

    if (channel.type !== Discord.ChannelType.GuildText) {
      await interaction.reply({
        content: 'Please select a text channel.',
        ephemeral: true
      });
      return;
    }

    state.moderationChannelId = channel.id;
    commitState();

    await interaction.reply({
      content: `Moderation events will now be logged to ${channel}`,
      ephemeral: true
    });
  }
});

// Message handling
bot.on('messageCreate', message => {
  // Ignore DMs and unknown channels
  if (!message.guild || (message.channel && (message.channel.type === Discord.ChannelType.DM))) {
    return;
  }

  // Handle broken member objects
  if (!message.member && message.content.startsWith("!")) {
    message.reply("Couldn't grab your server membership data via API. A reindex has been triggered. Please try again in a minute.");
    console.log("Broken message object detected - User: " + message.author.username);

    if (!memberFetching) {
      memberFetching = true;
      bot.guilds.cache.get(activeGuild).fetch()
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

  if (isOnlyAttachmentsThreePlus) {
    const uid = message.author.id;
    if (uid in botSpamScreenShotCheckObj && botSpamScreenShotCheckObj[uid] !== message.channel.id) {
      message.delete().catch(() => {});
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
        offense: "Mass Screenshots spam",
        action: "Message Deleted & User Banned",
        messageObj: { id: message.id, content: message.content }
      });
    } else {
      botSpamScreenShotCheckObj[uid] = message.channel.id;
      setTimeout(() => {
        if (uid in botSpamScreenShotCheckObj)
          delete botSpamScreenShotCheckObj[uid];
      }, 30000);
    }
  }

  // Early returns for non-members and bots
  if (!message.member) return;
  if (message.member.bot) return;

  // Check for banned file extensions
  let forbiddenMessageDeleted = false;
  if (bannedFileExtensions.length > 0 && message.attachments.size > 0) {
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

  attachmentCollection.forEach(att => {
    bannedFileExtensions.forEach(ext => {
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
\nPlease refrain from sending a file of the following types in the future: ${bannedFileExtensions.join(", ")}\
\nOur 'welcome' channel contains our server rules - please make sure to read them again and follow them to ensure every community member can have a good time.\
\n\nBest\n**Your moderation team**`;

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
  if (!state.moderationChannelId) {
    console.log("No moderation channel set. Use /monitor-channel to set one.");
    return;
  }

  const channel = bot.guilds.cache.get(activeGuild)?.channels.cache.get(state.moderationChannelId);
  if (!channel) {
    console.log("Moderation channel not found.");
    return;
  }

  const postDate = new Date().toISOString();

  const embed = {
    title: "Bot Moderation Action: " + actionObj.action,
    description: "Reason: " + actionObj.offense,
    url: `https://discord.com/channels/${activeGuild}/${actionObj.channel.id}/${actionObj.messageObj.id}`,
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
