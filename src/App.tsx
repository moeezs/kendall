import "./App.css";
import { useEffect, useRef, useState } from "react";
import { watch, exists, readDir, rename, mkdir } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { extractTextFromFile } from "./services/parser";
import { generateEmbedding } from "./services/ai";
import { saveFileRecord } from "./services/database";
import { categorizeBatch } from "./services/rag";
import { NavBar } from "@/components/ui/navbar";
import { Home, MessageCircle, Briefcase, Database } from "lucide-react";
import { HomeSection } from "@/components/home";
import { ChatSection } from "@/components/chat";
import { WorkSection } from "@/components/work";
import { DbSection } from "@/components/db";

function App() {
  const recentFilesRef = useRef<Map<string, number>>(new Map());
  
  // Batch processing state
  const pendingBatchRef = useRef<Array<{ filePath: string; fileName: string; text: string }>>([]);
  const batchTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Directory UI states
  const [activeFolders, setActiveFolders] = useState<string[]>([]);

  // Tab UI
  const [activeTab, setActiveTab] = useState("Home");

  const navItems = [
      { name: 'Home', url: '#', icon: Home },
      { name: 'Chat', url: '#', icon: MessageCircle },
      { name: 'Work', url: '#', icon: Briefcase },
      { name: 'DB', url: '#', icon: Database },
  ];

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
      
      <div className="mt-15 flex-1 flex gap-10 overflow-hidden">
        {activeTab === "Home" && <HomeSection activeFolders={activeFolders} />}
        {activeTab === "Chat" && <ChatSection />}
        {activeTab === "Work" && <WorkSection />}
        {activeTab === "DB" && <DbSection />}
      </div>
    </div>
  );
}

export default App;