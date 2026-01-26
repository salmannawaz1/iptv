require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const resellerRoutes = require('./routes/resellers');
const playlistRoutes = require('./routes/playlists');
const statsRoutes = require('./routes/stats');
const xtreamRoutes = require('./routes/xtream');
const m3uRoutes = require('./routes/m3u');

const { initializeDatabase } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware - IMPORTANT: Set body parser limits BEFORE other middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(cors({
  origin: [
    'http://localhost:5173',           // Vite dev server
    'http://localhost:3000',           // Alternative dev port
    'http://127.0.0.1:5173',
    'http://192.168.100.78:5173',      // Local network
    'https://iptv-panel.onrender.com', // Production panel (old)
    'https://iptv-87ae.onrender.com',  // Production panel (current)
    /^https:\/\/.*\.onrender\.com$/,   // Any Render subdomain
    /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/ // Any local network IP
  ],
  credentials: true
}));

// Start server after database initialization
async function startServer() {
  await initializeDatabase();

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/resellers', resellerRoutes);
  app.use('/api/playlists', playlistRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/m3u', m3uRoutes);
  
  // Root welcome page
  app.get('/', (req, res) => {
    res.json({
      name: 'IPTV Reseller API',
      status: 'online',
      version: '1.0.0',
      endpoints: {
        xtream_api: '/player_api.php',
        health: '/api/health',
        login: '/api/auth/login'
      },
      documentation: 'Use /player_api.php for Xtream Codes API',
      timestamp: new Date().toISOString()
    });
  });

  // Xtream Codes API compatibility (for IPTV apps)
  app.use('/', xtreamRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
  });

  app.listen(PORT, () => {
    console.log(`🚀 IPTV Reseller API running on port ${PORT}`);
  });
}

startServer().catch(console.error);
