import { useState, type ReactElement } from 'react';
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NodeCatalogEntry, ProviderInfo, WorkflowGraph, WorkflowIssue, WorkflowNodeType } from '@asf/shared';
import { createEditorState, select, type EditorState } from './graphState';
import { NodeInspector } from './NodeInspector';
import { NODE_DRAG_TYPE, NodePalette } from './NodePalette';
import { WorkflowCanvas } from './WorkflowCanvas';

// jsdom cannot lay out or measure a flow, so ReactFlow itself is replaced by a stub that records its props. The
// canvas logic under test (selection, connect errors, keyboard, drop) lives in WorkflowCanvas, not in xyflow.
interface FlowProps {
  nodes: { id: string; selected?: boolean }[];
  onConnect: (connection: unknown) => void;
}
const flow = vi.hoisted(() => ({ props: null as unknown }));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: FlowProps) => {
      flow.props = props;
      return (
        <div data-testid="flow">
          {props.nodes.map((node) => <span key={node.id} data-testid={`node-${node.id}`} data-selected={String(Boolean(node.selected))} />)}
          <input aria-label="inside input" />
        </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

const connectEdge = (source: string, target: string): void => {
  act(() => (flow.props as FlowProps).onConnect({ source, target, sourceHandle: 'out', targetHandle: null }));
};
const disabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;
const valueOf = (element: HTMLElement): string => (element as HTMLInputElement).value;

// ------------------------------------------------------------------ fixtures

const entry = (type: WorkflowNodeType, patch: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry => ({
  type,
  label: type[0].toUpperCase() + type.slice(1),
  category: 'agent',
  description: `${type} description`,
  executable: true,
  plannedReason: null,
  role: null,
  handles: { input: true, outputs: ['out'] },
  fields: [],
  ...patch,
});

const AGENT_FIELDS: NodeCatalogEntry['fields'] = [
  { key: 'providerId', label: 'Provider', type: 'provider' },
  { key: 'model', label: 'Model', type: 'model' },
  { key: 'effort', label: 'Effort', type: 'effort' },
];

const CATALOG: NodeCatalogEntry[] = [
  entry('trigger', { category: 'trigger', handles: { input: false, outputs: ['out'] } }),
  entry('backend', { fields: AGENT_FIELDS }),
  entry('qa', {
    label: 'QA',
    fields: [
      { key: 'maxAttempts', label: 'Attempts', type: 'number', default: 2, min: 1, max: 5 },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'mode', label: 'Mode', type: 'select', default: 'full', options: [{ value: 'full', label: 'Full' }, { value: 'quick', label: 'Quick' }] },
      { key: 'strict', label: 'Strict mode', type: 'boolean', default: false },
    ],
  }),
  entry('quality-gate', { label: 'Quality gate', category: 'control', handles: { input: true, outputs: ['pass', 'fail'] } }),
  entry('deploy', { category: 'output', executable: false, plannedReason: 'Deploy targets arrive in a later phase.' }),
];

const provider = (id: string, models: string[]): ProviderInfo => ({
  id,
  label: id.toUpperCase(),
  kind: 'cli',
  editsFiles: true,
  settings: {},
  isAi: true,
  enabled: true,
  available: true,
  version: null,
  reason: null,
  models,
  defaultModel: '',
  budgetUsd: null,
  spentUsd: 0,
  limitedUntil: null,
});

const PROVIDERS: ProviderInfo[] = [provider('alpha', ['alpha-1', 'alpha-2']), provider('beta', ['beta-1'])];

const node = (id: string, type: WorkflowNodeType, x = 0, y = 0, config: Record<string, unknown> = {}) => ({ id, type, position: { x, y }, config });

function graph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [node('trigger-1', 'trigger'), node('backend-1', 'backend', 240, 0, { providerId: 'alpha', model: 'alpha-1' }), node('qa-1', 'qa', 480, 0)],
    edges: [
      { id: 'trigger-1->backend-1', source: 'trigger-1', target: 'backend-1' },
      { id: 'backend-1->qa-1', source: 'backend-1', target: 'qa-1' },
    ],
  };
}

