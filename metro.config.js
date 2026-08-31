// The project had no metro.config.js — this reproduces Expo's default config
// and only adds 3D asset extensions so require('*.glb') resolves for the HUD
// diagram card (Item 1c-C).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('glb', 'gltf', 'bin', 'obj', 'mtl', 'hdr', 'exr');

module.exports = config;
