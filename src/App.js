import React, { useState } from "react";
import DownloadPanel from "./components/DownloadPanel";
import Header from "./components/Header";
import HistoryPanel from "./components/HistoryPanel";
import SettingsPanel from "./components/SettingsPanel";
import TorrentPanel from "./components/TorrentPanel";
import PlaylistPanel from "./components/PlaylistPanel";

export default function App() {
  const [activeTab, setActiveTab] = useState("download");
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app-container">
      <Header onSettingsClick={() => setShowSettings(true)} />

      <main className="main-content">
        <div className="tabs-container">
          <button
            className={`tab ${activeTab === "download" ? "active" : ""}`}
            onClick={() => setActiveTab("download")}
          >
            📥 Download
          </button>
          <button
            className={`tab ${activeTab === "torrent" ? "active" : ""}`}
            onClick={() => setActiveTab("torrent")}
          >
            🧲 Torrent
          </button>
          <button
            className={`tab ${activeTab === "playlist" ? "active" : ""}`}
            onClick={() => setActiveTab("playlist")}
          >
            📋 Playlist
          </button>
          <button
            className={`tab ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
          >
            📜 History
          </button>
        </div>

        <div className="fade-in">
          {activeTab === "download" && <DownloadPanel />}
          {activeTab === "torrent" && <TorrentPanel />}
          {activeTab === "playlist" && <PlaylistPanel />}
          {activeTab === "history" && <HistoryPanel />}
        </div>
      </main>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <SettingsPanel onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
