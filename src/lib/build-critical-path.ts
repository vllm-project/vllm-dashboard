export interface CriticalPathLane {
  id: string;
  startTime: string;
  endTime: string;
}

/** Lanes finishing within this of the build's end all bound its duration. */
const TERMINAL_WINDOW_MS = 60_000;
/** Clock skew between agents: a gate may appear to end just after a start. */
const TOLERANCE_MS = 2_000;
/** A gate releases at least this many starts within GATE_WINDOW_MS, or 5% of
 *  the build's lanes if larger: in a 460-job build, six starts inside any
 *  given 15s is routine and proves nothing. */
const GATE_MIN_FANOUT = 5;
const GATE_MIN_FANOUT_RATIO = 0.05;
const GATE_WINDOW_MS = 15_000;
/** Starts in the window before a gate ended count against it: a burst that
 *  was already under way means the lane merely finished during it. */
const GATE_ONSET_PENALTY = 3;
/** A lane starting within this long after a gate ended is attributed to it. */
const ATTRIBUTION_WINDOW_MS = 60_000;

interface ParsedLane {
  id: string;
  start: number;
  end: number;
}

interface Gate extends ParsedLane {
  score: number;
}

/**
 * Buildkite spans carry neither `depends_on` nor a usable queue wait, so a
 * dependency is recognised by its effect: when a gating job (bootstrap, an
 * image build) finishes, a burst of dependants starts within seconds. A lane
 * that merely finishes while such a burst is already under way is not a gate,
 * which is what the onset penalty rejects.
 */
function findGates(lanes: ParsedLane[]): Gate[] {
  const starts = lanes.map((lane) => lane.start).sort((a, b) => a - b);
  const countStarts = (from: number, to: number) => {
    // Inclusive [from, to] on a sorted array.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] < from) low = mid + 1;
      else high = mid;
    }
    let count = 0;
    for (let index = low; index < starts.length && starts[index] <= to; index++) count++;
    return count;
  };
  const minFanout = Math.max(
    GATE_MIN_FANOUT,
    Math.ceil(lanes.length * GATE_MIN_FANOUT_RATIO),
  );
  const gates: Gate[] = [];
  for (const lane of lanes) {
    const after = countStarts(lane.end - TOLERANCE_MS + 1, lane.end + GATE_WINDOW_MS);
    const before = countStarts(lane.end - GATE_WINDOW_MS, lane.end - TOLERANCE_MS);
    if (after < minFanout || before * GATE_ONSET_PENALTY > after) continue;
    gates.push({ ...lane, score: after - GATE_ONSET_PENALTY * before });
  }
  return gates;
}

/**
 * Infer the chain of lanes that set the build's duration.
 *
 * The lanes that finish last (within a minute of the build's end) are
 * build-limiting by definition. Each is then traced back through the gate it
 * most plausibly waited on: the strongest gate that ended shortly before it
 * started. The result is the critical path, typically one or two long jobs
 * plus the image builds and bootstrap that gated them, rather than every job
 * that briefly held the furthest end time while the build fanned out.
 */
export function criticalPathIds(lanes: CriticalPathLane[]): Set<string> {
  const chain = new Set<string>();
  const parsed: ParsedLane[] = lanes
    .map((lane) => ({
      id: lane.id,
      start: Date.parse(lane.startTime),
      end: Date.parse(lane.endTime),
    }))
    .filter((lane) => Number.isFinite(lane.start) && Number.isFinite(lane.end));
  if (parsed.length === 0) return chain;

  const buildEnd = Math.max(...parsed.map((lane) => lane.end));
  const gates = findGates(parsed);
  const pending = parsed.filter((lane) => lane.end >= buildEnd - TERMINAL_WINDOW_MS);
  for (const lane of pending) chain.add(lane.id);

  while (pending.length > 0) {
    const lane = pending.pop() as ParsedLane;
    let predecessor: Gate | null = null;
    for (const gate of gates) {
      if (chain.has(gate.id)) continue;
      if (gate.end > lane.start + TOLERANCE_MS) continue;
      if (lane.start - gate.end > ATTRIBUTION_WINDOW_MS) continue;
      if (
        !predecessor ||
        gate.score > predecessor.score ||
        (gate.score === predecessor.score && gate.end > predecessor.end)
      ) {
        predecessor = gate;
      }
    }
    if (!predecessor) continue;
    chain.add(predecessor.id);
    pending.push(predecessor);
  }
  return chain;
}
