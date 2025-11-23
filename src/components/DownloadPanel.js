import React, { useState } from "react";
import { useDownload } from "../context/DownloadContext";
import { cancelDownload, getFormats, postStartDownload, wsUrl } from "../utils/api";
import "./DownloadPanel.css";
import ToastContainer from "./ToastContainer";

export default function DownloadPanel() {
  const { state, dispatch } = useDownload();
  const [url, setUrl] = useState("");
  const [selectedQuality, setSelectedQuality] = useState("");
  const [selectedMode, setSelectedMode] = useState("");
  const [showQualitySelector, setShowQualitySelector] = useState(false);
  const [videoInfo, setVideoInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recommendedQuality, setRecommendedQuality] = useState(null);
  const [toasts, setToasts] = useState([]);

  // Toast helper functions with actions support
  const showToast = (message, type = 'info', duration = 3000, actions = null) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type, duration, actions }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  // Format file size helper
  const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return "";
    const mb = bytes / (1024 * 1024);
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(2)} GB`;
    } else if (mb >= 1) {
      return `${mb.toFixed(0)} MB`;
    } else {
      return `${(bytes / 1024).toFixed(0)} KB`;
    }
  };

  const handleFetch = async () => {
    if (!url.trim()) {
      showToast("Please enter a video URL", "error");
      return;
    }

    setLoading(true);
    const loadingToastId = Date.now();
    setToasts(prev => [...prev, { id: loadingToastId, message: "Fetching video information...", type: "loading", duration: 10000 }]);

    try {
      const data = await getFormats(url);
      removeToast(loadingToastId);

      if (data.error) {
        setVideoInfo({
          error: true,
          errorType: 'general',
          message: data.message || 'Failed to fetch video information'
        });
        showToast(data.message || "Failed to fetch video", "error");
        setShowQualitySelector(true);
        setLoading(false);
        return;
      }

      const recommended = getRecommendedQuality(data.video_formats);
      setRecommendedQuality(recommended);
      setVideoInfo(data);
      setShowQualitySelector(true);
      showToast("Video loaded successfully!", "success");
    } catch (error) {
      removeToast(loadingToastId);
      setVideoInfo({
        error: true,
        errorType: 'network',
        message: `Network error: ${error.message}`
      });
      setShowQualitySelector(true);
      showToast("Network error occurred", "error");
    } finally {
      setLoading(false);
    }
  };

  const getRecommendedQuality = (formats) => {
    const qualityPriority = ["8K", "4K", "2K", "1080p", "720p", "480p", "360p", "240p", "144p"];
    for (const quality of qualityPriority) {
      const found = formats.find(f => f.quality === quality);
      if (found) return found;
    }
    return formats[0];
  };

  const handleDownload = async () => {
    if (!selectedQuality || !selectedMode) {
      showToast("Please select a quality option", "error");
      return;
    }

    const item = {
      id: Date.now().toString(),
      url,
      quality: selectedQuality,
      mode: selectedMode,
      status: "downloading",
      progress: 0,
      filename: videoInfo?.title || "Unknown",
      speed: "0 KB/s",
      eta: "Calculating...",
    };

    dispatch({ type: "ADD_ITEM", item });
    showToast("Download started!", "success");

    try {
      await postStartDownload(url, item.id, selectedMode, selectedQuality);
      const ws = new WebSocket(wsUrl(item.id));

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("WebSocket message:", data);

        if (data.status === "downloading") {
          const progress = data.total_bytes
            ? Math.round((data.downloaded_bytes / data.total_bytes) * 100)
            : 0;
          const etaSeconds = data.eta ? Math.round(data.eta) : 0;
          const etaDisplay = etaSeconds > 0 ? `${etaSeconds}s` : "Calculating...";

          dispatch({
            type: "UPDATE_ITEM",
            id: item.id,
            updates: {
              progress,
              speed: data.speed ? `${Math.round(data.speed / 1024)} KB/s` : "0 KB/s",
              eta: etaDisplay,
            },
          });
        } else if (data.status === "finished") {
          dispatch({ type: "REMOVE_ITEM", id: item.id });

          dispatch({
            type: "PUSH_HISTORY",
            entry: {
              ...item,
              status: "completed",
              timestamp: Date.now(),
              filename: data.result?.final_path || item.filename
            },
          });

          const filePath = data.result?.final_path || item.filename;
          const videoTitle = videoInfo?.title || 'Video';
          showToast(
            `${videoTitle} downloaded successfully!`,
            "success",
            10000,
            [
              {
                label: "Open Video",
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
                        showToast("Video opened!", "success", 2000);
                      }
                    })
                    .catch(err => {
                      console.error('Failed to open file:', err);
                      showToast("Failed to open video", "error");
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
        } else if (data.status === "error") {
          dispatch({
            type: "UPDATE_ITEM",
            id: item.id,
            updates: { status: "error" }
          });
          showToast(`Download failed: ${data.error}`, "error");
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        showToast("Connection error", "error");
      };

    } catch (error) {
      console.error("Download error:", error);
      dispatch({
        type: "UPDATE_ITEM",
        id: item.id,
        updates: { status: "error" }
      });
      showToast("Failed to start download", "error");
    }

    setUrl("");
    setSelectedQuality("");
    setSelectedMode("");
    setVideoInfo(null);
    setShowQualitySelector(false);
    setRecommendedQuality(null);
  };

  const handleCancel = async (itemId) => {
    try {
      await cancelDownload(itemId);
      dispatch({ type: "REMOVE_ITEM", id: itemId });
      showToast("Download cancelled", "info");
    } catch (error) {
      console.error("Cancel error:", error);
      showToast("Failed to cancel download", "error");
    }
  };

  const activeDownloads = state.queue.filter((i) => i.status === "downloading");

  return (
    <>
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      <div className="download-panel-advanced">
        {/* COMBINED HEADER + INPUT CARD */}
        <div className="hero-card">
          <div className="hero-background-glow"></div>

          {/* ANIMATED HEADER */}
          <div className="animated-header-inline">
            <div className="animated-logo-container">
              <div className="logo-glow-ring"></div>
              <div className="logo-glow-ring delay-1"></div>
              <div className="logo-glow-ring delay-2"></div>
              <svg className="animated-logo" viewBox="0 0 100 100">
                <defs>
                  <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="50%" stopColor="#8b5cf6" />
                    <stop offset="100%" stopColor="#a855f7" />
                  </linearGradient>
                </defs>

                <circle cx="50" cy="50" r="35" fill="url(#logoGradient)" className="logo-circle" />
                <polygon points="42,35 42,65 68,50" fill="white" className="logo-play" />

                <circle cx="50" cy="50" r="42" fill="none" stroke="url(#logoGradient)"
                  strokeWidth="2" strokeDasharray="10 5" className="logo-ring-outer" />
                <circle cx="50" cy="50" r="38" fill="none" stroke="url(#logoGradient)"
                  strokeWidth="1.5" strokeDasharray="5 3" className="logo-ring-inner" />
              </svg>

              <div className="logo-particle particle-1"></div>
              <div className="logo-particle particle-2"></div>
              <div className="logo-particle particle-3"></div>
              <div className="logo-particle particle-4"></div>
            </div>

            <div className="header-text-inline">
              <h2 className="header-title-inline">AI Video Downloader</h2>
              <p className="header-subtitle-inline">Download videos in highest quality</p>
            </div>
          </div>

          {/* URL INPUT SECTION */}
          <div className="url-input-section-inline">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste video URL here..."
              className="url-input-advanced"
              disabled={loading}
            />
            <button
              onClick={handleFetch}
              className={`fetch-btn-advanced ${loading ? 'loading' : ''}`}
              disabled={loading}
            >
              <span className="btn-content">
                {loading ? (
                  <>
                    <span className="loading-spinner"></span>
                    <span>Loading...</span>
                  </>
                ) : (
                  <>
                    <span className="star-icon">✨</span>
                    <span>Fetch</span>
                    <span className="star-icon">✨</span>
                  </>
                )}
              </span>

              {!loading && (
                <div className="button-stars">
                  <span className="btn-star star-1">★</span>
                  <span className="btn-star star-2">★</span>
                  <span className="btn-star star-3">★</span>
                  <span className="btn-star star-4">★</span>
                  <span className="btn-star star-5">★</span>
                  <span className="btn-star star-6">★</span>
                </div>
              )}
            </button>
          </div>
        </div>

        {/* ERROR DISPLAY */}
        {showQualitySelector && videoInfo && videoInfo.error && (
          <div className="error-card-advanced">
            <div className="error-icon">⚠️</div>
            <h3>❌ Error Occurred</h3>
            <p className="error-message">{videoInfo.message}</p>
            <button
              onClick={() => {
                setUrl("");
                setShowQualitySelector(false);
                setVideoInfo(null);
              }}
              className="try-again-btn"
            >
              ← Try Again
            </button>
          </div>
        )}

        {/* QUALITY SELECTOR */}
        {showQualitySelector && videoInfo && !videoInfo.error && (
          <>
            {/* AI RECOMMENDATION BADGE */}
            {recommendedQuality && (
              <div className="ai-recommendation-badge">
                <div className="ai-icon">🤖</div>
                <div className="ai-text">
                  <strong>AI Recommendation</strong>
                  <span>Ultra connection - selected {recommendedQuality.quality} for maximum quality</span>
                </div>
                <button className="quality-pill">{recommendedQuality.quality}</button>
              </div>
            )}

            {/* VIDEO CARD */}
            <div className="video-card-advanced">
              <img src={videoInfo.thumbnail} alt="Thumbnail" className="video-thumbnail-advanced" />
              <div className="video-info-advanced">
                <h3 className="video-title-advanced">{videoInfo.title}</h3>
                <div className="video-meta-advanced">
                  <span className="video-duration">⏱ {formatDuration(videoInfo.duration)}</span>
                  <span className="video-platform">🌐 Youtube</span>
                </div>
              </div>
            </div>

            {/* SELECT QUALITY SECTION */}
            <div className="quality-selector-advanced">
              <h3 className="select-quality-title">📥 Select Quality</h3>

              {/* VIDEO + AUDIO */}
              <div className="quality-category">
                <div className="category-header">
                  <span className="category-dot red"></span>
                  <span className="category-name">VIDEO + AUDIO</span>
                </div>

                <div className="quality-grid">
                  {videoInfo.video_formats?.map((format, idx) => (
                    <div
                      key={idx}
                      className={`quality-card ${selectedQuality === format.format_id && selectedMode === "video" ? "selected" : ""} ${recommendedQuality?.format_id === format.format_id ? "recommended" : ""}`}
                      onClick={() => {
                        setSelectedQuality(format.format_id);
                        setSelectedMode("video");
                      }}
                    >
                      {recommendedQuality?.format_id === format.format_id && (
                        <span className="recommended-badge">AI ⭐</span>
                      )}

                      <div className="quality-label">{format.quality}</div>
                      <div className="quality-details">
                        <span>{format.ext ? format.ext.toUpperCase() : "MP4"}</span>
                        {format.filesize ? <span>{formatFileSize(format.filesize)}</span> : <span />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* AUDIO */}
              <div className="quality-category">
                <div className="category-header">
                  <span className="category-dot green"></span>
                  <span className="category-name">AUDIO</span>
                </div>

                <div className="quality-grid">
                  {videoInfo.audio_formats?.map((format, idx) => (
                    <div
                      key={idx}
                      className={`quality-card ${selectedQuality === format.format_id && selectedMode === "audio" ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedQuality(format.format_id);
                        setSelectedMode("audio");
                      }}
                    >
                      <div className="quality-label">{format.ext ? `${format.ext.toUpperCase()} Audio` : "Audio"}</div>
                      <div className="quality-details">
                        {format.abr ? <span>{format.abr} kbps</span> : <span>Audio</span>}
                        {format.filesize ? <span>{formatFileSize(format.filesize)}</span> : <span />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* DOWNLOAD BUTTON */}
            <button
              onClick={handleDownload}
              className="download-now-btn"
              disabled={!selectedQuality || !selectedMode}
            >
              <span className="download-icon">⬇️</span>
              Download Now
              <span className="sparkles-icon">✨</span>
            </button>
          </>
        )}

        {/* ACTIVE DOWNLOADS */}
        {activeDownloads.length > 0 && (
          <div className="active-downloads-section">
            <h3 className="section-title-advanced">📥 Active Downloads</h3>
            {activeDownloads.map((item) => (
              <DownloadItem
                key={item.id}
                item={item}
                onCancel={() => handleCancel(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function DownloadItem({ item, onCancel }) {
  return (
    <div className="download-item-advanced">
      <div className="download-info-row">
        <div>
          <div className="download-filename-advanced">{item.filename}</div>
          <div className="download-stats-advanced">
            {item.speed} • ETA: {item.eta}
          </div>
        </div>
        <div className="download-progress-text">{item.progress}%</div>
      </div>

      <div className="progress-bar-advanced">
        <div className={`progress-fill-advanced ${item.status === "paused" ? "paused-bar" : ""}`} style={{ width: `${item.progress}%` }} />
      </div>

      <button onClick={onCancel} className="cancel-btn-advanced">
        ✕ Cancel
      </button>
    </div>
  );
}
