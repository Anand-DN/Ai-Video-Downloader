import React, { useState } from "react";
import { useDownload } from "../context/DownloadContext";
import ToastContainer from "./ToastContainer";
import "./TorrentPanel.css";

export default function TorrentPanel() {
    const { state, dispatch } = useDownload();
    const [magnetLink, setMagnetLink] = useState("");
    const [loading, setLoading] = useState(false);
    const [toasts, setToasts] = useState([]);

    // Toast helper functions
    const showToast = (message, type = 'info', duration = 3000, actions = null) => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type, duration, actions }]);

        // Auto-remove after duration
        setTimeout(() => {
            removeToast(id);
        }, duration);
    };

    const removeToast = (id) => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
    };

    const handleAddTorrent = async () => {
        if (!magnetLink.trim()) {
            showToast("Please enter a magnet link", "error");
            return;
        }

        const torrentId = Date.now().toString();
        const item = {
            id: torrentId,
            magnetLink,
            status: "downloading",
            progress: 0,
            downloadRate: "0 KB/s",
            uploadRate: "0 KB/s",
            peers: 0,
            seeds: 0,
            filename: "Fetching metadata...",
            eta: "Calculating...",
        };

        dispatch({ type: "ADD_TORRENT", item });
        showToast("Torrent added!", "success", 2000);
        setLoading(true);

        try {
            const response = await fetch("http://localhost:8000/torrent/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ magnet: magnetLink, id: torrentId }),
            });

            const data = await response.json();

            // Connect WebSocket
            const ws = new WebSocket(`ws://localhost:8000/ws/torrent_${torrentId}`);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                console.log("Torrent progress:", data);

                if (data.status === "metadata") {
                    dispatch({
                        type: "UPDATE_TORRENT",
                        id: torrentId,
                        updates: {
                            filename: data.name,
                            totalSize: data.total_size,
                            numFiles: data.num_files,
                        },
                    });
                    showToast(`Metadata received: ${data.name}`, "info", 2000);

                } else if (data.status === "downloading") {
                    // Format ETA
                    const etaSeconds = data.eta || 0;
                    let etaDisplay = "Calculating...";

                    if (etaSeconds > 0) {
                        const hours = Math.floor(etaSeconds / 3600);
                        const minutes = Math.floor((etaSeconds % 3600) / 60);
                        const seconds = Math.floor(etaSeconds % 60);

                        if (hours > 0) {
                            etaDisplay = `${hours}h ${minutes}m`;
                        } else if (minutes > 0) {
                            etaDisplay = `${minutes}m ${seconds}s`;
                        } else {
                            etaDisplay = `${seconds}s`;
                        }
                    }

                    dispatch({
                        type: "UPDATE_TORRENT",
                        id: torrentId,
                        updates: {
                            progress: Math.round(data.progress),
                            downloadRate: `${(data.download_rate / 1024).toFixed(1)} KB/s`,
                            uploadRate: `${(data.upload_rate / 1024).toFixed(1)} KB/s`,
                            peers: data.num_peers,
                            seeds: data.num_seeds,
                            eta: etaDisplay,
                        },
                    });

                } else if (data.status === "finished") {
                    // Remove from active torrents
                    dispatch({ type: "REMOVE_TORRENT", id: torrentId });

                    // Add to history
                    dispatch({
                        type: "PUSH_TORRENT_HISTORY",
                        entry: {
                            ...item,
                            status: "completed",
                            timestamp: Date.now(),
                            filepath: data.save_path,
                        },
                    });

                    // Show success toast with action buttons
                    const filePath = data.save_path;
                    const fileName = item.filename || 'Torrent';

                    showToast(
                        `${fileName} downloaded successfully!`,
                        "success",
                        10000,
                        [
                            {
                                label: "Open File",
                                icon: "▶️",
                                primary: true,
                                onClick: () => {
                                    fetch('http://localhost:8000/open-file', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ path: filePath })
                                    })
                                        .then(res => res.json())
                                        .then(data => {
                                            if (data.error) {
                                                showToast(`Failed to open: ${data.error}`, "error");
                                            } else {
                                                showToast("File opened!", "success", 2000);
                                            }
                                        })
                                        .catch(err => {
                                            console.error('Failed to open file:', err);
                                            showToast("Failed to open file", "error");
                                        });
                                }
                            },
                            {
                                label: "Show in Folder",
                                icon: "📁",
                                onClick: () => {
                                    fetch('http://localhost:8000/show-in-folder', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ path: filePath })
                                    })
                                        .then(res => res.json())
                                        .then(data => {
                                            if (data.error) {
                                                showToast(`Failed to open folder: ${data.error}`, "error");
                                            } else {
                                                showToast("Folder opened!", "success", 2000);
                                            }
                                        })
                                        .catch(err => {
                                            console.error('Failed to show in folder:', err);
                                            showToast("Failed to open folder", "error");
                                        });
                                }
                            }
                        ]
                    );

                } else if (data.status === "cancelled") {
                    dispatch({ type: "REMOVE_TORRENT", id: torrentId });

                } else if (data.status === "error") {
                    dispatch({ type: "REMOVE_TORRENT", id: torrentId });
                    showToast(`Error: ${data.error}`, "error", 5000);
                }
            };

            ws.onerror = (error) => {
                console.error("WebSocket error:", error);
                showToast("Connection error", "error");
            };

            setMagnetLink("");

        } catch (error) {
            console.error("Error adding torrent:", error);
            showToast("Failed to add torrent", "error");
        } finally {
            setLoading(false);
        }
    };

    const handleCancelTorrent = async (torrentId) => {
        try {
            await fetch("http://localhost:8000/torrent/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: torrentId }),
            });

            // Remove from UI immediately
            dispatch({ type: "REMOVE_TORRENT", id: torrentId });
            showToast("Torrent cancelled", "info", 2000);

        } catch (error) {
            console.error("Cancel error:", error);
            // Still remove from UI
            dispatch({ type: "REMOVE_TORRENT", id: torrentId });
            showToast("Torrent cancelled", "info", 2000);
        }
    };

    const activeTorrents = state.torrents || [];

    return (
        <>
            <ToastContainer toasts={toasts} removeToast={removeToast} />

            <div className="torrent-panel">
                <div className="torrent-header">
                    <h2>🧲 Torrent Downloader</h2>
                    <p>Download files using magnet links</p>
                </div>

                <div className="torrent-input-section">
                    <input
                        type="text"
                        value={magnetLink}
                        onChange={(e) => setMagnetLink(e.target.value)}
                        placeholder="Paste magnet link here (magnet:?xt=...)"
                        className="torrent-input"
                        disabled={loading}
                    />
                    <button
                        onClick={handleAddTorrent}
                        className="torrent-add-btn"
                        disabled={loading}
                    >
                        {loading ? "Adding..." : "Add Torrent"}
                    </button>
                </div>

                {activeTorrents.length > 0 && (
                    <div className="active-torrents">
                        <h3>📥 Active Torrents</h3>
                        {activeTorrents.map((torrent) => (
                            <TorrentItem
                                key={torrent.id}
                                torrent={torrent}
                                onCancel={() => handleCancelTorrent(torrent.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

function TorrentItem({ torrent, onCancel }) {
    const formatSize = (bytes) => {
        if (!bytes) return "";
        const gb = bytes / (1024 * 1024 * 1024);
        const mb = bytes / (1024 * 1024);
        return gb >= 1 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
    };

    return (
        <div className="torrent-item">
            <div className="torrent-info">
                <div className="torrent-name">{torrent.filename}</div>
                {torrent.totalSize && (
                    <div className="torrent-size">{formatSize(torrent.totalSize)}</div>
                )}
                <div className="torrent-stats">
                    <span>↓ {torrent.downloadRate}</span>
                    <span>↑ {torrent.uploadRate}</span>
                    <span>Peers: {torrent.peers}</span>
                    <span>Seeds: {torrent.seeds}</span>
                    <span className="eta-badge">⏱ ETA: {torrent.eta}</span>
                </div>
            </div>

            <div className="torrent-progress-section">
                <div className="progress-bar">
                    <div
                        className="progress-fill"
                        style={{ width: `${torrent.progress}%` }}
                    />
                </div>
                <div className="progress-text">{torrent.progress}%</div>
            </div>

            <button onClick={onCancel} className="cancel-torrent-btn">
                ✕ Cancel
            </button>
        </div>
    );
}