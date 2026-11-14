/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // The dense workbench uses fine-grained alpha steps; Tailwind's default scale only has
      // 0/5/10/20/25/..., so /8 /12 /15 /18 /85 would otherwise be silently dropped.
      opacity: { 8: '.08', 12: '.12', 15: '.15', 18: '.18', 85: '.85' },
      colors: {
        ink: {
          950: '#0b0d12',
          900: '#10131b',
          850: '#151925',
          800: '#1b2030',
          700: '#262d40',
          600: '#38415a',
        },
        accent: {
          claude: '#e9a23b',
          codex: '#3ecf8e',
          agy: '#5b9dff',
          danger: '#f05252',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1', transform: 'scale(1)' }, '50%': { opacity: '.45', transform: 'scale(.75)' } },
        slideIn: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
        slideIn: 'slideIn .22s ease-out both',
      },
    },
  },
  plugins: [],
};
