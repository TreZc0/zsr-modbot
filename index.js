const Discord = require('discord.js');
const jsonfile = require('jsonfile');
const fs = require('fs');

// Configuration
const configFile = './config.json';
const config = jsonfile.readFileSync(configFile);

const discordToken = config["discord-token"];
const adminUserIDs = getConfiguredAdminUserIDs(config);

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
  Discord.GatewayIntentBits.DirectMessages,
  Discord.GatewayIntentBits.MessageContent
];

const bot = new Discord.Client({
  intents: botIntents,
  partials: [Discord.Partials.Channel]
});

// Spam tracking
let botSpamCheck = [];
let botSpamScreenShotCheckObj = {};

// Constants
const autoBan = true;

function getPingSignature(content) {
  const pingRe = /<@!?\d+>|<@&\d+>|@everyone|@here/g;
  const pings = content.match(pingRe) || [];
  const remainder = content.replace(pingRe, "").trim();

  if (pings.length === 0 || remainder.length > 0) {
    return null;
  }

  return pings
    .map(ping => ping.replace(/^<@!(\d+)>$/, "<@$1>"))
    .sort()
    .join("|");
}

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
      .setDescription('Show available commands and usage'),
    new Discord.SlashCommandBuilder()
      .setName('modbot-info')
      .setDescription('Show current bot configuration')
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

    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    const canWrite = botPerms && botPerms.has(Discord.PermissionFlagsBits.ViewChannel) && botPerms.has(Discord.PermissionFlagsBits.SendMessages);

    guildState.moderationChannelId = channel.id;
    console.log(`New monitoring channel ${channel.id} set for guild ${interaction.guildId} by user: ${interaction.member.displayName}`);
    commitState();

    await interaction.reply({
      content: canWrite
        ? `Moderation events will now be logged to ${channel}.`
        : `Moderation events will now be logged to ${channel}. Warning: the bot currently lacks permission to write there — please grant it View Channel and Send Messages access.`,
      flags: Discord.MessageFlags.Ephemeral
    });
  } else if (interaction.commandName === 'modbot-info') {
    if (!interaction.member.permissions.has(Discord.PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need Manage Server permission to use this command.',
        flags: Discord.MessageFlags.Ephemeral
      });
      return;
    }

    const logChannelId = guildState.moderationChannelId;
    let logChannelText;
    if (logChannelId) {
      const botPerms = interaction.guild.channels.cache.get(logChannelId)?.permissionsFor(interaction.guild.members.me);
      const canWrite = botPerms && botPerms.has(Discord.PermissionFlagsBits.ViewChannel) && botPerms.has(Discord.PermissionFlagsBits.SendMessages);
      logChannelText = `<#${logChannelId}>${canWrite ? '' : ' (bot lacks write permission)'}`;
    } else {
      logChannelText = 'Not configured — use `/monitor-channel` to set one.';
    }

    await interaction.reply({
      embeds: [{
        title: 'ZSR ModBot Info',
        color: 0x0099ff,
        fields: [
          { name: 'Log Channel', value: logChannelText }
        ],
        footer: { text: 'ZSR ModBot' }
      }],
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
bot.on('messageCreate', async message => {
  if (!message.guild && message.channel && message.channel.type === Discord.ChannelType.DM) {
    await handleAdminForwardedMessage(message);
    return;
  }

  // Ignore unknown channels
  if (!message.guild) {
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

  // Mass screenshots spam detection
  const attachRe = /<?https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\/attachments\/\d+\/\d+\/[^\s>]+(?=>|\s|$)>?/g;
  const matches = message.content.match(attachRe) || [];

  // Remove attachment links and common spam prefixes/formatting
  const remainder = getVisibleMessageText(message.content.replace(attachRe, ""));

  const isOnlyAttachmentsTwoPlus = matches.length >= 2 && remainder.length === 0;

  // Check for markdown link spam (e.g., [1.jpg](https://imgur.com/a/xyz))
  const markdownLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const markdownMatches = message.content.match(markdownLinkRe) || [];
  const markdownRemainder = getVisibleMessageText(message.content.replace(markdownLinkRe, ""));
  const isOnlyMarkdownLinksTwo = markdownMatches.length >= 2 && markdownRemainder.length === 0;

  // Check for actual file attachments (uploaded files, not URLs in content)
  const fileAttachmentRemainder = getVisibleMessageText(message.content);
  const isOnlyFileAttachmentsTwoPlus = message.attachments.size >= 2 && fileAttachmentRemainder.length <= 2;

  // Check for plain image URL spam (2+ bare image URLs)
  const plainImageUrlRe = /<?https?:\/\/[^\s>]+\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s>]*)?>?/gi;
  const plainImageMatches = message.content.match(plainImageUrlRe) || [];
  const plainImageRemainder = getVisibleMessageText(message.content.replace(plainImageUrlRe, ""));
  const isOnlyPlainImageUrls = plainImageMatches.length >= 3 && plainImageRemainder.length === 0;

  const plainImageMatchesForCount = message.content
      .replace(attachRe, "")
      .replace(markdownLinkRe, "")
      .match(plainImageUrlRe) || [];
  const screenshotCount = matches.length + markdownMatches.length + plainImageMatchesForCount.length + message.attachments.size;
  const nonScreenshotContent = getVisibleMessageText(
      message.content
          .replace(attachRe, "")
          .replace(markdownLinkRe, "")
          .replace(plainImageUrlRe, "")
  );
  const pingSignature = getPingSignature(nonScreenshotContent);
  const isScreenshotsWithOnlyPings = screenshotCount >= 2 && pingSignature !== null;

  const isScreenshotSpam = isOnlyAttachmentsTwoPlus || isOnlyMarkdownLinksTwo || isOnlyFileAttachmentsTwoPlus || isOnlyPlainImageUrls;

  if (isScreenshotSpam || isScreenshotsWithOnlyPings) {
      const uid = message.author.id;

      // Initialize tracking object if not exists
      if (!(uid in botSpamScreenShotCheckObj)) {
          botSpamScreenShotCheckObj[uid] = {
              count: 0,
              channels: new Set(),
              screenshotSpamChannels: new Set(),
              pingScreenshotChannels: new Set(),
              pingSignatures: []
          };
          setTimeout(() => {
              if (uid in botSpamScreenShotCheckObj)
                  delete botSpamScreenShotCheckObj[uid];
          }, 180000);
      }

      // Only count if this is a new channel
      if (!botSpamScreenShotCheckObj[uid].channels.has(message.channel.id)) {
          botSpamScreenShotCheckObj[uid].channels.add(message.channel.id);
          botSpamScreenShotCheckObj[uid].count++;
      }

      if (isScreenshotSpam) {
          botSpamScreenShotCheckObj[uid].screenshotSpamChannels.add(message.channel.id);
      }

      if (isScreenshotsWithOnlyPings && !botSpamScreenShotCheckObj[uid].pingScreenshotChannels.has(message.channel.id)) {
          botSpamScreenShotCheckObj[uid].pingScreenshotChannels.add(message.channel.id);
          botSpamScreenShotCheckObj[uid].pingSignatures.push(pingSignature);
      }

      const trackedPingSignatures = botSpamScreenShotCheckObj[uid].pingSignatures;
      const hasIdenticalPingScreenshots = botSpamScreenShotCheckObj[uid].pingScreenshotChannels.size >= 2 &&
          trackedPingSignatures.every(signature => signature !== null && signature === trackedPingSignatures[0]);
      const hasScreenshotSpamInMultipleChannels = botSpamScreenShotCheckObj[uid].screenshotSpamChannels.size >= 2;

      // Ban if spam detected in 2+ different channels
      if (hasScreenshotSpamInMultipleChannels || hasIdenticalPingScreenshots) {
          message.delete().catch(() => {});
          const moderationLog = {
              user: message.author.username,
              channel: { name: message.channel.name, id: message.channel.id },
              guildId: message.guild.id,
              offense: "Mass Screenshots spam",
              action: "Message Deleted & User Banned",
              messageObj: {
                  id: message.id,
                  content: message.content,
                  att: getAttachmentLogValue(message)
              }
          };

          // Fetch member if not available
          let member = message.member;
          if (!member) {
              try {
                  member = await message.guild.members.fetch(message.author.id);
              } catch (error) {
                  console.log("Couldn't fetch member for screenshot spam ban in guild " + message.guild.name + ": " + error);
                  logModerationAction({
                      ...moderationLog,
                      offense: "Mass Screenshots spam - member fetch failed",
                      action: "Message Deleted & Ban Failed"
                  });
                  delete botSpamScreenShotCheckObj[uid];
                  return;
              }
          }

          try {
              await member.ban({
                  deleteMessageSeconds: 43200,
                  reason: "Spam Bot with mass screenshots, auto banned!"
              });
              console.log(`Spam Bot with mass screenshots banned! Username: ${message.author.username}`);
              logModerationAction(moderationLog);
          } catch (error) {
              console.log("Couldn't ban bot (mass screenshots) in guild " + message.guild.name + " because of the following error: \n" + error);
              logModerationAction({
                  ...moderationLog,
                  action: "Message Deleted & Ban Failed"
              });
          } finally {
              delete botSpamScreenShotCheckObj[uid];
          }
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

  if (autoBan && message.member && message.content.toLowerCase().includes("omg join girl in cam")) {
    message.member.ban({ deleteMessageSeconds: 43200, reason: "Malware Bot, auto banned!" })
      .then(() => {
        console.log("Malware Spam Bot banned (cam girl discord)! Username: " + message.member.displayName);
        logModerationAction({
          user: message.author.username,
          channel: { name: message.channel.name, id: message.channel.id },
          guildId: message.guild.id,
          offense: "Malware Link Spam from user without roles",
          action: "Message Deleted & User Banned",
          messageObj: { id: message.id, content: message.content }
        });
      })
      .catch(error => console.log("Couldn't ban bot (cam girl discord) because of the following error: \n" + error));
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

function getConfiguredAdminUserIDs(configObj) {
  if (Array.isArray(configObj.adminUserIDs)) {
    return configObj.adminUserIDs.map(String).filter(Boolean);
  }

  if (configObj.adminUserID) {
    return [String(configObj.adminUserID)];
  }

  return [];
}

function isConfiguredAdmin(userId) {
  return adminUserIDs.includes(String(userId));
}

async function handleAdminForwardedMessage(message) {
  if (!isConfiguredAdmin(message.author.id)) {
    return;
  }

  const forwardedSnapshot = getForwardedSnapshot(message);
  if (!forwardedSnapshot) {
    return;
  }

  const wantsBan = message.content.trim().toLowerCase() === "ban";
  const source = await resolveForwardedSource(message, forwardedSnapshot);
  const messageToAnalyze = source.originalMessage || forwardedSnapshot;
  const guild = source.guild || messageToAnalyze.guild || null;
  const member = source.originalMessage
    ? await fetchGuildMember(guild, source.originalMessage.author.id)
    : null;
  const analysis = analyzeMessageAgainstRules(messageToAnalyze, guild, member);

  if (wantsBan) {
    await banForwardedMessageAuthor(message, source, analysis);
    return;
  }

  await message.reply({
    content: buildForwardedAnalysisReply(source, analysis, false),
    allowedMentions: { parse: [] }
  });
}

function getForwardedSnapshot(message) {
  if (!message.messageSnapshots || message.messageSnapshots.size === 0) {
    return null;
  }

  const snapshot = message.messageSnapshots.first();
  return snapshot?.message || snapshot || null;
}

async function resolveForwardedSource(message, forwardedSnapshot) {
  const reference = message.reference || {};
  const source = {
    guildId: reference.guildId || reference.guild_id || null,
    channelId: reference.channelId || reference.channel_id || null,
    messageId: reference.messageId || reference.message_id || forwardedSnapshot?.id || null,
    guild: null,
    channel: null,
    originalMessage: null,
    error: null
  };

  if (!source.channelId || !source.messageId) {
    source.error = "Forward reference did not include a source channel/message.";
    return source;
  }

  try {
    source.channel = await bot.channels.fetch(source.channelId);
    source.guild = source.channel?.guild || (source.guildId ? bot.guilds.cache.get(source.guildId) : null);

    if (!source.guild && source.guildId) {
      source.guild = await bot.guilds.fetch(source.guildId);
    }

    if (!source.channel?.messages) {
      source.error = "Forward source channel could not be read by the bot.";
      return source;
    }

    source.originalMessage = await source.channel.messages.fetch(source.messageId);
    source.guild = source.originalMessage.guild || source.guild;
  } catch (error) {
    source.error = formatError(error);
  }

  return source;
}

async function fetchGuildMember(guild, userId) {
  if (!guild || !userId) {
    return null;
  }

  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    console.log(`Couldn't fetch forwarded message member ${userId} in guild ${guild.id}: ${error}`);
    return null;
  }
}

function analyzeMessageAgainstRules(message, guild, member) {
  const content = getMessageContent(message);
  const normalizedContent = content.toLowerCase();
  const roleCount = member?.roles?.cache?.size;
  const lowRoleUser = typeof roleCount === "number" ? roleCount < 2 : null;
  const mentionCount = getMentionedUserCount(message, content);
  const guildState = guild && state[guild.id] ? state[guild.id] : null;
  const matches = [];

  const bannedAttachmentNames = getBannedAttachmentNames(message, guildState);
  if (bannedAttachmentNames.length > 0) {
    matches.push({
      offense: "Banned File Extension",
      action: "Message deletion and user warning",
      detail: `Matched attachment(s): ${bannedAttachmentNames.join(", ")}`
    });
  }

  if ((content.includes("@everyone") || content.includes("@here"))) {
    if (member && !member.permissions.has(Discord.PermissionFlagsBits.MentionEveryone)) {
      matches.push({
        offense: "Unauthorized Everyone/Here Ping",
        action: botSpamCheck.includes(member.displayName)
          ? "Message deletion and user ban"
          : "Message deletion and warning",
        detail: "Author does not have Mention Everyone permission."
      });
    } else if (!member) {
      matches.push({
        offense: "Everyone/Here Ping",
        action: "Needs original member permissions to decide warning/ban",
        detail: "The forwarded snapshot does not include member permissions."
      });
    }
  }

  if (autoBan && lowRoleUser === true && mentionCount > 6) {
    matches.push({
      offense: "Mass Ping from user without roles",
      action: "User ban",
      detail: `Mentioned ${mentionCount} users with ${roleCount} cached role(s).`
    });
  } else if (autoBan && lowRoleUser === null && mentionCount > 6) {
    matches.push({
      offense: "Mass Ping",
      action: "Needs original member roles to decide ban",
      detail: `Mentioned ${mentionCount} users.`
    });
  }

  if (autoBan && lowRoleUser === true && normalizedContent.includes("nitro for free")) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched phrase: nitro for free"
    });
  }

  if (autoBan && lowRoleUser === true && normalizedContent.includes("free discord nitro")) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched phrase: free discord nitro"
    });
  }

  if (autoBan && normalizedContent.includes("omg join girl in cam")) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched phrase: omg join girl in cam"
    });
  }

  if (autoBan && lowRoleUser === true && isDiscordPhishingLink(content)) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched Discord phishing/look-alike link pattern."
    });
  } else if (autoBan && lowRoleUser === null && isDiscordPhishingLink(content)) {
    matches.push({
      offense: "Discord phishing/look-alike link",
      action: "Needs original member roles to decide ban",
      detail: "Matched Discord phishing/look-alike link pattern."
    });
  }

  if (autoBan && lowRoleUser === true && content.includes("﷽")) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched Arabic character spam pattern."
    });
  }

  if (autoBan && lowRoleUser === true &&
    (content.startsWith("Sex Dating > http://") || content.includes("discord.amazingsexdating.com"))) {
    matches.push({
      offense: "Malware Link Spam from user without roles",
      action: "User ban",
      detail: "Matched adult content spam pattern."
    });
  }

  if (autoBan && lowRoleUser === true &&
    (content.startsWith("Best Casino Online > http://") || content.includes("gambldiscord.bestoffersx.com"))) {
    matches.push({
      offense: "Malware Link Spam (Betting) from user without roles",
      action: "User ban",
      detail: "Matched gambling spam pattern."
    });
  }

  const screenshotAnalysis = analyzeScreenshotSpamCandidate(message, content);
  if (screenshotAnalysis) {
    matches.push(screenshotAnalysis);
  }

  return {
    content,
    matches,
    attachmentText: getAttachmentLogValueFromAnyMessage(message)
  };
}

