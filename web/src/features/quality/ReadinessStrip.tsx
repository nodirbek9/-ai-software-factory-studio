import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import type { GateState, QualityGate, ReleaseReadiness } from '@asf/shared';
import { Panel } from '@/components/ui/primitives';
import { cn, timeAgo } from '@/lib/utils';

interface Tone { label: string; text: string; border: string; icon: typeof CheckCircle2 }

/** not_run is grey on purpose — an unmeasured gate must never look like a pass (D-016). */
export const GATE_TONE: Record<GateState, Tone> = {
  passed: { label: 'Passed', text: 'text-st-completed', border: 'border-st-completed/35', icon: CheckCircle2 },
  failed: { label: 'Failed', text: 'text-st-failed', border: 'border-st-failed/35', icon: XCircle },
  error: { label: 'Error', text: 'text-st-waiting', border: 'border-st-waiting/35', icon: AlertTriangle },
  not_run: { label: 'Not run', text: 'text-st-idle', border: 'border-line-soft', icon: MinusCircle },
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function gateReason(gate: QualityGate): string {
  if (gate.state === 'failed') return `${gate.label} failed`;
  if (gate.state === 'error') return `${gate.label} errored`;
  return gate.id === 'coverage' ? 'Coverage not measured' : `${gate.label} not run`;
}

/** A run is ready only when the server says so AND every gate passed; otherwise the reasons say what is missing. */
export function readinessReasons(readiness: ReleaseReadiness): string[] {
  const reasons: string[] = [];
  if (readiness.blockingFindings > 0) reasons.push(plural(readiness.blockingFindings, 'blocking finding'));
  for (const gate of readiness.gates) if (gate.state !== 'passed') reasons.push(gateReason(gate));
  return reasons;
}

export function isReady(readiness: ReleaseReadiness): boolean {
  return readiness.ready && readiness.blockingFindings === 0 && readiness.gates.every((gate) => gate.state === 'passed');
}

function GateCard({ gate }: { gate: QualityGate }) {
  const tone = GATE_TONE[gate.state];
  const Icon = tone.icon;
  return (
    <li data-gate={gate.id} data-state={gate.state} className={cn('min-w-0 rounded-lg border bg-ink-950 p-3', tone.border)}>
      <p className="truncate text-[12px] font-medium text-muted">{gate.label}</p>
      <p className={cn('mt-1 inline-flex items-center gap-1.5 text-[13px] font-semibold', tone.text)}>
        <Icon size={14} aria-hidden="true" />{tone.label}
      </p>
      <p className="mt-1 break-words text-[11.5px] text-faint">{gate.detail}</p>
      {gate.at && <p className="mt-0.5 text-[11px] text-faint">{timeAgo(gate.at)}</p>}
    </li>
  );
}

function Verdict({ readiness }: { readiness: ReleaseReadiness }) {
  if (isReady(readiness)) {
    return <p role="status" data-ready="true" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-st-completed"><CheckCircle2 size={15} aria-hidden="true" />Ready for release</p>;
  }
  return (
    <p role="status" data-ready="false" className="text-[13px] text-muted">
      <span className="font-semibold text-text">Not ready for release</span> — {readinessReasons(readiness).join(' · ') || 'the server did not report this run as ready'}
    </p>
  );
}

export function ReadinessStrip({ readiness }: { readiness: ReleaseReadiness | null }) {
  if (!readiness) {
    return (
      <Panel role="region" className="p-4" aria-label="Release readiness">
        <p role="status" className="text-[13px] text-muted">No run yet — release readiness is measured per run, so every gate is Not run.</p>
      </Panel>
    );
  }
  return (
    <Panel role="region" className="space-y-3 p-4" aria-label="Release readiness">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Release readiness · run #{readiness.runNumber}</h2>
        <Verdict readiness={readiness} />
      </div>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {readiness.gates.map((gate) => <GateCard key={gate.id} gate={gate} />)}
      </ul>
    </Panel>
  );
}
