import "./App.css";
import { useEffect, useRef, useState } from "react";
import { watch, exists, readDir, rename, mkdir } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { extractTextFromFile } from "./services/parser";
import { generateEmbedding } from "./services/ai";
import { saveFileRecord } from "./services/database";
import { askKendallOS, categorizeBatch } from "./services/rag";
import { NavBar } from "@/components/ui/navbar";
import { Home, MessageCircle, Briefcase } from "lucide-react";

function App() {
  const recentFilesRef = useRef<Map<string, number>>(new Map());
  
  // Batch processing state
  const pendingBatchRef = useRef<Array<{ filePath: string; fileName: string; text: string }>>([]);
  const batchTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Directory UI states
  const [activeFolders, setActiveFolders] = useState<string[]>([]);

  // Chat UI states
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; content: string; sources?: string[] }[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  // Tab UI
  const [activeTab, setActiveTab] = useState("Home");
  const navItems = [
      { name: 'Home', url: '#', icon: Home },
      { name: 'Chat', url: '#', icon: MessageCircle },
      { name: 'Work', url: '#', icon: Briefcase },
  ];

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

          console.log(`Queued ${fileName} for batch classification`);
          pendingBatchRef.current.push({ filePath, fileName, text });
          
          if (batchTimerRef.current) {
            clearTimeout(batchTimerRef.current);
          }

          batchTimerRef.current = setTimeout(async () => {
            const batchToProcess = [...pendingBatchRef.current];
            pendingBatchRef.current = []; // Clear queue

            if (batchToProcess.length === 0) return;
            console.log(`Processing batch of ${batchToProcess.length} files...`);

            try {
              // Ask Gemini for batch classification
              const fileContexts = batchToProcess.map(f => ({ fileName: f.fileName, text: f.text }));
              const folderMapping = await categorizeBatch(fileContexts, currentFolders);
              
              for (const file of batchToProcess) {
                const targetFolderName = folderMapping[file.fileName] || "Misc";
                console.log(`🤖 Gemini says ${file.fileName} belongs in: ${targetFolderName}`);
                
                let finalFilePath = file.filePath;
                if (targetFolderName && targetFolderName !== "Dump") {
                  const folderPath = await join(kendallPath, targetFolderName);
                  
                  // Auto-create folder tracking
                  const folderExists = await exists(folderPath);
                  if (!folderExists) {
                    await mkdir(folderPath);
                    setActiveFolders(prev => {
                      if (!prev.includes(targetFolderName)) return [...prev, targetFolderName];
                      return prev;
                    });
                    if (!currentFolders.includes(targetFolderName)) {
                      currentFolders.push(targetFolderName);
                    }
                  }

                  const newFilePath = await join(folderPath, file.fileName);
                  await rename(file.filePath, newFilePath);
                  finalFilePath = newFilePath;
                  console.log(`Moved ${file.fileName} to ${newFilePath}`);
                }

                console.log(`vectorizing text for ${file.fileName}`);
                const vector = await generateEmbedding(file.text);
                
                console.log(`saving ${file.fileName} to db...`);
                await saveFileRecord(finalFilePath, file.fileName, file.text, Array.from(vector));
                console.log(`✅ Saved ${file.fileName} to DB!`);
              }
            } catch (err) {
              console.error("Batch processing error:", err);
            }
          }, 3000);

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
    <div className="p-5 font-sans flex flex-col h-screen">
      <NavBar items={navItems} activeTab={activeTab} setActiveTab={setActiveTab} />
      
      <div className="mt-15 flex-1 flex gap-10">
        {activeTab === "Home" && (
          <div className="flex-1 p-5">
            <h2 className="text-2xl font-bold">Kendall</h2>
            <p className="text-gray-500">Your local, private agent.</p>
            
            <div className="mt-8">
              <h3 className="text-lg font-semibold">Active Directories</h3>
              <div className="flex flex-col gap-4 mt-3">
                <div className="flex gap-3 flex-wrap">
                  <div className="p-4 border-2 border-dashed border-gray-300 rounded-lg">
                    📥 Dump (Auto-Sort)
                  </div>
                  {activeFolders.map((folderName) => (
                    <div key={folderName} className="p-4 border border-gray-300 rounded-lg">
                      📁 {folderName}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "Chat" && (
          <div className="flex-1 bg-gray-50 rounded-xl p-5 flex flex-col border border-gray-200 h-full">
            <div className="flex-1 overflow-y-auto flex flex-col gap-4 mb-5">
              {messages.length === 0 && (
                <p className="text-gray-500 text-center my-auto">
                  Ask Kendall a question about your files...
                </p>
              )}
          {messages.map((msg, i) => (
            <div key={i} className={`max-w-[85%] ${msg.role === "user" ? "self-end" : "self-start"}`}>
              <div className={`px-4 py-3 rounded-xl ${
                msg.role === "user" 
                  ? "bg-blue-600 text-white rounded-br-sm" 
                  : "bg-gray-200 text-black rounded-bl-sm"
              }`}>
                {msg.content}
              </div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="text-[11px] text-gray-500 mt-1 pl-1">
                  Sources: {msg.sources.join(", ")}
                </div>
              )}
            </div>
          ))}
          {isTyping && (
            <div className="self-start text-gray-500 text-[13px]">
              Kendall is thinking...
            </div>
          )}
        </div>

            <div className="flex gap-2.5 mt-auto">
              <input 
                type="text" 
                placeholder="Ask Kendall..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                className="flex-1 p-3 rounded-lg border border-gray-300 text-[15px] text-black bg-white outline-none focus:border-blue-500"
              />
              <button 
                onClick={handleAsk}
                disabled={isTyping}
                className="px-5 rounded-lg border-none bg-blue-600 text-white cursor-pointer hover:bg-blue-700 disabled:opacity-50"
              >
                Ask
              </button>
            </div>
          </div>
        )}

        {activeTab === "Work" && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-500 text-lg">Work space coming soon...</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;