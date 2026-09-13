import type { ComponentProps } from 'react';
import { RefreshCw } from 'lucide-react';
import { useModelFiles } from '../hooks/useModelFiles';

export function ModelFileSelect({ value, onChange, ...props }: Omit<ComponentProps<'select'>, 'value' | 'onChange'> & {
  value: string; onChange: (value: string) => void;
}) {
  const { files, discovery, refresh } = useModelFiles();
  const filenames = [...new Set(files.map(file => file.filename))].sort();
  const statusId = `${props.id}-discovery`;
  return <div className="model-file-control">
    <select {...props} value={value} onChange={event => onChange(event.target.value)} aria-busy={discovery.loading}
      aria-describedby={`${props['aria-describedby'] ?? ''} ${statusId}`.trim()}>
      <option value="">Choose a GGUF filename</option>
      {value && !filenames.includes(value) && <option value={value}>{value} (not in discovery)</option>}
      {filenames.map(filename => <option key={filename} value={filename}>{filename}</option>)}
    </select>
    <div id={statusId}>
      {discovery.loading ? <p className="field-help" role="status">Discovering model files…</p>
        : discovery.error ? <p className="field-error" role="alert">Unable to discover model files: {discovery.error}</p>
          : !filenames.length && <p className="field-help" role="status">No GGUF files found. Set your models directory in Machine settings, then refresh.</p>}
    </div>
    <button type="button" className="text-button" disabled={props.disabled || discovery.loading} onClick={refresh}>
      <RefreshCw size={13} className={discovery.loading ? 'spin' : ''} />{discovery.error ? 'Retry model discovery' : 'Refresh model files'}
    </button>
  </div>;
}
