"use client";

import { useState, useRef, useEffect, useId } from "react";

interface MultiSelectProps {
  label: string;
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  options: string[];
  placeholder?: string;
}

export function MultiSelect({
  label,
  selected,
  onChange,
  options,
  placeholder = "All",
}: MultiSelectProps) {
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
          if (al === s && bl !== s) return -1;
          if (bl === s && al !== s) return 1;
          const aStarts = al.startsWith(s);
          const bStarts = bl.startsWith(s);
          if (aStarts && !bStarts) return -1;
          if (bStarts && !aStarts) return 1;
          return al.indexOf(s) - bl.indexOf(s);
        });

  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  };

  const buttonLabel =
    selected.size === 0
      ? placeholder
      : selected.size === 1
        ? [...selected][0]
        : `${selected.size} groups`;

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
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className="dashboard-control flex w-full items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-left text-sm shadow-sm hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 sm:w-48"
      >
        <span className={`min-w-0 truncate ${selected.size === 0 ? "text-zinc-400" : ""}`}>
          {buttonLabel}
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
        <div className="dashboard-popover absolute left-0 z-50 mt-1 w-full min-w-64 rounded-lg border border-black/10 bg-white shadow-[0_16px_40px_rgba(0,0,0,0.14)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_20px_50px_rgba(0,0,0,0.45)] sm:w-72">
          <div className="border-b border-zinc-200 p-2 dark:border-zinc-700">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search groups..."
              aria-label={`Search ${label.toLowerCase()}`}
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>
          <div className="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-700">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChange(new Set(options))}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                Select all
              </button>
              <span className="text-zinc-300 dark:text-zinc-600">|</span>
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                Clear
              </button>
            </div>
          </div>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
            className="max-h-60 overflow-y-auto py-1"
          >
            {filtered.map((option) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected.has(option)}
                  onClick={() => toggle(option)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <span
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                      selected.has(option)
                        ? "border-blue-500 bg-blue-500 text-white"
                        : "border-zinc-300 dark:border-zinc-600"
                    }`}
                  >
                    {selected.has(option) && (
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  {option}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-zinc-400">No matches</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
