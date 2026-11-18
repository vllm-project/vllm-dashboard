"use client";

import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { Avatar } from "@/components/triage/badges";
import { triageFetcher } from "@/lib/triage-format";
import { OWNER_NONE } from "@/lib/triage-query";

interface Maintainer {
  githubLogin: string;
  openAssignments: number;
}

interface Option {
  value: string | null;
  label: string;
  login?: string;
  hint?: string;
}

/**
 * "Anyone" / "Unowned" / each active maintainer (avatar, login, how many
 * items they own now). Type to filter; arrows move, Enter picks the
 * highlighted (first by default) match, Esc closes.
 */
export function OwnerPicker({
  value,
  onChange,
  className = "",
}: {
  value: string | null;
  onChange: (owner: string | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { data } = useSWR<{ maintainers: Maintainer[] }>("/api/triage/maintainers", triageFetcher, {
    revalidateOnFocus: false,
  });

  const options: Option[] = [
    { value: null, label: "Anyone" },
    { value: OWNER_NONE, label: "Unowned", hint: "no open owner" },
    ...(data?.maintainers ?? []).map((m) => ({
      value: m.githubLogin,
      label: m.githubLogin,
      login: m.githubLogin,
      hint: `${m.openAssignments} open`,
    })),
  ];
  const selected =
    options.find((option) => option.value?.toLowerCase() === value?.toLowerCase()) ??
    (value ? { value, label: value, login: value } : options[0]);
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  const shown = needle
    ? options.filter((option) =>
        `${option.label} ${option.value === OWNER_NONE ? "none unowned nobody" : ""}`.toLowerCase().includes(needle),
      )
    : options;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function openList() {
    setQuery("");
    setActive(Math.max(0, options.findIndex((option) => option.value === selected.value)));
    setOpen(true);
  }

  function pick(option: Option) {
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Owner: ${selected.label}`}
        onClick={() => (open ? setOpen(false) : openList())}
        className={`inline-flex h-8 w-full items-center gap-1.5 rounded-md border bg-white px-2 text-xs shadow-sm shadow-black/[0.02] hover:border-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-zinc-900 dark:hover:border-zinc-600 ${
          value ? "border-zinc-400 text-zinc-900 dark:border-zinc-500 dark:text-zinc-50" : "border-zinc-200 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
        }`}
      >
        {selected.login ? (
          <Avatar login={selected.login} size={16} />
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="5.5" r="2.75" />
            <path d="M2.75 13.5c.75-2.5 2.75-3.75 5.25-3.75s4.5 1.25 5.25 3.75" strokeLinecap="round" />
          </svg>
        )}
        <span className="truncate">{value ? selected.label : "Owner: anyone"}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="ml-auto h-3 w-3 shrink-0 text-zinc-400" fill="currentColor">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-60 rounded-lg border border-zinc-200 bg-white p-1 text-xs shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40">
        <input
          ref={input}
          type="search"
          value={query}
          placeholder="Find an owner…"
          aria-label="Find an owner"
          aria-controls={listId}
          aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(shown.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (shown[active]) pick(shown[active]);
            } else if (event.key === "Escape" || event.key === "Tab") {
              setOpen(false);
            }
          }}
          className="mb-1 h-7 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label="Owner"
          className="max-h-72 overflow-auto"
        >
          {shown.map((option, index) => {
            const isSelected = option.value === selected.value;
            return (
              <li
                key={option.value ?? "anyone"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
                  index === active ? "bg-zinc-100 dark:bg-zinc-800" : ""
                } ${!needle && index === 1 ? "mb-1 border-b border-zinc-100 pb-2 dark:border-zinc-800" : ""}`}
              >
                {option.login ? (
                  <Avatar login={option.login} size={18} />
                ) : (
                  <span aria-hidden="true" className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-zinc-100 text-[10px] text-zinc-500 dark:bg-zinc-800">
                    {option.value === OWNER_NONE ? "∅" : "∗"}
                  </span>
                )}
                <span className={`truncate ${isSelected ? "font-semibold text-zinc-950 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                  {option.label}
                </span>
                {option.hint && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{option.hint}</span>}
                {isSelected && (
                  <span aria-hidden="true" className={`${option.hint ? "" : "ml-auto"} text-zinc-900 dark:text-zinc-100`}>
                    ✓
                  </span>
                )}
              </li>
            );
          })}
          {!data && <li className="px-2 py-1.5 text-zinc-400">Loading maintainers…</li>}
          {data && shown.length === 0 && <li className="px-2 py-1.5 text-zinc-400">No owner matches “{query}”.</li>}
        </ul>
        </div>
      )}
    </div>
  );
}
