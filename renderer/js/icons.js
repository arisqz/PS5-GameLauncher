// Line icons (24×24, stroke = currentColor). Paths adapted from Feather/Lucide (MIT/ISC).
const P = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5.5 5.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  home: '<path d="M3.5 10.2 12 3.5l8.5 6.7V20a1 1 0 0 1-1 1h-5v-6.2h-5V21h-5a1 1 0 0 1-1-1z"/>',
  library:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><path d="M15.2 14.6h4.6a1.7 1.7 0 0 1 1.68 1.46l.4 2.9a1.4 1.4 0 0 1-2.43 1.13l-.95-1.04h-3.4l-.95 1.04a1.4 1.4 0 0 1-2.43-1.13l.4-2.9a1.7 1.7 0 0 1 1.68-1.46z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  gamepad:
    '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59l-.9 7.2A2.7 2.7 0 0 0 4.5 19c.9 0 1.7-.5 2.1-1.3L8 15h8l1.4 2.7c.4.8 1.2 1.3 2.1 1.3a2.7 2.7 0 0 0 2.7-3.2l-.9-7.2A4 4 0 0 0 17.32 5z"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  display: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  play: '<path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  more: '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  starFill: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" fill="currentColor"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  trophy:
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0z"/>',
  storage: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
  system: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10"/>',
  sort: '<path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  restart: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
  sparkle: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
  accessibility: '<circle cx="12" cy="4.5" r="1.8"/><path d="M4 8.5l8 1.5 8-1.5M12 10v4.5M8.5 21l3.5-6.5 3.5 6.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  backspace: '<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6M12 9l6 6"/>',
  shift: '<path d="M12 3 3 12h5v8h8v-8h5z"/>',
  space: '<path d="M4 10v4h16v-4"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  steam: '<circle cx="12" cy="12" r="10"/><circle cx="15.5" cy="9.5" r="2.5"/><path d="m13.4 11.3-3.9 2.9M2.6 14.5l4.4 1.8"/><circle cx="8.6" cy="15.6" r="2"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  skipNext: '<path d="M5 5.2v13.6a.8.8 0 0 0 1.25.66l9.4-6.8a.8.8 0 0 0 0-1.32l-9.4-6.8A.8.8 0 0 0 5 5.2z" fill="currentColor" stroke="none"/><rect x="16.6" y="4.5" width="2.6" height="15" rx="1" fill="currentColor" stroke="none"/>',
  skipPrev: '<path d="M19 5.2v13.6a.8.8 0 0 1-1.25.66l-9.4-6.8a.8.8 0 0 1 0-1.32l9.4-6.8A.8.8 0 0 1 19 5.2z" fill="currentColor" stroke="none"/><rect x="4.8" y="4.5" width="2.6" height="15" rx="1" fill="currentColor" stroke="none"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  party: '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><circle cx="17.2" cy="9.2" r="2.7"/><path d="M16.6 14.4a5.2 5.2 0 0 1 5 6.1"/>',
  micOff:
    '<path d="m2 2 20 20"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M17 16.95A7 7 0 0 1 5 12v-2M19 10v2a7 7 0 0 1-.11 1.23M12 19v3"/>',
  headphonesOff: '<path d="M3 18v-6a9 9 0 0 1 15.4-6.33M21 12v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/><path d="m2 2 20 20"/>',
  phoneOff:
    '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="M23 1 1 23"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  speaker: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  nightLight: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/><path d="M17 3v3M15.5 4.5h3"/>',
  fBluetooth:
    '<mask id="clm-bt"><rect width="24" height="24" fill="#fff"/><path d="m8.4 8.6 7.2 6.8-3.6 3.4V5.2l3.6 3.4-7.2 6.8" stroke="#000" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></mask><rect x="3.4" y="1.8" width="17.2" height="20.4" rx="8.6" fill="currentColor" stroke="none" mask="url(#clm-bt)"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  // Filled glyphs for the settings root (PS5 style)
  fLibrary:
    '<g fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><path d="M14.6 14h4.8a1.9 1.9 0 0 1 1.86 1.6l.5 3.1a1.5 1.5 0 0 1-2.6 1.25l-.9-1.05h-3.5l-.9 1.05a1.5 1.5 0 0 1-2.6-1.25l.5-3.1A1.9 1.9 0 0 1 14.6 14z"/></g>',
  fHome: '<path fill="currentColor" stroke="none" d="M12 2.8 2.6 10.3c-.45.36-.2 1.1.38 1.1H5V20a1 1 0 0 0 1 1h4.4v-5.8h3.2V21H18a1 1 0 0 0 1-1v-8.6h2.02c.58 0 .83-.74.38-1.1z"/>',
  fUsers:
    '<mask id="clm-user"><rect width="24" height="24" fill="#fff"/><circle cx="8.9" cy="10" r="1.45" fill="#000"/><circle cx="15.1" cy="10" r="1.45" fill="#000"/><path d="M8.4 14.1c1 1.35 2.2 2 3.6 2s2.6-.65 3.6-2" stroke="#000" stroke-width="1.8" fill="none"/></mask><rect x="2.8" y="2.8" width="18.4" height="18.4" rx="4.6" fill="currentColor" stroke="none" mask="url(#clm-user)"/>',
  fSystem: '<g fill="currentColor" stroke="none"><path d="M12 2.4 20.6 6.9 12 11.3 3.4 6.9z"/><path d="M2.9 8.3l8.4 4.3v9.2l-8.4-4.4z"/><path d="M21.1 8.3l-8.4 4.3v9.2l8.4-4.4z"/></g>',
  fStorage: '<g fill="currentColor" stroke="none"><ellipse cx="12" cy="5.8" rx="8" ry="3.1"/><path d="M4 8v10.1c0 1.75 3.6 3.15 8 3.15s8-1.4 8-3.15V8c-1.6 1.45-4.6 2.3-8 2.3S5.6 9.45 4 8z"/></g>',
  fSound: '<path fill="currentColor" stroke="none" d="M3 9h4l5.6-4.6c.4-.33 1-.04 1 .48v14.24c0 .52-.6.81-1 .48L7 15H3a.8.8 0 0 1-.8-.8V9.8A.8.8 0 0 1 3 9z"/><path d="M16.6 8.8a4.6 4.6 0 0 1 0 6.4M19.2 6.2a8.4 8.4 0 0 1 0 11.6" stroke-width="2"/>',
  fScreen: '<rect x="2.4" y="5.8" width="19.2" height="12.4" rx="1.2" stroke-width="2.4"/>',
  fAccessories:
    '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M7.1 5.6h9.8a4.4 4.4 0 0 1 4.33 3.6l1.12 6.3a2.9 2.9 0 0 1-5.1 2.35L15.2 15H8.8l-2.05 2.85a2.9 2.9 0 0 1-5.1-2.35L2.77 9.2A4.4 4.4 0 0 1 7.1 5.6zM7.2 8.4v1.75H5.45v1.6H7.2v1.75h1.6v-1.75h1.75v-1.6H8.8V8.4zm9 .45a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1zm-1.9 2.3a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1z"/>',
  fGuide:
    '<path fill="currentColor" stroke="none" d="M4 4.6C4 3.7 4.7 3 5.6 3H11v16.4c-.9-.7-2-1-3.2-1H5.6c-.9 0-1.6-.7-1.6-1.6zM13 3h5.4c.9 0 1.6.7 1.6 1.6v12.2c0 .9-.7 1.6-1.6 1.6h-2.2c-1.2 0-2.3.3-3.2 1z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  fAbout:
    '<mask id="clm-info"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="7.6" r="1.35" fill="#000"/><rect x="10.85" y="10.3" width="2.3" height="7" rx="1.1" fill="#000"/></mask><circle cx="12" cy="12" r="9.6" fill="currentColor" stroke="none" mask="url(#clm-info)"/>',
};

export function icon(name, cls = '') {
  const p = P[name] || P.info;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

export function iconEl(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstElementChild;
}
