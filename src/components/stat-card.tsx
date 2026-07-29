interface StatCardProps {
  label: string;
  value: string | number;
  detail?: string;
  color?: "green" | "red" | "yellow" | "default";
  className?: string;
}

const colorMap = {
  green: "text-emerald-600 dark:text-emerald-400",
  red: "text-red-600 dark:text-red-400",
  yellow: "text-yellow-600 dark:text-yellow-400",
  default: "text-zinc-900 dark:text-zinc-100",
};

export function StatCard({
  label,
  value,
  detail,
  color = "default",
  className = "",
}: StatCardProps) {
  return (
    <div className={`rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950 ${className}`}>
      <p className="text-xs font-medium text-zinc-500 sm:text-sm dark:text-zinc-400">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight sm:text-3xl ${colorMap[color]}`}>
        {value}
      </p>
      {detail && (
        <p className="mt-1 text-xs leading-5 text-zinc-500 sm:text-sm dark:text-zinc-400">
          {detail}
        </p>
      )}
    </div>
  );
}
