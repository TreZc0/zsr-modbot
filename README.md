# Discord Moderation Bot

A streamlined Discord bot focused on automated spam protection and moderation logging.

## Features

### Spam Protection
- **Mass Screenshot Detection**: Bans users posting 3+ attachment links across different channels
- **@everyone/@here Abuse**: Warns first, then bans on repeat offenses
- **Mass Mentions**: Auto-bans users with few roles mentioning 6+ users
- **Nitro Scams**: Detects and bans "free nitro" phishing attempts
- **Discord Phishing**: Blocks fake Discord gift/app links using regex patterns
- **Adult Content Spam**: Blocks dating/gambling spam bots
- **Banned File Extensions**: Removes messages with prohibited file types

### Moderation Logging
- All moderation actions are logged to a configurable channel
- Rich embed format with offense details, user info, and original message
- Clickable links to original message location

## Setup

### Prerequisites
- Node.js 22 or higher
- A Discord Bot Token with the following permissions:
  - Read Messages/View Channels
  - Send Messages
  - Manage Messages
  - Ban Members
  - Read Message History

### Required Bot Intents
Enable these in the Discord Developer Portal:
- Server Members Intent
- Message Content Intent
- Presence Intent (optional)

### Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Configure the bot:
   - Open `config.json`
   - Replace `YOUR_BOT_TOKEN_HERE` with your bot token

4. Start the bot:
```bash
npm start
```

## Configuration

### config.json

```json
{
  "discord-token": "YOUR_BOT_TOKEN_HERE"
}
```

- **discord-token**: Your bot's authentication token

## Usage

### Getting Help

Use the `/modbot-help` command to see a list of available commands and their usage directly in Discord:

```
/modbot-help
```

### Multi-Guild Support
The bot now supports multiple guilds (servers) out of the box. Configuration for moderation channels and banned file extensions is stored per-guild in `state.json`.

### Setting Up Moderation Logging

Use the `/monitor-channel` slash command to set where moderation events are logged for the current server:

```
/monitor-channel #moderation-logs
```

**Requirements:**
- You need "Manage Server" permission to use this command
- The channel must be a text channel

### Managing Banned Extensions

Use the `/banned-extensions` slash command to manage prohibited file types for the current server:

- **Add an extension:** `/banned-extensions add .exe`
- **Remove an extension:** `/banned-extensions remove .exe`
- **List banned extensions:** `/banned-extensions list`

**Requirements:**
- You need "Manage Server" permission to use this command

### Automatic Moderation

The bot automatically monitors all messages for spam patterns and takes action:

1. **First offense** (for @everyone/@here): Warning message + deletion
2. **Repeat offense**: Automatic ban + moderation log
3. **Malware/phishing links**: Immediate ban + log
4. **Banned file extensions**: Message deletion + DM warning to user + log (requires configuration via `/banned-extensions`)

## Moderation Actions

All actions are logged with:
- Username
- Channel name
- Offense type
- Action taken
- Original message content
- Timestamp

### Auto-Ban Toggle

To disable automatic banning (for testing):

```javascript
const autoBan = false; // Default: true
```

## Spam Patterns Detected

1. **Mass Screenshots**: 3+ Discord attachment URLs with no text
2. **Everyone/Here Pings**: Users without permission trying to ping everyone
3. **Mass User Mentions**: 6+ user mentions from users with <2 roles
4. **Nitro Scams**: "nitro for free" or "free discord nitro"
5. **Discord Phishing**: Typosquatted Discord domains (e.g., `discørd.gift`)
6. **Arabic Spam Character**: Specific Unicode character used by spam bots
7. **Adult Content**: Known adult dating spam patterns
8. **Gambling Spam**: Casino spam patterns

## Permissions Required

The bot needs these Discord permissions:
- View Channels
- Send Messages
- Manage Messages (to delete spam)
- Ban Members (to ban spammers)
- Read Message History
- Use Slash Commands

## State Management

The bot stores its configuration in `state.json`:
- Moderation channel ID
- Active spam tracking (in memory)

## Error Handling

The bot automatically:
- Reconnects on disconnection
- Handles missing member data
- Logs errors to console
- Continues operation after failed actions

## Troubleshooting

### Bot not responding to slash commands
- Ensure the bot has been invited with `applications.commands` scope
- Check that "Use Slash Commands" permission is granted
- Restart the bot to re-register commands

### Moderation logs not appearing
- Run `/monitor-channel` to set the log channel
- Verify the bot has "Send Messages" permission in that channel
- Check `state.json` for the saved channel ID

### Bot can't ban users
- Ensure the bot's role is higher than the target user's highest role
- Verify "Ban Members" permission is granted
- Check bot logs for permission errors

## License

MIT

## Support

For issues or questions, please check the bot console logs for detailed error information.
