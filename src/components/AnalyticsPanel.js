import React, { useEffect, useState } from "react";
import "./AnalyticsPanel.css";

export default function AnalyticsPanel() {
    const [analytics, setAnalytics] = useState(null);

    useEffect(() => {
        fetchAnalytics();
    }, []);

    const fetchAnalytics = async () => {
        try {
            const response = await fetch("http://localhost:8000/analytics");
            const data = await response.json();
            setAnalytics(data);
        } catch (error) {
            console.error("Failed to fetch analytics:", error);
        }
    };

    if (!analytics) return <div>Loading analytics...</div>;

    return (
        <div className="analytics-panel">
            <h2>📊 Download Analytics</h2>

            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-icon">📥</div>
                    <div className="stat-value">{analytics.total_downloads}</div>
                    <div className="stat-label">Total Downloads</div>
                </div>

                <div className="stat-card">
                    <div className="stat-icon">💾</div>
                    <div className="stat-value">{analytics.total_size_mb.toFixed(2)} GB</div>
                    <div className="stat-label">Total Size</div>
                </div>

                <div className="stat-card">
                    <div className="stat-icon">🎬</div>
                    <div className="stat-value">{analytics.downloads_by_type.video}</div>
                    <div className="stat-label">Videos</div>
                </div>

                <div className="stat-card">
                    <div className="stat-icon">🎵</div>
                    <div className="stat-value">{analytics.downloads_by_type.audio}</div>
                    <div className="stat-label">Audio</div>
                </div>
            </div>

            <div className="recent-downloads">
                <h3>Recent Downloads</h3>
                <div className="download-list">
                    {analytics.recent_downloads.slice(0, 10).map((download, index) => (
                        <div key={index} className="download-entry">
                            <div className="download-title">{download.title}</div>
                            <div className="download-meta">
                                <span>{download.size_mb} MB</span>
                                <span>{download.type}</span>
                                <span>{new Date(download.timestamp).toLocaleDateString()}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
