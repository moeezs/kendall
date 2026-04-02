import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateEmbedding } from "./ai";
import { getAllFiles } from "./database";
import { getProviderAndModel } from "./settings";
import { ollamaGenerate, ollamaChat, isOllamaRunning } from "./ollama";

// Cosine similarity function
function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// search
export async function searchContext(query: string, topK: number = 3) {
  // Turn the query into a vector using the local model
  const queryVector = await generateEmbedding(query);
  
  // Get all indexed files from our local SQLite Database
  const allFiles = await getAllFiles();
  
  const scoredFiles = allFiles.map((file) => {
    let embedding: number[] = [];
    try {
      if (typeof file.embedding === "string") {
        embedding = JSON.parse(file.embedding);
      }
    } catch (e) {
      console.error("Failed to parse embedding for file:", file.filename);
    }
    
    let score = -1;
    if (embedding && embedding.length > 0) {
      // Calculate how mathematically similar the query is to the document
      score = cosineSimilarity(queryVector, embedding);
    }
    
    return { ...file, score };
  });

  // Sort by highest similarity first
  scoredFiles.sort((a, b) => b.score - a.score);
  
  // Return only the top few matching files
  return scoredFiles.slice(0, topK);
}

// generation
export async function askKendallOS(query: string, chatHistory: {role: string, content: string}[] = []) {
  const { provider, model: modelName } = await getProviderAndModel("chat");

  console.log("[rag] Searching local database for context...");
  const contexts = await searchContext(query, 3);
  const relevantContexts = contexts.filter(c => c.score > 0.25);
  console.log("[rag] Results:", contexts.map(c => `${c.filename} (${c.score.toFixed(3)})`));

  const allFiles = await getAllFiles();

  // Build RAG context block — only injected when relevant files exist
  const contextBlock = relevantContexts.length > 0
    ? relevantContexts
        .map(c => `[Source: ${c.filename}]\n${(c.content || '').substring(0, 1500)}`)
        .join("\n\n---\n\n")
    : null;

  const systemPrompt = `You are Kendall OS, a concise and friendly personal AI assistant with access to ${allFiles.length} indexed local files from the user's system.

Rules:
- Be brief and conversational. Avoid long essays or bullet-point dumps.
- When asked about the user's data, use the file context provided in the message to answer accurately.
- If the provided context is NOT relevant to the question, do NOT cite it. Just answer naturally or say you couldn't find it.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly this line (no exceptions): USED_SOURCES: <comma-separated filenames you cited> or USED_SOURCES: NONE`;

  // Inject RAG context into the user's message (not the system prompt)
  const userMessage = contextBlock
    ? `Context from my files:\n${contextBlock}\n\nQuestion: ${query}`
    : query;

  let responseText: string;

  if (provider === "ollama") {
    console.log(`[rag] Sending to Ollama (${modelName}) via chat...`);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];
    for (const msg of chatHistory.slice(-10)) {
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      });
    }
    messages.push({ role: "user", content: userMessage });

    responseText = await ollamaChat(modelName, messages);
  } else {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing Gemini API Key. Please add it to your .env file.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
    });

    const formattedHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    for (const msg of chatHistory.slice(-10)) {
      formattedHistory.push({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    }

    const chat = model.startChat({ history: formattedHistory });
    console.log("[rag] Sending to Gemini via chat.sendMessage...");
    const result = await chat.sendMessage(userMessage);
    responseText = result.response.text();
  }

  // Parse the USED_SOURCES line the model always emits
  let usedSources: string[] = [];
  const sourcesMatch = responseText.match(/USED_SOURCES:\s*(.+)/i);
  if (sourcesMatch) {
    const raw = sourcesMatch[1].trim();
    if (raw.toUpperCase() !== "NONE") {
      usedSources = raw.split(",").map(s => s.trim()).filter(Boolean);
    }
    responseText = responseText.replace(/\n?USED_SOURCES:\s*.+/i, "").trim();
  }

  const contextFiles = relevantContexts
    .filter(c => usedSources.some(s => c.filename.includes(s) || s.includes(c.filename)))
    .map(c => c.path);

  return { answer: responseText, contextFiles };
}

export async function categorizeFile(fileText: string, availableFolders: string[]) {
  const { provider, model: modelName } = await getProviderAndModel("autosort");

  try {
    const prompt = `
      You are an automated file sorter.
      Look at the following text extracted from a file, and determine which folder it belongs in.
      
      Available Folders: ${availableFolders.join(", ")}
      
      Reply with ONLY the exact name of the folder it belongs to. Do not add punctuation, explanations, or quotes.
      If it does not clearly fit into any of the available folders, reply with exactly: Misc
      
      File Text (Preview):
      ${fileText.substring(0, 1500)}
    `;

    if (provider === "ollama") {
      const result = await ollamaGenerate(modelName, prompt);
      return result.trim();
    } else {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) return "Misc";
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    }
  } catch (error) {
    console.error("Sorting error:", error);
    return "Random";
  }
}

