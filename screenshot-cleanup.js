const SCREENSHOT_CLEANUP_DELAY_MS = 30_000;
const UNKNOWN_MESSAGE_ERROR_CODE = 10_008;

function isUnknownMessageError(error) {
  return Number(error?.code) === UNKNOWN_MESSAGE_ERROR_CODE;
}

function uniqueMessageRecords(records) {
  const unique = new Map();

  for (const record of records) {
    if (!record?.channelId || !record?.messageId) continue;
    unique.set(record.messageId, record);
  }

  return Array.from(unique.values());
}

async function deleteLingeringScreenshotSpamMessages(guild, records, logger = console) {
  const messages = uniqueMessageRecords(records);

  await Promise.all(messages.map(async ({ channelId, messageId }) => {
    try {
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
      if (!channel?.messages?.fetch) {
        logger.error(`Could not check screenshot spam message ${messageId}: channel ${channelId} is not text-based.`);
        return;
      }

      const lingeringMessage = await channel.messages.fetch({ message: messageId, force: true });
      await lingeringMessage.delete();
      logger.warn(`Deleted screenshot spam message ${messageId} after Discord's ban cleanup left it behind.`);
    } catch (error) {
      // Discord returns Unknown Message when the ban cleanup (or another
      // moderator) already removed it. That is the expected successful case.
      if (!isUnknownMessageError(error)) {
        logger.error(`Could not clean up screenshot spam message ${messageId} in channel ${channelId}:`, error);
      }
    }
  }));
}

function scheduleScreenshotSpamCleanup(guild, records, options = {}) {
  const delayMs = options.delayMs ?? SCREENSHOT_CLEANUP_DELAY_MS;
  const schedule = options.schedule ?? setTimeout;
  const logger = options.logger ?? console;
  const messages = uniqueMessageRecords(records);

  if (messages.length === 0) return null;

  return schedule(() => {
    void deleteLingeringScreenshotSpamMessages(guild, messages, logger);
  }, delayMs);
}

module.exports = {
  SCREENSHOT_CLEANUP_DELAY_MS,
  deleteLingeringScreenshotSpamMessages,
  scheduleScreenshotSpamCleanup
};
