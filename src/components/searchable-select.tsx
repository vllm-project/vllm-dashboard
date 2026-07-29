"use client";

import { useState, useRef, useEffect, useId } from "react";

interface SearchableSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  allLabel?: string;
  /** Optional per-option count, shown muted on the right (e.g. datapoints). */
  counts?: Record<string, number>;
}

export function SearchableSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  counts,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerId = useId();
  const listboxId = useId();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const filtered = !search
    ? options
    : options
        .filter((o) => o.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
          const al = a.toLowerCase();
          const bl = b.toLowerCase();
          const s = search.toLowerCase();
          // Exact match first
          if (al === s && bl !== s) return -1;
          if (bl === s && al !== s) return 1;
          // Starts-with next
          const aStarts = al.startsWith(s);
          const bStarts = bl.startsWith(s);
          if (aStarts && !bStarts) return -1;
          if (bStarts && !aStarts) return 1;
          // Then by match position
          return al.indexOf(s) - bl.indexOf(s);
        });

  return (
    <div
      ref={ref}
      className="relative w-full min-w-0 sm:w-auto"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          setSearch("");
        }
      }}
    >
      <label
        htmlFor={triggerId}
        className="mb-1 block text-xs font-medium tracking-[0.01em] text-zinc-500 dark:text-zinc-400"
      >
        {label}
      </label>
      <button
        id={triggerId}
        type="button"
        onClick={() => setOpen(!open)}
        title={value || allLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className="dashboard-control flex min-h-11 w-full items-center justify-between rounded-md border border-zinc-200 bg-white px-3 text-left text-sm shadow-sm hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 sm:min-h-10 sm:w-52"
      >
        <span className={`min-w-0 truncate ${value ? "" : "text-zinc-400"}`}>
          {value || allLabel}
        </span>
        <svg
          className={`ml-2 h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 ease-[var(--ease-out)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="dashboard-popover absolute left-0 z-50 mt-2 w-full min-w-64 rounded-lg border border-black/10 bg-white shadow-[0_16px_40px_rgba(0,0,0,0.14)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_20px_50px_rgba(0,0,0,0.45)] sm:w-72">
          <div className="border-b border-zinc-200 p-2 dark:border-zinc-700">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}...`}
              aria-label={`Search ${label.toLowerCase()}`}
              className="min-h-10 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="max-h-60 overflow-y-auto py-1"
          >
            {allLabel && (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 sm:min-h-10 ${
                    !value ? "font-medium text-blue-600 dark:text-blue-400" : ""
                  }`}
                >
                  {allLabel}
                </button>
              </li>
            )}
            {filtered.map((option) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === option}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 sm:min-h-10 ${
                    value === option
                      ? "font-medium text-blue-600 dark:text-blue-400"
                      : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{option}</span>
                  {counts?.[option] !== undefined && (
                    <span className="shrink-0 tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
                      {counts[option]}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="flex min-h-11 items-center px-3 py-2 text-sm text-zinc-400">
                No matches
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
