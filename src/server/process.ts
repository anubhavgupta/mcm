import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { buildArgs, catalog, fieldSupported, isFieldEnabled, parseHelp, resolveConfig } from '../shared/config';
import type { Capabilities, LocalSettings, ServerStatus, Values } from '../shared/types';
import { ApiError, messageOf } from './errors';
import { Events } from './events';
import { resolveModel } from './models';
import { Store } from './storage';

export interface ProcessOptions {
  helpTimeoutMs?: number;
  stopTimeoutMs?: number;
  readyTimeoutMs?: number;
  healthIntervalMs?: number;
  fetch?: typeof fetch;
}

function childEnvironment(settings: LocalSettings): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    !/^(HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|MCM_INTERCEPTOR_MODULE)$/i.test(key) &&
    (!settings.hfToken || value !== settings.hfToken)));
}

async function executable(settings: LocalSettings): Promise<string> {
  if (!settings.executablePath || !isAbsolute(settings.executablePath)) {
    throw new ApiError(400, 'Set an absolute llama-server executable path in Machine settings.');
  }

  try { await access(settings.executablePath, constants.X_OK); }
  catch { throw new ApiError(400, 'The llama-server executable is missing or not executable. Update Machine settings.'); }
  return settings.executablePath;
}

async function ensurePortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new ApiError(409, `Local port ${port} is already in use or unavailable. Stop that server or change the llama-server port in Machine settings.`)));
    probe.listen(port, '127.0.0.1', () => { probe.close(() => resolve()); });
  });
}

export async function discoverCapabilities(settings: LocalSettings, timeoutMs = 5000): Promise<Capabilities> {
  const path = await executable(settings);
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(settings) });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const fail = (message: string): void => {
      failure ??= new ApiError(400, message);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => fail('Executable --help timed out. Verify this is a compatible llama-server binary.'), timeoutMs);
    const collect = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 1024 * 1024) fail('Executable --help exceeded the 1 MiB output limit.');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => { failure = new ApiError(400, 'Cannot run the configured executable.'); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new ApiError(400, `Executable --help exited with code ${code}.`)); return; }
      const raw = Buffer.concat(chunks).toString('utf8');
      const help = settings.hfToken ? raw.split(settings.hfToken).join('[REDACTED]') : raw;
      resolve({ help, flags: parseHelp(help) });
    });
  });
}

interface RunningChild {
  child: ChildProcess;
  exited: Promise<void>;
  controller: AbortController;
  port: number;
}

