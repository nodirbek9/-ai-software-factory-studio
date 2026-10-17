import { fireEvent, render, screen } from '@testing-library/react';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Models } from './Models';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { agentConfig, providers } from '@/test/fixtures';

const agentsGroup = `${AGENT_ROLE_INFO.pm.name} model`;

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ providers, agentConfigs: [{ ...agentConfig }] });
});

describe('Models & Providers page', () => {
  it('opens on the Providers tab with the V1 Providers page', async () => {
    const network = installFetchMock({ 'GET /api/usage': [] });
    render(<Models />);
    expect(screen.getByRole('tab', { name: 'Providers' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Providers', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: agentsGroup })).toBeNull();
    expect(await screen.findByText('No usage recorded')).toBeTruthy();
    expect(network.calls).toEqual([{ method: 'GET', path: '/api/usage', body: undefined }]);
  });

  it('switches to the V1 Agents page from the Agents tab', async () => {
    installFetchMock({ 'GET /api/usage': [] });
    render(<Models />);
    await screen.findByText('No usage recorded');
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: agentsGroup })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Providers', level: 1 })).toBeNull();
  });

  it('starts on the Agents tab when the store view is agents', () => {
    useStudio.setState({ view: 'agents' });
    installFetchMock({});
    render(<Models />);
    expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: agentsGroup })).toBeTruthy();
  });
});
