// A.R.A.'s timed reminders in the app — [REMIND_ME: what | YYYY-MM-DD HH:MM]
// schedules a local notification on this phone, so it fires even with no
// backend and no signal. (Reminders set from Telegram are pushed by the
// server's reminder cron instead — server/reminders.js.)
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// "YYYY-MM-DD HH:MM" (device-local time, optional am/pm) or "+20m"/"+2h"/"+1d".
export function parseWhen(s) {
  s = String(s || '').trim();
  const rel = /^\+?\s*(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.exec(s);
  if (rel) {
    const unit = rel[2][0].toLowerCase();
    return new Date(Date.now() + Number(rel[1]) * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (!m) return null;
  let h = m[4] != null ? Number(m[4]) : 9;
  if (m[6]) { h %= 12; if (/pm/i.test(m[6])) h += 12; }
  return new Date(+m[1], +m[2] - 1, +m[3], h, m[5] != null ? Number(m[5]) : 0);
}

export async function scheduleReminder(text, when) {
  const date = parseWhen(when);
  if (!text || !date || isNaN(date)) throw new Error(`couldn't read the time "${when}"`);
  if (date.getTime() < Date.now() - 60000) throw new Error('that time has already passed');
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Nudges',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#E8C98A',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') throw new Error('notifications are turned off for Empire OS');
  await Notifications.scheduleNotificationAsync({
    content: { title: 'A.R.A. — Reminder', body: text, data: { kind: 'reminder', persona: 'ara' } },
    trigger: { date, channelId: 'default' },
  });
  return date;
}
