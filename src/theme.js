// Empire OS — visual design tokens.
// Dark-gold aesthetic. Two typefaces: DM Mono (labels / UI / data),
// Cormorant Garamond (display — word of the day, verse, large numerals).
//
// Font files live in assets/fonts/ and are registered in App.js via
// Font.loadAsync(FONT_MAP). Reference families by the FONTS.* constants.

export const FONT_MAP = {
  'DMMono-Light': require('./../assets/fonts/DMMono-Light.ttf'),
  'DMMono-Regular': require('./../assets/fonts/DMMono-Regular.ttf'),
  'DMMono-Medium': require('./../assets/fonts/DMMono-Medium.ttf'),
  'Cormorant-Light': require('./../assets/fonts/CormorantGaramond-Light.ttf'),
  'Cormorant-Regular': require('./../assets/fonts/CormorantGaramond-Regular.ttf'),
  'Cormorant-Medium': require('./../assets/fonts/CormorantGaramond-Medium.ttf'),
  'Cormorant-SemiBold': require('./../assets/fonts/CormorantGaramond-SemiBold.ttf'),
};

export const FONTS = {
  monoLight: 'DMMono-Light',
  mono: 'DMMono-Regular',
  monoMed: 'DMMono-Medium',
  displayLight: 'Cormorant-Light',
  display: 'Cormorant-Regular',
  displayMed: 'Cormorant-Medium',
  displaySemi: 'Cormorant-SemiBold',
};

// Fallback stack used before custom fonts finish loading / if one fails.
export const MONO_FALLBACK = 'monospace';

export const colors = {
  // Grounds — warm near-blacks, darkest to lightest.
  bg: '#000000',
  surface: '#0A0907',
  surfaceRaised: '#100E0B',
  card: '#14110C',
  hairline: '#1F1B14', // neutral 1px divider
  hairlineGold: 'rgba(232,201,138,0.12)', // gold-tinted divider

  // Gold scale.
  gold: '#E8C98A', // hero / brand
  goldBright: '#F3E3BE', // highlights, active numerals
  goldDim: '#9A8355', // secondary gold text
  goldFaint: '#5E4F35', // disabled / track-on-gold
  brass: '#B48E56', // muted accent

  // Text — warm neutrals.
  text: '#F2ECDE', // primary copy
  textMuted: '#A99E88', // secondary copy
  textDim: '#6C6353', // captions, meta
  textFaint: '#3E3A31', // placeholders, empty states

  // Status.
  online: '#5FA779',
  onlineDim: 'rgba(95,167,121,0.35)',
  warn: '#D9A441',
  danger: '#C7614B',

  // Ring / progress semantics (revenue rings, empire score).
  ringTrack: '#1C1913',
  ringLow: '#B0553F',
  ringMid: '#C49A4A',
  ringHigh: '#5FA779',
};

// Spacing scale (px).
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
};

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
};

// Text style presets. Spread into a StyleSheet entry or use inline.
export const type = {
  // --- Mono (labels / UI / data) ---
  // Section / eyebrow labels — sparse, wide-tracked.
  label: {
    fontFamily: FONTS.mono,
    fontSize: 9,
    letterSpacing: 3,
    color: colors.textDim,
  },
  labelGold: {
    fontFamily: FONTS.monoMed,
    fontSize: 9,
    letterSpacing: 3,
    color: colors.gold,
  },
  // Small meta / captions.
  meta: {
    fontFamily: FONTS.mono,
    fontSize: 8,
    letterSpacing: 1.5,
    color: colors.textDim,
  },
  // Body running text in mono contexts.
  body: {
    fontFamily: FONTS.mono,
    fontSize: 13,
    lineHeight: 20,
    color: colors.textMuted,
  },
  // List item / row title.
  row: {
    fontFamily: FONTS.mono,
    fontSize: 13,
    letterSpacing: 0.3,
    color: colors.text,
  },
  // Data numerals (small).
  data: {
    fontFamily: FONTS.monoMed,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.text,
  },
  // Buttons.
  button: {
    fontFamily: FONTS.monoMed,
    fontSize: 10,
    letterSpacing: 2,
  },

  // --- Display (Cormorant) ---
  // Big reactor numeral.
  reactorNumber: {
    fontFamily: FONTS.displaySemi,
    fontSize: 58,
    letterSpacing: 1,
    color: colors.goldBright,
  },
  // Panel display headline (e.g. Batman day label).
  displayTitle: {
    fontFamily: FONTS.displayMed,
    fontSize: 30,
    letterSpacing: 0.5,
    color: colors.text,
  },
  // Word of the day.
  word: {
    fontFamily: FONTS.displaySemi,
    fontSize: 34,
    letterSpacing: 0.5,
    color: colors.gold,
  },
  // Verse of the day — set in italic-weight display.
  verse: {
    fontFamily: FONTS.display,
    fontSize: 19,
    lineHeight: 28,
    color: colors.text,
  },
};

export default { colors, space, radius, type, FONTS, FONT_MAP };
