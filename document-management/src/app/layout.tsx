import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Document Management System · Aurum Ventura",
    template: "%s · Aurum Ventura",
  },
  description:
    "Store, organize, and manage all business documents securely in one place.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#5b3fe0",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
