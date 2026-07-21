"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { PERF_DATA_START_DATE } from "@/lib/perf-data";

interface PerfSettingsValue {
  startDate: string;
  setStartDate: (date: string) => void;
}

const PerfSettingsContext = createContext<PerfSettingsValue | null>(null);

export function PerfSettingsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [startDate, setStartDate] = useState(PERF_DATA_START_DATE);

  return (
    <PerfSettingsContext.Provider value={{ startDate, setStartDate }}>
      {children}
    </PerfSettingsContext.Provider>
  );
}

export function usePerfSettings(): PerfSettingsValue {
  const value = useContext(PerfSettingsContext);
  if (!value) {
    throw new Error("usePerfSettings must be used within PerfSettingsProvider");
  }
  return value;
}

export function PerfSettingsMenu() {
  const { startDate, setStartDate } = usePerfSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const overridden = startDate !== PERF_DATA_START_DATE;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative ml-auto self-center">
      <button
        type="button"
        aria-label="Performance settings"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        title="Performance settings"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.75}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.592c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.245a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.7 7.7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.956.259 1.431l-1.296 2.245a1.125 1.125 0 0 1-1.37.49l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.6 6.6 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.542-.56.94-1.11.94h-2.592c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.645-.87a6.5 6.5 0 0 1-.22-.127c-.325-.196-.72-.257-1.075-.124l-1.217.456a1.125 1.125 0 0 1-1.37-.49l-1.296-2.245a1.125 1.125 0 0 1 .26-1.431l1.003-.827c.293-.241.438-.613.43-.992a6.8 6.8 0 0 1 0-.255c.008-.378-.137-.75-.43-.991l-1.004-.827a1.125 1.125 0 0 1-.259-1.431l1.296-2.245a1.125 1.125 0 0 1 1.37-.49l1.217.456c.355.133.75.072 1.076-.124.072-.044.146-.086.22-.128.331-.183.581-.495.644-.869l.213-1.281Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </svg>
        {overridden && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-indigo-500 ring-2 ring-white dark:ring-zinc-950" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-3">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Performance data
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Choose the earliest benchmark date to include on this tab.
            </p>
          </div>
          <label
            htmlFor="perf-start-date"
            className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300"
          >
            Show data from
          </label>
          <input
            id="perf-start-date"
            type="date"
            value={startDate}
            onInput={(event) =>
              setStartDate(event.currentTarget.value || PERF_DATA_START_DATE)
            }
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Default: Jun 14, 2026
            </span>
            <button
              type="button"
              onClick={() => setStartDate(PERF_DATA_START_DATE)}
              disabled={!overridden}
              className="text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-500 disabled:cursor-default disabled:text-zinc-300 dark:text-indigo-400 dark:hover:text-indigo-300 dark:disabled:text-zinc-600"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
