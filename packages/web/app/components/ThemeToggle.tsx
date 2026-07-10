"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";

type Theme = "dark" | "light";

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 2.5v2.1M10 15.4v2.1M17.5 10h-2.1M4.6 10H2.5M15.3 4.7l-1.5 1.5M6.2 13.8l-1.5 1.5M15.3 15.3l-1.5-1.5M6.2 6.2 4.7 4.7" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
      <path d="M15.5 12.8A6.9 6.9 0 1 1 7.2 4.5a5.6 5.6 0 0 0 8.3 8.3Z" />
    </svg>
  );
}

function getTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }

  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(next: Theme) {
  const root = document.documentElement;
  root.classList.add("theme-transitioning");
  root.dataset.theme = next;
  root.style.colorScheme = next;

  try {
    localStorage.setItem("agentrelay-theme", next);
  } catch {}

  window.setTimeout(() => root.classList.remove("theme-transitioning"), 300);
}

interface ThemeToggleProps {
  className?: string;
  borderClassName?: string;
  hoverBorderClassName?: string;
  hoverBgClassName?: string;
  textClassName?: string;
}

export function ThemeToggle({
  className,
  borderClassName = "border-[var(--border-default)]",
  hoverBorderClassName = "hover:border-[var(--border-strong)]",
  hoverBgClassName = "hover:bg-[var(--surface-strong)]",
  textClassName = "text-[var(--fg-muted)] hover:text-[var(--fg)]",
}: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={clsx(
        "inline-flex h-10 w-10 items-center justify-center rounded-full border bg-[var(--surface-glass)] transition-colors",
        borderClassName,
        hoverBorderClassName,
        hoverBgClassName,
        textClassName,
        className,
      )}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
