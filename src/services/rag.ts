import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateEmbedding } from "./ai";
import { getAllFiles } from "./database";

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
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing Gemini API Key. Please add it to your .env file.");

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

  const genAI = new GoogleGenerativeAI(apiKey);

  // System instruction is passed separately — NOT as part of the conversation history.
  // This is the correct Gemini API pattern for setting a persistent persona.
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: `You are Kendall OS, a concise and friendly personal AI assistant with access to ${allFiles.length} indexed local files from the user's system.

Rules:
- Be brief and conversational. Avoid long essays or bullet-point dumps.
- When asked about the user's data, use the file context provided in the message to answer accurately.
- If the provided context is NOT relevant to the question, do NOT cite it. Just answer naturally or say you couldn't find it.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly this line (no exceptions): USED_SOURCES: <comma-separated filenames you cited> or USED_SOURCES: NONE`,
  });

  // Build proper Gemini history. Gemini expects alternating user/model turns.
  // Map "ai" role → "model" as Gemini requires, and only include complete pairs.
  const formattedHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  const historySlice = chatHistory.slice(-10); // last 10 messages for context window efficiency

  for (const msg of historySlice) {
    formattedHistory.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    });
  }

  // Start a proper multi-turn chat session with history
  const chat = model.startChat({ history: formattedHistory });

  // Inject RAG context into the user's message (not the system prompt)
  const userMessage = contextBlock
    ? `Context from my files:\n${contextBlock}\n\nQuestion: ${query}`
    : query;

  console.log("[rag] Sending to Gemini via chat.sendMessage...");
  try {
    const result = await chat.sendMessage(userMessage);
    let responseText = result.response.text();

    // Parse the USED_SOURCES line the model always emits
    let usedSources: string[] = [];
    const sourcesMatch = responseText.match(/USED_SOURCES:\s*(.+)/i);
    if (sourcesMatch) {
      const raw = sourcesMatch[1].trim();
      if (raw.toUpperCase() !== "NONE") {
        usedSources = raw.split(",").map(s => s.trim()).filter(Boolean);
      }
      // Strip it from the visible answer
      responseText = responseText.replace(/\n?USED_SOURCES:\s*.+/i, "").trim();
    }

    // Only surface paths for files the model explicitly cited
    const contextFiles = relevantContexts
      .filter(c => usedSources.some(s => c.filename.includes(s) || s.includes(c.filename)))
      .map(c => c.path);

    return { answer: responseText, contextFiles };
  } catch (err: any) {
    console.error("[rag] Gemini API Error:", err);
    throw new Error(err.message || "Failed to contact Gemini API");
  }
}

export async function categorizeFile(fileText: string, availableFolders: string[]) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) return "Misc";
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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }); 
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
    
  } catch (error) {
    console.error("Sorting error:", error);
    return "Random";
  }
}

// Batch Auto-Sort (Handles 15+ files in 1 API Call)
export async function categorizeBatch(files: { fileName: string, text: string }[], availableFolders: string[]): Promise<Record<string, string>> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    return files.reduce((acc, f) => ({ ...acc, [f.fileName]: "Misc" }), {});
  }
  
  if (files.length === 0) return {};

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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }); 
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
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
