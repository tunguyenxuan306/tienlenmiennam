export default function HomePage() {
  return (
    <main className="landing">
      <section className="hero">
        <span className="eyebrow">TIẾN LÊN MIỀN NAM</span>
        <h1>Sân chơi bài<br />Realtime</h1>
        <p>Bàn chơi 4 người, phòng công khai hoặc riêng tư, ví tiền ảo và bot AI.</p>
        <div className="actions">
          <a className="primary" href="/lobby">Chơi ngay</a>
          <a className="secondary" href="/guide">Luật chơi</a>
        </div>
      </section>
    </main>
  );
}
