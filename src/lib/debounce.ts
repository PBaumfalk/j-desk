export function debounce<T extends unknown[]>(ms: number, fn: (...a: T) => void): (...a: T) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: T) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
