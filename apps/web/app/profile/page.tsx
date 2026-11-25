"use client";

import { useEffect, useState } from "react";
import { authorizedFetch } from "../api";

export default function ProfilePage() {
  const [profile, setProfile] = useState<Record<string, string | number | null> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  useEffect(() => {
    if (!localStorage.getItem("accessToken")) { window.location.href = "/login"; return; }
    authorizedFetch(`${api}/api/me`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Không thể tải thông tin tài khoản");
        return response.json();
      })
      .then(setProfile)
      .catch((failure) => setError(failure instanceof Error ? failure.message : "Lỗi kết nối"))
      .finally(() => setLoading(false));
  }, [api]);

  return (
    <main className="lobby-shell">
      <section className="panel profile-panel">
        <h1>{String(profile?.nickname ?? "Tài khoản")}</h1>
        {loading && <p>Đang tải...</p>}
        {error && <p className="error">{error}</p>}
        <p>ID: {String(profile?.id ?? "")}</p>
        <p>Số dư: {String(profile?.balance ?? "0")} xu</p>
        <p>Ván chơi: {String(profile?.gamesPlayed ?? 0)} · Thắng: {String(profile?.gamesWon ?? 0)}</p>
        <a className="primary" href="/lobby">Vào sảnh</a>
      </section>
    </main>
  );
}
