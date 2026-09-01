// The project had no metro.config.js — this reproduces Expo's default config
// and only adds 3D asset extensions so require('*.glb') resolves for the HUD
// diagram card (Item 1c-C).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('glb', 'gltf', 'bin', 'obj', 'mtl', 'hdr', 'exr');

// The backend lives in server/ with its own package.json — keep Metro out of it.
const serverDir = path.join(__dirname, 'server').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [new RegExp('^' + serverDir + '[\\\\/].*')];

module.exports = config;
