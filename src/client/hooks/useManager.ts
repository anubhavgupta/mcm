import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Bootstrap, LogEntry, PublicSettings, ServerStatus, Throughput, Workspace } from '../../shared/types';
import { api, errorMessage } from '../api';

const statusSchema = z.object({
  phase: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']),
  modelId: z.string().optional(),
  pid: z.number().optional(),
  error: z.string().optional(),
});
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), data: statusSchema }),
  z.object({ type: z.literal('log'), data: z.object({
    timestamp: z.string(), stream: z.enum(['stdout', 'stderr', 'manager']), text: z.string(),
  }) }),
  z.object({ type: z.literal('throughput'), data: z.object({
    requestId: z.string(), protocol: z.enum(['openai', 'anthropic']),
    pp: z.number().nullable(), tg: z.number().nullable(),
    inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
    source: z.enum(['llama.cpp', 'unavailable']),
    measurement: z.enum(['timings', 'prometheus']).optional(), active: z.boolean(),
  }) }),
]);

export function useManager() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [throughput, setThroughput] = useState<Throughput | null>(null);
  const seen = useRef(new Set<string>());
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<Bootstrap>('/bootstrap');
      setData(result);
      setStatus(result.status);
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed = eventSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === 'status') {
          setStatus(message.data);
          if (message.data.phase === 'starting' || message.data.phase === 'stopped') setThroughput(null);
        }
        if (message.type === 'throughput') setThroughput(message.data);
        if (message.type === 'log') {
          const key = `${message.data.timestamp}:${message.data.stream}:${message.data.text}`;
          if (seen.current.has(key)) return;
          seen.current.add(key);
          if (seen.current.size > 1000) {
            const oldest = seen.current.values().next().value;
            if (oldest !== undefined) seen.current.delete(oldest);
          }
          setLogs(current => [...current, { ...message.data, text: message.data.text.slice(0, 16_384) }].slice(-500));
        }
      } catch {
        // Ignore malformed events without replacing the last known server state.
      }
    };
    events.onmessage = receive;
    events.addEventListener('status', receive);
    events.addEventListener('log', receive);
    events.addEventListener('throughput', receive);
    return () => events.close();
  }, []);

  const setWorkspace = (workspace: Workspace) => setData(current => current ? { ...current, workspace } : current);
  const setSettings = (settings: PublicSettings) => setData(current => current ? { ...current, settings } : current);
  return { data, error, loading, reload, connected, status, setStatus, logs, clearLogs: () => setLogs([]), throughput, setWorkspace, setSettings };
}
