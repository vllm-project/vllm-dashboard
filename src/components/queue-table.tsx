"use client";

export interface Agent {
  id: string;
  name: string;
  queue: string | null;
  state: string;
  ip_address: string;
  hostname: string;
  last_job_finished_at: string | null;
}

function stateColor(state: string) {
  switch (state) {
    case "connected":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400";
    case "disconnected":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400";
    case "stopped":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    case "lost":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400";
    default:
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  }
}

export function QueueTable({ agents }: { agents: Agent[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h3 className="text-sm font-medium text-muted">
          Agents
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-5 py-2.5 font-medium">Name</th>
              <th className="px-5 py-2.5 font-medium">Queue</th>
              <th className="px-5 py-2.5 font-medium">State</th>
              <th className="px-5 py-2.5 font-medium">Hostname</th>
              <th className="px-5 py-2.5 font-medium">IP</th>
              <th className="px-5 py-2.5 font-medium">Last Job</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr
                key={agent.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
              >
                <td className="px-5 py-2.5 font-medium">{agent.name}</td>
                <td className="px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                  {agent.queue ?? "—"}
                </td>
                <td className="px-5 py-2.5">
                  <span
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${stateColor(agent.state)}`}
                  >
                    {agent.state}
                  </span>
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-zinc-500">
                  {agent.hostname}
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-zinc-500">
                  {agent.ip_address}
                </td>
                <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                  {agent.last_job_finished_at
                    ? new Date(agent.last_job_finished_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-zinc-400">
                  No agents found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
