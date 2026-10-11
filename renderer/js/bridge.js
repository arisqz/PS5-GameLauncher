// Platform bridge, loaded before the app's modules.
//
// Electron: the preload script has already put `window.api` in place, and
// app:// URLs work as they are.
//
// Tauri: `window.api` is built here with the same functions. Every call goes
// to one Rust command ("ipc") with the Electron channel name, so the Rust side
// mirrors main/main.js handler by handler. app:// URLs are served by the Rust
// "app" protocol, which WebView2 reaches as http://app.localhost/<root>/...

(() => {
  const tauri = window.__TAURI__;
  if (!tauri) {
    window.appUrl = (url) => url;
    return;
  }

  window.appUrl = (url) => (typeof url === 'string' ? url.replace(/^app:\/\//, 'http://app.localhost/') : url);

  const CHANNELS = {
    getState: 'state:get',
    getInfo: 'info:get',
    setSettings: 'settings:set',

    scan: 'library:scan',
    refreshAll: 'library:refreshAll',
    addFolder: 'library:addFolder',
    removeFolder: 'library:removeFolder',
    addFiles: 'library:addFiles',
    importPaths: 'library:import',
    restoreExcluded: 'library:restoreExcluded',
    resetLibrary: 'library:reset',

    updateGame: 'game:update',
    removeGame: 'game:remove',
    refreshArt: 'game:refreshArt',
    setMatch: 'game:setMatch',
    customArt: 'game:customArt',
    openLocation: 'game:openLocation',
    pickProfileImage: 'profile:pickImage',
    removeProfileImage: 'profile:removeImage',
    launch: 'game:launch',
    closeGame: 'game:close',
    continueGame: 'game:continue',
    launchCancel: 'game:launchCancel',
    gamesRunning: 'games:running',
    overlayClosed: 'overlay:closed',
    overlayNavigate: 'overlay:navigate',
    overlayToggle: 'overlay:toggle',
    popupInGame: 'notify:popup',
    passthroughStatus: 'passthrough:status',
    padFallback: 'pad:fallback',
    soundPacks: 'sounds:list',
    browseSoundPacks: 'sounds:browse',
    downloadSoundPack: 'sounds:download',
    removeSoundPack: 'sounds:remove',
    installSoundPack: 'sounds:installLocal',

    searchSteam: 'steam:search',

    discordState: 'discord:state',
    discordSetup: 'discord:setup',
    discordConnect: 'discord:connect',
    discordDisconnect: 'discord:disconnect',
    discordForget: 'discord:forget',
    discordCmd: 'discord:cmd',
    discordOpenChat: 'discord:openChat',
    discordCloseChat: 'discord:closeChat',
    discordOpenInDiscord: 'discord:openInDiscord',

    sysAvailable: 'sys:available',
    media: 'sys:media',
    mediaPlaying: 'sys:mediaPlaying',
    mediaCommand: 'sys:mediaCmd',
    getVolume: 'sys:volume',
    setVolume: 'sys:setVolume',
    setMute: 'sys:setMute',
    audioOutputs: 'sys:audioOutputs',
    setAudioOutput: 'sys:setAudioOutput',
    getBrightness: 'sys:brightness',
    setBrightness: 'sys:setBrightness',
    getNightLight: 'sys:nightLight',
    setNightLight: 'sys:setNightLight',
    btState: 'bt:state',
    btRadio: 'bt:radio',
    btConnect: 'bt:connect',
    btPair: 'bt:pair',
    btUnpair: 'bt:unpair',
    btScan: 'bt:scan',
    cacheSize: 'cache:size',
    openDataFolder: 'app:openData',
    openExternal: 'app:openExternal',
    windowAction: 'window:action',
    power: 'power:action',
  };

  const EVENTS = ['library:changed', 'scan:progress', 'notify', 'game:exited', 'game:running', 'window:state', 'settings:changed', 'discord:state', 'navigate', 'pad:action', 'overlay:open', 'overlay:close', 'overlay:toast', 'game:started', 'discord:message', 'discord:chat', 'passthrough:state'];

  const { invoke } = tauri.core;
  const api = {};
  for (const [name, channel] of Object.entries(CHANNELS)) {
    api[name] = (...args) => invoke('ipc', { channel, args });
  }

  // Dropped files: Tauri hands over paths itself (see the drag-drop event), so
  // there is no File -> path lookup like Electron's webUtils.
  api.pathForFile = () => null;

  // Listening on this window: gets events for every window (emit) and the ones
  // meant only for this one (emit_to), like Electron's webContents.send.
  const thisWindow = tauri.webviewWindow.getCurrentWebviewWindow();
  api.on = (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    let off = null;
    let cancelled = false;
    thisWindow.listen(channel, (e) => cb(e.payload)).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      if (off) off();
    };
  };

  window.api = Object.freeze(api);
})();
