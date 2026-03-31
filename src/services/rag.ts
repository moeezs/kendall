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

  console.log("Searching local database for context...");
  const contexts = await searchContext(query, 3);
  
  // Filter out low scores so we don't include irrelevant sources
  const relevantContexts = contexts.filter(c => c.score > 0.25);
  
  const allFiles = await getAllFiles();
  const totalFiles = allFiles.length;
  
  // Format context snippets
  const contextText = relevantContexts.length > 0
    ? relevantContexts.map((c) => `[Source: ${c.filename}]\n${(c.content || '').substring(0, 1500)}...`).join("\n\n")
    : "No relevant documents found in index.";

  let historyText = "";
  if (chatHistory.length > 0) {
    historyText = "Previous Conversation History:\n" + chatHistory.map(msg => `${msg.role === 'user' ? 'User' : 'Kendall'}: ${msg.content}`).join("\n") + "\n\n";
  }

  const prompt = `You are Kendall OS, a helpful, conversational, and concise personal AI assistant. 
You are currently indexing and have access to ${totalFiles} local files from the user's system.

Guidelines:
- Act like a natural personal assistant. Keep responses brief, friendly, and conversational. Do not write long essays.
- If the user asks general questions about you or your system, answer naturally using the information provided above, or mention the past conversation in the context.
- When the user asks about their data, use the provided "Context" to answer. 
- Very Important: If the provided Context documents are NOT relevant to the user's query, do not hallucinate an answer based on them. Just answer naturally or say you couldn't find it in their files.

${historyText}Context from User's Files:
${contextText}

User: "${query}"`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

  console.log("Sending structured prompt to Gemini API...");
  try {
    const result = await model.generateContent(prompt);
    return {
      answer: result.response.text(),
      // Return the full paths so they can be opened in finder
      contextFiles: relevantContexts.map((c) => c.path)
    };
  } catch (err: any) {
    console.error("Gemini API Error:", err);
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
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
