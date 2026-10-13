import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Ship our probes and the explicitly installed statusLine hook. Credentials stay
// on the final host; only parsed observations travel over the existing SSH link.
export async function remoteModules(directory: string): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const name of ["remote-bridge", "capacity-probes", "claude-capacity", "antigravity-remote", "antigravity-usage", "json-file-writer", "git-workspace"]) {
    sources[`./${name}`] = await readFile(join(directory, `${name}.js`), "utf8");
  }
  sources["./antigravity-hook-source"] = `exports.source=${JSON.stringify(await readFile(join(directory, "..", "..", "scripts", "antigravity-status.cjs"), "utf8"))};`;
  return sources;
}
export function remoteModuleLoader(sources: Record<string, string>): string {
  return `const sources=${JSON.stringify(sources)};const cache={};const load=name=>{if(!Object.hasOwn(sources,name))return require(name);if(cache[name])return cache[name].exports;const m=cache[name]={exports:{}};new Function('require','module','exports',sources[name])(load,m,m.exports);return m.exports};`;
}