const selected = (...ids: string[]): EditorState => select(createEditorState(graph()), ids);

/** The last state a component reported through onChange. */
function lastState(onChange: ReturnType<typeof vi.fn>): EditorState {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1][0] as EditorState;
}

const configOf = (state: EditorState, id: string): Record<string, unknown> | undefined => state.graph.nodes.find((n) => n.id === id)?.config;
const nodeIds = (state: EditorState): string[] => state.graph.nodes.map((n) => n.id);

/** Keeps the editor state like the page does, so several events chain on each other. */
function Harness({ initial, readOnly = false, onChange }: { initial: EditorState; readOnly?: boolean; onChange: (state: EditorState) => void }): ReactElement {
  const [state, setState] = useState(initial);
  return (
    <WorkflowCanvas
      state={state}
      catalog={CATALOG}
      readOnly={readOnly}
      onChange={(next) => {
        setState(next);
        onChange(next);
      }}
    />
  );
}

const region = (): HTMLElement => screen.getByRole('region', { name: 'Workflow canvas' });

// ------------------------------------------------------------------ palette

describe('NodePalette', () => {
  it('groups entries by category and filters by the search text', () => {
    render(<NodePalette catalog={CATALOG} onAdd={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Triggers' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Control' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'gate' } });
    expect(screen.getByRole('button', { name: /Quality gate/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Backend/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No node matches/)).toBeTruthy();
  });

  it('disables planned entries, shows their reason and never adds them', () => {
    const onAdd = vi.fn();
    render(<NodePalette catalog={CATALOG} onAdd={onAdd} />);
    const planned = screen.getByRole('button', { name: /Deploy/ });
    expect(disabled(planned)).toBe(true);
    expect(planned.getAttribute('draggable')).not.toBe('true');
    expect(screen.getByText(/Deploy targets arrive in a later phase/)).toBeTruthy();
    fireEvent.click(planned);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('adds an executable node on click and starts a drag carrying its type', () => {
    const onAdd = vi.fn();
    render(<NodePalette catalog={CATALOG} onAdd={onAdd} />);
    const backend = screen.getByRole('button', { name: /Backend/ });
    expect(backend.getAttribute('draggable')).toBe('true');
    fireEvent.click(backend);
    expect(onAdd).toHaveBeenCalledWith('backend');

    const setData = vi.fn();
    fireEvent.dragStart(backend, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(NODE_DRAG_TYPE, 'backend');
  });

  it('locks every entry while the workflow is read-only', () => {
    const onAdd = vi.fn();
    render(<NodePalette catalog={CATALOG} onAdd={onAdd} readOnlyReason="Built-in template." />);
    expect(screen.getByText('Built-in template.')).toBeTruthy();
    for (const button of screen.getAllByRole('button')) expect(disabled(button)).toBe(true);
  });
});

// ------------------------------------------------------------------ inspector

describe('NodeInspector', () => {
  const renderInspector = (state: EditorState, extra: Partial<Parameters<typeof NodeInspector>[0]> = {}) => {
    const onChange = vi.fn();
    render(<NodeInspector state={state} catalog={CATALOG} providers={PROVIDERS} onChange={onChange} {...extra} />);
    return onChange;
  };

  it('shows a graph summary and a hint when nothing is selected', () => {
    renderInspector(selected());
    expect(screen.getByText('Nodes').nextSibling?.textContent).toBe('3');
    expect(screen.getByText('Connections').nextSibling?.textContent).toBe('2');
    expect(screen.getByText(/Select a node or a connection/)).toBeTruthy();
  });

  it('edits the label and reports the updated graph', () => {
    const onChange = renderInspector(selected('qa-1'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Verify' } });
    expect(lastState(onChange).graph.nodes.find((n) => n.id === 'qa-1')?.label).toBe('Verify');
  });

  it('builds the form from the catalog fields and writes config edits', () => {
    const onChange = renderInspector(selected('qa-1'));
    expect(valueOf(screen.getByLabelText('Attempts'))).toBe('2');

    fireEvent.change(screen.getByLabelText('Attempts'), { target: { value: '4' } });
    expect(configOf(lastState(onChange), 'qa-1')?.maxAttempts).toBe(4);

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'check the API' } });
    expect(configOf(lastState(onChange), 'qa-1')?.notes).toBe('check the API');

    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'quick' } });
    expect(configOf(lastState(onChange), 'qa-1')?.mode).toBe('quick');

    fireEvent.click(screen.getByLabelText('Strict mode'));
    expect(configOf(lastState(onChange), 'qa-1')?.strict).toBe(true);
  });

  it('clamps a number to its max when the field loses focus', () => {
    const onChange = renderInspector(selected('qa-1'));
    const attempts = screen.getByLabelText('Attempts');
    fireEvent.change(attempts, { target: { value: '99' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(attempts);
    expect(configOf(lastState(onChange), 'qa-1')?.maxAttempts).toBe(5);
    expect(valueOf(attempts)).toBe('5');
  });

  it('offers the models of the chosen provider and clears a model the new provider lacks', () => {
    const onChange = renderInspector(selected('backend-1'));
    const models = within(screen.getByLabelText('Model')).getAllByRole('option').map((option) => option.textContent);
    expect(models).toEqual(['Provider default', 'alpha-1', 'alpha-2']);

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'beta' } });
    const config = configOf(lastState(onChange), 'backend-1');
    expect(config?.providerId).toBe('beta');
    expect(config).not.toHaveProperty('model');
  });

  it('lists the effort levels with an empty default', () => {
    const onChange = renderInspector(selected('backend-1'));
    const effort = screen.getByLabelText('Effort');
    const values = within(effort).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
    expect(values[0]).toBe('');
    expect(values.length).toBeGreaterThan(1);
    fireEvent.change(effort, { target: { value: values[1] } });
    expect(configOf(lastState(onChange), 'backend-1')?.effort).toBe(values[1]);
  });

  it('lists the issues of the selected node only', () => {
    const issues: WorkflowIssue[] = [
      { code: 'E_CONFIG', severity: 'error', message: 'QA needs a command.', nodeId: 'qa-1' },
      { code: 'E_CONFIG', severity: 'warning', message: 'Backend has no model.', nodeId: 'backend-1' },
    ];
    renderInspector(selected('qa-1'), { issues });
    expect(screen.getByText(/QA needs a command/)).toBeTruthy();
    expect(screen.queryByText(/Backend has no model/)).toBeNull();
  });

  it('disables every input when read-only', () => {
    const onChange = renderInspector(selected('qa-1'), { readOnly: true });
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    for (const label of ['Label', 'Attempts', 'Notes', 'Mode', 'Strict mode']) {
      expect(disabled(screen.getByLabelText(label))).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes a selected connection', () => {
    const onChange = renderInspector(selected(), { selectedEdgeId: 'backend-1->qa-1' });
    fireEvent.click(screen.getByRole('button', { name: /Delete connection/ }));
    expect(lastState(onChange).graph.edges.map((edge) => edge.id)).toEqual(['trigger-1->backend-1']);
  });

  it('does not let a read-only inspector delete a connection', () => {
    renderInspector(selected(), { selectedEdgeId: 'backend-1->qa-1', readOnly: true });
    expect(disabled(screen.getByRole('button', { name: /Delete connection/ }))).toBe(true);
  });
});

