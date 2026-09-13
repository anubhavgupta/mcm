const targets: Record<string, string> = {
  linux: 'x86_64-unknown-linux-gnu',
  windows: 'x86_64-pc-windows-msvc',
};
const mode = Deno.args[0];
if (!mode || (mode !== 'dev' && !targets[mode])) throw new Error('Choose linux, windows, or dev.');
if (Deno.version.deno !== '2.9.6') throw new Error('Use the pinned Deno 2.9.6 installed by npm ci.');
const lock: { packages: Record<string, { dev?: boolean }> } = JSON.parse(await Deno.readTextFile('package-lock.json'));
const args = ['desktop', '-A', '--backend', 'webview', '--include', 'dist/client',
  '--exclude', 'node_modules/.deno', '--exclude', 'node_modules/.bin'];
// Manual npm resolution preserves npm's lockfile and never rewrites node_modules.
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (path.startsWith('node_modules/') && metadata.dev) args.push('--exclude', path);
}
if (mode === 'dev') args.push('--hmr');
else args.push('--target', targets[mode]!, '--output', `dist/desktop/${mode}/MCM`);
args.push('desktop/main.ts');
const result = await new Deno.Command(Deno.execPath(), {
  args, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
}).output();
Deno.exit(result.code);
