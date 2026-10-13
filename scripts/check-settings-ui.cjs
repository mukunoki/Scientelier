// Uses smoke-layout's isolated stores and mock CLI transport, never live data.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
module.exports = async function checkSettingsUi(win, presets) {
  const js = source => win.webContents.executeJavaScript(source);
  const wait = async source => {
    for (let i = 0; i < 100; i++) {
      if (await js(source)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`Timed out: ${source}`);
  };
  await js(`showView('settings')`);
  assert.equal(await js(`document.querySelectorAll('.settings-page-nav [role=tab]').length`), 8);
  for (const id of ['execution','work-common','presets','writing','skills','remote','report','benchmarks']) {
    await js(`document.getElementById('settings-${id}-tab').click()`);
    assert.equal(await js(`document.querySelectorAll('.settings-page:not([hidden])').length`), 1);
    assert.equal(await js(`document.getElementById('settings-${id}').checkVisibility()`), true);
  }
  await js(`document.getElementById('settings-execution-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  assert.equal(await js(`document.activeElement.id`), 'settings-work-common-tab');
  // Switching categories must retain input and show remote deep links correctly.
  await js(`selectSettingsPage('settings-remote');document.getElementById('remote-user').value='unsaved-fixture';selectSettingsPage('settings-presets');openServiceSettings(undefined,true)`);
  assert.equal(await js(`document.getElementById('remote-user').value`), 'unsaved-fixture');
  assert.equal(await js(`document.getElementById('settings-remote').hidden`), false);
  await js(`selectSettingsPage('settings-presets');document.getElementById('preset-manager-select').value='coding';document.getElementById('preset-manager-select').dispatchEvent(new Event('change'))`);
  assert.equal(await js(`document.getElementById('preset-raw-editor').hidden`), true);
  assert.equal(await js(`document.querySelectorAll('.preset-panel textarea').length`), 1);
  assert.equal(await js(`document.querySelectorAll('.preset-panel textarea').length && document.getElementById('preset-rules').checkVisibility()`), false);
  assert.equal(await js(`document.querySelector('#preset-goal-editor, #preset-rule-sections')`), null);
  const before = await presets.capture('coding');
  await js(`document.getElementById('preset-edit').click();document.getElementById('preset-rules').value+='\\nUI regression draft';document.getElementById('preset-rules').dispatchEvent(new Event('input'));document.getElementById('preset-edit').click()`);
  assert.match(await js(`document.getElementById('preset-status').textContent`), /未保存/);
  await js(`document.getElementById('preset-manager-select').value='paper';document.getElementById('preset-manager-select').dispatchEvent(new Event('change'));document.getElementById('preset-manager-select').value='coding';document.getElementById('preset-manager-select').dispatchEvent(new Event('change'));selectSettingsPage('settings-report');selectSettingsPage('settings-presets');document.getElementById('preset-edit').click()`);
  assert.match(await js(`document.getElementById('preset-rules').value`), /UI regression draft/);
  await js(`document.getElementById('preset-save').click()`);
  await wait(`!presetsBusy`);
  const saved = await presets.capture('coding');
  assert.match(saved.rules, /UI regression draft/);
  assert.deepEqual(saved.manifest.goal, before.manifest.goal, 'hidden checklist defaults must survive saves unchanged');
  await js(`document.getElementById('preset-rules').value+='\\nDiscard me';document.getElementById('preset-rules').dispatchEvent(new Event('input'));document.getElementById('preset-revert').click()`);
  assert.equal(await js(`document.getElementById('preset-rules').value`), saved.rules);
  assert.equal(await js(`document.getElementById('preset-save').disabled`), true);
  // Editor reopening, asynchronous refresh and every category must work at small sizes.
  await js(`document.getElementById('preset-edit').click()`);
  for (const [width,height] of [[980,620],[1200,820]]) {
    win.setSize(width,height);
    await new Promise(resolve => setTimeout(resolve,100));
    assert.equal(await js(`(()=>{const v=document.getElementById('settings-view');return v.scrollWidth<=v.clientWidth+2})()`), true);
    await js(`selectSettingsPage('settings-report');document.getElementById('settings-view').scrollTop=document.getElementById('settings-view').scrollHeight`);
    assert.equal(await js(`(()=>{const v=document.getElementById('settings-view').getBoundingClientRect(),b=document.querySelector('#report-settings-form button[type=submit]').getBoundingClientRect();return b.top>=v.top&&b.bottom<=v.bottom+2})()`), true);
    await js(`selectSettingsPage('settings-presets')`);
  }
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync(join(__dirname,'../output/pdf/settings-tabs-simplified.png'), (await win.webContents.capturePage()).toPNG());
  console.log('Settings tabs, keyboard navigation, remote links, mode editor, persistence and resize checks passed.');
};
