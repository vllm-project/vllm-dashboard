"use client";

// Stateless: the inline <head> script sets the initial `.dark` class on
// <html>, and the icons below show/hide purely via the `dark:` CSS variant,
// so there is nothing to hydrate. The button just flips the class + storage.
export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.classList.contains("dark")
      ? "light"
      : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light/dark theme"
      className="rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {/* Sun — shown in dark mode */}
      <svg className="hidden h-4 w-4 dark:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <circle cx="12" cy="12" r="4" />
        <path strokeLinecap="round" d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M19.07 4.93l-1.41 1.41M6.34 17.66l-1.41 1.41" />
      </svg>
      {/* Moon — shown in light mode */}
      <svg className="h-4 w-4 dark:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    </button>
  );
}
