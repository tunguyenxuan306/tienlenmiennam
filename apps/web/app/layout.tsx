import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tiến Lên Online",
  description: "Game bài Tiến Lên Miền Nam realtime"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
