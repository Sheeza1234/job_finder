/** Colours come from CSS variables so light and dark themes switch with one definition (see src/index.css). */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: { bg: v('bg'), card: v('card'), ink: v('ink'), mute: v('mute'), line: v('line'), accent: v('accent'), 'accent-ink': v('accent-ink'), warn: v('warn'), warnbg: v('warnbg'), bad: v('bad'), good: v('good'), goodbg: v('goodbg'), info: v('info') },
      fontFamily: { sans: ['Inter', '"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', '"Noto Naskh Arabic"', '"Noto Sans Arabic"', 'sans-serif'] },
    },
  },
  plugins: [],
};
