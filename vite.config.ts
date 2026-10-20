import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const apiKey = mode === 'development' ? env.GEMINI_API_KEY || '' : '';
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      // Relative asset paths so the build works under https://<user>.github.io/<repo>/
      base: './',
      define: {
        // Never bake a key into a production build: anyone visiting the deployed site could read it.
        // Deployed users enter their own key in the app (stored only in their browser).
        'process.env.API_KEY': JSON.stringify(apiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(apiKey)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
