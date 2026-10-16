import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AGENT_ROLES, AGENT_ROLE_INFO, EFFORT_LEVELS, type AgentTestResult } from '@asf/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Agents } from './Agents';
import { useStudio } from '@/store/studio';
import { installFetchMock, type JsonReply } from '@/test/fetchMock';
import { agentConfig, agentResult, providers } from '@/test/fixtures';

function renderPm() {
  render(<Agents />);
  const group = screen.getByRole('radiogroup', { name: `${AGENT_ROLE_INFO.pm.name} model` });
  const form = group.closest('form');
  if (!form) throw new Error('PM form is missing');
  return within(form);
}

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ providers, agentConfigs: [{ ...agentConfig }] });
});

describe('Agents configuration', () => {
  it('renders all roles and selects saved, default, custom and replacement provider models', () => {
    installFetchMock({});
    const pm = renderPm();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(AGENT_ROLES.length);
    const group = pm.getByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(providers[0].models.length + 1);
    expect(pm.getByRole('radio', { name: 'claude-saved' }).getAttribute('aria-checked')).toBe('true');
    const defaultModel = pm.getByRole('radio', { name: 'claude-default (default)' });
    fireEvent.click(defaultModel);
    expect(defaultModel.getAttribute('aria-checked')).toBe('true');
    expect(pm.getByRole('radio', { name: 'claude-saved' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(pm.getByRole('radio', { name: 'Other…' }));
    const custom = pm.getByRole('textbox', { name: 'Custom model id' });
    fireEvent.change(custom, { target: { value: 'custom/模型🚀' } });
    expect((custom as HTMLInputElement).value).toBe('custom/模型🚀');
    expect(pm.getByRole('radio', { name: 'Other…' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(pm.getByLabelText('Provider'), { target: { value: 'codex' } });
    expect(pm.getByRole('radio', { name: 'codex-default (default)' }).getAttribute('aria-checked')).toBe('true');
    expect(pm.queryByRole('textbox', { name: 'Custom model id' })).toBeNull();
  });

  it('lists effort options and disables testing after an unsaved effort change', () => {
    installFetchMock({});
    const pm = renderPm();
    const effort = pm.getByLabelText(/^Reasoning effort/) as HTMLSelectElement;
    expect(effort.value).toBe('high');
    expect(within(effort).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Provider default', ...EFFORT_LEVELS]);
    expect((pm.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(effort, { target: { value: 'low' } });
    expect(pm.getByText('Save first — the test uses the saved settings')).toBeTruthy();
    expect((pm.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the exact configuration, refetches it and enables testing again', async () => {
    const updated = { ...agentConfig, model: 'claude-default', effort: 'low', allowFallback: true };
    const network = installFetchMock({
      'PUT /api/agents/pm/config': {},
      'GET /api/providers': providers,
      'GET /api/agents/config': [updated],
    });
    const pm = renderPm();
    fireEvent.click(pm.getByRole('radio', { name: 'claude-default (default)' }));
    fireEvent.change(pm.getByLabelText(/^Reasoning effort/), { target: { value: 'low' } });
    fireEvent.click(pm.getByRole('checkbox'));
    fireEvent.click(pm.getByRole('button', { name: 'Save' }));
    expect(await pm.findByText('Saved')).toBeTruthy();
    expect(network.calls).toEqual([
      { method: 'PUT', path: '/api/agents/pm/config', body: {
        providerId: 'claude-code', model: 'claude-default', allowFallback: true, effort: 'low',
      } },
      { method: 'GET', path: '/api/providers', body: undefined },
      { method: 'GET', path: '/api/agents/config', body: undefined },
    ]);
    expect(pm.queryByText('Save first — the test uses the saved settings')).toBeNull();
    expect((pm.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Agents provider test', () => {
  it('shows a pending request then the actual model, effort, tokens, answer and duration', async () => {
    let resolve!: (reply: JsonReply) => void;
    const pending = new Promise<JsonReply>((done) => { resolve = done; });
    const network = installFetchMock({ 'POST /api/agents/pm/test': () => pending });
    const pm = renderPm();
    fireEvent.click(pm.getByRole('button', { name: 'Test' }));
    expect((pm.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(network.calls).toEqual([{ method: 'POST', path: '/api/agents/pm/test', body: {} }]);
    await act(async () => { resolve({ json: agentResult() }); });
    const result = await pm.findByText(/✓ claude-saved \(Claude Code\)/);
    for (const text of ['effort high', '123 thinking tokens', 'answer 42', '1.5 s']) {
      expect(result.textContent).toContain(text);
    }
    await waitFor(() => expect((pm.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it.each<{ name: string; result: Partial<AgentTestResult>; expected: string }>([
    { name: 'model mismatch', result: { actualModel: 'other-model', correct: false }, expected: 'asked for claude-saved, got other-model' },
    { name: 'unsupported effort', result: { effortApplied: false }, expected: 'effort not supported by this provider' },
    { name: 'failed run', result: { ok: false, correct: false, error: 'Provider refused the run' }, expected: 'Provider refused the run' },
  ])('reports $name', async ({ result, expected }) => {
    installFetchMock({ 'POST /api/agents/pm/test': agentResult(result) });
    const pm = renderPm();
    fireEvent.click(pm.getByRole('button', { name: 'Test' }));
    expect(await pm.findByText(expected)).toBeTruthy();
  });

  it('surfaces HTTP failures in an alert', async () => {
    installFetchMock({ 'POST /api/agents/pm/test': () => ({ status: 500, json: { error: 'boom' } }) });
    const pm = renderPm();
    fireEvent.click(pm.getByRole('button', { name: 'Test' }));
    expect((await pm.findByRole('alert')).textContent).toBe('boom');
  });
});
