/** A stable two-group partition, not a score or a new provider request. */
export function followedFirst<T>(items: T[], isFollowed: (item: T) => boolean): T[] {
  const followed: T[] = [];
  const other: T[] = [];
  for (const item of items) (isFollowed(item) ? followed : other).push(item);
  return [...followed, ...other];
}