export class ProcessManager {
  private status: ServerStatus = { phase: 'stopped' };
  private running?: RunningChild;
  private lastModelId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(private store: Store, private events: Events, private options: ProcessOptions = {}) {}
  getStatus(): ServerStatus { return { ...this.status }; }
  getManagedPort(): number | undefined { return this.running?.port; }
  private setStatus(status: ServerStatus): void {
    this.status = status;
    this.events.emit({ type: 'status', data: this.getStatus() });
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async preview(modelId: string, capabilities?: Capabilities, settings = this.store.getSettings(), workspace = this.store.getWorkspace()): Promise<{ executable: string; args: string[] }> {
    const model = workspace.models.find(item => item.id === modelId);
    if (!model) throw new ApiError(404, 'Model configuration not found.');
    const path = await executable(settings);
    const modelPath = await resolveModel(settings, model);
    const values = resolveConfig(workspace, model);
    if (capabilities) {
      const group = workspace.groups.find(item => item.id === model.groupId);
      const explicit: Values = { ...workspace.base, ...group?.values, ...model.values };
      for (const field of catalog.fields) {
        if (!isFieldEnabled(field, values)) continue;
        if (!fieldSupported(field, capabilities.flags) && !Object.hasOwn(explicit, field.key)) {
          const selectedDependent = catalog.fields.find(dependent =>
            dependent.dependsOn?.key === field.key && (Object.hasOwn(explicit, dependent.key) || dependent.required) &&
            isFieldEnabled(dependent, values) && values[dependent.key] !== '' && values[dependent.key] !== false);
          if (selectedDependent) {
            throw new ApiError(400, `${selectedDependent.label} requires ${field.label} (${field.flag}), which this executable does not support. Clear the override or select a compatible executable.`);
          }
          if (values[field.key] !== false && values[field.key] !== '' && !field.omitValues?.includes(values[field.key]!)) {
            this.events.log(`Using executable default for ${field.label}: implicit ${field.flag} is unsupported. Set an explicit override to require this option.`);
          }
          delete values[field.key];
        }
      }
    }
    const resolvedFiles: Record<string, string> = {};
    for (const field of catalog.fields) {
      if (field.control !== 'model-file' || !isFieldEnabled(field, values)) continue;
      const filename = values[field.key];
      if (typeof filename !== 'string' || !filename) continue;
      resolvedFiles[field.key] = await resolveModel(
        { ...settings, modelBindings: settings.draftModelBindings ?? {} },
        { ...model, name: `draft model for ${model.name}`, model: { filename } },
      );
    }
    let args: string[];
    try { args = buildArgs(values, capabilities?.flags, resolvedFiles); }
    catch (error) { throw new ApiError(400, `${messageOf(error)} Clear the explicit override or select a compatible executable.`); }
    args.push('--model', modelPath, '--host', '127.0.0.1', '--port', String(settings.serverPort));
    if (capabilities?.flags.includes('--metrics')) args.push('--metrics');
    return { executable: path, args };
  }
  launch(modelId: string): Promise<ServerStatus> {
    return this.serialize(async () => {
      if (this.closing) throw new ApiError(503, 'Manager is shutting down.');
      if (this.running) throw new ApiError(409, 'Stop the current server before launching another model.');
      return this.start(modelId);
    });
  }
  private async start(modelId: string): Promise<ServerStatus> {
    const settings = this.store.getSettings();
    const workspace = this.store.getWorkspace();
    const capabilities = await discoverCapabilities(settings, this.options.helpTimeoutMs);
    const command = await this.preview(modelId, capabilities, settings, workspace);
    await ensurePortAvailable(settings.serverPort);
    const child = spawn(command.executable, command.args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(settings) });
    const controller = new AbortController();
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const running = { child, exited, controller, port: settings.serverPort };
    this.running = running;
    this.lastModelId = modelId;
    for (const [stream, readable] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const flush = (final = false): void => {
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) {
          this.events.log(pending.slice(0, index), stream);
          pending = pending.slice(index + 1);
        }
        if (pending.length > 16384 || final) {
          if (pending) this.events.log(pending, stream);
          pending = '';
        }
      };
      readable!.on('data', (chunk: Buffer) => { pending += decoder.write(chunk); flush(); });
      readable!.on('end', () => { pending += decoder.end(); flush(true); });
    }
    child.once('error', error => {
      if (this.running === running) this.setStatus({ phase: 'failed', modelId, error: this.store.redact(messageOf(error)) });
    });
    child.once('close', (code, signal) => {
      controller.abort();
      if (this.running !== running) return;
      this.running = undefined;
      if (this.status.phase !== 'stopping' && this.status.phase !== 'failed') {
        this.setStatus({ phase: 'failed', modelId, error: `llama-server exited (${signal ?? code}). Inspect server logs.` });
      }
    });
    this.setStatus({ phase: 'starting', modelId, pid: child.pid });
    this.events.log(`Starting model ${modelId}; waiting for llama-server /health.`);
    void this.waitReady(running, settings.serverPort, modelId);
    return this.getStatus();
  }
  private async waitReady(running: RunningChild, port: number, modelId: string): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120000);
    const fetcher = this.options.fetch ?? fetch;
    while (!running.controller.signal.aborted && this.running === running && Date.now() < deadline) {
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([running.controller.signal, AbortSignal.timeout(1500)]),
          redirect: 'error',
        });
        const healthy = response.ok;
        await response.body?.cancel();
        if (healthy && this.running === running && !running.controller.signal.aborted) {
          this.setStatus({ phase: 'ready', modelId, pid: running.child.pid });
          this.events.log('llama-server is ready.');
          return;
        }
      } catch { /* A loading server may refuse connections or return 503. */ }
      await delay(this.options.healthIntervalMs ?? 300, undefined, { signal: running.controller.signal }).catch(() => {});
    }
    if (this.running === running && !running.controller.signal.aborted) {
      this.setStatus({ phase: 'failed', modelId, error: 'llama-server did not become healthy before the readiness timeout. Inspect logs and model settings.' });
      await this.serialize(async () => {
        if (this.running === running) await this.terminate(running);
      });
    }
  }
  private async terminate(running: RunningChild): Promise<void> {
    running.controller.abort();
    const captured = running.child;
    captured.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (captured.exitCode === null && captured.signalCode === null) captured.kill('SIGKILL');
    }, this.options.stopTimeoutMs ?? 3000);
    try { await running.exited; } finally { clearTimeout(timer); }
    if (this.running === running) this.running = undefined;
  }
  private async stopCurrent(): Promise<ServerStatus> {
    if (this.running) {
      this.setStatus({ ...this.status, phase: 'stopping' });
      await this.terminate(this.running);
    }
    this.setStatus({ phase: 'stopped' });
    this.events.log('llama-server stopped.');
    return this.getStatus();
  }
  stop(): Promise<ServerStatus> { return this.serialize(() => this.stopCurrent()); }
  restart(): Promise<ServerStatus> {
    return this.serialize(async () => {
      if (this.closing) throw new ApiError(503, 'Manager is shutting down.');
      const modelId = this.lastModelId;
      if (!modelId) throw new ApiError(400, 'Launch a model before restarting.');
      await this.stopCurrent();
      return this.start(modelId);
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.stop();
  }
}
