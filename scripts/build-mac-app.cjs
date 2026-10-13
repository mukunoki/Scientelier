// A normal Electron .app that loads the live project. No authentication or task
// data is copied; ordinary project updates keep using the same desktop icon.
const {execFileSync} = require('node:child_process');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, realpathSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {homedir} = require('node:os');

function xml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}

function appPlist(project, version, original) {
  // Keep Electron's native window/menu and runtime metadata. Only branding
  // changes; rebuilding a minimal plist drops platform-specific startup keys.
  if(original) {
    // Keep the bundle identifier to retain OS permissions and app ownership.
    for(const [key,value] of Object.entries({CFBundleIdentifier:'local.agent-harness.desktop',CFBundleName:'Scientelier',
      CFBundleDisplayName:'Scientelier',CFBundleIconFile:'Scientelier.icns',CFBundleShortVersionString:version})) {
      const pattern=new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
      if(!pattern.test(original))throw new Error(`Electron Info.plistに${key}がありません。`);
      original=original.replace(pattern,(_all,start,end)=>start+xml(value)+end);
    }
    return original.replace(/<\/dict>\s*<\/plist>\s*$/,`<key>AgentHarnessProjectPath</key><string>${xml(project)}</string>\n</dict></plist>\n`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.agent-harness.desktop</string>
<key>CFBundleName</key><string>Scientelier</string>
<key>CFBundleDisplayName</key><string>Scientelier</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>Scientelier.icns</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>AtomApplication</string>
<key>NSMainNibFile</key><string>MainMenu</string>
<key>NSRequiresAquaSystemAppearance</key><false/>
<key>NSQuitAlwaysKeepsWindows</key><false/>
<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
<key>AgentHarnessProjectPath</key><string>${xml(project)}</string>
</dict></plist>\n`;
}

function bootstrap(project, standalone = false) {
  return `const {app,dialog}=require('electron');
const {join}=require('node:path');const {existsSync,mkdirSync,writeFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');
const project=${standalone ? '__dirname' : JSON.stringify(project)};
// Keep the existing data/Keychain identity even though Finder has a new bundle.
const userData=join(app.getPath('appData'),'agent-harness');app.setPath('userData',userData);
app.commandLine.appendSwitch('force-renderer-accessibility');
function fail(error) {
  let detail=String(error?.stack||error);try{detail=require(join(project,'dist/core/redact.js')).redactSecrets(detail);}catch{}
  const logs=join(userData,'logs');mkdirSync(logs,{recursive:true});writeFileSync(join(logs,'desktop-startup.log'),detail,{mode:0o600});
  app.whenReady().then(()=>{dialog.showErrorBox('Scientelierを起動できません',detail);app.quit();});
}
if(!existsSync(join(project,'dist/main.js'))) {
  fail(new Error('Scientelierのプロジェクトフォルダを開けません。移動・削除せず、Macのフォルダアクセス許可を確認してください。\\n'+project));
} else {
  // Finder does not inherit the terminal PATH. Import only PATH, never secrets
  // or shell output, and bound startup so a shell profile cannot hang the app.
  const shell=spawnSync('/bin/zsh',['-lic', 'printf "\\\\0%s\\\\0" "$PATH"'],{encoding:'utf8',timeout:4000});
  const path=shell.stdout?.split('\\0').at(-2);if(path)process.env.PATH=path;
  try{process.chdir(project);require(join(project,'dist/main.js'));}catch(error){fail(error);}
}
`;
}

function generatedApp(target, project) {
  const plist = readFileSync(join(target, 'Contents/Info.plist'), 'utf8');
  if (!/<string>local\.agent-harness\.(launcher|desktop)<\/string>/.test(plist)) return false;
  const encoded = plist.match(/<key>AgentHarnessProjectPath<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  if (!encoded) return false;
  // The old checkout path may be a compatibility symlink after a repo rename.
  // Resolve it before ownership checks, never move apps belonging to another repo.
  const stored = encoded.replace(/&(amp|lt|gt|quot|apos);/g, (_match, key) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[key]));
  try { return realpathSync(stored) === realpathSync(project); } catch { return false; }
}

function build(project = resolve(__dirname, '..')) {
  if (process.platform !== 'darwin') throw new Error('Mac上で実行してください。');
  if (!existsSync(join(project, 'dist/main.js'))) throw new Error('先に npm run build を実行してください。');
  const target = join(project, 'Scientelier.app');
  // Never overwrite an unrelated user app. Existing generated launchers are
  // moved aside, not deleted, so an interrupted rebuild remains recoverable.
  if (existsSync(target)) {
    if (!generatedApp(target, project)) {
      throw new Error('同名の別アプリがあります。上書きしません。');
    }
  }
  const staging = mkdtempSync(join(project, '.mac-app-build-'));
  const bundle = join(staging, 'Scientelier.app'), contents = join(bundle, 'Contents');
  execFileSync('/usr/bin/ditto', [join(project,'node_modules/electron/dist/Electron.app'), bundle]);
  const binary = join(staging, 'make-icon');
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', join(project, 'assets/macos/icon.m'), '-o', binary], {stdio:'inherit'});
  const iconset = join(staging, 'Scientelier.iconset'); mkdirSync(iconset);
  execFileSync(binary, [iconset]);
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources', 'Scientelier.icns')]);
  copyFileSync(join(iconset, 'icon_256x256@2x.png'), join(project, 'assets/macos/app-icon.png'));
  const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
  writeFileSync(join(contents, 'Info.plist'), appPlist(project, version, readFileSync(join(contents,'Info.plist'),'utf8')));
  const entry=join(contents,'Resources','app');mkdirSync(entry);
  // Legacy runtime name is deliberate: preserve macOS Safe Storage encryption.
  writeFileSync(join(entry,'package.json'),JSON.stringify({name:'agent-harness',version,main:'bootstrap.cjs'}));
  writeFileSync(join(entry,'bootstrap.cjs'),bootstrap(project));
  execFileSync('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')], {stdio:'inherit'});
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle], {stdio:'inherit'});
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {stdio:'inherit'});
  if (existsSync(target)) renameSync(target, join(staging, 'previous-launcher.app'));
  renameSync(bundle, target);
  if(process.argv.includes('--install-desktop')) {
    const desktop=join(homedir(),'Desktop','Scientelier.app');
    if(existsSync(desktop)) {
      if(!generatedApp(desktop,project))throw new Error('デスクトップに同名の別アプリがあります。上書きしません。');
      renameSync(desktop,join(staging,'previous-desktop.app'));
    }
    execFileSync('/usr/bin/ditto',[target,desktop]);
    console.log(`デスクトップに配置しました: ${desktop}`);
    // Retire only our previous branded bundles, after installing the new one.
    // Keep recoverable backups instead of deleting them or touching other apps.
    for (const [old,backup] of [[join(project,'Agent Harness.app'),'previous-agent-harness-project.app'],
      [join(homedir(),'Desktop','Agent Harness.app'),'previous-agent-harness-desktop.app']]) {
      if(existsSync(old) && generatedApp(old, project)) {
        renameSync(old,join(staging,backup));
        console.log(`旧アプリを退避しました: ${old}`);
      }
    }
  }
  console.log(`作成しました: ${target}\nFinderでダブルクリックして起動できます。元のプロジェクトは残してください。`);
  return target;
}

module.exports = {xml, appPlist, bootstrap, generatedApp, build};
if (require.main === module) build();