// Batch Auto-Sort (Handles 15+ files in 1 API Call)
export async function categorizeBatch(files: { fileName: string, text: string }[], availableFolders: string[]): Promise<Record<string, string>> {
  if (files.length === 0) return {};

  const { provider, model: modelName } = await getProviderAndModel("autosort");

  try {
    const filePreviews = files.map(f => ({
      fileName: f.fileName,
      textPreview: f.text.substring(0, 1000)
    }));

    const prompt = `
      You are an automated file sorter processing a batch of files.
      Determine which folder each file belongs in based on its text preview.
      
      Available Folders: ${availableFolders.join(", ")}
      
      If a file doesn't clearly fit into any folder, map it to: Misc
      
      Respond STRICTLY with a raw JSON object mapping the exact fileName to the target folder string. 
      Do NOT include markdown formatting like \`\`\`json. Just the raw JSON object.
      Example: {"annual_report.pdf": "Work", "grocery_receipt.jpg": "Misc"}

      Files to categorize:
      ${JSON.stringify(filePreviews, null, 2)}
    `;

    let responseText: string;

    if (provider === "ollama") {
      responseText = await ollamaGenerate(modelName, prompt);
    } else {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        return files.reduce((acc, f) => ({ ...acc, [f.fileName]: "Misc" }), {});
      }
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      responseText = result.response.text().trim();
    }

    // Clean up potential markdown formatting if the model slipped up
    if (responseText.startsWith("\`\`\`json")) {
      responseText = responseText.replace(/^\`\`\`json/, "").replace(/\`\`\`$/, "").trim();
    } else if (responseText.startsWith("\`\`\`")) {
      responseText = responseText.replace(/^\`\`\`/, "").replace(/\`\`\`$/, "").trim();
    }

    return JSON.parse(responseText);
  } catch (error) {
    console.error("Batch sorting error:", error);
    return files.reduce((acc, f) => ({ ...acc, [f.fileName]: "Misc" }), {});
  }
}

// ── Agentic Document Generation ──

export interface AgentStep {
  phase: "researching" | "planning" | "writing" | "refining" | "done" | "error";
  message: string;
  detail?: string;
}

export async function generateDocument(
  prompt: string,
  projectName: string,
  fileContents: { filename: string; content: string }[],
  onStep: (step: AgentStep) => void,
): Promise<string> {
  const { provider, model: modelName } = await getProviderAndModel("work");

  // Pre-flight: surface a clear error if Ollama is not running
  if (provider === "ollama") {
    const running = await isOllamaRunning();
    if (!running) {
      onStep({ phase: "error", message: "Ollama is not running. Please start Ollama and try again." });
      throw new Error("Ollama is not running. Please start Ollama and try again.");
    }
  }

  // Helper: generate text with the configured provider
  async function gen(userPrompt: string, system?: string): Promise<string> {
    if (provider === "ollama") {
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: userPrompt });
      return ollamaChat(modelName, messages);
    } else {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) throw new Error("Missing Gemini API Key.");
      const genAI = new GoogleGenerativeAI(apiKey);
      const opts: any = { model: modelName };
      if (system) opts.systemInstruction = system;
      const model = genAI.getGenerativeModel(opts);
      const result = await model.generateContent(userPrompt);
      return result.response.text().trim();
    }
  }

  // ── Phase 1: Research ──
  onStep({ phase: "researching", message: "Analyzing project files and searching for relevant context..." });

  const fileOverview = fileContents.map((f) => `- ${f.filename} (${f.content.length} chars)`).join("\n");
  const projectContext = fileContents
    .map((f) => `[${f.filename}]\n${f.content.substring(0, 4000)}`)
    .join("\n\n---\n\n");

  // RAG search for additional context beyond linked files
  const ragResults = await searchContext(prompt, 5);
  const extraFiles = ragResults
    .filter((r) => r.score > 0.25 && !fileContents.some((f) => f.filename === r.filename))
    .slice(0, 3);

  const extraContext = extraFiles
    .map((f) => `[${f.filename}]\n${(f.content || "").substring(0, 2000)}`)
    .join("\n\n---\n\n");

  onStep({
    phase: "researching",
    message: `Found ${fileContents.length} project file${fileContents.length !== 1 ? "s" : ""}${extraFiles.length > 0 ? ` + ${extraFiles.length} related indexed file${extraFiles.length !== 1 ? "s" : ""}` : ""}.`,
  });

  const fullContext = projectContext + (extraContext ? "\n\n---\n\n" + extraContext : "");

  // ── Phase 2: Planning ──
  onStep({ phase: "planning", message: "Creating document outline..." });

  let outline: { title: string; sections: { heading: string; brief: string }[] };

  if (provider === "ollama") {
    // Local models: use a dead-simple TITLE/SECTION format — no JSON required, fast to generate
    const simplePrompt = `Create a document outline.
Project: ${projectName}
Request: ${prompt}
${fileOverview ? `Files:\n${fileOverview}` : ""}

Reply ONLY with this exact format (no explanations, no numbering):
TITLE: <document title>
SECTION: <section heading>
SECTION: <section heading>
SECTION: <section heading>

Use 3 to 5 sections.`;

    console.log("[agent] Requesting outline from Ollama...");
    try {
      const planText = await ollamaChat(modelName, [{ role: "user", content: simplePrompt }], 60_000);
      console.log("[agent] Outline response received:", planText.substring(0, 200));
      const lines = planText.split("\n").map((l) => l.trim()).filter(Boolean);
      const titleLine = lines.find((l) => l.toUpperCase().startsWith("TITLE:"));
      const sectionLines = lines.filter((l) => l.toUpperCase().startsWith("SECTION:"));
      if (!titleLine || sectionLines.length === 0) throw new Error("Could not parse outline from response");
      outline = {
        title: titleLine.replace(/^title:\s*/i, "").trim() || projectName,
        sections: sectionLines.map((s) => ({
          heading: s.replace(/^section:\s*/i, "").trim(),
          brief: `Write content for this section based on: ${prompt}`,
        })),
      };
    } catch (err) {
      console.error("[agent] Outline generation failed, using fallback:", err);
      outline = {
        title: projectName,
        sections: [
          { heading: "Overview", brief: "High-level overview addressing the request." },
          { heading: "Details", brief: `Detailed response to: ${prompt}` },
          { heading: "Conclusion", brief: "Summary and closing remarks." },
        ],
      };
    }
  } else {
    const planSystem = `You are a document architect. Given a request and source material, create a structured outline for the document.

Reply with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"title": "Document Title", "sections": [{"heading": "Section Heading", "brief": "2-3 sentence description of what this section should cover and what information to include"}]}

Create between 3 and 8 sections depending on the complexity of the request. Each section brief should be specific and actionable.`;

    const planPrompt = `Project: ${projectName}
User's request: ${prompt}

Available source files:
${fileOverview || "(no project files linked)"}

Create a document outline that best addresses the user's request.`;

    try {
      let planText = await gen(planPrompt, planSystem);
      if (planText.includes("```")) {
        planText = planText.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
      }
      const jsonMatch = planText.match(/\{[\s\S]*\}/);
      if (jsonMatch) planText = jsonMatch[0];
      outline = JSON.parse(planText);
      if (!outline.title || !Array.isArray(outline.sections) || outline.sections.length === 0) {
        throw new Error("Invalid outline structure");
      }
    } catch (err) {
      console.error("[agent] Outline parse failed, using fallback:", err);
      outline = {
        title: projectName,
        sections: [
          { heading: "Overview", brief: "High-level overview addressing the request." },
          { heading: "Details", brief: `Detailed response to: ${prompt}` },
          { heading: "Conclusion", brief: "Summary and closing remarks." },
        ],
      };
    }
  }

  onStep({
    phase: "planning",
    message: `Outline ready: "${outline.title}" — ${outline.sections.length} sections`,
    detail: outline.sections.map((s, i) => `${i + 1}. ${s.heading}`).join("\n"),
  });

  // ── Phase 3: Writing (section by section) ──
  const writerSystem = `You are a professional document writer. Write the requested section of a document.

Rules:
- Write in clear, professional prose.
- Do NOT use markdown formatting (no #, **, *, etc.). Use plain text only.
- Write substantively — each section should be 2-6 detailed paragraphs.
- Use specific information from the provided source files when relevant.
- Maintain consistency with previously written sections.
- Output ONLY the section body text. Do NOT repeat the section heading — it is added automatically.`;

  const writtenSections: string[] = [];

  for (let i = 0; i < outline.sections.length; i++) {
    const section = outline.sections[i];
    onStep({
      phase: "writing",
      message: `Writing section ${i + 1}/${outline.sections.length}: "${section.heading}"...`,
    });

    let sectionText: string;
    try {
      if (provider === "ollama") {
        // Local models: compact prompt with a hard 2-minute per-section limit
        const contextSnippet = fullContext.substring(0, 2000);
        const ollamaSectionPrompt = `Write the "${section.heading}" section for a document titled "${outline.title}".${contextSnippet ? `\n\nContext:\n${contextSnippet}` : ""}\n\nWrite 2-4 paragraphs of professional prose. Plain text only, no markdown, do not repeat the heading.`;
        console.log(`[agent] Writing section ${i + 1} via Ollama...`);
        sectionText = await ollamaChat(modelName, [{ role: "user", content: ollamaSectionPrompt }], 120_000);
        console.log(`[agent] Section ${i + 1} done (${sectionText.length} chars)`);
      } else {
        const previousSummary =
          writtenSections.length > 0
            ? `\n\nPreviously written sections:\n${writtenSections.map((text, j) => `--- ${outline.sections[j].heading} ---\n${text.substring(0, 800)}`).join("\n\n")}`
            : "";
        const sectionPrompt = `Document title: "${outline.title}"

Section to write now: "${section.heading}"
Section brief: ${section.brief}

Source material (use this to inform your writing):
${fullContext.substring(0, 10000)}
${previousSummary}

Write this section now. Be thorough and substantive.`;
        sectionText = await gen(sectionPrompt, writerSystem);
      }
      writtenSections.push(sectionText || `[Section "${section.heading}" returned no content]`);
    } catch (err: any) {
      console.error(`[agent] Failed to write section "${section.heading}":`, err);
      writtenSections.push(`[This section could not be generated: ${err.message}]`);
    }
  }

  // ── Phase 4: Assemble draft ──
  let draft = outline.title + "\n\n";
  for (let i = 0; i < outline.sections.length; i++) {
    draft += outline.sections[i].heading + "\n\n" + writtenSections[i] + "\n\n\n";
  }

  // ── Phase 5: Refine ──
  if (provider === "ollama") {
    // Skip the expensive refine pass for local models — return the assembled draft as-is
    onStep({ phase: "refining", message: "Assembling final document..." });
  } else {
    onStep({ phase: "refining", message: "Reviewing and polishing the complete document..." });

    const refineSystem = `You are a document editor. Polish and refine the given document draft.

Rules:
- Fix inconsistencies, awkward phrasing, and factual errors.
- Improve transitions and flow between sections.
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Keep the exact same structure (title + sections). Do NOT add or remove sections.
- Output the complete refined document.`;

    try {
      draft = await gen(
        `Review and polish this document draft. Preserve the structure exactly.\n\n${draft}`,
        refineSystem,
      );
    } catch (err) {
      console.error("[agent] Refining failed, using unrefined draft:", err);
    }
  }

  onStep({ phase: "done", message: "Document generation complete." });
  return draft;
}

