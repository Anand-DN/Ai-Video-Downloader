const BASE_URL = "http://127.0.0.1:8000";
const WS_URL = "ws://127.0.0.1:8000";

export async function getFormats(url) {
  const q = encodeURIComponent(url);
  const res = await fetch(`${BASE_URL}/formats?url=${q}`);
  return await res.json();
}

export async function postStartDownload(url, id, mode, format_id) {
  const res = await fetch(`${BASE_URL}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, id, mode, format_id }),
  });
  if (!res.ok) throw new Error("Failed");
  return await res.json();
}

export async function cancelDownload(id) {
  return await fetch(`${BASE_URL}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).then(r => r.json());
}

export function wsUrl(id) {
  return `${WS_URL}/ws/${id}`;
}