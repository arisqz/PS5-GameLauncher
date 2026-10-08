import { escapeHtml } from '../util.js';
import { state } from '../state.js';

export const AVATARS = [
  'linear-gradient(135deg,#3b82f6,#7c3aed)',
  'linear-gradient(135deg,#f97316,#db2777)',
  'linear-gradient(135deg,#10b981,#0ea5e9)',
  'linear-gradient(135deg,#eab308,#ef4444)',
  'linear-gradient(135deg,#6366f1,#ec4899)',
  'linear-gradient(135deg,#14b8a6,#84cc16)',
  'linear-gradient(135deg,#64748b,#0f172a)',
  'linear-gradient(135deg,#f43f5e,#8b5cf6)',
];

/** Avatar markup for a profile ({ name, avatar, image }); defaults to the active one. */
export function avatarHtml(cls = '', profile = null) {
  const s = state.settings;
  const p = profile || { name: s.profileName, avatar: s.avatar, image: s.avatarImage };
  const bg = AVATARS[(p.avatar || 0) % AVATARS.length];
  if (p.image && /^app:\/\/avatar\//.test(p.image)) {
    return `<div class="avatar has-image ${cls}" style="background:${bg}"><img class="av-img" src="${escapeHtml(p.image)}" alt="" draggable="false"></div>`;
  }
  const initial = escapeHtml((p.name || 'P').trim().charAt(0).toUpperCase() || 'P');
  return `<div class="avatar ${cls}" style="background:${bg}"><span class="av-initial">${initial}</span></div>`;
}
