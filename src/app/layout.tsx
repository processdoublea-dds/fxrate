import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FX Rate Monitor",
  description: "Monitor exchange rates from BOT, SCB, KTB, KBANK, and Bloomberg",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
