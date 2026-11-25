"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { authorizedFetch, refreshAccessToken } from "../../api";

type Card = { rank: number; suit: "SPADES" | "CLUBS" | "DIAMONDS" | "HEARTS" };

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card[]>([]);
  const [status, setStatus] = useState("Đang kết nối");
  const [roomId, setRoomId] = useState("");
  const [turn, setTurn] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    const api = process.env.NEXT_PUBLIC_SOCKET_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://tienlenmiennam-65yq.onrender.com";
    if (!localStorage.getItem("accessToken")) { window.location.href = "/login"; return; }
    let client: Socket | null = null;
    let cancelled = false;
    let refreshTimer: number | undefined;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://tienlenmiennam-65yq.onrender.com";
    void authorizedFetch(`${apiUrl}/api/rooms/${params.code}/join`, { method: "POST" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Không thể vào phòng");
      if (cancelled) return;
      setRoomId(data.id);
      client = io(api, {
        auth: (callback) => callback({ token: localStorage.getItem("accessToken") }),
        reconnection: true
      });
      setSocket(client);
      client.on("connect", () => {
        setStatus("Đã kết nối");
        client?.emit("room:join", { code: params.code });
      });
      client.on("disconnect", () => setStatus("Đã mất kết nối"));
      let refreshing = false;
      client.on("connect_error", async (failure) => {
        setError("Không thể xác thực kết nối realtime");
        if (!/token|auth|account/i.test(failure.message)) return;
        if (refreshing) return;
        refreshing = true;
        try {
          const renewed = await refreshAccessToken();
          if (renewed && client) {
            client.auth = { token: renewed };
            client.connect();
          }
        } catch {
          setError("Không thể gia hạn phiên đăng nhập");
        } finally {
          refreshing = false;
        }
      });
      refreshTimer = window.setInterval(async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const renewed = await refreshAccessToken();
          if (renewed && client?.connected) {
            client.auth = { token: renewed };
            client.disconnect().connect();
          }
        } catch {
          setError("Không thể gia hạn phiên đăng nhập");
        } finally {
          refreshing = false;
        }
      }, 12 * 60 * 1000);
      client.on("room:state", (room) => {
        setRoomId(room.id ?? "");
        setStatus(room.status);
        setIsOwner(Boolean(room.isOwner));
      });
      client.on("game:hand", (payload: { cards: Card[] }) => setHand(payload.cards));
      client.on("game:turn", (payload: { seat: number }) => setTurn(payload.seat));
      client.on("game:played", (played: { cards: Card[] }) => {
        setStatus("Bài đã đánh");
        setHand((current) => current.filter((card) =>
          !played.cards.some((playedCard) => playedCard.rank === card.rank && playedCard.suit === card.suit)
        ));
        setSelected([]);
      });
      client.on("game:error", (payload: { message: string }) => setError(payload.message));
      client.on("room:error", (payload: { message: string }) => setError(payload.message));
    }).catch((failure) => {
      setStatus("Không vào được phòng");
      setError(failure instanceof Error ? failure.message : "Lỗi kết nối");
    });
    return () => { cancelled = true; if (refreshTimer) window.clearInterval(refreshTimer); client?.disconnect(); };
  }, [params.code]);

  function toggle(card: Card) {
    setSelected((current) => current.some((item) => item.rank === card.rank && item.suit === card.suit)
      ? current.filter((item) => !(item.rank === card.rank && item.suit === card.suit))
      : [...current, card]);
  }

  function play() {
    socket?.emit("game:play", { roomId, cards: selected });
  }

  function pass() {
    socket?.emit("game:pass", { roomId });
  }

  return (
    <main className="game-shell">
      <header className="game-header"><a href="/lobby">← Sảnh</a><strong>Phòng {params.code}</strong><span>{status}</span></header>
      {error && <div className="game-error">{error}</div>}
      <section className="game-table">
        <div className="seat seat-top">Ghế đối thủ</div>
        <div className="seat seat-left">Ghế trái</div>
        <div className="seat seat-right">Ghế phải</div>
        <div className="played-area">{turn !== null ? `Lượt ghế ${turn}` : "Chờ bắt đầu"}</div>
        <div className="hand">
          {hand.map((card) => (
            <button className={selected.some((item) => item.rank === card.rank && item.suit === card.suit) ? "card selected" : "card"} key={`${card.rank}-${card.suit}`} onClick={() => toggle(card)}>
              <span>{card.rank}</span><b>{card.suit === "SPADES" ? "♠" : card.suit === "CLUBS" ? "♣" : card.suit === "DIAMONDS" ? "♦" : "♥"}</b>
            </button>
          ))}
        </div>
      </section>
      {isOwner && status === "WAITING" && <button className="start-game" onClick={() => socket?.emit("room:start", { roomId })}>Bắt đầu ván</button>}
      <footer className="game-actions"><button onClick={play} disabled={!selected.length}>Đánh bài</button><button onClick={pass}>Bỏ lượt</button></footer>
    </main>
  );
}
