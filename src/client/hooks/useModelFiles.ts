import { useEffect, useState } from 'react';
import type { ModelFile } from '../../shared/types';
import { api, errorMessage, jsonBody } from '../api';

export function useModelFiles() {
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [discovery, setDiscovery] = useState({ loading: true, error: '' });
  const [scan, setScan] = useState<{ revision: number; directory?: string }>({ revision: 0 });
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery({ loading: true, error: '' });
    setFiles([]);
    void api<{ models: ModelFile[] }>('/models', {
      ...(scan.directory !== undefined ? jsonBody({ modelsDirectory: scan.directory }) : {}),
      signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) return;
      setFiles(result.models);
      setDiscovery({ loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setDiscovery({ loading: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [scan]);
  return { files, discovery, refresh: (directory?: string) => setScan(current => ({ revision: current.revision + 1, directory })) };
}
