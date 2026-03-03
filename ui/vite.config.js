import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte()],
    build: {
        target: ['es2019', 'chrome80'], // Vidaa OS / modern smart TV browser
        minify: 'esbuild',
        rollupOptions: {
            output: {
                manualChunks: {
                    'hls': ['hls.js'],
                },
            },
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'http://localhost:3001', rewrite: p => p.replace(/^\/api/, '') },
            '/ss': { target: 'http://localhost:11470', rewrite: p => p.replace(/^\/ss/, '') },
        },
    },
});
