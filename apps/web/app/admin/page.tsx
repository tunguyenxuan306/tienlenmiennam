"use client";

import { useEffect, useState } from "react";
import { authorizedFetch } from "../api";

type UserRow = { id: string; username: string; nickname: string; role: string; status: string; balance: string };

export default function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const api = process.env.NEXT_PUBLIC_API_URL ?? "https://tienlenmiennam-65yq.onrender.com";

  useEffect(() => {
    authorizedFetch(`${api}/api/admin/users`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? "Không có quyền truy cập");
        return response.json();
      })
      .then(setUsers)
      .catch((failure) => setError(failure.message))
      .finally(() => setLoading(false));
  }, [api]);

  return (
    <main className="lobby-shell">
      <section className="panel admin-panel">
        <h1>Quản trị</h1>
        {loading && <p>Đang tải...</p>}
        {error && <p className="error">{error}</p>}
        <div className="table-wrap"><table><thead><tr><th>Tài khoản</th><th>Biệt danh</th><th>Vai trò</th><th>Trạng thái</th><th>Số dư</th></tr></thead>
          <tbody>{users.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.nickname}</td><td>{user.role}</td><td>{user.status}</td><td>{user.balance}</td></tr>)}</tbody>
        </table></div>
      </section>
    </main>
  );
}
