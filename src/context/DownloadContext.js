import React, { createContext, useContext, useEffect, useReducer } from "react";
import { loadHistoryFromStorage, saveHistoryToStorage } from "../utils/storage";

const DownloadContext = createContext();

const initial = {
  queue: [],
  history: [],
  torrents: [],
  settings: { defaultMode: "video", maxConcurrent: 2 },
};

function reducer(state, action) {
  switch (action.type) {
    case "ADD_ITEM":
      return { ...state, queue: [...state.queue, action.item] };

    case "UPDATE_ITEM":
      return {
        ...state,
        queue: state.queue.map((i) =>
          i.id === action.id ? { ...i, ...action.updates } : i
        ),
      };

    case "REMOVE_ITEM":
      return { ...state, queue: state.queue.filter((i) => i.id !== action.id) };

    case "PUSH_HISTORY":
      const h = [action.entry, ...state.history].slice(0, 500);
      saveHistoryToStorage(h);
      return { ...state, history: h };

    case "SET_HISTORY":
      return { ...state, history: action.history };

    case "DELETE_HISTORY":
      const newh = state.history.filter((h) => h.id !== action.id);
      saveHistoryToStorage(newh);
      return { ...state, history: newh };

    case "CLEAR_HISTORY":
      saveHistoryToStorage([]);
      return { ...state, history: [] };

    case "SET_SETTINGS":
      return { ...state, settings: { ...state.settings, ...action.settings } };

    // Torrent actions
    case "ADD_TORRENT":
      return {
        ...state,
        torrents: [...state.torrents, action.item],
      };

    case "UPDATE_TORRENT":
      return {
        ...state,
        torrents: state.torrents.map((t) =>
          t.id === action.id ? { ...t, ...action.updates } : t
        ),
      };

    case "REMOVE_TORRENT":
      return {
        ...state,
        torrents: state.torrents.filter((t) => t.id !== action.id),
      };

    case "PUSH_TORRENT_HISTORY":
      const torrentHistory = [action.entry, ...state.history].slice(0, 500);
      saveHistoryToStorage(torrentHistory);
      return { ...state, history: torrentHistory };

    case "CLEAR_TORRENTS":
      return { ...state, torrents: [] };

    default:
      return state;
  }
}

export function DownloadProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    const local = loadHistoryFromStorage();
    if (local && local.length) {
      dispatch({ type: "SET_HISTORY", history: local });
    }
  }, []);

  return (
    <DownloadContext.Provider value={{ state, dispatch }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownload() {
  return useContext(DownloadContext);
}