function getMessageContent(message) {
  return String(message?.content || "");
}

function getMessageAttachments(message) {
  if (!message?.attachments) {
    return [];
  }

  if (typeof message.attachments.values === "function") {
    return Array.from(message.attachments.values());
  }

  if (Array.isArray(message.attachments)) {
    return message.attachments;
  }

  return [];
}

function getMentionedUserCount(message, content) {
  const memberMentions = message?.mentions?.members?.size;
  if (typeof memberMentions === "number" && memberMentions > 0) {
    return memberMentions;
  }

  const userMentions = message?.mentions?.users?.size;
  if (typeof userMentions === "number" && userMentions > 0) {
    return userMentions;
  }

  const mentionIds = new Set();
  const mentionRe = /<@!?(\d+)>/g;
  let match;
  while ((match = mentionRe.exec(content)) !== null) {
    mentionIds.add(match[1]);
  }

  if (Array.isArray(message?.mentions)) {
    message.mentions.forEach(mention => {
      const id = mention?.id || mention?.user?.id;
      if (id) mentionIds.add(id);
    });
  }

  return mentionIds.size;
}

function getBannedAttachmentNames(message, guildState) {
  if (!guildState || !guildState.bannedExtensions || guildState.bannedExtensions.length === 0) {
    return [];
  }

  return getMessageAttachments(message)
    .map(att => att.name || att.filename || "")
    .filter(name => name && guildState.bannedExtensions.some(ext => name.toLowerCase().endsWith(ext)));
}

