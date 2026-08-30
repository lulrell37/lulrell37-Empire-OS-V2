# Empire OS V2 — build notes

## Expo / React Native version

This project is pinned to **Expo SDK 51** (`expo` ~51.0.0, `react-native` 0.74.5,
`react` 18.2.0). Do not assume behavior from a newer SDK — several APIs changed
after 51 (`expo-av` split into `expo-audio`/`expo-video`, the New Architecture
default, `expo-file-system` next API, etc.). None of that applies here.

Expo no longer hosts versioned docs for SDK 51 (`/versions/v51.0.0/` 404s). When
you need to confirm an API:

1. Check the installed version — `package.json`, or
   `https://cdn.jsdelivr.net/npm/expo@51.0.39/bundledNativeModules.json` for the
   Expo-managed native module versions SDK 51 expects.
2. Read that exact package version's typings/README on npm/jsdelivr
   (e.g. `https://cdn.jsdelivr.net/npm/expo-font@12.0.10/build/Font.d.ts`).
3. Only then fall back to `https://docs.expo.dev/versions/latest/`, treating
   anything version-flagged as newer-than-51 with suspicion.

Key pinned native-module versions for SDK 51:

| Package | Version |
| --- | --- |
| expo-font | ~12.0.10 |
| expo-gl | ~14.0.2 |
| react-native-reanimated | ~3.10.1 |
| react-native-gesture-handler | ~2.16.1 |
| react-native-svg | 15.2.0 |
| expo-av | ~14.0.7 |

## Builds

Android APK via EAS (`eas build --platform android --profile preview`), also
wired through GitHub Actions on push to `main`. Any change that adds or updates a
native module (fonts, `expo-gl`, `reanimated`, …) requires a fresh native build —
it will not ship as an OTA update.
