export type QueueView = "details" | "traffic";

type QueueSearchParams = Pick<URLSearchParams, "get" | "toString">;

export function getQueueView(params: QueueSearchParams): QueueView {
  return params.get("view") === "traffic" ? "traffic" : "details";
}

export function queueViewHref(
  params: QueueSearchParams,
  view: QueueView,
): string {
  const next = new URLSearchParams(
    getQueueView(params) === view ? params.toString() : "",
  );
  next.set("view", view);
  const range = params.get("range");
  if (range !== null) next.set("range", range);
  if (view === "details") {
    const queue = params.get("queue");
    if (queue) next.set("queue", queue);
  }
  return `/queue?${next}`;
}