// ── Agentic Document Revision ──

export async function reviseDocument(
  existingDocument: string,
  revisionInstructions: string,
  projectName: string,
  fileContents: { filename: string; content: string }[],
  onStep: (step: AgentStep) => void,
): Promise<string> {
  const { provider, model: modelName } = await getProviderAndModel("work");

  // Pre-flight: surface a clear error if Ollama is not running
  if (provider === "ollama") {
    const running = await isOllamaRunning();
    if (!running) {
      onStep({ phase: "error", message: "Ollama is not running. Please start Ollama and try again." });
      throw new Error("Ollama is not running. Please start Ollama and try again.");
    }
  }

  // ── Phase 1: Analyze ──
  onStep({ phase: "researching", message: "Analyzing revision instructions and existing document..." });

  const projectContext = fileContents
    .map((f) => `[${f.filename}]\n${f.content.substring(0, 3000)}`)
    .join("\n\n---\n\n");

  // ── Phase 2: Targeted revision ──
  onStep({ phase: "refining", message: "Applying targeted revisions to document..." });

  const reviseSystem = `You are a precise document revision specialist. You receive an existing document and specific revision instructions.

Rules:
- Make ONLY the changes requested. Preserve everything that isn't being changed.
- Do NOT rewrite sections that don't need revision — keep their wording as close to the original as possible.
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- If asked to add content, insert it in the most appropriate location.
- If asked to remove content, remove it cleanly without leaving gaps.
- If asked to change tone or style, apply it consistently throughout.
- Output the complete revised document (not just the changed parts).`;

  const revisionPromptText = `Project: ${projectName}

Revision instructions: ${revisionInstructions}
${fileContents.length > 0 ? `\nSource files for reference:\n${projectContext.substring(0, 6000)}\n\n` : ""}
Current document:
---
${existingDocument}
---

Apply the revision instructions above. Change only what is specified — preserve everything else exactly as written. Return the complete revised document.`;

  let revised = existingDocument;
  try {
    if (provider === "ollama") {
      revised = await ollamaChat(modelName, [
        { role: "system", content: reviseSystem },
        { role: "user", content: revisionPromptText },
      ]);
    } else {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) throw new Error("Missing Gemini API Key.");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: reviseSystem,
      });
      const result = await model.generateContent(revisionPromptText);
      revised = result.response.text().trim();
    }
  } catch (err: any) {
    console.error("[agent] Revision failed:", err);
    throw new Error(err.message || "Revision failed");
  }

  onStep({ phase: "done", message: "Revision complete." });
  return revised;
}
