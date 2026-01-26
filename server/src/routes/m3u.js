const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all M3U playlists
router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const playlists = await db.prepare(`
      SELECT id, name, filename, m3u_url, channel_count, created_at, created_by
      FROM m3u_playlists
      ORDER BY created_at DESC
    `).all();
    
    res.json(playlists);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get single playlist with content
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const playlist = await db.prepare('SELECT * FROM m3u_playlists WHERE id = ?').get(req.params.id);
    
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    res.json(playlist);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// Upload M3U file content
router.post('/upload', authenticateToken, isAdmin, async (req, res) => {
  try {
    console.log('[M3U Upload] Request received');
    console.log('[M3U Upload] Body keys:', Object.keys(req.body));
    console.log('[M3U Upload] User:', req.user.username);
    
    const db = getDb();
    const { name, filename, m3u_content } = req.body;
    
    if (!name || !m3u_content) {
      console.log('[M3U Upload] Missing required fields - name:', !!name, 'content:', !!m3u_content);
      return res.status(400).json({ error: 'Name and M3U content required' });
    }
    
    console.log('[M3U Upload] Name:', name);
    console.log('[M3U Upload] Filename:', filename);
    console.log('[M3U Upload] Content length:', m3u_content.length);
    
    // Count channels in M3U content
    const lines = m3u_content.split('\n');
    let channelCount = 0;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        channelCount++;
      }
    }
    
    console.log('[M3U Upload] Channel count:', channelCount);
    
    const id = uuidv4();
    await db.prepare(`
      INSERT INTO m3u_playlists (id, name, filename, m3u_content, channel_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, filename || 'uploaded.m3u', m3u_content, channelCount, req.user.id);
    
    console.log('[M3U Upload] Playlist saved with ID:', id);
    
    res.status(201).json({
      id,
      name,
      filename: filename || 'uploaded.m3u',
      channel_count: channelCount,
      message: 'M3U playlist uploaded successfully'
    });
  } catch (err) {
    console.error('[M3U Upload] Error:', err);
    res.status(500).json({ error: 'Failed to upload playlist', details: err.message });
  }
});

// Add M3U from URL
router.post('/from-url', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { name, m3u_url } = req.body;
    
    if (!name || !m3u_url) {
      return res.status(400).json({ error: 'Name and M3U URL required' });
    }
    
    // Fetch M3U content from URL
    const axios = require('axios');
    const response = await axios.get(m3u_url, { timeout: 30000 });
    const m3u_content = response.data;
    
    // Count channels
    const lines = m3u_content.split('\n');
    let channelCount = 0;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        channelCount++;
      }
    }
    
    const id = uuidv4();
    await db.prepare(`
      INSERT INTO m3u_playlists (id, name, m3u_url, m3u_content, channel_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, m3u_url, m3u_content, channelCount, req.user.id);
    
    res.status(201).json({
      id,
      name,
      m3u_url,
      channel_count: channelCount,
      message: 'M3U playlist added from URL successfully'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add playlist from URL' });
  }
});

// Update playlist
router.put('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { name, m3u_content, m3u_url } = req.body;
    
    const existing = await db.prepare('SELECT id FROM m3u_playlists WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    let channelCount = 0;
    if (m3u_content) {
      const lines = m3u_content.split('\n');
      for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
          channelCount++;
        }
      }
    }
    
    await db.prepare(`
      UPDATE m3u_playlists 
      SET name = COALESCE(?, name),
          m3u_content = COALESCE(?, m3u_content),
          m3u_url = COALESCE(?, m3u_url),
          channel_count = ?
      WHERE id = ?
    `).run(name, m3u_content, m3u_url, channelCount, req.params.id);
    
    res.json({ message: 'Playlist updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// Delete playlist
router.delete('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    
    const existing = await db.prepare('SELECT id FROM m3u_playlists WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    await db.prepare('DELETE FROM m3u_playlists WHERE id = ?').run(req.params.id);
    
    res.json({ message: 'Playlist deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Get M3U content as file (for users to download or for app to use)
router.get('/:id/content', async (req, res) => {
  try {
    const db = getDb();
    const playlist = await db.prepare('SELECT m3u_content, filename FROM m3u_playlists WHERE id = ?').get(req.params.id);
    
    if (!playlist || !playlist.m3u_content) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    res.setHeader('Content-Type', 'application/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="${playlist.filename || 'playlist.m3u'}"`);
    res.send(playlist.m3u_content);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get playlist content' });
  }
});

module.exports = router;
