# Kendall Telegram Bot — Usage Guide

## Getting Started

1. Open the Kendall desktop app and go to the **Work** tab.
2. Click the **Bot** toggle at the bottom of the project sidebar to start the bot.
3. Go to the **Settings** tab to choose your AI provider (Gemini or Ollama) and model.
4. Open Telegram and find your bot (the one you configured with `TELEGRAM_BOT_TOKEN`).
5. Send `/start` to begin.

## How It Works

**Kendall is an autonomous AI assistant.** You don't need to memorize commands or break tasks into steps — just tell it what you want in plain language, and it will plan and execute the full workflow automatically.

Kendall can chain multiple actions from a single message. For example, saying "Create a project called Marketing, link my research files, and draft a proposal" will cause Kendall to execute all three steps without you needing to intervene.

Everything you do on Telegram is saved to the same database as the desktop app, so projects, files, chats, and documents stay in sync.

## AI Provider Settings

You can switch between AI providers from the **Settings** tab in the desktop app:

- **Google Gemini** — Cloud-based, requires API key. Multiple model options available (Flash, Pro, etc.)
- **Ollama** — Run models locally on your machine. No API key needed. Supports any model you have installed.

Settings are synced with the Telegram bot in real-time.

---

## Natural Language Examples

Instead of typing specific commands, just talk to Kendall naturally. It will figure out what to do:

### Multi-Step Workflows (Autonomous)

```
"Create a project called Q4 Report, find and link all my financial documents, then draft an executive summary"
"Set up a new project with my research files and write me a comprehensive analysis"
"Switch to the Marketing project, add the brand guidelines, and revise the proposal to be more formal"
"I need a PDF of that report, and also start a fresh conversation after"
```

### Project Management

```
"Create a new project called Marketing Pitch"
"What projects do I have?"
"Switch to the Client Proposal project"
"Delete the old test project"
```

### File Linking

```
"Link the annual report to this project"
"What files are in the project?"
"Add the market research file"
"Remove the draft document"
"Find all my finance-related files and add them"
```

### Document Generation

```
"Write me a proposal based on our research files"
"Create a comprehensive report about Q3 performance"
"Draft an executive summary from the linked documents"
```

### Revisions

```
"Make the introduction shorter"
"Add a budget section"
"Change the tone to be more formal"
"Fix the conclusion — it should mention next steps"
```

### Export

```
"Send me the PDF"
"I need a Word document"
"Export this as a PDF"
```

### Chat Management

```
"Start a new conversation"
"What am I working on right now?"
```

### Regular Questions

```
"What does the annual report say about revenue?"
"Summarize my research notes"
"What files do I have about marketing?"
```

---

## Slash Commands (Shortcuts)

These still work if you prefer explicit commands. They're available in Telegram's command menu.

| Command                  | Description                |
| ------------------------ | -------------------------- |
| `/help`                  | Show all commands          |
| `/newchat`               | Start a new conversation   |
| `/history`               | List past conversations    |
| `/loadchat <n>`          | Switch to conversation #n  |
| `/reset`                 | Clear current conversation |
| `/projects`              | List projects              |
| `/newproject <name>`     | Create a project           |
| `/deleteproject <name>`  | Delete a project           |
| `/project <name>`        | Select/view a project      |
| `/files`                 | List linked files          |
| `/link <query>`          | Link a file                |
| `/unlink <filename>`     | Unlink a file              |
| `/generate <prompt>`     | Generate a document        |
| `/revise <instructions>` | Revise last document       |
| `/pdf`                   | Export as PDF              |
| `/docx`                  | Export as DOCX             |

---

## Typical Workflow

```
You: "Create a project called Client Pitch"
Kendall: Done! Created "Client Pitch" and set it as active.

You: "Link the market research and client brief files"
Kendall: Linked 2 files: market_research.pdf, client_brief.docx

You: "Write a pitch deck script covering our value proposition and market fit"
Kendall: 🔍 Analyzing project files...
         📝 Outline ready: 5 sections
         ✍️ Writing section 3/5...
         ✨ Polishing...
         ✅ Done!
         [Full document text]

You: "Add a section about competitor analysis"
Kendall: [Revised document with new section]

You: "Send me the PDF"
Kendall: [PDF file attached]
```

---

## Data Sync

- **Projects** created/deleted on Telegram appear instantly in the desktop app's Work tab (and vice versa).
- **Chat messages** are saved under the Chat tab in the desktop app.
- **Generated documents** are saved as `.txt` files in `~/Desktop/kendall/Projects/<project name>/`.
- **PDF/DOCX exports** are also saved to the project directory.
- **Conversation history** is preserved — use `/history` and `/loadchat` to revisit old conversations.

## Notes

- The bot is restricted to your Telegram user ID only (configured in `server/.env`).
- Files must be indexed by the desktop app first (drop into `~/Desktop/kendall/Dump/`).
- Multi-page PDFs are fully supported (no content cutoff).
