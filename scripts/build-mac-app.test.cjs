const test = require('node:test');
const assert = require('node:assert/strict');
const {runInNewContext} = require('node:vm');
const {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {xml, appPlist, bootstrap, generatedApp} = require('./build-mac-app.cjs');

test('native launcher plist preserves spaces and escapes project paths', () => {
  const plist = appPlist('/Users/test/A & B/研究 "sample"', '0.1.0');
  assert.match(plist, /A &amp; B\/研究 &quot;sample&quot;/);
  assert.match(plist, /CFBundleExecutable.*Electron/);
  assert.match(plist, /CFBundleName.*Scientelier/);
  assert.match(plist, /CFBundleDisplayName.*Scientelier/);
  assert.match(plist, /CFBundleIconFile.*Scientelier.icns/);
  assert.match(plist, /CFBundleIdentifier.*local.agent-harness.desktop/);
  assert.match(plist, /AgentHarnessProjectPath/);
  assert.doesNotMatch(plist, /LSUIElement/);
  assert.match(plist,/NSMainNibFile.*MainMenu/);
  assert.equal(xml("<'a'>"), '&lt;&apos;a&apos;&gt;');
});

test('app ownership recognizes the old repo symlink but rejects an unrelated app', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scientelier-brand-'));
  try {
    const project = join(directory, 'Scientelier & research'), alias = join(directory, 'agent_harness');
    const app = join(directory, 'Agent Harness.app'), other = join(directory, 'other');
    mkdirSync(project); mkdirSync(other); symlinkSync(project, alias);
    mkdirSync(join(app, 'Contents'), {recursive:true});
    writeFileSync(join(app, 'Contents', 'Info.plist'), appPlist(alias, '0.1.0'));
    assert.equal(generatedApp(app, project), true);
    assert.equal(generatedApp(app, other), false);
    writeFileSync(join(app, 'Contents', 'Info.plist'), appPlist(project, '0.1.0').replace('local.agent-harness.desktop', 'unrelated.vendor.app'));
    assert.equal(generatedApp(app, project), false);
  } finally { rmSync(directory, {recursive:true,force:true}); }
});

test('branding preserves native Electron metadata instead of recreating its plist', () => {
  const original = appPlist('/old/project', '0.0.1')
    .replace('<key>AgentHarnessProjectPath</key><string>/old/project</string>', '')
    .replace('</dict></plist>', '<key>RuntimeOnlyKey</key><string>keep me</string></dict></plist>');
  const plist = appPlist('/new/A & B', '0.2.0', original);
  assert.match(plist, /RuntimeOnlyKey.*keep me/);
  assert.match(plist, /NSMainNibFile.*MainMenu/);
  assert.match(plist, /CFBundleExecutable.*Electron/);
  assert.match(plist, /CFBundleShortVersionString.*0\.2\.0/);
  assert.match(plist, /AgentHarnessProjectPath.*\/new\/A &amp; B/);
  assert.equal((plist.match(/<key>AgentHarnessProjectPath<\/key>/g) || []).length, 1);
});

test('desktop bootstrap preserves data identity and loads the latest project', () => {
  const source=bootstrap('/Users/test/研究 "sample"');
  assert.doesNotThrow(()=>new Function(source));
  assert.match(source,/join\(app.getPath\('appData'\),'agent-harness'\);app.setPath\('userData',userData\)/);
  assert.match(source,/timeout:4000/);
  assert.match(source,/process.chdir\(project\);require\(join\(project,'dist\/main.js'\)\)/);
  assert.doesNotMatch(source,/console\.log|ELECTRON_RUN_AS_NODE=1/);
  assert.match(source,/desktop-startup.log/);
});

test('Finder bootstrap restores only PATH and retains existing user data', () => {
  const calls=[], process={env:{PATH:'/usr/bin'},chdir:p=>calls.push(['cwd',p])};
  runInNewContext(bootstrap('/work/研究 app'),{process,require:id=>{
    if(id==='electron')return {app:{getPath:()=>'/saved',setPath:(...a)=>calls.push(a),commandLine:{appendSwitch:()=>{}}}};
    if(id==='node:path')return require('node:path');
    if(id==='node:fs')return {existsSync:()=>true};
    if(id==='node:child_process')return {spawnSync:(command,args,options)=>{
      assert.equal(command,'/bin/zsh'); assert.equal(options.timeout,4000);
      assert.equal(args[1], 'printf "\\0%s\\0" "$PATH"');
      return {stdout:'shell notice\n\0/opt/homebrew/bin:/usr/bin\0'};
    }};
    calls.push(['main',id]);
  }});
  assert.deepEqual(calls,[['userData','/saved/agent-harness'],['cwd','/work/研究 app'],['main','/work/研究 app/dist/main.js']]);
  assert.equal(process.env.PATH,'/opt/homebrew/bin:/usr/bin');
});
