// Push-notification registration. The backend's scheduled nudge sender (phase 4)
// delivers to whatever tokens are registered here; this module gets the device's
// Expo push token and hands it to `${backend}/push/register`.
//
// Entirely inert without a backend: no backend -> no token request, no prompt.
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { loadBackend } from './keyStore';

// app.json > expo.extra.eas.projectId — required by getExpoPushTokenAsync in a
// standalone build. Not a secret; it's already in the committed app config.
const PROJECT_ID = '3f241a38-1ea1-4046-8eee-16dece02697b';

let registeredToken = null; // set once per launch so we hit /push/register once

// Foreground behaviour: still show the banner while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function expoPushToken() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Nudges',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#E8C98A',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
  return data || null;
}

// Ask permission (once), get the token, register it with the backend. No-op on a
// simulator, with no backend configured, or if the user denies the prompt.
export async function registerPushToken() {
  const be = await loadBackend();
  if (!be || !Device.isDevice) return null;
  try {
    const token = await expoPushToken();
    if (!token || token === registeredToken) return token;
    const res = await fetch(be.url + '/push/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + be.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    if (res.ok) registeredToken = token;
    return token;
  } catch (e) {
    console.warn('push register failed:', e.message);
    return null;
  }
}

// Tell the backend to forget this device (called when the backend is disconnected).
export async function unregisterPushToken() {
  const be = await loadBackend();
  const token = registeredToken;
  registeredToken = null;
  if (!be || !token) return;
  try {
    await fetch(be.url + '/push/unregister', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + be.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {}
}

// Fire a one-off test notification to every registered device via the backend.
export async function sendTestPush() {
  const be = await loadBackend();
  if (!be) throw new Error('Connect a backend first');
  const res = await fetch(be.url + '/push/test', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + be.token },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
