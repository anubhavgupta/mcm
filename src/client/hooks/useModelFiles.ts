import { useEffect, useState } from 'react';
import type { ModelFile } from '../../shared/types';
import { api, errorMessage } from '../api';

export function useModelFiles() {
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [discovery, setDiscovery] = useState({ loading: true, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery({ loading: true, error: '' });
    void api<{ models: ModelFile[] }>('/models', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setFiles(result.models);
      setDiscovery({ loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setDiscovery({ loading: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [revision]);
  return { files, discovery, refresh: () => setRevision(value => value + 1) };
}
