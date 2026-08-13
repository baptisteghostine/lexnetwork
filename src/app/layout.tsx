import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rolo",
  description: "Personal CRM — never lose touch",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Light is the default; the ThemeToggle writes this cookie so SSR can
  // render the chosen theme without a flash.
  const theme = (await cookies()).get("rolo-theme")?.value;
  return (
    <html
      lang="en"
      className={`${theme === "dark" ? "dark " : ""}h-full antialiased`}
    >
      <body className="min-h-full font-sans text-[13px]">{children}</body>
    </html>
  );
}
