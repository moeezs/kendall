# How Kendall Works — Full Technical Breakdown

This document covers every part of the Kendall codebase: what each file does, every function, every AI prompt, and every flow from start to finish.

---

## Table of Contents

1. [What Kendall Is](#1-what-kendall-is)
2. [Project Structure](#2-project-structure)
3. [The Database](#3-the-database)
4. [The Embedding Pipeline (Local AI)](#4-the-embedding-pipeline-local-ai)
5. [The File Parser](#5-the-file-parser)
6. [Feature 1 — Auto-Sort (Dump Folder)](#6-feature-1--auto-sort-dump-folder)
7. [Feature 2 — RAG Chat](#7-feature-2--rag-chat)
8. [Feature 3 — Work (Projects + Document Generation)](#8-feature-3--work-projects--document-generation)
9. [Feature 4 — Telegram Bot](#9-feature-4--telegram-bot)
10. [Feature 5 — DB Viewer](#10-feature-5--db-viewer)
11. [Feature 6 — Settings](#11-feature-6--settings)
12. [The LLM Abstraction Layer (Server)](#12-the-llm-abstraction-layer-server)
13. [Every AI Prompt, Explained](#13-every-ai-prompt-explained)
14. [Full Flow Diagrams](#14-full-flow-diagrams)

---

## 1. What Kendall Is

Kendall is a **local-first personal AI OS**. It runs as a desktop app (built with Tauri + React) and optionally exposes a Telegram bot as a companion. Everything it indexes stays on your machine — no cloud database, no telemetry.

The two main AI providers supported are:
- **Google Gemini** (cloud, via API key)
- **Ollama** (fully local, self-hosted models like llama3.1)

You pick one globally and can override per-feature in Settings.

---

## 2. Project Structure

```
src/                    ← React frontend (runs inside Tauri)
  App.tsx               ← Root component, file watcher, batch sorter
  components/
    home.tsx            ← Home tab: folder grid + activity log
    chat.tsx            ← Chat tab: RAG chat UI
    work.tsx            ← Work tab: projects, document generation
    db.tsx              ← DB tab: view indexed files and chats
    settings.tsx        ← Settings tab: AI provider/model config
    ui/navbar.tsx       ← Navigation bar
  services/
    ai.ts               ← Local embedding model (HuggingFace)
    database.ts         ← All SQLite queries (Tauri side)
    parser.ts           ← File text extraction (PDF, DOCX, images, text)
    rag.ts              ← RAG search + Gemini chat + document generation

server/
  index.js              ← Telegram bot + HTTP API server
```

The Tauri app and the Node.js server share the **same SQLite database file** on disk. The server uses WAL mode so both can access it at the same time without conflicts.

---

## 3. The Database

**File:** `src/services/database.ts` (Tauri side) and `server/index.js` (server side)

The database lives at `~/Library/Application Support/<app-id>/kendall.db` on macOS.

### Tables

#### `files`
Stores every indexed file.

| Column | Type | What it is |
|---|---|---|
| `id` | INTEGER | Auto-increment primary key |
| `path` | TEXT | Full file path on disk (unique) |
| `filename` | TEXT | Just the filename (e.g. `report.pdf`) |
| `content` | TEXT | The full extracted text content |
| `embedding` | TEXT | JSON array of 384 floats (the semantic vector) |
| `created_at` | DATETIME | When it was indexed |

#### `chats`
One row per conversation.

| Column | Type | What it is |
|---|---|---|
| `id` | TEXT | UUID or `"telegram-bot"` |
| `title` | TEXT | Human-readable name |
| `created_at` | DATETIME | When created |

#### `messages`
Every message in every chat.

| Column | Type | What it is |
|---|---|---|
| `id` | INTEGER | Auto-increment |
| `chat_id` | TEXT | Foreign key → chats |
| `role` | TEXT | `"user"` or `"ai"` |
| `content` | TEXT | Message text |
| `sources` | TEXT | JSON array of file paths cited |
| `created_at` | DATETIME | Timestamp |

#### `projects`
Work projects.

| Column | Type | What it is |
|---|---|---|
| `id` | TEXT | UUID |
| `name` | TEXT | Project name |
| `description` | TEXT | Optional description |
| `created_at` | DATETIME | When created |

#### `project_files`
Many-to-many link between projects and files.

| Column | Type | What it is |
|---|---|---|
| `project_id` | TEXT | Foreign key → projects |
| `file_id` | INTEGER | Foreign key → files |

#### `settings` (server only)
Key-value store for bot settings.

| Column | Type | What it is |
|---|---|---|
| `key` | TEXT | Setting name |
| `value` | TEXT | Setting value |

### Key Database Functions (Tauri)

| Function | What it does |
|---|---|
| `getDb()` | Returns the singleton DB connection, initializing tables on first call |
| `initDb()` | Creates all tables if they don't exist, runs schema migrations |
| `saveFileRecord(path, filename, content, embedding)` | Inserts or updates a file row. If the path already exists, it overwrites content + embedding |
| `getFileRecord(path)` | Fetches a single file row by path |
| `getAllFiles()` | Returns all files that have an embedding (excludes unprocessed files) |
| `getAllFilesMetadata()` | Like `getAllFiles` but only returns id, path, filename, content_length — no heavy content/embedding columns |
| `deleteFileRecord(id)` | Deletes a file by id |
| `createChat(id, title)` | Creates a new chat row |
| `addMessage(chatId, role, content, sources?)` | Appends a message to a chat. Sources are serialized as JSON |
| `getChats()` | All chats, newest first |
| `getMessages(chatId)` | All messages for a chat, in order. Parses sources back to array |
| `deleteChat(chatId)` | Deletes a chat and all its messages (cascade) |
| `createProject(id, name, description)` | Creates a project row |
| `getProjects()` | All projects, newest first |
| `updateProject(id, name, description)` | Updates project name/description |
| `deleteProject(id)` | Deletes project and its file links (cascade) |
| `getProjectFiles(projectId)` | Returns metadata of all files linked to a project |
| `getProjectFileContents(projectId)` | Like above but includes full `content` field |
| `addProjectFile(projectId, fileId)` | Links a file to a project (INSERT OR IGNORE so duplicates are safe) |
| `removeProjectFile(projectId, fileId)` | Unlinks a file from a project |

---

## 4. The Embedding Pipeline (Local AI)

**File:** `src/services/ai.ts`

This is the local semantic understanding layer. It converts any piece of text into a list of 384 numbers called a **vector** (or embedding). Texts that are similar in meaning end up with similar vectors.

### Model

**`Xenova/all-MiniLM-L6-v2`** — a small but capable sentence embedding model that runs entirely in the browser via HuggingFace Transformers.js. No GPU or internet needed. Downloads once and is cached.

### Functions

#### `getEmbeddingModel()`
```
Returns: FeatureExtractionPipeline
```
Singleton — loads the model once on first call. Subsequent calls return the already-loaded model immediately.

#### `generateEmbedding(text)`
```
Input:  text string
Output: number[] (384 floats)
```
1. Calls `getEmbeddingModel()` to ensure the model is ready
2. Runs the text through the model with `pooling: "mean"` (averages all token vectors into one) and `normalize: true` (scales the vector to length 1)
3. Returns a plain JavaScript number array from the Float32 output

**The server has a parallel implementation** in `server/index.js` using the same HuggingFace pipeline but running in Node.js instead of the browser.

---

## 5. The File Parser

**File:** `src/services/parser.ts`

Extracts plain text from any supported file. This is what feeds the embedding pipeline.

### Supported File Types

| Extension | How it's extracted |
|---|---|
| `.txt`, `.md` | Tauri's `readTextFile` — direct read |
| `.pdf` | `pdfjs-dist` — renders each page and reconstructs text from positioned text items, respecting line breaks |
| `.docx` | `mammoth` — strips Word markup and returns raw text |
| `.png`, `.jpg`, `.jpeg` | `Tesseract.js` — OCR (optical character recognition), reads text from images |

### Functions

#### `readFileWithRetry(filePath, attempts=8, delayMs=300)`
Tries to read a file up to 8 times with 300ms between attempts. Needed because file system events sometimes fire before the file is fully written.

#### `cleanText(raw)`
Normalizes extracted text:
- Collapses multiple spaces within a line to one space
- Trims whitespace from each line
- Drops blank lines

#### `extractPdf(filePath)`
1. Reads the file as raw bytes with retry
2. Loads it with `pdfjs-dist` — uses a blob-based worker to be compatible with Tauri's WebKit
3. Iterates every page
4. For each page: streams text content items, detects new lines by checking if the Y coordinate (vertical position) changes by more than 2 points
5. Joins all pages with double newlines

#### `extractDocx(filePath)`
Reads the file as bytes, passes it to mammoth's `extractRawText`, returns the plain text.

#### `extractImage(filePath, ext)`
Reads the image bytes, creates a blob URL, passes it to Tesseract's `recognize` function in English mode, cleans up the URL.

#### `extractTextFromFile(filePath)` — the main export
Determines file type by extension and calls the right extractor. Returns the cleaned text string. Returns an empty string for unsupported types.

**The server has a parallel implementation** (`extractTextFromBuffer`) that works from a Buffer in memory instead of a file path — used when Telegram sends a file.

---

## 6. Feature 1 — Auto-Sort (Dump Folder)

**File:** `src/App.tsx`

This is the "magic" folder. You drop any file into `~/Desktop/kendall/Dump` and the app automatically:
1. Detects it
2. Reads it
3. Asks AI which folder it belongs in
4. Moves it there
5. Indexes it for search

### How the Watcher Works

On app startup, `App.tsx` runs a `useEffect` that:
1. Reads `~/Desktop/kendall/` to discover existing subfolders
2. Calls Tauri's `watch()` to listen for all file system events in the Dump folder

When a file change fires:
- Checks the event type — only acts on `create` and `modify/rename` (a rename into the folder)
- Skips hidden files (starting with `.`)
- Skips "rename out" events (file leaving the folder)
- Checks the file still exists (race condition guard)
- Uses a 3-second debounce per file path — if the same file triggers events rapidly, only processes it once

### Batch Processing

Files aren't processed one by one. They're queued in `pendingBatchRef` and processed together 3 seconds after the last file was added. This means if you drop 20 files at once, they go to Gemini in a single API call instead of 20 calls.

```
File dropped → extract text → push to pending batch
                              ↓
                        3 second timer resets
                              ↓ (after 3 seconds of quiet)
                        Send all pending files to categorizeBatch()
                              ↓
                        Move each file to its target folder
                              ↓
                        Generate embedding for each file
                              ↓
                        Save to SQLite
```

### `categorizeBatch()` in `src/services/rag.ts`

```
Input:  Array of { fileName, text } + list of available folder names
Output: Object mapping fileName → folder name
```

**The prompt sent to Gemini:**
```
You are an automated file sorter processing a batch of files.
Determine which folder each file belongs in based on its text preview.

Available Folders: [folder1, folder2, ...]

If a file doesn't clearly fit into any folder, map it to: Misc

Respond STRICTLY with a raw JSON object mapping the exact fileName to the target folder string.
Do NOT include markdown formatting like ```json. Just the raw JSON object.
Example: {"annual_report.pdf": "Work", "grocery_receipt.jpg": "Misc"}

Files to categorize:
[{ fileName: "...", textPreview: "first 1000 chars of content" }]
```

Gemini returns raw JSON. The app parses it and moves each file accordingly.

**Fallback:** If a file is mapped to `"Misc"` and there's no Misc folder, it just stays in Dump. If the target folder doesn't exist, the app creates it automatically and registers it in the UI.

After sorting, each file is embedded and saved to the database regardless of which folder it ends up in.

---

## 7. Feature 2 — RAG Chat

**Files:** `src/components/chat.tsx`, `src/services/rag.ts`

RAG stands for **Retrieval-Augmented Generation**. The idea: before asking the AI your question, find the most relevant files from your local database and inject their content into the prompt. The AI answers using your own data.

### Flow

```
User types question → handleAsk()
  ↓
Create or continue a chat in SQLite
  ↓
Save user message to DB
  ↓
Call askKendallOS(query, chatHistory)
  ↓
  1. generateEmbedding(query) — turn the question into a vector
  2. searchContext(query, topK=3) — find the 3 most similar files
  3. Filter: only keep files with similarity score > 0.25
  4. Build context block from matching files (first 1500 chars each)
  5. Start Gemini chat session with full conversation history (last 10 msgs)
  6. Send: context block + user question to Gemini
  7. Parse USED_SOURCES from response
  8. Return { answer, contextFiles }
  ↓
Display response + clickable source file chips
Save AI message + sources to DB
```

### `searchContext(query, topK=3)` in `src/services/rag.ts`

```
Input:  query string, topK number
Output: Array of file rows, sorted by similarity score, highest first
```

1. Embeds the query with `generateEmbedding(query)`
2. Loads all files with embeddings from SQLite
3. For each file, parses the stored embedding JSON and computes cosine similarity vs the query vector
4. Sorts by score descending
5. Returns the top K files

### Cosine Similarity

How it measures "how similar" two vectors are. The formula:

$$\text{similarity} = \frac{\vec{A} \cdot \vec{B}}{|\vec{A}||\vec{B}|}$$

Score range: -1 to 1. Threshold is **0.25** — below that, the file is considered not relevant enough to include.

### The System Prompt for Chat

```
You are Kendall OS, a concise and friendly personal AI assistant with access to
{N} indexed local files from the user's system.

Rules:
- Be brief and conversational. Avoid long essays or bullet-point dumps.
- When asked about the user's data, use the file context provided in the message to answer accurately.
- If the provided context is NOT relevant to the question, do NOT cite it. Just answer naturally or say you couldn't find it.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly this line (no exceptions):
  USED_SOURCES: <comma-separated filenames you cited> or USED_SOURCES: NONE
```

### Source Parsing

The model always appends `USED_SOURCES: filename1.pdf, filename2.docx` (or `USED_SOURCES: NONE`) at the end of its response. The app:
1. Regex matches this line
2. Strips it from the visible reply
3. Cross-references the filenames against the retrieved context files
4. Surfaces only the files the model actually used as clickable chips (clicking opens the file in Finder)

### Multi-turn History

The last 10 messages from the current chat are passed to Gemini's `startChat({ history })`. This means follow-up questions work naturally — the model remembers what was said earlier in the conversation.

---

## 8. Feature 3 — Work (Projects + Document Generation)

**Files:** `src/components/work.tsx`, `src/services/rag.ts`

### Projects

Projects are named containers that link together a set of indexed files. They have a corresponding folder on disk at `~/Desktop/kendall/Projects/<name>/`.

#### CRUD operations

| Action | What happens |
|---|---|
| Create | Generates a UUID, inserts into `projects` table, creates the folder on disk |
| Delete | Removes from DB (cascade deletes project_files links), removes the folder from disk |
| Select | Sets the active project in UI state |
| Link file | Opens a file picker showing all indexed files. Clicking toggles the `project_files` link |
| Unlink file | Removes the link row from `project_files` |

### Agentic Document Generation

When you type a prompt and click Generate, `generateDocument()` in `src/services/rag.ts` runs a 5-phase pipeline:

#### Phase 1: Research

```
- Collects full content of all files linked to the project
- Runs searchContext(prompt, 5) to find semantically related files from the broader index (even if not explicitly linked)
- Filters RAG results to score > 0.25 and not already in project files
- Merges everything into one big context string
```

#### Phase 2: Planning

Sends this prompt to Gemini (`gemini-2.5-flash-lite`):

**System:**
```
You are a document architect. Given a request and source material, create a structured outline for the document.

Reply with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"title": "Document Title", "sections": [{"heading": "Section Heading", "brief": "2-3 sentence description of what this section should cover and what information to include"}]}

Create between 3 and 8 sections depending on the complexity of the request. Each section brief should be specific and actionable.
```

**User message:**
```
Project: {projectName}
User's request: {prompt}

Available source files:
{list of filenames with sizes}

Create a document outline that best addresses the user's request.
```

Returns a JSON outline object. If parsing fails, falls back to a simple 3-section structure (Overview, Details, Conclusion).

#### Phase 3: Writing

For each section in the outline, sends a separate prompt to Gemini:

**System:**
```
You are a professional document writer. Write the requested section of a document.

Rules:
- Write in clear, professional prose.
- Do NOT use markdown formatting (no #, **, *, etc.). Use plain text only.
- Write substantively — each section should be 2-6 detailed paragraphs.
- Use specific information from the provided source files when relevant.
- Output ONLY the section body text. Do NOT repeat the section heading.
```

**User message:**
```
Document title: "{title}"

Section: "{heading}"
Brief: {brief}

Source material:
{first 10,000 chars of combined project context}

Previously written:
{summaries of already-written sections, so writing stays coherent}

Write this section now.
```

Sections are written sequentially (not in parallel) so each one can reference what came before.

#### Phase 4: Assemble

Combines: `Title\n\nSection Heading\n\nSection Body\n\n\n` for all sections into one document string.

#### Phase 5: Refine

Sends the full assembled draft for a final polish pass:

**System:**
```
You are a document editor. Polish and refine the given document draft.

Rules:
- Fix inconsistencies, awkward phrasing, and factual errors.
- Improve transitions and flow between sections.
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Keep the exact same structure. Do NOT add or remove sections.
- Output the complete refined document.
```

**User message:**
```
Review and polish this document draft. Preserve the structure exactly.

{full draft}
```

If this step fails, the unrefined draft is returned instead.

### Document Revision

`reviseDocument()` sends a simpler single prompt:

**System:**
```
You are a precise document revision specialist. Make ONLY the changes requested. Preserve everything else.

Rules:
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Output the complete revised document (not just the changed parts).
```

**User message:**
```
Project: {projectName}

Revision instructions: {what to change}

Source files:
{first 6000 chars of project files}

Current document:
---
{existing document text}
---

Apply the revisions. Return the complete revised document.
```

### Export

- **PDF**: Uses `jsPDF` in the browser to lay out title + body text with pagination
- **DOCX**: Uses `docx` library to build a Word document with proper heading and paragraph elements

---

## 9. Feature 4 — Telegram Bot

**File:** `server/index.js`

The Telegram bot is a separate Node.js process that you start from the Work tab. It connects to the same SQLite database as the desktop app.

### Security

Every incoming message is checked against `TELEGRAM_ALLOWED_USER_ID` (from `.env`). Any message from a different user ID is silently dropped before reaching any handler.

### Bot Architecture

The bot uses **function calling** (tool use). Instead of hardcoding commands into the message handler, it sends the user's plain text to Gemini with a list of tools defined. Gemini decides which tool to call based on what the user said. This means the bot understands natural language — "create a project called Research" and `/newproject Research` both work.

### The Bot System Prompt

```
You are Kendall, an autonomous AI assistant managing a personal knowledge base and document workspace.

You have access to {N} indexed local files and {M} projects.
Active project: {project name or "none"}
{linked files list}
{last generated document title or "no document"}

Memory:
{contents of ~/Desktop/kendall/Kendall/Memory/context.md}

Rules:
- Be concise. You're on Telegram — phone-readable responses only.
- Plain text only. No markdown, no asterisks, no # headers.
- Use the tools to take actions. Don't describe actions, just do them.
- For document tasks, always call the appropriate tool rather than writing the document inline.
- After a tool returns a result, give a SHORT confirmation. Don't repeat the tool result verbatim.
- Only call tools when the user's intent clearly matches. For simple questions or chat, just answer.
```

### Function Calling Loop

When the user sends a message:

1. The message + system prompt + conversation history → `llmChat()`
2. If Gemini returns a function call → `executeFunction(name, args, ctx)` runs the action
3. The function result is fed back to Gemini → `llmContinue()`
4. Repeat up to 12 times (to handle multi-step tasks like "create project → link file → generate doc")
5. When Gemini returns text (no more function calls), send it to the user

### Available Tools (Function Definitions)

| Tool | What it does |
|---|---|
| `list_projects` | Lists all projects (marks active one) |
| `create_project` | Creates a new project + directory |
| `delete_project` | Deletes project + directory |
| `select_project` | Sets the active project for the session |
| `list_project_files` | Shows files linked to active project |
| `link_file` | Semantic search across index, links matching files to active project |
| `unlink_file` | Removes a file from active project |
| `generate_document` | Runs the full 5-phase document generation pipeline |
| `revise_document` | Revises the last generated document |
| `export_pdf` | Generates and sends a PDF to Telegram |
| `export_docx` | Generates and sends a DOCX to Telegram |
| `start_new_chat` | Creates a new conversation in the DB |
| `show_active_status` | Reports current project + document state |
| `save_note` | Appends a note to the persistent memory file |
| `write_file` | Writes any content to a file + sends it to Telegram |
| `quick_generate` | Generates content (no project required) and sends as txt/pdf/docx |

### File Receiving

When you **send a document** to the bot:
1. Downloads the file from Telegram's CDN
2. Saves it to `~/Desktop/kendall/Kendall/Files/`
3. Extracts text (PDF/DOCX/text files)
4. Generates an embedding
5. Inserts into the `files` table (with path `telegram://<filename>`)
6. If there's an active project, auto-links the file to it
7. If you added a caption, treats it as an instruction and runs it through the function calling loop

When you **send a photo**:
1. Downloads the largest resolution
2. Saves locally
3. If Gemini is the active provider: encodes image as base64 and sends to Gemini's vision model
4. If Ollama: OCRs the image with a local model if one is available
5. Responds with what it sees / answers your caption question

### Persistent Memory

The bot has a memory file at `~/Desktop/kendall/Kendall/Memory/context.md`. When you say "remember that my deadline is Friday", it calls `save_note` which appends a timestamped entry to this file. On every subsequent message, the full memory file is injected into the system prompt so the bot always has context.

### Slash Commands

The bot also accepts traditional slash commands as an alternative to natural language:

| Command | What it does |
|---|---|
| `/start` | Welcome message |
| `/help` | Lists all commands |
| `/reset` | Clears current conversation history + session state |
| `/newchat` | Creates a new conversation in DB |
| `/history` | Lists all past Telegram conversations |
| `/loadchat <n>` | Switches to conversation #n from history list |
| `/projects` | Lists all projects |
| `/newproject <name>` | Creates a new project |
| `/deleteproject <name>` | Deletes a project |
| `/project <name>` | Selects a project (or shows active project if no name given) |
| `/files` | Lists files linked to active project |
| `/link <query>` | Links files matching query to active project |
| `/unlink <filename>` | Unlinks a file from active project |
| `/generate <prompt>` | Runs document generation (with live status updates) |
| `/revise <instructions>` | Revises the last generated document |
| `/pdf` | Exports and sends last document as PDF |
| `/docx` | Exports and sends last document as DOCX |

### HTTP Health/Settings API

The bot runs an HTTP server on port `3721` alongside the bot. The desktop app uses this to:
- `GET /health` — check if the bot is running
- `GET /settings` — fetch current settings from the DB
- `POST /settings` — save updated settings to the DB

This is how the Settings tab in the desktop app talks to the bot.

---

## 10. Feature 5 — DB Viewer

**File:** `src/components/db.tsx`

A read-only dashboard for inspecting what's in the database.

### Files Tab ("Embeddings")
- Calls `getAllFilesMetadata()` — loads all indexed files (no content/embedding columns for speed)
- Lets you filter by filename/path search and by parent folder
- Shows file icon based on extension (PDF, image, or generic article)
- Click the reveal icon to open the file in Finder
- Click the delete icon to call `deleteFileRecord(id)` and remove from DB
- Shows `content_length` (how many characters were extracted) next to each file

### Chats Tab
- Calls `getChats()` — all conversations, newest first
- Search by title
- Click "Open" to jump to that chat in the Chat tab (via `onOpenChat` callback → `setActiveChatId` in App)
- Click delete to call `deleteChat(chatId)` which removes chat + all its messages

---

## 11. Feature 6 — Settings

**File:** `src/components/settings.tsx`

The Settings tab talks to the bot's HTTP server at `http://127.0.0.1:3721/settings`.

### What You Can Configure

**Global provider**: `gemini` or `ollama` — used as the fallback for any feature that doesn't have a specific override.

**Per-feature provider overrides** (four features):
- Autosorting (classifying files into folders)
- Chat (RAG chat tab)
- Work (document generation)
- Telegram Bot

Each feature can independently use Gemini or Ollama with its own model.

**Gemini settings**: API key, model selection (from a hardcoded list of current Gemini models).

**Ollama settings**: Base URL (default `http://localhost:11434`), model selection. The Settings tab pings Ollama's `/api/tags` endpoint to discover which models you have installed locally and offers them as a dropdown.

### How Settings Are Stored

On the server side, all settings are in the `settings` SQLite table as key-value pairs. The `DEFAULT_SETTINGS` object in `server/index.js` defines all defaults. When the server starts, it seeds missing keys from defaults.

`getSetting(key)` → looks up from DB, falls back to DEFAULT_SETTINGS  
`setSetting(key, value)` → INSERT OR REPLACE into settings table  
`getAllSettings()` → merges DB rows over DEFAULT_SETTINGS (DB wins)

---

## 12. The LLM Abstraction Layer (Server)

**File:** `server/index.js`

The server has a unified interface so all AI calls work whether you're using Gemini or Ollama, without the callers needing to care.

### `resolveProvider(feature)`
Reads settings and returns `"gemini"` or `"ollama"` for the given feature. Checks per-feature override first, falls back to global provider.

### `resolveModel(feature)`
Same logic but returns the model name string (e.g. `"gemini-2.5-flash-lite"` or `"llama3.1"`).

### `callOllamaChat(messages, options)`
POSTs to Ollama's `/api/chat` endpoint with `stream: false`. Handles connection errors specifically to give a helpful "Ollama is not running" message.

### `callOllamaGenerate(prompt, systemPrompt, options)`
POSTs to Ollama's `/api/generate` endpoint. Used for simple generation without chat history.

### `geminiToolsToOllamaTools(geminiTools)`
Converts Gemini's function declaration format to Ollama's tool format. This is what allows the same tool definitions to work with either provider.

### `llmChat(systemPrompt, conversationHistory, userMessage, options)`
The main multi-turn chat function. 

- **Ollama path**: Builds a `messages` array with system role, history, and user message. If tools are provided, converts them. Detects tool calls in the response.
- **Gemini path**: Creates a `getGenerativeModel` with system instruction and tools, starts a chat session with history, sends the message.

Returns `{ text, functionCall, _geminiChat | _ollamaMessages }` — the last two are needed for `llmContinue`.

### `llmContinue(prevResult, functionName, functionResponse, options)`
Continues the conversation after a function call. Feeds the function result back to the model and gets the next response.

### `llmGenerate(systemPrompt, prompt, feature)`
Simple one-shot generation (no history, no tools). Used for document writing phases.

---

## 13. Every AI Prompt, Explained

### Auto-Sort (single file)
> Used when batch categorization fails or as a fallback
```
You are an automated file sorter.
Look at the following text extracted from a file, and determine which folder it belongs in.

Available Folders: {folders}

Reply with ONLY the exact name of the folder it belongs to. Do not add punctuation, explanations, or quotes.
If it does not clearly fit into any of the available folders, reply with exactly: Misc

File Text (Preview):
{first 1500 chars of file content}
```

### Auto-Sort (batch)
```
You are an automated file sorter processing a batch of files.
Determine which folder each file belongs in based on its text preview.

Available Folders: {folders}

If a file doesn't clearly fit into any folder, map it to: Misc

Respond STRICTLY with a raw JSON object mapping the exact fileName to the target folder string.
Do NOT include markdown formatting like ```json. Just the raw JSON object.

Files to categorize:
[{ fileName, textPreview }...]
```

### RAG Chat (Tauri app)
**System:**
```
You are Kendall OS, a concise and friendly personal AI assistant with access to {N} indexed local files.

Rules:
- Be brief and conversational. Avoid long essays or bullet-point dumps.
- When asked about the user's data, use the file context provided in the message to answer accurately.
- If the provided context is NOT relevant to the question, do NOT cite it. Just answer naturally or say you couldn't find it.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly this line (no exceptions):
  USED_SOURCES: <comma-separated filenames you cited> or USED_SOURCES: NONE
```
**User message:**
```
Context from my files:
[Source: filename.pdf]
{first 1500 chars of file content}

---

[Source: filename2.docx]
{first 1500 chars}

Question: {user's question}
```
(If no relevant context found, just sends the question directly)

### Telegram Bot (main conversation)
**System:**
```
You are Kendall, an autonomous AI assistant managing a personal knowledge base and document workspace.

You have access to {N} indexed local files and {M} projects.
Active project: {name or "none"}
{linked files list or "No files linked"}
{document status}

Memory:
{contents of memory/context.md}

Rules:
- Be concise. You're on Telegram — phone-readable responses only.
- Plain text only. No markdown, no asterisks, no # headers.
- Use the tools to take actions. Don't describe actions, just do them.
- For document tasks, always call the appropriate tool rather than writing the document inline.
- After a tool returns a result, give a SHORT confirmation.
- Only call tools when the user's intent clearly matches. For simple questions or chat, just answer.
```

### Document Planning Prompt
**System:**
```
You are a document architect. Given a request and source material, create a structured outline for the document.

Reply with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"title": "Document Title", "sections": [{"heading": "Section Heading", "brief": "2-3 sentence description..."}]}

Create between 3 and 8 sections depending on the complexity. Each section brief should be specific and actionable.
```

### Document Section Writing Prompt
**System:**
```
You are a professional document writer. Write the requested section of a document.

Rules:
- Write in clear, professional prose.
- Do NOT use markdown formatting (no #, **, *, etc.). Use plain text only.
- Write substantively — each section should be 2-6 detailed paragraphs.
- Use specific information from the provided source files when relevant.
- Output ONLY the section body text. Do NOT repeat the section heading.
```

### Document Refinement Prompt
**System:**
```
You are a document editor. Polish and refine the given document draft.

Rules:
- Fix inconsistencies, awkward phrasing, and factual errors.
- Improve transitions and flow between sections.
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Keep the exact same structure. Do NOT add or remove sections.
- Output the complete refined document.
```

### Document Revision Prompt
**System:**
```
You are a precise document revision specialist. Make ONLY the changes requested. Preserve everything else.

Rules:
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Output the complete revised document (not just the changed parts).
```

### Quick Generate (Bot, no project)
**System:**
```
You are a professional writer. Write the requested content with depth and quality.
Use plain text only — no markdown, no asterisks, no headers with #.
Write section headings on their own lines. Be comprehensive and thorough.
```

---

## 14. Full Flow Diagrams

### Auto-Sort Flow
```
Drop file into ~/Desktop/kendall/Dump
    ↓
Tauri file watcher detects event (create or rename-in)
    ↓
Debounce check — same file seen within 3 seconds? → skip
    ↓
extractTextFromFile(filePath)
  ├─ .txt/.md  → readTextFile
  ├─ .pdf      → pdfjs-dist page-by-page
  ├─ .docx     → mammoth
  └─ .png/.jpg → Tesseract OCR
    ↓
Push to pendingBatch[]
    ↓
Reset 3-second batch timer
    ↓  (3 seconds after last drop)
categorizeBatch(allPendingFiles, availableFolders)
  → Single Gemini API call → JSON mapping filename → folder
    ↓
For each file:
  ├─ Target folder exists? If not, create it + update UI
  ├─ Move file from Dump → target folder
  └─ Log action to System Watch Log
    ↓
generateEmbedding(extractedText)  ← local HuggingFace model
    ↓
saveFileRecord(finalPath, filename, content, embedding)
  → INSERT OR UPDATE in SQLite files table
    ↓
Log "Indexed {filename}" in green
```

### RAG Chat Flow
```
User types question → presses Enter → handleAsk()
    ↓
If no chatId: create new chat in SQLite (UUID, first 30 chars as title)
    ↓
addMessage(chatId, "user", query)
    ↓
Show typing indicator
    ↓
askKendallOS(query, last 5 messages)
    ↓
  generateEmbedding(query)         ← local model, in browser
    ↓
  searchContext(query, topK=3)
    ├─ Load all files with embeddings from SQLite
    ├─ Compute cosine similarity for each
    ├─ Sort by score
    └─ Return top 3 (filter score > 0.25 later)
    ↓
  Filter: relevantContexts = score > 0.25
    ↓
  Build contextBlock (source headers + first 1500 chars per file)
    ↓
  genAI.getGenerativeModel({ systemInstruction: "You are Kendall OS..." })
    ↓
  model.startChat({ history: last10Messages })
    ↓
  chat.sendMessage(contextBlock + "\n\nQuestion: " + query)
    ↓
  Parse USED_SOURCES from response
  Strip USED_SOURCES line from visible text
    ↓
  Return { answer, contextFiles }
    ↓
setMessages → renders response + source chips
addMessage(chatId, "ai", answer, contextFiles)
```

### Document Generation Flow
```
User selects project → types prompt → clicks Generate
    ↓
getProjectFileContents(projectId)  ← full content from SQLite
    ↓
generateDocument(prompt, projectName, fileContents, onStep)
    ↓
  PHASE 1: RESEARCH
    ├─ Build file overview list
    ├─ searchContext(prompt, 5) → find related files NOT in project
    └─ Merge into fullContext string
    ↓
  PHASE 2: PLANNING
    ├─ Send to Gemini: "Create a JSON outline for this document"
    ├─ Parse JSON → { title, sections: [{ heading, brief }] }
    └─ Fallback: hardcoded 3-section outline if parse fails
    ↓
  PHASE 3: WRITING  (sequential, one section at a time)
    ├─ For each section:
    │   ├─ Send to Gemini: "Write this section using source material + prior sections"
    │   └─ Append result to writtenSections[]
    └─ All sections done
    ↓
  PHASE 4: ASSEMBLE
    └─ Concatenate: title + section headings + bodies
    ↓
  PHASE 5: REFINE
    ├─ Send full draft to Gemini: "Polish and improve this document"
    └─ Return refined text (or unrefined if error)
    ↓
setGeneratedContent → renders in text area
    ↓
User can: Revise (re-runs single prompt) | Export PDF | Export DOCX
```

### Telegram Bot Message Flow
```
User sends message to Telegram bot
    ↓
Middlewate: check user ID === ALLOWED_USER_ID → block if not
    ↓
bot.on("text") handler
    ↓
saveMsgToCurrent("user", messageText)
    ↓
buildBotSystemPrompt()
  ├─ Count files and projects from DB
  ├─ List active project + linked files
  ├─ Load memory from context.md
  └─ Build system prompt string
    ↓
loadCurrentHistory(20)  ← last 20 turns from DB
    ↓
llmChat(systemPrompt, history, messageText, { tools: workTools })
  ↓ (Gemini or Ollama based on settings)
  ├─ If text response: send to Telegram, save to DB, done
  └─ If function call:
      ↓
      executeFunction(name, args, ctx)
        ├─ list_projects → query DB
        ├─ create_project → insert DB + mkdir
        ├─ generate_document → run 5-phase pipeline, send result
        ├─ export_pdf → generate buffer, send as document
        ├─ save_note → append to memory file
        └─ ... (all 14 tools)
      ↓
      llmContinue(prevResult, functionName, functionResult)
      ↓
      Loop up to 12 times (handles multi-step tasks)
      ↓
      Final text response → send to Telegram → save to DB
```

### File Indexing via Telegram
```
User sends a file to the bot
    ↓
downloadTelegramFile(ctx, fileId) → Buffer
    ↓
saveBotFile(filename, buffer)  ← saves to ~/Desktop/kendall/Kendall/Files/
    ↓
extractTextFromBuffer(buffer, filename)
  ├─ .pdf  → pdf-parse
  ├─ .docx → mammoth
  └─ text  → buffer.toString("utf-8")
    ↓
generateEmbedding(text.substring(0, 8000))
    ↓
indexFileIntoDb(filename, content, "telegram://" + filename)
  └─ INSERT OR UPDATE files table
    ↓
If activeProjectId: auto-link to project
    ↓
Reply with confirmation + text preview
    ↓
If caption: run caption through full function-calling message handler
```
