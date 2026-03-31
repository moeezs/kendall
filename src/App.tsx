import "./App.css";
import { useEffect, useRef, useState } from "react";
import { watch, exists, readDir, rename, remove, mkdir } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { extractTextFromFile } from "./services/parser";
import { generateEmbedding } from "./services/ai";
import { saveFileRecord } from "./services/database";
import { askKendallOS, categorizeFile } from "./services/rag";

function App() {
  const [currentPath, setCurrentPath] = useState("Loading...");
  const recentFilesRef = useRef<Map<string, number>>(new Map());

  // Directory UI states
  const [activeFolders, setActiveFolders] = useState<string[]>([]);
  const [basePath, setBasePath] = useState("");

  const fetchFolders = async (kendallPath: string) => {
    try {
      const entries = await readDir(kendallPath); 
      const foldersOnly = entries
        .filter(entry => entry.isDirectory && entry.name !== "Dump" && !entry.name.startsWith("."))
        .map(entry => entry.name);
        
      setActiveFolders(foldersOnly);
    } catch (error) {
      console.error("Failed to read directories:", error);
    }
  };

  // Chat UI states
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; content: string; sources?: string[] }[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  const handleAsk = async () => {
    if (!query.trim()) return;

    const unsubmittedQuery = query;
    setMessages(prev => [...prev, { role: "user", content: unsubmittedQuery }]);
    setQuery("");
    setIsTyping(true);

    try {
      const response = await askKendallOS(unsubmittedQuery);
      setMessages(prev => [...prev, { 
        role: "ai", 
        content: response.answer,
        sources: response.contextFiles
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "ai", content: `❌ Error: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  useEffect(() => {
    let unwatchFn: () => void;

    // We store this mutable copy inside the effect so watcher can access latest folders
    let currentFolders: string[] = [];

    const startWatching = async () => {
      const desktop = await desktopDir();
      const kendallPath = await join(desktop, "kendall");
      const dumpPath = await join(kendallPath, "Dump");
      
      setBasePath(kendallPath);
      setCurrentPath(dumpPath); 
      
      // Fetch dynamic folders on startup
      try {
        const entries = await readDir(kendallPath); 
        const foldersOnly = entries
          .filter(entry => entry.isDirectory && entry.name !== "Dump" && !entry.name.startsWith("."))
          .map(entry => entry.name);
          
        setActiveFolders(foldersOnly);
        currentFolders = foldersOnly;
      } catch (error) {
        console.error("Failed to read directories:", error);
      }

      console.log("Starting watcher on:", dumpPath);
      
      // calls the callback whenever any changes are detected
      const unwatch = await watch(dumpPath, async (event) => {
        const targetPath = event.paths[event.paths.length - 1];
        if (!targetPath) return;

        const fileName = targetPath.split(/[/\\]/).pop() || "";
        
        // no hidden files, please
        if (fileName.startsWith('.')) return; 

        const eventType = event.type as any;
        const isCreate = !!eventType.create;
        const isRename = eventType.modify?.kind === "rename";

        if (!isCreate && !isRename) return;

        // ignore renames
        if (isRename && event.paths.length >= 2) {
          const sourcePath = event.paths[0];
          const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
          if (normalizePath(sourcePath).startsWith(normalizePath(dumpPath))) {
            return; 
          }
        }

        // check if it still exists there
        let fileExists = false;
        try {
          fileExists = await exists(targetPath);
        } catch {
          return;
        }
        if (!fileExists) return;

        const filePath = targetPath;
        
        const now = Date.now();
        const lastSeen = recentFilesRef.current.get(filePath) ?? 0;
        if (now - lastSeen < 3000) return;
        recentFilesRef.current.set(filePath, now);

        // Cleanup stale keys
        for (const [seenPath, timestamp] of recentFilesRef.current) {
          if (now - timestamp > 10000) {
            recentFilesRef.current.delete(seenPath);
          }
        }

        console.log("✅ NEW FILE: ", fileName);

        try {
          // Extract Text
          console.log("extracting text");
          const text = await extractTextFromFile(filePath);

          // Ask Gemini where it goes
          const targetFolderName = await categorizeFile(text, currentFolders);
          console.log(`🤖 Gemini says this belongs in: ${targetFolderName}`);

          // Move the physical file on the Mac
          let finalFilePath = filePath;
          if (targetFolderName && targetFolderName !== "Dump") {
            const folderPath = await join(kendallPath, targetFolderName);
            
            // Auto-create folder if Gemini hallucinated a new one or if 'Misc' doesn't exist
            const folderExists = await exists(folderPath);
            if (!folderExists) {
              await mkdir(folderPath);
              setActiveFolders(prev => [...prev, targetFolderName]);
              currentFolders.push(targetFolderName);
            }

            const newFilePath = await join(folderPath, fileName);
            await rename(filePath, newFilePath);
            finalFilePath = newFilePath;
            console.log(`Moved file to ${newFilePath}`);
          }

          console.log("vectorizing text");
          // Vectorize
          const vector = await generateEmbedding(text);
          
          console.log("✅ Processed:", finalFilePath.split('/').pop());
          
          // Save to DB
          console.log("saving to db...");
          await saveFileRecord(finalFilePath, fileName, text, Array.from(vector));
          console.log("✅ Saved to DB!");
        } catch (err) {
          const message = String(err);

          // Ignore move-out races and permission-scoped path checks.
          if (
            message.includes("No such file") ||
            message.includes("not found") ||
            message.includes("forbidden path")
          ) {
            return;
          }

          console.error("Processing error:", err);
        }
      });

      return unwatch;
    };

    startWatching().then((fn) => { unwatchFn = fn; });

    // Cleanup
    return () => { 
      if (unwatchFn) {
        try {
          unwatchFn();
        } catch (e) {
          console.warn("Unwatch err:", e);
        }
      } 
    };
  }, []);


  return (
    <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif", display: "flex", gap: "40px" }}>
      <div style={{ flex: 1 }}>
        <h2>Kendall</h2>
        <p style={{ color: "gray" }}>Your local, private agent.</p>
        
        <div style={{ marginTop: "30px" }}>
          <h3>Active Directories</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "15px", marginTop: "10px" }}>
            <p>Current Path: <br/><code>{currentPath}</code></p>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <div style={{ padding: "15px", border: "2px dashed #ccc", borderRadius: "8px" }}>
                📥 Dump (Auto-Sort)
              </div>
              {/* DYNAMIC FOLDERS RENDER HERE */}
              {activeFolders.map((folderName) => (
                <div key={folderName} style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
                  📁 {folderName}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, backgroundColor: "#f9fafb", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", border: "1px solid #e5e7eb", minHeight: "80vh" }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "15px", marginBottom: "20px", maxHeight: "60vh" }}>
          {messages.length === 0 && (
            <p style={{ color: "gray", textAlign: "center", marginTop: "auto", marginBottom: "auto" }}>
              Ask Kendall a question about your files...
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{ alignSelf: msg.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div style={{ 
                backgroundColor: msg.role === "user" ? "#007AFF" : "#e5e7eb", 
                color: msg.role === "user" ? "white" : "black",
                padding: "12px 16px", 
                borderRadius: "12px",
                borderBottomRightRadius: msg.role === "user" ? "2px" : "12px",
                borderBottomLeftRadius: msg.role === "ai" ? "2px" : "12px"
              }}>
                {msg.content}
              </div>
              {msg.sources && msg.sources.length > 0 && (
                <div style={{ fontSize: "11px", color: "gray", marginTop: "4px", paddingLeft: "4px" }}>
                  Sources: {msg.sources.join(", ")}
                </div>
              )}
            </div>
          ))}
          {isTyping && (
            <div style={{ alignSelf: "flex-start", color: "gray", fontSize: "13px" }}>
              Kendall is thinking...
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "auto" }}>
          <input 
            type="text" 
            placeholder="Ask Kendall..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            style={{ flex: 1, padding: "12px", borderRadius: "8px", border: "1px solid #ccc", fontSize: "15px" }}
          />
          <button 
            onClick={handleAsk}
            disabled={isTyping}
            style={{ padding: "0 20px", borderRadius: "8px", border: "none", backgroundColor: "#007AFF", color: "white", cursor: "pointer" }}
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;