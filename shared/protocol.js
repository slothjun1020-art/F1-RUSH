// Constants and validation helpers shared by the server and the browser client.

export const MAX_PLAYERS = 8;
export const LAPS = 5;
const NICK_MAX = 12;
export const COUNTDOWN_MS = 4000;
// How often the server rebroadcasts every car's position to the room, and how often each client
// reports its own car back to the server. Both were raised from the original 20 Hz because a
// remote car can only look as smooth as the rarer of the two: sending your own position more often
// does nothing for how other players see you if the server still only relays it 20 times a second.
export const SNAP_HZ = 30;
export const SEND_HZ = 32;
export const FINISH_GRACE_MS = 60000;

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export const CAR_COLORS = [
  '#e10600', '#1e6bff', '#f5c400', '#12b76a',
  '#ff7a00', '#a855f7', '#00c2d1', '#ff5fa2',
];

export function sanitizeNick(raw) {
  if (typeof raw !== 'string') return '';
  // Drop control characters and collapse whitespace; render code only ever uses textContent/fillText.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, NICK_MAX).join('');
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export function isValidCode(code) {
  return typeof code === 'string'
    && code.length === CODE_LENGTH
    && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export function isFiniteNum(n, limit = 1e6) {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;
}
