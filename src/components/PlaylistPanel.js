import React, { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import "./PlaylistPanel.css";
import ToastContainer from "./ToastContainer";

export default function PlaylistPanel() {
    const { theme } = useTheme(); // Changed from ThemeContext to useTheme
    const [playlistUrl, setPlaylistUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [playlistInfo, setPlaylistInfo] = useState(null);
    const [selectedVideos, setSelectedVideos] = useState(new Set());
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({});
    const [toasts, setToasts] = useState([]);

    const showToast = (message, type = 'info', duration = 3000) => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type, duration }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(toast => toast.id !== id));
        }, duration);
    };

    const removeToast = (id) => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
    };

    const handleFetchPlaylist = async () => {
        if (!playlistUrl.trim()) {
            showToast("Please enter a playlist URL", "error");
            return;
        }

        setLoading(true);
        setPlaylistInfo(null);
        setSelectedVideos(new Set());

        try {
            const response = await fetch("http://localhost:8000/playlist/info", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: playlistUrl }),
            });

            const data = await response.json();

            if (data.error) {
                showToast(data.error, "error", 4000);
                setPlaylistInfo(null);
            } else {
                setPlaylistInfo(data);
                setSelectedVideos(new Set(data.videos.map(v => v.id)));
                showToast(`✓ Found ${data.playlist_count} videos in "${data.playlist_title}"`, "success", 4000);
            }
        } catch (error) {
            showToast("Failed to fetch playlist. Please check your connection.", "error");
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const toggleVideo = (videoId) => {
        if (downloading) return;

        const newSelected = new Set(selectedVideos);
        if (newSelected.has(videoId)) {
            newSelected.delete(videoId);
        } else {
            newSelected.add(videoId);
        }
        setSelectedVideos(newSelected);
    };

    const toggleAll = () => {
        if (!playlistInfo || !playlistInfo.videos || downloading) return;

        if (selectedVideos.size === playlistInfo.videos.length) {
            setSelectedVideos(new Set());
            showToast("Deselected all videos", "info", 2000);
        } else {
            setSelectedVideos(new Set(playlistInfo.videos.map(v => v.id)));
            showToast(`Selected all ${playlistInfo.videos.length} videos`, "info", 2000);
        }
    };

    const downloadSingleVideo = async (video, quality = '1080p') => {
        return new Promise(async (resolve, reject) => {
            try {
                const downloadId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

                setDownloadProgress(prev => ({
                    ...prev,
                    [video.id]: { status: 'fetching', progress: 0, title: video.title }
                }));

                // Get formats
                const formatsResponse = await fetch(
                    `http://localhost:8000/formats?url=${encodeURIComponent(video.url)}`
                );
                const formatsData = await formatsResponse.json();

                if (formatsData.error) {
                    throw new Error(formatsData.message || "Failed to fetch formats");
                }

                // Find requested quality or best available
                const selectedFormat = formatsData.video_formats.find(f => f.quality === quality)
                    || formatsData.video_formats[0];

                setDownloadProgress(prev => ({
                    ...prev,
                    [video.id]: { status: 'starting', progress: 5, title: video.title }
                }));

                // Start download
                const downloadResponse = await fetch("http://localhost:8000/download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: downloadId,
                        url: video.url,
                        mode: "video",
                        format_id: selectedFormat.format_id,
                    }),
                });

                const downloadData = await downloadResponse.json();

                if (downloadData.error) {
                    throw new Error(downloadData.error);
                }

                // Connect WebSocket for progress
                const ws = new WebSocket(`ws://localhost:8000/ws/${downloadId}`);

                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);

                    if (data.status === "downloading") {
                        const progress = data.total_bytes
                            ? (data.downloaded_bytes / data.total_bytes) * 100
                            : 0;

                        setDownloadProgress(prev => ({
                            ...prev,
                            [video.id]: {
                                status: 'downloading',
                                progress: progress,
                                speed: data.speed || 0,
                                eta: data.eta || 0,
                                title: video.title
                            }
                        }));
                    } else if (data.status === "finished") {
                        setDownloadProgress(prev => ({
                            ...prev,
                            [video.id]: { status: 'completed', progress: 100, title: video.title }
                        }));
                        ws.close();
                        resolve();
                    } else if (data.status === "error") {
                        throw new Error(data.error || "Download failed");
                    }
                };

                ws.onerror = () => {
                    reject(new Error("WebSocket connection failed"));
                };

            } catch (error) {
                setDownloadProgress(prev => ({
                    ...prev,
                    [video.id]: { status: 'error', progress: 0, error: error.message, title: video.title }
                }));
                reject(error);
            }
        });
    };

    const handleDownloadSelected = async () => {
        if (selectedVideos.size === 0) {
            showToast("Please select at least one video to download", "error");
            return;
        }

        setDownloading(true);
        const totalVideos = selectedVideos.size;
        showToast(`🚀 Starting download of ${totalVideos} video${totalVideos > 1 ? 's' : ''}...`, "info", 5000);

        const selectedArray = Array.from(selectedVideos);
        const videosToDownload = playlistInfo.videos.filter(v => selectedArray.includes(v.id));

        let completed = 0;
        let failed = 0;

        for (const video of videosToDownload) {
            try {
                await downloadSingleVideo(video);
                completed++;
                showToast(`✓ Completed: ${video.title.substring(0, 40)}${video.title.length > 40 ? '...' : ''}`, "success", 3000);
            } catch (error) {
                failed++;
                showToast(`✗ Failed: ${video.title.substring(0, 30)}... - ${error.message}`, "error", 4000);
            }

            // Small delay between downloads
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        setDownloading(false);

        // Final summary
        if (failed === 0) {
            showToast(`🎉 All ${completed} videos downloaded successfully!`, "success", 5000);
        } else {
            showToast(`📊 Download complete: ${completed} successful, ${failed} failed`, "info", 5000);
        }
    };

    const formatDuration = (seconds) => {
        if (!seconds) return "Unknown";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const formatSpeed = (bytesPerSec) => {
        if (!bytesPerSec) return "0 KB/s";
        const mbps = bytesPerSec / (1024 * 1024);
        if (mbps >= 1) return `${mbps.toFixed(2)} MB/s`;
        return `${(bytesPerSec / 1024).toFixed(2)} KB/s`;
    };

    return (
        <div className={`playlist-panel ${theme}`}>
            <ToastContainer toasts={toasts} removeToast={removeToast} />

            <div className="playlist-header">
                <div className="playlist-icon">📋</div>
                <h2>Playlist Downloader</h2>
                <p>Download entire YouTube playlists with one click</p>
            </div>

            <div className="playlist-input-section">
                <input
                    type="text"
                    value={playlistUrl}
                    onChange={(e) => setPlaylistUrl(e.target.value)}
                    placeholder="Paste YouTube playlist URL here..."
                    className="playlist-input"
                    disabled={loading || downloading}
                    onKeyPress={(e) => {
                        if (e.key === 'Enter' && !loading && !downloading) {
                            handleFetchPlaylist();
                        }
                    }}
                />
                <button
                    onClick={handleFetchPlaylist}
                    className="fetch-playlist-btn"
                    disabled={loading || downloading}
                >
                    {loading ? (
                        <>
                            <span className="spinner"></span> Loading...
                        </>
                    ) : (
                        'Fetch Playlist'
                    )}
                </button>
            </div>

            {playlistInfo && playlistInfo.videos && playlistInfo.videos.length > 0 ? (
                <div className="playlist-content">
                    <div className="playlist-info-header">
                        <div className="playlist-title-section">
                            <h3>{playlistInfo.playlist_title}</h3>
                            <span className="video-count">{playlistInfo.playlist_count} videos</span>
                        </div>
                        <div className="playlist-actions">
                            <button
                                onClick={toggleAll}
                                className="select-all-btn"
                                disabled={downloading}
                            >
                                {selectedVideos.size === playlistInfo.videos.length ? "Deselect All" : "Select All"}
                            </button>
                            <button
                                onClick={handleDownloadSelected}
                                className="download-selected-btn"
                                disabled={downloading || selectedVideos.size === 0}
                            >
                                {downloading ? (
                                    <>
                                        <span className="spinner-small"></span> Downloading...
                                    </>
                                ) : (
                                    `Download Selected (${selectedVideos.size})`
                                )}
                            </button>
                        </div>
                    </div>

                    <div className="video-list">
                        {playlistInfo.videos.map((video, index) => {
                            const progress = downloadProgress[video.id];
                            const isSelected = selectedVideos.has(video.id);

                            return (
                                <div
                                    key={video.id || index}
                                    className={`video-item ${isSelected ? 'selected' : ''} ${progress?.status || ''}`}
                                    onClick={() => toggleVideo(video.id)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => { }}
                                        className="video-checkbox"
                                        disabled={downloading}
                                    />
                                    {video.thumbnail && (
                                        <img
                                            src={video.thumbnail}
                                            alt={video.title}
                                            className="video-thumb"
                                            onError={(e) => e.target.style.display = 'none'}
                                        />
                                    )}
                                    <div className="video-details">
                                        <div className="video-header">
                                            <span className="video-number">#{index + 1}</span>
                                            {progress?.status === 'completed' && <span className="status-badge completed">✓</span>}
                                            {progress?.status === 'error' && <span className="status-badge error">✗</span>}
                                            {progress?.status === 'downloading' && <span className="status-badge downloading">⏬</span>}
                                        </div>
                                        <div className="video-title">{video.title}</div>
                                        <div className="video-meta">
                                            <span className="video-duration">⏱ {formatDuration(video.duration)}</span>
                                        </div>

                                        {progress && (
                                            <div className="video-progress">
                                                {progress.status === 'fetching' && (
                                                    <span className="status-text">
                                                        <span className="spinner-tiny"></span> Fetching formats...
                                                    </span>
                                                )}
                                                {progress.status === 'starting' && (
                                                    <span className="status-text">
                                                        <span className="spinner-tiny"></span> Starting download...
                                                    </span>
                                                )}
                                                {progress.status === 'downloading' && (
                                                    <>
                                                        <div className="progress-bar">
                                                            <div
                                                                className="progress-fill"
                                                                style={{ width: `${progress.progress}%` }}
                                                            ></div>
                                                        </div>
                                                        <span className="status-text">
                                                            {progress.progress.toFixed(1)}% • {formatSpeed(progress.speed)}
                                                            {progress.eta > 0 && ` • ETA ${Math.floor(progress.eta)}s`}
                                                        </span>
                                                    </>
                                                )}
                                                {progress.status === 'completed' && (
                                                    <span className="status-text success">✓ Download completed</span>
                                                )}
                                                {progress.status === 'error' && (
                                                    <span className="status-text error">✗ {progress.error}</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : playlistInfo && playlistInfo.videos && playlistInfo.videos.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-icon">📭</div>
                    <h3>No videos found in this playlist</h3>
                    <p>Try another playlist URL</p>
                </div>
            ) : null}
        </div>
    );
}
