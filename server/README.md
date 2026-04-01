# Kendall OS — Telegram Bot Server

## Setup

### 1. Create your Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts (pick a name and username)
3. BotFather gives you a token like `123456789:ABCdef...` — save it

### 2. Install dependencies

```bash
cd server
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in `server/.env`:

| Variable                 | Where to get it / What it does                                                  |
| ------------------------ | -------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`         | Same key from your main `.env`                                                  |
| `TELEGRAM_BOT_TOKEN`     | From @BotFather in step 1                                                        |
| `TELEGRAM_ALLOWED_USER_ID` | Your personal Telegram numeric user ID; only this user can talk to the bot (required) |
| `KENDALL_APP_ID`         | (Optional) App ID used to select which Kendall DB to use                         |
| `DB_PATH`                | (Optional) Full path to the Kendall DB file; overrides the default/app-based path |
### 4. Start the bot

```bash
cd server
npm start
```

That's it. No ngrok, no webhooks, no port forwarding needed - the bot uses long polling.

### 5. Chat

Search for your bot's username in Telegram and send it a message. Send `/reset` to clear conversation history.

---

## Notes

- Conversation history is stored **per chat ID** in SQLite and persists across restarts (until you send `/reset`).
- The bot gives short, mobile-friendly responses (no markdown).
- Uses Gemini `startChat` with a sliding window of the last 20 turns for context (not the full history).
