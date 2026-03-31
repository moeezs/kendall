import "./App.css";
import { useEffect, useRef, useState } from "react";
import { watch, exists } from "@tauri-apps/plugin-fs";
import { desktopDir, join } from "@tauri-apps/api/path";
import { extractTextFromFile } from "./services/parser";
import { generateEmbedding } from "./services/ai";
import { saveFileRecord } from "./services/database";

function App() {
  const [currentPath, setCurrentPath] = useState("Loading...");
  const recentFilesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let unwatchFn: () => void;

    const startWatching = async () => {
      const desktop = await desktopDir();
      const dumpPath = await join(desktop, "kendall/Dump");
      setCurrentPath(dumpPath); 
      
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
          // Extract
          console.log("extracting text");
          const text = await extractTextFromFile(filePath);

          console.log("vectorizing text");
          // Vectorize
          const vector = await generateEmbedding(text);
          
          console.log("✅ Processed:", filePath.split('/').pop());
          console.log("Vector preview:", vector.slice(0, 5));
          
          // DB
          console.log("saving to db...");
          await saveFileRecord(filePath, fileName, text, Array.from(vector));
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
    <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
      <h2>Kendall</h2>
      <p style={{ color: "gray" }}>Your local, private agent.</p>
      
      <div style={{ marginTop: "30px" }}>
        <h3>Active Directories</h3>
        <div style={{ display: "flex", gap: "15px", marginTop: "10px" }}>
          <p>Current Path: {currentPath}</p>
          <div style={{ padding: "15px", border: "2px dashed #ccc", borderRadius: "8px" }}>
            📥 Dump (Auto-Sort)
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            📚 McMaster
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            📌 Projects
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            🫡 Random
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;