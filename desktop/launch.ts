import { fileURLToPath } from 'node:url';

if (!['linux', 'windows'].includes(Deno.build.os)) throw new Error('MCM desktop supports Windows and Linux.');
const platform = Deno.build.os === 'windows' ? 'windows' : 'linux';
const build = new Deno.Command(Deno.execPath(), {
  args: ['task', `desktop:build:${platform}`],
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
const result = await build.output();
if (!result.success) Deno.exit(result.code);
const launcher = new URL(`../dist/desktop/${platform}/MCM/MCM${platform === 'windows' ? '.exe' : ''}`, import.meta.url);
const command = new Deno.Command(fileURLToPath(launcher), { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
Deno.exit((await command.output()).code);
