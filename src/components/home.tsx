interface HomeProps {
  activeFolders: string[];
}

export function HomeSection({ activeFolders }: HomeProps) {
  return (
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
  );
}