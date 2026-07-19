import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flâneur",
  description: "Photograph something in Hong Kong — find what it costs, or find where to buy one like it.",
  // Standalone Home Screen app: keeps the name short under the icon and marks it
  // web-app-capable so it opens chromeless. The icon itself comes from
  // app/apple-icon.png, which Next links as the apple-touch-icon automatically.
  appleWebApp: {
    capable: true,
    title: "Flâneur",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#ece8dd",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
