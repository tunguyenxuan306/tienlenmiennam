"use client";

import { useState } from "react";

export default function RegisterPage() {
  const [form, setForm] = useState({ username: "", nickname: "", password: "", email: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch(`${api}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) return setError(data.error ?? "Đăng ký thất bại");
      window.location.href = "/login";
    } catch {
      setError("Không thể kết nối máy chủ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <span className="eyebrow">THÀNH VIÊN MỚI</span>
        <h1>Đăng ký</h1>
        <label>Tài khoản<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label>
        <label>Biệt danh<input value={form.nickname} onChange={(event) => setForm({ ...form, nickname: event.target.value })} required /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>Mật khẩu<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>{loading ? "Đang tạo..." : "Tạo tài khoản"}</button>
      </form>
    </main>
  );
}
