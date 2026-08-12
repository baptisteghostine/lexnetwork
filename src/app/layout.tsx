import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rolo",
  description: "Personal CRM — never lose touch",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full font-sans text-[13px]">{children}</body>
    </html>
  );
}
