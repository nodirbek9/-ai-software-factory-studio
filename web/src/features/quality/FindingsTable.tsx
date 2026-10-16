import type { Finding, FindingSeverity, FindingSource, FindingStatus } from '@asf/shared';
import { cn } from '@/lib/utils';

export const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
export const SOURCE_LABEL: Record<FindingSource, string> = { security: 'Security review', review: 'Code review', audit: 'Dependency audit' };
export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open', accepted: 'Accepted', false_positive: 'False positive', fix_planned: 'Fix planned', fixed: 'Fixed',
};

export const SEVERITY_TONE: Record<FindingSeverity, string> = {
  critical: 'border-st-failed/50 bg-st-failed/20 text-st-failed',
  high: 'border-st-failed/30 bg-st-failed/10 text-st-failed',
  medium: 'border-st-waiting/30 bg-st-waiting/10 text-st-waiting',
  low: 'border-st-running/30 bg-st-running/10 text-st-running',
  info: 'border-line bg-ink-800 text-muted',
};

export function SeverityPill({ severity }: { severity: FindingSeverity }) {
  return <span data-severity={severity} className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium', SEVERITY_TONE[severity])}>{SEVERITY_LABEL[severity]}</span>;
}

export function formatLocation(finding: Pick<Finding, 'file' | 'line'>): string {
  if (!finding.file) return '—';
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

export interface FindingsTableProps {
  findings: Finding[];
  selectedId: string | null;
  onOpen: (finding: Finding) => void;
}

/** Rows open the drawer on click; the title is a real button so the keyboard can reach it too. */
export function FindingsTable({ findings, selectedId, onOpen }: FindingsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-[12.5px]">
        <thead className="text-[11.5px] text-faint">
          <tr className="border-b border-line-soft">
            <th scope="col" className="px-4 py-2 font-medium">Title</th>
            <th scope="col" className="px-2 py-2 font-medium">Severity</th>
            <th scope="col" className="px-2 py-2 font-medium">File</th>
            <th scope="col" className="px-2 py-2 font-medium">Source</th>
            <th scope="col" className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => (
            <tr key={finding.id} data-finding={finding.id} aria-selected={finding.id === selectedId} onClick={() => onOpen(finding)}
              className={cn('cursor-pointer border-b border-line-soft/60 hover:bg-ink-800/60', finding.id === selectedId && 'bg-ink-800/80')}>
              <td className="max-w-[320px] px-4 py-2">
                <button type="button" className="block w-full truncate text-left font-medium hover:text-brand-2" title={finding.title} onClick={(event) => { event.stopPropagation(); onOpen(finding); }}>
                  {finding.title}
                </button>
              </td>
              <td className="px-2 py-2"><SeverityPill severity={finding.severity} /></td>
              <td className="max-w-[220px] truncate px-2 py-2 font-mono text-[11.5px] text-muted" title={formatLocation(finding)}>{formatLocation(finding)}</td>
              <td className="px-2 py-2 text-muted">{SOURCE_LABEL[finding.source]}</td>
              <td className="px-4 py-2 text-muted">{STATUS_LABEL[finding.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
