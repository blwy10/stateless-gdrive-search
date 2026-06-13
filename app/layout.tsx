import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stateless GDrive Search",
  description: "Query connected Google Drives with a constrained AI agent."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
