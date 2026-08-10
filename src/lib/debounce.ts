export interface Debounced<T extends unknown[]> {
  (...a: T): void;
  cancel(): void;
}

export function debounce<T extends unknown[]>(ms: number, fn: (...a: T) => void): Debounced<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = ((...a: T) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as Debounced<T>;
  d.cancel = () => clearTimeout(t);
  return d;
}
