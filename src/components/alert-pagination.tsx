/**
 * Shared pager for the alert lists. Both feeds can run to hundreds of cards in
 * a busy week, and both page them ten at a time.
 */
export function AlertPagination({
  currentPage,
  pageCount,
  total,
  unit,
  onPageChange,
}: {
  currentPage: number;
  pageCount: number;
  total: number;
  unit: { one: string; many: string };
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
      <span>
        Page {currentPage + 1} of {pageCount} · {total}{" "}
        {total === 1 ? unit.one : unit.many}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={currentPage === 0}
          onClick={() => onPageChange(currentPage - 1)}
          className="dashboard-control rounded-full border border-zinc-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-zinc-700"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={currentPage >= pageCount - 1}
          onClick={() => onPageChange(currentPage + 1)}
          className="dashboard-control rounded-full border border-zinc-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-zinc-700"
        >
          Next
        </button>
      </div>
    </div>
  );
}
