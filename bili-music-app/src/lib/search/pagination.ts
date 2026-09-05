export const MAX_SEARCH_PAGES = 10;
export function validTotalPages(value: unknown, itemCount = 0): number | undefined {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (number === 0 && itemCount > 0)) return undefined;
  return number;
}
export function pageLimit(totalPages?: number): number {
  const total = Number.isSafeInteger(totalPages) && Number(totalPages) >= 0 ? Number(totalPages) : MAX_SEARCH_PAGES;
  return Math.max(1, Math.min(MAX_SEARCH_PAGES, total));
}
export function pageNumbers(current: number, maximum: number): Array<number | "gap"> {
  const end = pageLimit(maximum);
  if (end <= 7) return Array.from({ length: end }, (_, index) => index + 1);
  const wanted = new Set([1, end, current - 1, current, current + 1]);
  if (current <= 3) for (let page = 2; page <= 4; page++) wanted.add(page);
  if (current >= end - 2) for (let page = end - 3; page < end; page++) wanted.add(page);
  const sorted = [...wanted].filter((page) => page >= 1 && page <= end).sort((a, b) => a - b);
  const items: Array<number | "gap"> = [];
  for (const page of sorted) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      if (page - previous === 2) items.push(previous + 1);
      else items.push("gap");
    }
    items.push(page);
  }
  return items;
}
