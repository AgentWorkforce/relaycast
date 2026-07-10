"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthControls } from "./AuthControls";
import { LogoIcon, LogoWordmark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-20 border-b border-[var(--nav-border)] transition-[border-color,box-shadow] duration-200 ${
        scrolled
          ? "bg-[var(--nav-bg)] backdrop-blur-xl shadow-lg"
          : "bg-[var(--nav-solid-bg)] shadow-sm"
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <LogoIcon className="h-6" />
          <LogoWordmark className="h-5" />
        </Link>
        <div className="ml-auto flex items-center gap-4">
          <ThemeToggle
            borderClassName="border-[var(--nav-border)]"
            hoverBorderClassName="hover:border-[var(--nav-border-strong)]"
            hoverBgClassName="hover:bg-[var(--nav-surface-hover)]"
            textClassName="text-[var(--nav-fg)]"
            className="bg-[var(--nav-surface)]"
          />
          <AuthControls />
        </div>
      </div>
    </header>
  );
}