// ------------------------------------------------------------------ canvas

describe('WorkflowCanvas', () => {
  it('feeds the graph to the flow with the selection', () => {
    render(<WorkflowCanvas state={selected('qa-1')} catalog={CATALOG} onChange={vi.fn()} />);
    expect(screen.getByTestId('node-qa-1').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('node-backend-1').getAttribute('data-selected')).toBe('false');
  });

  it('shows the reason inline and does not connect when a connection is invalid', () => {
    const onChange = vi.fn();
    render(<WorkflowCanvas state={selected()} catalog={CATALOG} onChange={onChange} />);
    // Nothing may end in a trigger: its catalog entry has no input.
    connectEdge('backend-1', 'trigger-1');
    const message = screen.getByText(/cannot have incoming connections/);
    expect(message.closest('[aria-live="polite"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds a valid connection', () => {
    const onChange = vi.fn();
    render(<WorkflowCanvas state={selected()} catalog={CATALOG} onChange={onChange} />);
    connectEdge('trigger-1', 'qa-1');
    expect(lastState(onChange).graph.edges.map((edge) => edge.id)).toContain('trigger-1->qa-1');
  });

  it('deletes the selection with Delete, undoes it with Ctrl+Z and redoes it with Ctrl+Shift+Z', () => {
    const onChange = vi.fn();
    render(<Harness initial={selected('qa-1')} onChange={onChange} />);
    fireEvent.keyDown(region(), { key: 'Delete' });
    expect(nodeIds(lastState(onChange))).toEqual(['trigger-1', 'backend-1']);
    fireEvent.keyDown(region(), { key: 'z', ctrlKey: true });
    expect(nodeIds(lastState(onChange))).toEqual(['trigger-1', 'backend-1', 'qa-1']);
    fireEvent.keyDown(region(), { key: 'z', ctrlKey: true, shiftKey: true });
    expect(nodeIds(lastState(onChange))).toEqual(['trigger-1', 'backend-1']);
  });

  it('selects everything with Ctrl+A and copies and pastes with Ctrl+C / Ctrl+V', () => {
    const onChange = vi.fn();
    render(<Harness initial={selected()} onChange={onChange} />);
    fireEvent.keyDown(region(), { key: 'a', ctrlKey: true });
    expect(lastState(onChange).selection).toHaveLength(3);
    fireEvent.keyDown(region(), { key: 'c', ctrlKey: true });
    fireEvent.keyDown(region(), { key: 'v', ctrlKey: true });
    expect(lastState(onChange).graph.nodes).toHaveLength(6);
  });

  it('ignores shortcuts typed into an input inside the canvas', () => {
    const onChange = vi.fn();
    render(<Harness initial={selected('qa-1')} onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('inside input'), { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not edit when read-only, but still selects', () => {
    const onChange = vi.fn();
    render(<Harness initial={selected('qa-1')} readOnly onChange={onChange} />);
    fireEvent.keyDown(region(), { key: 'Delete' });
    fireEvent.keyDown(region(), { key: 'v', ctrlKey: true });
    connectEdge('trigger-1', 'qa-1');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(region(), { key: 'a', ctrlKey: true });
    expect(lastState(onChange).selection).toHaveLength(3);
  });

  it('adds the palette node that is dropped on the canvas, and ignores planned or unknown types', () => {
    const onChange = vi.fn();
    render(<Harness initial={selected()} onChange={onChange} />);
    const drop = (type: string): void => {
      const event = createEvent.drop(region(), { dataTransfer: { types: [NODE_DRAG_TYPE], getData: () => type } });
      Object.defineProperties(event, { clientX: { value: 300 }, clientY: { value: 200 } });
      fireEvent(region(), event);
    };

    drop('deploy');
    drop('not-a-node');
    expect(onChange).not.toHaveBeenCalled();

    drop('backend');
    const state = lastState(onChange);
    const added = state.graph.nodes.find((n) => n.id === 'backend-2');
    expect(added?.type).toBe('backend');
    // Dropped at the pointer, centred on the 200x64 card.
    expect(added?.position).toEqual({ x: 200, y: 168 });
    expect(state.selection).toEqual(['backend-2']);
  });
});
