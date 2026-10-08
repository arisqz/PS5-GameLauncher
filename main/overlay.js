// In-game overlay: a transparent, always-on-top window that shows the quick
// menu above whatever is in the foreground. It is a normal separate window —
// nothing is injected into or read from the game.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

class OverlayManager {
  /**
   * @param {object} o
   * @param {import('./system').SystemBridge} o.system
   */
  constructor({ system, onVisibility }) {
    this.system = system;
    this.onVisibility = onVisibility || (() => {});
    this.win = null;
    this.visible = false;
    this.prevForeground = null;
    this.hideTimer = null;
  }

  create() {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      title: 'PS5 Game Launcher Overlay',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenu(null);
    win.loadURL('app://ui/overlay.html');
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12' && process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
    });
    win.on('closed', () => {
      this.win = null;
      this.visible = false;
    });
    this.win = win;
    return win;
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  hwndOf(win) {
    try {
      const buf = win.getNativeWindowHandle();
      return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    } catch {
      return 0;
    }
  }

  /** Show the overlay on the monitor of the current foreground window. */
  async show(info = {}) {
    if (!this.win) this.create();
    if (this.visible) return;
    clearTimeout(this.hideTimer);
    this.visible = true;
    const fg = await this.system.foreground();
    this.prevForeground = fg && fg.hwnd ? fg.hwnd : null;
    const display = fg && fg.w > 0 ? screen.getDisplayMatching({ x: fg.x, y: fg.y, width: fg.w, height: fg.h }) : screen.getPrimaryDisplay();
    this.win.setBounds(display.bounds);
    this.send('overlay:open', info);
    this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.moveTop();
    this.system.setPadForward(true);
    this.onVisibility(true);
    // Take focus so the game stops reacting to input while the menu is open
    // (games read the controller only while they are the foreground window).
    // Fullscreen games sometimes take it straight back, so keep claiming it.
    const hwnd = this.hwndOf(this.win);
    const ok = await this.system.focusWindow(hwnd);
    if (!ok) this.win.focus();
    clearInterval(this.focusTimer);
    this.focusTimer = setInterval(async () => {
      if (!this.visible || !this.win) return clearInterval(this.focusTimer);
      const fg = await this.system.foreground();
      if (this.visible && fg && Number(fg.hwnd) !== Number(hwnd)) {
        await this.system.focusWindow(hwnd);
        this.win.moveTop();
      }
    }, 400);
  }

  /** Ask the overlay page to play its closing animation (it calls hideNow after). */
  requestClose() {
    if (!this.visible) return;
    this.send('overlay:close');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideNow(), 900);
  }

  async hideNow({ restoreFocus = true } = {}) {
    clearTimeout(this.hideTimer);
    if (!this.win || !this.visible) return;
    this.visible = false;
    clearInterval(this.focusTimer);
    this.system.setPadForward(false);
    this.win.hide();
    // Resume a paused game before it gets focus back.
    await this.onVisibility(false);
    if (restoreFocus && this.prevForeground) await this.system.focusWindow(this.prevForeground);
    this.prevForeground = null;
  }

  toggle(info) {
    if (this.visible) this.requestClose();
    else this.show(info);
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { OverlayManager };
