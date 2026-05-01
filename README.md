# Kendall

A local-first personal AI OS. Drop files into a folder and they get automatically sorted. Ask questions across all your documents. Build projects and generate polished docs from your research. Control everything from your desktop — or from Telegram, on the go.

Built with Tauri, React, TypeScript, and Rust. Runs entirely on macOS.

---

## Table of Contents

- [Video Demos](#video-demos)
- [Features](#features)
- [How It Works](#how-it-works)
- [Setup](#setup)
  - [Desktop App](#desktop-app)
  - [Telegram Bot](#telegram-bot)
- [Auto-Sort (Dump Folder)](#auto-sort-dump-folder)
- [Chat — Ask Your Files](#chat--ask-your-files)
- [Work — Projects & Document Generation](#work--projects--document-generation)
- [Telegram Bot](#telegram-bot-1)
- [Settings — AI Providers & Models](#settings--ai-providers--models)
- [Database (DB Tab)](#database-db-tab)
- [Supported File Types](#supported-file-types)
- [Tech Stack](#tech-stack)

---

## Video Demos

### Telegram Bot — Generate a PDF via chat

Creates a new project via the Telegram bot and asks it to generate a PDF of an essay about the Dune movie.

<video src="https://media.githubusercontent.com/media/moeezs/kendall/main/demos/kendall-bot-demo.MP4" controls width="100%"></video>

### Desktop App — Auto-sort files and query the chat

Sorts files into the right folders automatically, then asks the Chat tab when an assignment is due.

<video src="https://media.githubusercontent.com/media/moeezs/kendall/main/demos/kendall-app-demo.mp4" controls width="100%"></video>

---

## Features

| Feature               | Description                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Auto-Sort**         | Drop files into `~/Desktop/kendall/Dump`. They are read, understood, and moved to the right folder automatically.               |
| **RAG Chat**          | Ask natural language questions across all indexed documents. Sources are cited and clickable.                                   |
| **Projects**          | Group files into projects. Generate full documents (reports, proposals, summaries) from linked files. Export as PDF or DOCX.    |
| **Telegram Bot**      | Full autonomous AI agent. Create projects, link files, generate and export documents — all from your phone, no commands needed. |
| **Local or Cloud AI** | Use Google Gemini (cloud) or Ollama (local, no API key) — per feature, independently configured.                                |
| **Fully Local DB**    | Everything is stored in SQLite on your machine. No cloud sync, no data leaves unless you use Gemini.                            |

---

## How It Works

```
~/Desktop/kendall/
├── Dump/                  ← Drop files here for auto-sorting
├── Work/
├── Finance/
├── Research/
├── Misc/
└── [your custom folders]
```

1. **Files land in `Dump/`** → Kendall reads the content, generates a local embedding, and asks an AI to pick the right destination folder → file is moved automatically.
2. **All indexed files** live in a local SQLite database with their content and vector embeddings, ready to be searched.
3. **Chat** uses cosine similarity over those embeddings to find relevant documents, then passes context to the AI to synthesise an answer.
4. **Work** lets you cherry-pick files into a project and generate a polished document from them.
5. **Telegram Bot** connects to the same database as the desktop app — projects, files, chats, and settings stay in sync.

---

## Download

### Latest Release

Download the latest `.dmg` from the [Releases page](https://github.com/moeezs/kendall/releases).

1. Download the `.dmg` file
2. Open it and drag **Kendall** to your **Applications** folder
3. Launch Kendall from Applications

On first launch, the **onboarding wizard** will guide you through:

1. **Choosing your Kendall home directory** (default: `~/Desktop/kendall`)
2. **Setting up AI** — Google Gemini (API key) or Ollama (local, no API key)
3. **Configuring Telegram bot** (optional — can skip and set up later)
4. Done — Kendall creates the folder structure and starts watching your Dump folder

### Build from Source

**Prerequisites:** Node.js, Rust, and the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for macOS.

```bash
# Clone and install
git clone https://github.com/moeezs/kendall.git
cd kendall
npm install

# Run in development
npm run tauri dev

# Build for production
npm run tauri build
```

> **Note:** The `.env` file is no longer required — all settings are configured through the onboarding wizard or the Settings tab in the app.

### Telegram Bot

Start the bot directly from the **Work** tab in the desktop app using the **Bot** toggle.

Alternatively, run it separately:

```bash
cd server
npm install

# Copy the example env (optional if running from the app — settings sync from DB)
cp .env.example .env
# Fill in server/.env (see below)

npm start
```

**Environment variables** (in `server/.env` or set via app Settings):

| Variable                   | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`       | Token from @BotFather on Telegram                                  |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID — only this user can talk to the bot |
| `GEMINI_API_KEY`           | Your Google AI key (only needed if using Gemini)                   |
| `KENDALL_APP_ID`           | (Optional) Tauri app ID used to locate the DB file                 |
| `DB_PATH`                  | (Optional) Full path to `kendall.db` — overrides auto-detection    |

The bot uses long polling. No webhooks, no ngrok, no port forwarding needed.

---

## Auto-Sort (Dump Folder)

Drop any file into `~/Desktop/kendall/Dump/` and Kendall handles the rest.

**What happens:**

1. The file watcher detects the new file.
2. Kendall extracts the text content (PDF, DOCX, image OCR, plain text).
3. A local AI embedding is generated using `Xenova/all-MiniLM-L6-v2` (runs entirely in-process, no network call).
4. The file record and embedding are saved to the local SQLite database.
5. Gemini (or Ollama) picks the best destination from your existing folders — in batches for efficiency.
6. The file is moved to the correct folder. A log entry appears on the Home tab.

Files that don't clearly fit any folder go to `Misc/`. You can create new folders from the Home tab and they immediately become valid sorting targets.

---

## Chat — Ask Your Files

The **Chat** tab is a full RAG (Retrieval-Augmented Generation) interface against all indexed files on your system.

**How it works:**

- Your query is turned into a vector embedding using the same local model.
- Cosine similarity is computed against every indexed file's stored embedding.
- The top matching files (score > 0.25) are injected as context.
- Gemini (or Ollama) generates a grounded answer citing only the files it actually used.
- **Sources are shown below each response** — click any source chip to reveal the file in Finder.

**Conversation memory:** The last 10 messages are included as chat history, so you can ask follow-up questions naturally. All chat history is persisted in SQLite and loads back when you reopen a conversation.

---

## Work — Projects & Document Generation

The **Work** tab is for structured, document-based workflows.

### Projects

- Create a named project — a matching folder is created at `~/Desktop/kendall/Projects/<name>/`.
- Link any indexed file to the project from the file picker.
- Remove files from the project at any time.

### Document Generation

With files linked, describe what you want:

> _"Write a comprehensive proposal based on the linked research"_
> _"Create an executive summary from these quarterly reports"_
> _"Draft a technical spec that covers all my notes"_

The AI reads every linked file's content, reasons over it, and produces a full structured document. Agent steps are shown live as it works.

### Revisions

Once a document is generated, ask for changes:

> _"Make the introduction shorter"_
> _"Add a budget section at the end"_
> _"Change the tone to be more formal"_

### Export

- **PDF** — exported and saved to the project folder (or sent as a file via Telegram).
- **DOCX** — proper Word document with headings and formatting.

---

## Telegram Bot

The bot gives you full Kendall functionality from your phone. It connects directly to the same SQLite database as the desktop app — no separate storage.

### Getting Started

1. Open the Kendall desktop app → **Work** tab → toggle **Bot** on.
2. Find your bot on Telegram (the one you configured with `TELEGRAM_BOT_TOKEN`).
3. Send `/start`.

### How It Works

Kendall is an **autonomous agent**. You don't need to memorize commands — just say what you want in plain language and it will plan and execute the full workflow, chaining multiple actions automatically.

> _"Create a project called Q4 Report, find and link all my financial documents, then draft an executive summary"_

Kendall will create the project, search for relevant files, link them, and generate the document — all from one message.

### Commands

| Command  | What it does                             |
| -------- | ---------------------------------------- |
| `/start` | Begin a conversation                     |
| `/reset` | Clear conversation history for your chat |

Everything else is natural language.

### Natural Language Examples

**Project management**

```
"Create a new project called Marketing Pitch"
"What projects do I have?"
"Switch to the Client Proposal project"
"Delete the old test project"
```

**File linking**

```
"Link the annual report to this project"
"What files are in the project?"
"Add anything related to Q3 finance"
"Remove the draft document"
```

**Document generation & revision**

```
"Write a proposal based on our research files"
"Create a comprehensive report about Q3 performance"
"Make the introduction shorter"
"Add a budget section"
"Change the tone to be more formal"
```

**Export**

```
"Send me the PDF"
"Export this as a Word document"
```

**Asking questions**

```
"What does the annual report say about revenue?"
"Summarize my research notes"
"What files do I have about marketing?"
```

**Multi-step workflows**

```
"Set up a new project with my research files and write me a comprehensive analysis"
"Switch to the Marketing project, add the brand guidelines, and revise the proposal to be more formal"
"I need a PDF of that report, and also start a fresh conversation after"
```

### Security

Only the Telegram user ID set in `TELEGRAM_ALLOWED_USER_ID` can interact with the bot. All other users receive no response.

---

## Settings — AI Providers & Models

Each Kendall feature has its own **independent** AI provider and model configuration. You can run Chat on Gemini Pro while Auto-Sort uses a lightweight local Ollama model, for example.

### Features

| Feature          | What it controls                               |
| ---------------- | ---------------------------------------------- |
| **Autosorting**  | Model used to categorise files dropped in Dump |
| **Chat**         | Model used to answer questions in the Chat tab |
| **Work**         | Model used to generate and revise documents    |
| **Telegram Bot** | Model used by the bot agent                    |

### Providers

**Google Gemini** (cloud)

- Requires a Gemini API key.
- Available models: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`, and more.

**Ollama** (local, no API key)

- Runs models on your own machine. No data leaves your system.
- Supports any model installed in Ollama: `llama3.3`, `mistral`, `gemma3`, `qwen2.5`, `deepseek-r1`, and others.
- Configure the Ollama URL (default: `http://localhost:11434`).
- Available models are fetched live from your running Ollama instance.

Settings changes take effect immediately and sync to the Telegram bot in real-time without a restart.

---

## Database (DB Tab)

The **DB** tab shows every file Kendall has indexed — path, filename, and when it was added. This is a read-only view of the local SQLite database (`kendall.db`), stored in the standard Tauri app data directory.

---

## Supported File Types

| Type                            | How it's parsed                                                           |
| ------------------------------- | ------------------------------------------------------------------------- |
| PDF                             | `pdfjs-dist` — full text extraction with layout-aware line reconstruction |
| DOCX                            | `mammoth` — structured Word document parsing                              |
| Images (PNG, JPG, JPEG)         | `tesseract.js` — OCR runs locally in-process                              |
| Plain text (TXT, MD, CSV, etc.) | Direct read                                                               |

---

## Tech Stack

| Layer           | Technology                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| Desktop shell   | [Tauri v2](https://tauri.app) (Rust)                                        |
| Frontend        | React 19, TypeScript, Vite, Tailwind CSS v4                                 |
| Local database  | SQLite via `@tauri-apps/plugin-sql`                                         |
| Embeddings      | `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` (runs in-process) |
| AI (cloud)      | Google Gemini (`@google/generative-ai`)                                     |
| AI (local)      | Ollama (HTTP API)                                                           |
| PDF parsing     | `pdfjs-dist`                                                                |
| DOCX parsing    | `mammoth`                                                                   |
| OCR             | `tesseract.js`                                                              |
| Document export | `jsPDF`, `docx`                                                             |
| Telegram bot    | `telegraf`, Node.js, long polling                                           |
| File watching   | `@tauri-apps/plugin-fs` `watch()`                                           |
