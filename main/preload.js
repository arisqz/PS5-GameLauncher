const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: invoke('state:get'),
  getInfo: invoke('info:get'),
  setSettings: invoke('settings:set'),

  scan: invoke('library:scan'),
  refreshAll: invoke('library:refreshAll'),
  addFolder: invoke('library:addFolder'),
  removeFolder: invoke('library:removeFolder'),
  addFiles: invoke('library:addFiles'),
  importPaths: invoke('library:import'),
  restoreExcluded: invoke('library:restoreExcluded'),
  resetLibrary: invoke('library:reset'),

  updateGame: invoke('game:update'),
  removeGame: invoke('game:remove'),
  refreshArt: invoke('game:refreshArt'),
  setMatch: invoke('game:setMatch'),
  customArt: invoke('game:customArt'),
  openLocation: invoke('game:openLocation'),
  pickProfileImage: invoke('profile:pickImage'),
  removeProfileImage: invoke('profile:removeImage'),
  launch: invoke('game:launch'),
  closeGame: invoke('game:close'),
  continueGame: invoke('game:continue'),
  launchCancel: invoke('game:launchCancel'),
  gamesRunning: invoke('games:running'),
  overlayClosed: invoke('overlay:closed'),
  overlayNavigate: invoke('overlay:navigate'),
  overlayToggle: invoke('overlay:toggle'),

  searchSteam: invoke('steam:search'),

  discordState: invoke('discord:state'),
  discordSetup: invoke('discord:setup'),
  discordConnect: invoke('discord:connect'),
  discordDisconnect: invoke('discord:disconnect'),
  discordForget: invoke('discord:forget'),
  discordCmd: invoke('discord:cmd'),

  sysAvailable: invoke('sys:available'),
  media: invoke('sys:media'),
  mediaCommand: invoke('sys:mediaCmd'),
  getVolume: invoke('sys:volume'),
  setVolume: invoke('sys:setVolume'),
  setMute: invoke('sys:setMute'),
  audioOutputs: invoke('sys:audioOutputs'),
  setAudioOutput: invoke('sys:setAudioOutput'),
  getBrightness: invoke('sys:brightness'),
  setBrightness: invoke('sys:setBrightness'),
  getNightLight: invoke('sys:nightLight'),
  setNightLight: invoke('sys:setNightLight'),
  btState: invoke('bt:state'),
  btRadio: invoke('bt:radio'),
  btConnect: invoke('bt:connect'),
  btPair: invoke('bt:pair'),
  btUnpair: invoke('bt:unpair'),
  btScan: invoke('bt:scan'),
  cacheSize: invoke('cache:size'),
  openDataFolder: invoke('app:openData'),
  openExternal: invoke('app:openExternal'),
  windowAction: invoke('window:action'),
  power: invoke('power:action'),

  pathForFile: (file) => webUtils.getPathForFile(file),

  on(channel, cb) {
    const allowed = ['library:changed', 'scan:progress', 'notify', 'game:exited', 'game:running', 'window:state', 'settings:changed', 'discord:state', 'navigate', 'pad:action', 'overlay:open', 'overlay:close', 'game:started'];
    if (!allowed.includes(channel)) return () => {};
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
