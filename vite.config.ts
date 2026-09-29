import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { handleAmapRequest } from './server/amap.ts'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'amap-service-proxy',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/_AMapService/') || request.url === '/api/map-config') {
            void handleAmapRequest(request, response)
            return
          }
          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/_AMapService/') || request.url === '/api/map-config') {
            void handleAmapRequest(request, response)
            return
          }
          next()
        })
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    proxy: { '/api/trip': 'http://127.0.0.1:4173', '/api/install': 'http://127.0.0.1:4173', '/api/admin': 'http://127.0.0.1:4173' },
  },
})
