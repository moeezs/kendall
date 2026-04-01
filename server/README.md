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

| Variable             | Where to get it                |
| -------------------- | ------------------------------ |
| `GEMINI_API_KEY`     | Same key from your main `.env` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather in step 1      |

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

- Conversation history is kept **per chat ID** in memory (resets when server restarts).
- The bot gives short, mobile-friendly responses (no markdown).
- Uses Gemini `startChat` with full conversation history for context.