function isDiscordPhishingLink(content) {
  const normalizedContent = content.toLowerCase();
  return /[\b\/]d(?!isc)[0-9a-zA-Z]{1,}ord-g[0-9a-zA-Z]{1,}\./g.test(normalizedContent) ||
    /[\b\/]d(?!isc)[0-9a-zA-Z]{1,4}ord\./g.test(normalizedContent) ||
    /[\b\/]dis(?!cord)[0-9a-zA-Z]{1,}\.gift\//g.test(normalizedContent) ||
    /[\b\/]dis(?!cord)[0-9a-zA-Z]{1,}app\.com\//g.test(normalizedContent);
}

function analyzeScreenshotSpamCandidate(message, content) {
  const attachments = getMessageAttachments(message);
  const attachRe = /<?https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\/attachments\/\d+\/\d+\/[^\s>]+(?=>|\s|$)>?/g;
  const markdownLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const plainImageUrlRe = /<?https?:\/\/[^\s>]+\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s>]*)?>?/gi;

  const discordAttachmentMatches = content.match(attachRe) || [];
  const markdownMatches = content.match(markdownLinkRe) || [];
  const plainImageMatchesForCount = content
    .replace(attachRe, "")
    .replace(markdownLinkRe, "")
    .match(plainImageUrlRe) || [];
  const screenshotCount = discordAttachmentMatches.length + markdownMatches.length + plainImageMatchesForCount.length + attachments.length;

  if (screenshotCount < 2) {
    return null;
  }

  const nonScreenshotContent = getVisibleMessageText(
    content
      .replace(attachRe, "")
      .replace(markdownLinkRe, "")
      .replace(plainImageUrlRe, "")
  );
  const pingSignature = getPingSignature(nonScreenshotContent);
  const plainImageRemainder = getVisibleMessageText(content.replace(plainImageUrlRe, ""));
  const hasOnlyScreenshots = nonScreenshotContent.length === 0 || plainImageRemainder.length === 0;

  if (!hasOnlyScreenshots && pingSignature === null) {
    return null;
  }

  return {
    offense: "Mass Screenshots spam candidate",
    action: "Track user; ban only after repeated matching posts across channels",
    detail: `Found ${screenshotCount} screenshot/image attachment or link(s).`
  };
}

