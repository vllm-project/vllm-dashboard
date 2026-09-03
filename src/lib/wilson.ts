/**
 * Wilson score lower bound for a binomial proportion.
 *
 * Raw failure rates over-rank jobs with few runs (5/5 failed beats 29/45).
 * The 95% lower bound answers "how bad is this job at worst, given the
 * evidence?", which orders noisy small-sample rates below well-established
 * ones. Returns a fraction in [0, 1].
 */
export function wilsonLowerBound(
  failures: number,
  total: number,
  z = 1.96,
): number {
  if (total <= 0) return 0;
  const p = failures / total;
  const z2 = z * z;
  const center = p + z2 / (2 * total);
  const margin =
    z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  const lower = (center - margin) / (1 + z2 / total);
  return Math.max(0, Math.min(1, lower));
}
