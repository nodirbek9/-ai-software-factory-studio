import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface VirtualRowsProps<T> {
  items: readonly T[];
  /** Every row has exactly this height (px); variable heights are not supported by design. */
  rowHeight: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** Stable key per item; also used to keep the scroll position when rows are prepended. Defaults to the index. */
  getKey?: (item: T, index: number) => string | number;
  /** Fired once per list length when the user scrolls within `endThreshold` rows of the end. */
  onEndReached?: () => void;
  endThreshold?: number;
  /** Viewport height used until the element is measured (jsdom and the first paint report 0). */
  fallbackHeight?: number;
  className?: string;
  ariaLabel?: string;
  ariaBusy?: boolean;
}

/** Index range [start, end) of the rows to render for a scroll position. */
export function windowRange(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan: number): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + viewport) / rowHeight);
  return { start: Math.min(count, Math.max(0, first - overscan)), end: Math.min(count, Math.max(0, last + overscan)) };
}

const MAX_ANCHOR_SCAN = 5000;

/** Fixed-row-height windowed list: only the visible rows (plus overscan) exist in the DOM, so 50k+ rows stay cheap. */
export function VirtualRows<T>({
  items, rowHeight, overscan = 8, renderRow, getKey, onEndReached, endThreshold = 10, fallbackHeight = 480, className, ariaLabel, ariaBusy,
}: VirtualRowsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  const firedFor = useRef(-1);
  const firstKey = useRef<string | number | null>(null);
  const keyOf = (item: T, index: number): string | number => (getKey ? getKey(item, index) : index);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setMeasured(element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Rows prepended above a scrolled-down viewport must not move what the user is reading.
  useLayoutEffect(() => {
    const element = ref.current;
    const previous = firstKey.current;
    const current = items.length ? keyOf(items[0], 0) : null;
    firstKey.current = current;
    if (items.length < firedFor.current) firedFor.current = -1;
    if (!element || !getKey || previous === null || previous === current || element.scrollTop <= 0) return;
    const limit = Math.min(items.length, MAX_ANCHOR_SCAN);
    for (let index = 1; index < limit; index += 1) {
      if (keyOf(items[index], index) === previous) {
        element.scrollTop += index * rowHeight;
        setScrollTop(element.scrollTop);
        return;
      }
    }
  }, [items]);

  const viewport = measured > 0 ? measured : fallbackHeight;
  const { start, end } = windowRange(items.length, rowHeight, scrollTop, viewport, overscan);

  function handleScroll() {
    const element = ref.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    if (!onEndReached || firedFor.current === items.length) return;
    if (element.scrollTop + viewport >= (items.length - endThreshold) * rowHeight) {
      firedFor.current = items.length;
      onEndReached();
    }
  }

  const rows: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    rows.push(
      <div key={keyOf(item, index)} role="listitem" className="absolute inset-x-0" style={{ top: index * rowHeight, height: rowHeight }}>
        {renderRow(item, index)}
      </div>,
    );
  }

  return (
    <div ref={ref} role="list" aria-label={ariaLabel} aria-busy={ariaBusy} onScroll={handleScroll} className={cn('relative min-h-0 overflow-y-auto', className)}>
      <div className="relative w-full" style={{ height: items.length * rowHeight }}>{rows}</div>
    </div>
  );
}
