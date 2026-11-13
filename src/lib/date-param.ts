// startDate / endDate as the CI routes accept them: a date, or a full ISO
// timestamp from a drag-zoom. Anything else is refused before it reaches a
// query or a cache key.
const DATE_PARAM =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function isValidDateParam(value: string | null): boolean {
  return (
    value === null ||
    value === "" ||
    (DATE_PARAM.test(value) && !Number.isNaN(new Date(value).getTime()))
  );
}
