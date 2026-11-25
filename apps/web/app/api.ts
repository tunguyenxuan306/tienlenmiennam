const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "https://tienlenmiennam-65yq.onrender.com";

export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) return null;

  const response = await fetch(`${apiBase}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  if (!response.ok) {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    return null;
  }
  const data = await response.json() as { accessToken: string; refreshToken?: string };
  localStorage.setItem("accessToken", data.accessToken);
  if (data.refreshToken) localStorage.setItem("refreshToken", data.refreshToken);
  return data.accessToken;
}

export async function authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  let token = localStorage.getItem("accessToken");
  const makeRequest = (accessToken: string | null) => {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };

  let response = await makeRequest(token);
  if (response.status !== 401 || !localStorage.getItem("refreshToken")) return response;
  token = await refreshAccessToken();
  if (!token) return response;
  response = await makeRequest(token);
  return response;
}
