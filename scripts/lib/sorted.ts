export function lowerBound<T>(items: T[], value: number, time: (item: T) => number): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time(items[middle]) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
export function timeRange<T extends { time: number }>(items: T[], start: number, end: number) {
  return items.slice(
    lowerBound(items, start, (item) => item.time),
    lowerBound(items, end + Number.EPSILON * Math.max(1, end), (item) => item.time),
  );
}
