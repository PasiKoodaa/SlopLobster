module.exports = {
  content: {
    relative: true,
    files: ['./src/**/*.html', './src/**/*.js'],
  },
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Space Grotesk', 'sans-serif'],
      },
    },
  },
};
