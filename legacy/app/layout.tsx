import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const appName = process.env.APP_NAME ?? "Asklepio";

export const metadata: Metadata = {
  title: `${appName} — Sağlık Turizmi Meta Ads Agent`,
  description: "Klinikler için otomatik A/B testi ve ROAS bazlı bütçe yönetimi",
};

const navItems = [
  { href: "/", label: "Genel Bakış" },
  { href: "/kampanyalar", label: "Kampanyalar" },
  { href: "/testler", label: "A/B Testleri" },
  { href: "/leads", label: "Lead Takibi" },
  { href: "/medya", label: "Medya" },
  { href: "/whatsapp", label: "WhatsApp" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="tr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 font-bold text-white">
                {appName.charAt(0).toUpperCase()}
              </span>
              <span className="font-semibold">{appName}</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {navItems.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}