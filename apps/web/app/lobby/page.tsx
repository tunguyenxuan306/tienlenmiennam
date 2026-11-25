"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authorizedFetch } from "../api";

type Room = { id: string; code: string; name: string; status: string; entryFee: string; playerCount: number; spectatorCount: number };

export default function LobbyPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  const load = useCallback(async () => {
    if (!token) { setLoading(false); return; }
    try {
      const response = await authorizedFetch(`${api}/api/rooms`);
      if (!response.ok) throw new Error("Không thể tải danh sách phòng");
      setRooms(await response.json());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Lỗi kết nối");
    } finally {
      setLoading(false);
    }
  }, [api, token]);

  useEffect(() => {
    setToken(localStorage.getItem("accessToken"));
  }, []);

  useEffect(() => { if (token !== null) void load(); else setLoading(false); }, [load, token]);

  async function createRoom() {
    setError("");
    try {
      const response = await authorizedFetch(`${api}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, entryFee: 0, botEnabled: true })
      });
      const data = await response.json();
      if (!response.ok) return setError(data.error ?? "Không thể tạo phòng");
      setName("");
      await load();
    } catch {
      setError("Không thể kết nối máy chủ");
    }
  }

  return (
    <main className="lobby-shell">
      <header className="topbar"><Link href="/">Tiến Lên</Link><nav><Link href="/profile">Tài khoản</Link><Link href="/login">Đăng nhập</Link></nav></header>
      {!token ? (
        <section className="empty-card"><h1>Vào sảnh</h1><p>Đăng nhập để tạo hoặc tham gia phòng.</p><a className="primary" href="/login">Đăng nhập</a></section>
      ) : (
        <>
          <section className="panel create-panel">
            <h1>Tạo phòng</h1>
            <div className="form-row">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tên phòng" />
              <button onClick={createRoom} disabled={!name.trim()}>Tạo phòng</button>
            </div>
            <p>Hiện chỉ hỗ trợ phòng miễn phí; cược và payout đang bị tắt.</p>
            {error && <p className="error">{error}</p>}
          </section>
          {loading && <section className="empty-card">Đang tải phòng...</section>}
          {!loading && rooms.length === 0 && <section className="empty-card">Chưa có phòng công khai.</section>}
          <section className="room-grid">
            {rooms.map((room) => (
              <article className="room-card" key={room.id}>
                <div><span className="room-code">{room.code}</span><h2>{room.name}</h2></div>
                <p>{room.playerCount}/4 người · {room.spectatorCount} khán giả</p>
                <p>Vào: {room.entryFee} xu</p>
                <a className="join-button" href={`/room/${room.code}`}>Tham gia</a>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
