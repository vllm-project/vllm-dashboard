export const PERF_DATA_START_DATE = "2026-06-14";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePerfDataStartDate(value?: string | null): string {
  if (!value || !ISO_DATE_PATTERN.test(value)) return PERF_DATA_START_DATE;

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return PERF_DATA_START_DATE;
  }

  return value;
}

export function perfDataStartCondition(value?: string | null): string {
  return `message:date::STRING >= '${resolvePerfDataStartDate(value)}'`;
}

export const PERF_DATA_START_CONDITION = perfDataStartCondition();
