import { useEffect, useState } from "react";
import { getAllFilesMetadata, deleteFileRecord } from "../services/database";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export function DbSection() {
  const [dbFiles, setDbFiles] = useState<any[]>([]);

  useEffect(() => {
    refreshDbFiles();
  }, []);

  const refreshDbFiles = async () => {
    try {
      const files = await getAllFilesMetadata();
      setDbFiles(files);
    } catch (err) {
      console.error("Failed to load DB files:", err);
    }
  };

  return (
    <div className="flex-1 p-5 overflow-y-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold">Database Index</h2>
        <button 
          onClick={refreshDbFiles}
          className="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm cursor-pointer"
        >
          Refresh
        </button>
      </div>
      
      {dbFiles.length === 0 ? (
        <p className="text-gray-500 text-center">No files indexed yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {dbFiles.map((f, idx) => (
            <div key={idx} className="flex flex-col gap-2 p-4 border border-gray-200 rounded-lg bg-[#7c7c80] shadow-sm">
              <div className="flex justify-between items-start">
                <div className="font-semibold">{f.filename}</div>
                <div className="flex gap-2 text-xs">
                  <button 
                    onClick={() => revealItemInDir(f.path)}
                    className="px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded cursor-pointer transition-colors"
                  >
                    Reveal in Finder
                  </button>
                  <button 
                    onClick={async () => {
                      try {
                        console.log("Delete clicked for ID:", f.id);
                        await deleteFileRecord(f.id);
                        await refreshDbFiles();
                      } catch (err) {
                        console.error("Could not delete:", err);
                        alert("Failed to delete record. Check console.");
                      }
                    }}
                    className="px-2 py-1 bg-red-100 hover:bg-red-200 text-red-800 rounded cursor-pointer transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="text-sm text-gray-200 truncate" title={f.path}>
                {f.path}
              </div>
              <div className="text-xs text-gray-100">
                Tokens: {(f.content_length || 0).toLocaleString()} chars
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
