// Settings › User Guide: step-by-step help for the setups that need a few
// clicks outside the launcher. Rendered by the settings view ('step' items).

import { api } from '../state.js';

const step = (n, label) => ({ type: 'step', n, label });

export function guideCategory(router) {
  const go = (category, section) => () => router.open('settings', { category, section });
  return {
    id: 'guide',
    readable: true,
    label: 'User Guide',
    icon: 'fGuide',
    desc: 'How to set up Discord, artwork, brightness and more',
    sections: [
      {
        label: 'Adding Games',
        items: () => [
          { type: 'header', label: 'Get your games into the launcher' },
          step(1, 'Steam and Epic Games are found automatically. Make sure the Steam and Epic switches are on in Settings › Library.'),
          step(2, 'For any other game, make a folder (for example "D:\\Game Shortcuts") and put shortcuts to your games in it: .lnk, .url or .exe files.'),
          step(3, 'Open Settings › Library and choose Add Folder…, then pick that folder. You can also drag a shortcut or a folder onto the window.'),
          step(4, 'Artwork, logos and descriptions are downloaded automatically. If a game shows the wrong art, open its … menu and choose Change Artwork › Find on Steam…'),
          { type: 'action', icon: 'folderPlus', label: 'Add a Game Folder…', run: () => api.addFolder() },
          { type: 'action', icon: 'settings', label: 'Open Library Settings', run: go('library') },
        ],
      },
      {
        label: 'Connect Discord',
        items: () => [
          { type: 'header', label: 'Control your voice call from the quick menu' },
          { type: 'note', label: 'Discord only lets apps control your voice if you own the app, so you create your own once. It is free and takes about two minutes.' },
          step(1, 'Open the Discord Developer Portal (button below) in your browser and sign in with your Discord account.'),
          step(2, 'Click New Application, give it any name (for example "PS5 Launcher") and accept the terms.'),
          step(3, 'Open OAuth2 in the menu on the left. Copy the Client ID.'),
          step(4, 'Click Reset Secret, confirm, and copy the Client Secret. It is only shown once.'),
          step(5, 'Under Redirects, click Add Redirect, enter http://localhost and click Save Changes.'),
          step(6, 'In the launcher, open Settings › Users and Accounts › Discord. Enter the Client ID and the Client Secret, then choose Connect to Discord.'),
          step(7, 'Discord shows an Authorize window. Click Authorize. From now on the launcher connects by itself whenever Discord is running.'),
          { type: 'action', icon: 'external', label: 'Open the Discord Developer Portal', run: () => api.openExternal('https://discord.com/developers/applications') },
          { type: 'action', icon: 'party', label: 'Go to Discord Settings', run: go('users', 'Discord') },
        ],
      },
      {
        label: 'Better Artwork',
        items: () => [
          { type: 'header', label: 'SteamGridDB for games that are not on Steam' },
          { type: 'note', label: 'Most artwork comes from Steam and needs no setup. For Epic exclusives, emulated games and other games that are not on Steam, a free SteamGridDB key gives much better covers, backgrounds and logos.' },
          step(1, 'Open SteamGridDB (button below) and sign in. You can sign in with your Steam account.'),
          step(2, 'Go to your profile Preferences › API and click Generate API Key. Copy the key.'),
          step(3, 'In the launcher, open Settings › Library › Artwork, choose SteamGridDB API Key and paste the key.'),
          step(4, 'Choose Refresh All Artwork on the same page to download the new art for your whole library.'),
          { type: 'action', icon: 'external', label: 'Open SteamGridDB', run: () => api.openExternal('https://www.steamgriddb.com/profile/preferences/api') },
          { type: 'action', icon: 'image', label: 'Go to Artwork Settings', run: go('library', 'Artwork') },
        ],
      },
      {
        label: 'Brightness',
        items: () => [
          { type: 'header', label: 'If a monitor is missing in Brightness' },
          { type: 'note', label: 'The launcher changes the brightness on the monitor itself, the same as its own buttons. This uses a standard called DDC/CI, which most monitors support but some ship with turned off.' },
          step(1, 'Open your monitor’s on-screen menu with the buttons on the monitor (often under System, Setup or Other) and turn on DDC/CI.'),
          step(2, 'Connect the monitor directly to your graphics card with DisplayPort or HDMI. Docks, KVM switches and some adapters do not pass DDC/CI through.'),
          step(3, 'Come back to Settings › Screen and Video › Brightness. The monitor is looked for again every time you open the page.'),
          step(4, 'Still missing? Some monitors and most TVs do not support DDC/CI at all. Use the monitor’s own buttons for those. Laptop screens use the Windows brightness instead and always work.'),
          { type: 'action', icon: 'sun', label: 'Go to Brightness', run: go('screen', 'Brightness') },
        ],
      },
      {
        label: 'Controller',
        items: () => [
          { type: 'header', label: 'If the Guide / PS button does nothing' },
          step(1, 'Steam can take over the button. In Steam, open Settings › Controller and turn off the Guide button chord, or close Steam to test.'),
          step(2, 'The Xbox Game Bar can open on the Xbox button. In Windows Settings › Gaming › Game Bar, turn off "Open Game Bar using this button on a controller".'),
          step(3, 'In games, the quick menu also opens with Ctrl+Alt+Home on the keyboard. You can turn the overlay and the shortcut on or off in Settings › System › In-Game Overlay.'),
          { type: 'action', icon: 'settings', label: 'Go to Overlay Settings', run: go('system', 'In-Game Overlay') },
        ],
      },
    ],
  };
}
