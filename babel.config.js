// The project previously had no babel.config.js — Expo's Metro transformer
// applied babel-preset-expo implicitly. Once this file exists we must list the
// preset ourselves. react-native-reanimated/plugin MUST be last.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
