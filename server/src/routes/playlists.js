const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { authenticateToken, isReseller, isActiveReseller, isAdmin } = require('../middleware/auth');

const router = express.Router();

const STREAM_SERVER = process.env.STREAM_SERVER_URL || 'http://localhost:8080';

// Get all bouquets
router.get('/bouquets', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const bouquets = await db.prepare('SELECT * FROM bouquets ORDER BY name').all();
    res.json(bouquets.map(b => ({
      ...b,
      channels: JSON.parse(b.channels || '[]')
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bouquets' });
  }
});

// Create bouquet (admin only)
router.post('/bouquets', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { name, description, channels } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }

    const bouquetId = uuidv4();
    await db.prepare(`
      INSERT INTO bouquets (id, name, description, channels)
      VALUES (?, ?, ?, ?)
    `).run(bouquetId, name, description || '', JSON.stringify(channels || []));

    res.status(201).json({ message: 'Bouquet created', id: bouquetId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create bouquet' });
  }
});

// Generate M3U playlist info for a user
router.get('/m3u/:userId', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // If user has custom M3U URL, use that
    const m3uUrl = user.m3u_url || `${STREAM_SERVER}/get.php?username=${user.username}&password=${user.password}&type=m3u_plus&output=ts`;
    
    // Generate Xtream Codes API info
    const xtreamInfo = {
      server: STREAM_SERVER,
      username: user.username,
      password: user.password,
      port: '8080'
    };

    res.json({
      m3u_url: m3uUrl,
      custom_m3u: user.m3u_url || null,
      xtream: xtreamInfo,
      user: {
        username: user.username,
        expiry: user.expiry_date,
        max_connections: user.max_connections
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate playlist' });
  }
});

// Serve actual M3U playlist file (public endpoint for IPTV players)
router.get('/play/:username/:password', async (req, res) => {
  try {
    const db = getDb();
    const { username, password } = req.params;

    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user || user.password !== password) {
      // Also check if password matches the plain text (for simple setups)
      if (!user) {
        return res.status(401).send('#EXTM3U\n# Invalid credentials');
      }
    }

    // Check if user is active and not expired
    if (!user.is_active) {
      return res.status(403).send('#EXTM3U\n# Account disabled');
    }

    const now = new Date();
    const expiry = new Date(user.expiry_date);
    if (expiry < now) {
      return res.status(403).send('#EXTM3U\n# Subscription expired');
    }

    // If user has custom M3U URL, fetch and return it
    if (user.m3u_url) {
      try {
        const response = await fetch(user.m3u_url);
        const m3uContent = await response.text();
        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="${username}.m3u"`);
        return res.send(m3uContent);
      } catch (fetchErr) {
        console.error('Failed to fetch M3U:', fetchErr);
        return res.status(500).send('#EXTM3U\n# Failed to load playlist');
      }
    }

    // Return a sample M3U if no custom URL
    const sampleM3u = `#EXTM3U
#EXTINF:-1 tvg-id="sample1" tvg-name="Sample Channel 1" group-title="General",Sample Channel 1
http://sample-stream.com/live/stream1.m3u8
#EXTINF:-1 tvg-id="sample2" tvg-name="Sample Channel 2" group-title="General",Sample Channel 2
http://sample-stream.com/live/stream2.m3u8
#EXTINF:-1 tvg-id="sample3" tvg-name="News Channel" group-title="News",News Channel
http://sample-stream.com/live/news.m3u8
`;
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(sampleM3u);
  } catch (err) {
    console.error(err);
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Validate user credentials (for IPTV player authentication)
router.post('/validate', async (req, res) => {
  try {
    const db = getDb();
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password (support both hashed and plain text for compatibility)
    const validPassword = bcrypt.compareSync(password, user.password) || password === user.password;
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    if (new Date(user.expiry_date) < new Date()) {
      return res.status(403).json({ error: 'Account expired' });
    }

    // Return user info in Xtream Codes format
    res.json({
      user_info: {
        username: user.username,
        password: password,
        status: 'Active',
        exp_date: Math.floor(new Date(user.expiry_date).getTime() / 1000),
        is_trial: 0,
        active_cons: 0,
        created_at: Math.floor(new Date(user.created_at).getTime() / 1000),
        max_connections: user.max_connections,
        allowed_output_formats: ['m3u8', 'ts']
      },
      server_info: {
        url: STREAM_SERVER,
        port: '8080',
        https_port: '443',
        server_protocol: 'http'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// Get user's assigned bouquets
router.get('/user/:userId/bouquets', authenticateToken, isReseller, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const bouquets = await db.prepare(`
      SELECT b.* FROM bouquets b
      INNER JOIN user_bouquets ub ON b.id = ub.bouquet_id
      WHERE ub.user_id = ?
    `).all(req.params.userId);

    res.json(bouquets.map(b => ({
      ...b,
      channels: JSON.parse(b.channels || '[]')
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bouquets' });
  }
});

module.exports = router;