function getAttachmentLogValueFromAnyMessage(message) {
  const attachments = getMessageAttachments(message);
  if (attachments.length === 0) {
    return "";
  }

  return attachments
    .map(att => {
      const name = att.name || att.filename || "attachment";
      return att.url ? `${name}: ${att.url}` : name;
    })
    .join("\n")
    .substring(0, 1024);
}

async function banForwardedMessageAuthor(adminMessage, source, analysis) {
  if (!source.originalMessage || !source.guild) {
    await adminMessage.reply({
      content: `Could not ban from this forward. I could not fetch the original guild message.${source.error ? `\nError: ${truncateText(source.error, 1200)}` : ""}`,
      allowedMentions: { parse: [] }
    });
    return;
  }

  const originalMessage = source.originalMessage;
  const guild = source.guild;

  if (originalMessage.author.id === bot.user.id) {
    await adminMessage.reply("Refusing to ban the bot's own forwarded message.");
    return;
  }

  let deleteSucceeded = false;
  try {
    await originalMessage.delete();
    deleteSucceeded = true;
  } catch (error) {
    console.error(`Couldn't delete forwarded source message ${originalMessage.id}:`, error);
  }

  try {
    await guild.members.ban(originalMessage.author.id, {
      deleteMessageSeconds: 43200,
      reason: `Admin forwarded DM ban requested by ${adminMessage.author.tag || adminMessage.author.id}`
    });

    logModerationAction({
      user: originalMessage.author.username,
      channel: {
        name: originalMessage.channel.name,
        id: originalMessage.channel.id
      },
      guildId: guild.id,
      offense: analysis.matches.length > 0
        ? analysis.matches.map(match => match.offense).join(", ")
        : "Manual admin ban from forwarded message",
      action: deleteSucceeded
        ? "Message Deleted & User Banned"
        : "User Banned; Message Delete Failed",
      messageObj: {
        id: originalMessage.id,
        content: analysis.content,
        att: analysis.attachmentText
      }
    });

    await adminMessage.reply({
      content: buildForwardedAnalysisReply(source, analysis, true, deleteSucceeded),
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error(`Couldn't ban forwarded message author ${originalMessage.author.id}:`, error);
    await adminMessage.reply({
      content: `I found the forwarded source, but the ban failed.\nError: ${truncateText(formatError(error), 1200)}`,
      allowedMentions: { parse: [] }
    });
  }
}

function buildForwardedAnalysisReply(source, analysis, banExecuted, deleteSucceeded) {
  const originalMessage = source.originalMessage;
  const guildName = source.guild?.name || source.guildId || "[unknown server]";
  const channelName = source.channel?.name || originalMessage?.channel?.name || source.channelId || "[unknown channel]";
  const authorText = originalMessage
    ? `${originalMessage.author.username} (${originalMessage.author.id})`
    : "[unavailable from forwarded snapshot]";
  const ruleLines = analysis.matches.length > 0
    ? analysis.matches.map(match => `- ${match.offense}: ${match.action}. ${match.detail}`).join("\n")
    : "- No configured moderation rules matched.";
  const actionLine = banExecuted
    ? `\nAction: banned original author and ${deleteSucceeded ? "deleted" : "tried to delete"} the forwarded source message.`
    : "";
  const fetchLine = source.error
    ? `\nSource fetch note: ${truncateText(source.error, 500)}`
    : "";

  return truncateText([
    "Forwarded message analysis",
    `Server: ${guildName}`,
    `Channel: ${channelName}`,
    `Author: ${authorText}`,
    "Rule evaluation:",
    ruleLines,
    actionLine,
    fetchLine
  ].filter(Boolean).join("\n"), 1900);
}

function getVisibleMessageText(content) {
  return content
    .replace(/\|\|/g, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "")
    .replace(/\*/g, "")
    .replace(/_ _/g, "")
    .replace(/[\p{Cf}\uFEFF]/gu, "")
    .trim();
}

function truncateFieldValue(value) {
  if (!value || getVisibleMessageText(value).length === 0) {
    return "[no visible text]";
  }

  return value.substring(0, 1024);
}

function getAttachmentLogValue(message) {
  if (!message.attachments || message.attachments.size === 0) {
    return "";
  }

  return Array.from(message.attachments.values())
    .map(att => `${att.name || "attachment"}: ${att.url}`)
    .join("\n")
    .substring(0, 1024);
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 15) + "...[truncated]";
}

function formatError(error) {
  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.stack) {
    return error.stack;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function buildAdminFallbackMessage(actionObj, reason, error) {
  const guildId = actionObj.guildId;
  const guild = bot.guilds.cache.get(guildId);
  const channelName = actionObj.channel?.name || "[unknown channel]";
  const channelId = actionObj.channel?.id || "[unknown channel id]";
  const messageId = actionObj.messageObj?.id || "[unknown message id]";
  const messageLink = guildId && channelId !== "[unknown channel id]" && messageId !== "[unknown message id]"
    ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
    : "[unavailable]";
  const errorText = formatError(error);
  const originalText = truncateFieldValue(actionObj.messageObj?.content || "");
  const attachmentText = actionObj.messageObj?.att
    ? `\nAttachments: ${truncateText(actionObj.messageObj.att, 500)}`
    : "";

  return truncateText([
    "Moderation log delivery failed.",
    `Server: ${guild ? `${guild.name} (${guild.id})` : guildId}`,
    `Failure: ${reason}`,
    errorText ? `Error: ${truncateText(errorText, 700)}` : "",
    `Action: ${actionObj.action}`,
    `Offense: ${actionObj.offense}`,
    `User: ${actionObj.user}`,
    `Channel: ${channelName} (${channelId})`,
    `Message: ${messageLink}`,
    `Original message: ${truncateText(originalText, 300)}${attachmentText}`
  ].filter(Boolean).join("\n"), 1900);
}

function dmAdminModerationLogFailure(actionObj, reason, error) {
  if (adminUserIDs.length === 0) {
    console.log("No adminUserID/adminUserIDs set in config.json - cannot DM moderation log failure.");
    return;
  }

  adminUserIDs.forEach(adminId => {
    bot.users.fetch(adminId)
      .then(adminUser => adminUser.send(buildAdminFallbackMessage(actionObj, reason, error)))
      .catch(dmError => {
        console.error(`Couldn't DM admin user ${adminId} about moderation log failure:`, dmError);
      });
  });
}

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
    dmAdminModerationLogFailure(actionObj, "No moderation channel configured for this server");
    return;
  }

  const channel = bot.guilds.cache.get(guildId)?.channels.cache.get(state[guildId].moderationChannelId);
  if (!channel) {
    dmAdminModerationLogFailure(
      actionObj,
      `Configured moderation channel ${state[guildId].moderationChannelId} was not found`
    );
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
        value: truncateFieldValue(actionObj.messageObj.content),
        inline: true
      }
    ]
  };

  if (actionObj.messageObj.att && actionObj.messageObj.att.length > 0) {
    embed.fields.push({
      name: "Message Attachment(s)",
      value: truncateFieldValue(actionObj.messageObj.att),
      inline: true
    });
  }

  channel.send({ embeds: [embed] }).catch((e) => {
    console.error("Error sending moderation log:", e);
    dmAdminModerationLogFailure(actionObj, "Discord rejected or failed the moderation channel log send", e);
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
