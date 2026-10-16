import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/** Renders agent-produced Markdown. Raw HTML is not enabled, so model output cannot inject markup. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-studio text-[13px]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
