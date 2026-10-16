import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPreset, createLayout, minimizePanel, toggleMaximize } from './layout';
import { LayoutView } from './LayoutView';

// jsdom has no ResizeObserver, which react-resizable-panels needs to measure its groups.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  (document.defaultView as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  delete (document.defaultView as unknown as Record<string, unknown>).ResizeObserver;
});

const renderPanel = (id: string) => <div data-testid={`content-${id}`}>Panel {id}</div>;

function contents() {
  return screen.queryAllByTestId(/^content-/).map((el) => el.getAttribute('data-testid'));
}

describe('LayoutView', () => {
  it('renders every panel of preset 4 through renderPanel, in reading order', () => {
    const onResize = vi.fn();
    render(<LayoutView layout={createLayout(4)} renderPanel={renderPanel} onResize={onResize} />);
    expect(contents()).toEqual(['content-p1', 'content-p2', 'content-p3', 'content-p4']);
    // 2x2 = one separator between the rows plus one inside each row
    expect(screen.getAllByLabelText('Resize panels')).toHaveLength(3);
    // only user drags report a resize, not the initial layout
    expect(onResize).not.toHaveBeenCalled();
  });

  it('renders a single panel without any separator', () => {
    render(<LayoutView layout={createLayout(1)} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p1']);
    expect(screen.queryAllByLabelText('Resize panels')).toHaveLength(0);
  });

  it('renders the other presets with the right number of panels and separators', () => {
    const expected: [1 | 2 | 3 | 5 | 6 | 8, number, number][] = [
      [2, 2, 1],
      [3, 3, 2],
      [5, 5, 1 + 2 + 1],
      [6, 6, 1 + 2 + 2],
      [8, 8, 1 + 3 + 3],
    ];
    for (const [preset, panels, separators] of expected) {
      const { unmount } = render(<LayoutView layout={createLayout(preset)} renderPanel={renderPanel} onResize={() => {}} />);
      expect(contents()).toHaveLength(panels);
      expect(screen.queryAllByLabelText('Resize panels')).toHaveLength(separators);
      unmount();
    }
  });

  it('renders only the maximized panel', () => {
    const layout = toggleMaximize(createLayout(4), 'p2');
    render(<LayoutView layout={layout} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p2']);
    expect(screen.queryAllByLabelText('Resize panels')).toHaveLength(0);
  });

  it('does not render minimized panels', () => {
    const layout = minimizePanel(createLayout(4), 'p3');
    render(<LayoutView layout={layout} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p1', 'content-p2', 'content-p4']);
    expect(screen.queryByTestId('content-p3')).toBeNull();
    // rows: p1|p2 has a separator, p4 stands alone; the two rows are separated
    expect(screen.getAllByLabelText('Resize panels')).toHaveLength(2);
  });

  it('collapses a split whose panels are all minimized', () => {
    const layout = minimizePanel(minimizePanel(createLayout(4), 'p3'), 'p4');
    render(<LayoutView layout={layout} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p1', 'content-p2']);
    expect(screen.getAllByLabelText('Resize panels')).toHaveLength(1);
  });

  it('follows layout changes (preset switch, panel restored)', () => {
    const { rerender } = render(<LayoutView layout={createLayout(4)} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toHaveLength(4);
    rerender(<LayoutView layout={applyPreset(createLayout(4), 2)} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p1', 'content-p2']);
    rerender(<LayoutView layout={createLayout(3)} renderPanel={renderPanel} onResize={() => {}} />);
    expect(contents()).toEqual(['content-p1', 'content-p2', 'content-p3']);
  });
});
