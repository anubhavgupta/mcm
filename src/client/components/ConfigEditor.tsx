import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { ArrowDown, Check, CircleHelp, Cpu, DollarSign, FlaskConical, Gauge, HardDrive, RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { catalog, defaults, fieldError, fieldSupported, isFieldEnabled } from '../../shared/config';
import type { Capabilities, ExecutableVersion, PublicSettings, SettingValue, Values, Workspace } from '../../shared/types';
import type { Selection } from './Sidebar';
import { MethodSelect } from './MethodSelect';
import { ModelFileSelect } from './ModelFileSelect';
import { ExecutableVersionCheck } from './ExecutableVersionCheck';
import { executableOverride, expectedLlamaVersion, resolveExecutable } from '../../shared/executable';

interface EditorValues { values: Values; overrides: Record<string, boolean>; executableOverride: boolean; executablePath: string }
export interface ExecutableEdit { override: boolean; path: string; version?: string }

export function ConfigEditor({ workspace, settings, selection, capabilities, onDirty, onSave, busy }: {
  workspace: Workspace; settings: PublicSettings; selection: Selection; capabilities: Capabilities | null;
  onDirty: (dirty: boolean) => void; onSave: (values: Values, executable: ExecutableEdit) => Promise<void>; busy: boolean;
}) {
  const group = selection.kind === 'group' ? workspace.groups.find(item => item.id === selection.id) : undefined;
  const model = selection.kind === 'model' ? workspace.models.find(item => item.id === selection.id) : undefined;
  const parentGroup = model?.groupId ? workspace.groups.find(item => item.id === model.groupId) : undefined;
  const own = selection.kind === 'base' ? workspace.base : group?.values ?? model?.values ?? {};
  const inherited = { ...defaults, ...(selection.kind !== 'base' ? workspace.base : {}), ...parentGroup?.values };
  const localOverrides = settings.executableOverrides;
  const ownExecutable = executableOverride(settings, selection);
  const inheritedExecutable = selection.kind === 'base' ? settings.executablePath
    : resolveExecutable(settings, workspace, parentGroup ? { kind: 'group', id: parentGroup.id } : { kind: 'base' });
  const inheritedExecutableSource = parentGroup && executableOverride(settings, { kind: 'group', id: parentGroup.id }) ? 'Group'
    : selection.kind !== 'base' && localOverrides?.base ? 'Base' : 'Machine';
  const [checkedVersion, setCheckedVersion] = useState<ExecutableVersion | undefined>();
  const form = useForm<EditorValues>({
    defaultValues: {
      values: { ...inherited, ...own },
      overrides: Object.fromEntries(catalog.fields.map(field => [field.key, Object.hasOwn(own, field.key)])),
      executableOverride: !!ownExecutable,
      executablePath: ownExecutable ?? inheritedExecutable,
    },
    mode: 'onChange',
  });
  const watched = useWatch({ control: form.control });
  const effectiveExecutable = watched.executableOverride ? watched.executablePath ?? '' : inheritedExecutable;
  const ownVersion = selection.kind === 'base' ? workspace.llamaVersion : model?.llamaVersion ?? group?.llamaVersion;
  const versionDirty = checkedVersion?.executablePath === effectiveExecutable && checkedVersion?.version !== ownVersion;
  const effective: Values = { ...inherited };
  for (const field of catalog.fields) {
    const value = watched.values?.[field.key];
    if (watched.overrides?.[field.key] && value !== undefined) effective[field.key] = value;
  }
  const overrideCount = Object.values(watched.overrides ?? {}).filter(Boolean).length;
  const isDirty = form.formState.isDirty || versionDirty;
  useEffect(() => { onDirty(isDirty); }, [isDirty, onDirty]);
  useEffect(() => {
    for (const field of catalog.fields) {
      if (!isFieldEnabled(field, effective)) form.clearErrors(`values.${field.key}`);
    }
  }, [watched.values, watched.overrides, form]);

  const origin = (key: string) => {
    if (watched.overrides?.[key]) return selection.kind === 'base' ? 'Base' : selection.kind === 'group' ? 'Group' : 'Model';
    if (parentGroup && Object.hasOwn(parentGroup.values, key)) return 'Group';
    if (selection.kind !== 'base' && Object.hasOwn(workspace.base, key)) return 'Base';
    return 'Default';
  };
  const icons = { compute: Cpu, sampling: SlidersHorizontal, memory: HardDrive, advanced: FlaskConical };
  const submit = form.handleSubmit(async data => {
    const values: Values = {};
    for (const field of catalog.fields) {
      if (selection.kind === 'model' && field.required && isFieldEnabled(field, effective) && effective[field.key] === '') {
        form.setError(`values.${field.key}`, { message: `${field.label} is required. Override this setting and choose a GGUF file, or inherit one from Base or Group.` });
        document.getElementById(`setting-${field.key}`)?.scrollIntoView({ block: 'center' });
        return;
      }
      if (!data.overrides[field.key]) continue;
      const value = data.values[field.key];
      const error = fieldError(field, value);
      if (error) { form.setError(`values.${field.key}`, { message: error }); return; }
      values[field.key] = value;
    }
    await onSave(values, {
      override: data.executableOverride, path: effectiveExecutable,
      version: checkedVersion?.executablePath === effectiveExecutable ? checkedVersion.version : undefined,
    });
  });
  return <form className="config-editor" onSubmit={submit} noValidate>
    <section className="settings-section" aria-labelledby="executable-override-heading">
      <div className="section-header"><div><h2 id="executable-override-heading">Server executable</h2><p>Model &gt; Group &gt; Base &gt; Machine Settings. Paths stay on this machine.</p></div></div>
      <div className={`field-card ${watched.executableOverride ? 'is-overridden' : ''}`}>
        <div className="field-top"><label htmlFor="config-executable-path">llama-server executable path</label><span className="origin-badge">{watched.executableOverride ? selection.kind === 'base' ? 'Base' : selection.kind === 'group' ? 'Group' : 'Model' : inheritedExecutableSource}</span></div>
        <input id="config-executable-path" type="text" disabled={!watched.executableOverride || busy}
          {...form.register('executablePath', { validate: value => !form.getValues('executableOverride') || !!value.trim() || 'Enter an executable path or reset to inherited.' })}
          aria-invalid={!!form.formState.errors.executablePath} />
        {form.formState.errors.executablePath && <p className="field-error" role="alert">{form.formState.errors.executablePath.message}</p>}
        <ExecutableVersionCheck path={effectiveExecutable} expected={expectedLlamaVersion(workspace, selection)} disabled={busy} onChecked={result => {
          setCheckedVersion(result);
          form.setValue('executablePath', result.executablePath, { shouldDirty: true });
        }} />
        <p className="field-help">Machine-local path; only checked version metadata is shared. Check the version before saving to record the build used for this configuration.</p>
        <div className="field-bottom"><code>machine-local</code><button type="button" className="override-button" disabled={busy}
          aria-label={watched.executableOverride ? 'Reset executable path to inherited' : 'Override executable path'}
          onClick={() => {
            form.setValue('executableOverride', !watched.executableOverride, { shouldDirty: true });
            if (watched.executableOverride) form.setValue('executablePath', inheritedExecutable, { shouldDirty: true, shouldValidate: true });
          }}>{watched.executableOverride ? <><RotateCcw size={12} />Reset</> : <>Override <span>↗</span></>}</button></div>
      </div>
    </section>
    <div className="inheritance-strip">
      <span className={selection.kind === 'base' ? 'current' : ''}><LayersIcon />Base</span><ArrowDown size={13} className="inherit-arrow" />
      <span className={selection.kind === 'group' ? 'current' : ''}>Group <small>optional</small></span><ArrowDown size={13} className="inherit-arrow" />
      <span className={selection.kind === 'model' ? 'current' : ''}>Model</span>
      <span className="inheritance-note">Only your overrides are saved.</span>
    </div>
    <div className="section-jumps" aria-label="Configuration sections">
      {catalog.sections.map(section => <a key={section.id} href={`#section-${section.id}`} onClick={event => { event.preventDefault(); document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{section.title}</a>)}
    </div>
    {catalog.sections.map(section => {
      const Icon = section.id === 'compute' ? icons.compute : section.id === 'sampling' ? icons.sampling : section.id === 'memory' ? icons.memory : section.id === 'pricing' ? DollarSign : icons.advanced;
      return <section className="settings-section" id={`section-${section.id}`} key={section.id} aria-labelledby={`heading-${section.id}`}>
        <div className="section-header"><div className={`section-icon ${section.id}`}><Icon size={19} /></div><div><h2 id={`heading-${section.id}`}>{section.title}</h2><p>{section.description}</p></div></div>
        <div className="fields-grid">
          {catalog.fields.filter(field => field.section === section.id).map(field => {
            const overridden = watched.overrides?.[field.key] ?? false;
            const enabled = isFieldEnabled(field, effective);
            if (field.hideWhenDisabled && !enabled) return null;
            const supported = !capabilities || fieldSupported(field, capabilities.flags);
            const selectedFlag = capabilities ? [field.flag, ...(field.aliases ?? [])].find(flag => flag !== undefined && capabilities.flags.includes(flag)) : field.flag;
            const fieldId = `setting-${field.key}`;
            return <div className={`field-card ${field.control === 'multi-select' ? 'full-width' : ''} ${overridden ? 'is-overridden' : ''} ${!enabled ? 'dependency-disabled' : ''}`} key={field.key}>
              <div className="field-top"><label id={`${fieldId}-label`} htmlFor={field.control === 'multi-select' ? undefined : fieldId}>{field.label}</label><span className={`origin-badge origin-${origin(field.key).toLowerCase()}`}>{origin(field.key)}</span></div>
              <Controller control={form.control} name={`values.${field.key}`}
                rules={{ validate: value => !enabled || !form.getValues(`overrides.${field.key}`) || fieldError(field, value) || true }}
                render={({ field: input, fieldState }) => {
                  const common = { id: fieldId, name: input.name, ref: input.ref, onBlur: input.onBlur, disabled: !enabled || !overridden || busy, 'aria-invalid': !!fieldState.error, 'aria-required': enabled && field.required, 'aria-describedby': `${fieldId}-help${fieldState.error ? ` ${fieldId}-error` : ''}` };
                  const update = (value: SettingValue) => input.onChange(value);
                  return <>
                    {field.control === 'multi-select' ? <MethodSelect id={fieldId} name={input.name} inputRef={input.ref} value={String(input.value ?? 'none')} options={field.options ?? []} disabled={common.disabled} onChange={update} onBlur={input.onBlur} describedBy={common['aria-describedby']} invalid={common['aria-invalid']} />
                      : field.control === 'model-file' ? <ModelFileSelect {...common} value={String(input.value ?? '')} onChange={update} />
                      : field.control === 'toggle' ? <div className="toggle-line"><label className="switch"><input {...common} type="checkbox" checked={input.value === true} onChange={event => update(event.target.checked)} /><span className="switch-track" /></label><span className="toggle-value">{input.value === true ? 'Enabled' : 'Disabled'}</span></div>
                      : field.control === 'select' ? <select {...common} value={String(input.value ?? '')} onChange={event => update(event.target.value)}>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
                        : field.control === 'json' ? <textarea {...common} value={String(input.value ?? '')} onChange={event => update(event.target.value)} placeholder='{"enable_thinking": false}' rows={2} spellCheck={false} />
                          : <input {...common} type={field.control === 'number' ? 'number' : 'text'} value={typeof input.value === 'boolean' ? String(input.value) : input.value ?? ''} min={field.min} max={field.max} step={field.integer ? 1 : field.step ?? 'any'} onChange={event => update(field.control === 'number' && event.target.value !== '' ? event.target.valueAsNumber : event.target.value)} />}
                    {fieldState.error && <p className="field-error" id={`${fieldId}-error`} role="alert">{fieldState.error.message}</p>}
                  </>;
                }} />
              <p className="field-help" id={`${fieldId}-help`}>{!enabled ? `Available when ${catalog.fields.find(item => item.key === field.dependsOn?.key)?.label ?? field.dependsOn?.key} ${field.dependsOn?.containsAny ? `includes ${field.dependsOn.containsAny.join(' or ')}` : `is ${String(field.dependsOn?.equals)}`}.` : field.description ?? (selectedFlag ? selectedFlag : 'Configuration preference')}
                {enabled && field.required && effective[field.key] === '' && ` Required before launch: override ${field.label} and choose a GGUF file, or inherit one from Base or Group.${selection.kind !== 'model' ? ' Base and Group configurations can be saved without a file for models to supply later.' : ''}`}
              </p>
              {!supported && <p className="support-warning"><CircleHelp size={13} />Not supported by the probed executable</p>}
              {capabilities && selectedFlag && selectedFlag !== field.flag && <p className="alias-note">Compatible alias: <code>{selectedFlag}</code></p>}
              <div className="field-bottom"><code>{field.flag ?? 'preference'}</code>
                <button type="button" className="override-button" disabled={busy || (!enabled && !overridden)}
                  aria-label={overridden ? `Reset ${field.label} to inherited` : `Override ${field.label}`}
                  onClick={() => {
                    form.setValue(`overrides.${field.key}`, !overridden, { shouldDirty: true });
                    if (overridden) form.setValue(`values.${field.key}`, inherited[field.key], { shouldDirty: true, shouldValidate: true });
                  }}>{overridden ? <><RotateCcw size={12} />Reset</> : <>Override <span>↗</span></>}</button>
              </div>
            </div>;
          })}
        </div>
      </section>;
    })}
    <div className="save-bar"><div><span className={`save-state ${isDirty ? 'dirty' : ''}`}>{isDirty ? <span className="tiny-dot" /> : <Check size={15} />}{isDirty ? 'Unsaved changes' : 'All changes saved'}</span><small>{overrideCount} explicit {overrideCount === 1 ? 'override' : 'overrides'} · other values inherited</small></div>
      <button className="button primary" type="submit" disabled={!isDirty || busy}><Save size={16} />{busy ? 'Saving…' : 'Save changes'}</button>
    </div>
  </form>;
}

function LayersIcon() { return <Gauge size={14} />; }
