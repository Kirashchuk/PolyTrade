import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
export default defineConfig({plugins:[solid()],server:{port:5178,strictPort:true,proxy:{'/api':'http://127.0.0.1:4310'}},build:{outDir:'dist',target:'es2022',chunkSizeWarningLimit:1300}});
