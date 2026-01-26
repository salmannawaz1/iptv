const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Busboy = require('busboy');
const { getDb } = require('../db/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Helper to count channels by streaming through content
function countChannelsStreaming(content) {
  let count = 0;
  let pos = 0;
  const searchStr = '#EXTINF:';
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    count++;
    pos += searchStr.length;
  }
  return count;
}

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

// Upload M3U file using streaming (handles large files)
router.post('/upload', authenticateToken, isAdmin, (req, res) => {
  console.log('[M3U Upload] Request received');
  console.log('[M3U Upload] Content-Type:', req.headers['content-type']);
  console.log('[M3U Upload] User:', req.user.username);
  
  const contentType = req.headers['content-type'] || '';
  
  // Handle multipart form data (file upload)
  if (contentType.includes('multipart/form-data')) {
    handleMultipartUpload(req, res);
  } 
  // Handle JSON body (for smaller files or backwards compatibility)
  else if (contentType.includes('application/json')) {
    handleJsonUpload(req, res);
  } else {
    res.status(400).json({ error: 'Unsupported content type' });
  }
});

// Handle multipart file upload with streaming
async function handleMultipartUpload(req, res) {
  try {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit
    
    let name = '';
    let filename = '';
    let channelCount = 0;
    let fileProcessed = false;
    let m3uContent = '';
    const MAX_STORE_SIZE = 10 * 1024 * 1024; // Only store content if < 10MB
    let contentSize = 0;
    let buffer = '';
    
    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'name') name = val;
      if (fieldname === 'filename') filename = val;
    });
    
    busboy.on('file', (fieldname, file, info) => {
      filename = filename || info.filename || 'uploaded.m3u';
      console.log('[M3U Upload] Processing file:', filename);
      
      file.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        contentSize += chunkStr.length;
        
        // Count channels in this chunk
        buffer += chunkStr;
        
        // Process complete lines
        let lastNewline = buffer.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const completeLines = buffer.substring(0, lastNewline);
          buffer = buffer.substring(lastNewline + 1);
          
          // Count #EXTINF occurrences
          channelCount += countChannelsStreaming(completeLines);
          
          // Store content only if small enough
          if (contentSize <= MAX_STORE_SIZE) {
            m3uContent += completeLines + '\n';
          }
        }
      });
      
      file.on('end', () => {
        // Process remaining buffer
        if (buffer) {
          channelCount += countChannelsStreaming(buffer);
          if (contentSize <= MAX_STORE_SIZE) {
            m3uContent += buffer;
          }
        }
        fileProcessed = true;
        console.log('[M3U Upload] File processed, channels:', channelCount, 'size:', contentSize);
      });
    });
    
    busboy.on('finish', async () => {
      try {
        if (!name) {
          name = filename.replace(/\.(m3u|m3u8)$/i, '');
        }
        
        const db = getDb();
        const id = uuidv4();
        
        // For large files, don't store content - just metadata
        const contentToStore = contentSize <= MAX_STORE_SIZE ? m3uContent : null;
        
        await db.prepare(`
          INSERT INTO m3u_playlists (id, name, filename, m3u_content, channel_count, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, name, filename, contentToStore, channelCount, req.user.id);
        
        console.log('[M3U Upload] Saved playlist:', id, 'channels:', channelCount);
        
        res.status(201).json({
          id,
          name,
          filename,
          channel_count: channelCount,
          stored_content: contentSize <= MAX_STORE_SIZE,
          message: 'M3U playlist uploaded successfully'
        });
      } catch (err) {
        console.error('[M3U Upload] Save error:', err);
        res.status(500).json({ error: 'Failed to save playlist', details: err.message });
      }
    });
    
    busboy.on('error', (err) => {
      console.error('[M3U Upload] Busboy error:', err);
      res.status(500).json({ error: 'Upload failed', details: err.message });
    });
    
    req.pipe(busboy);
  } catch (err) {
    console.error('[M3U Upload] Error:', err);
    res.status(500).json({ error: 'Failed to process upload', details: err.message });
  }
}

// Handle JSON upload (for smaller files)
async function handleJsonUpload(req, res) {
  try {
    const db = getDb();
    const { name, filename, m3u_content } = req.body;
    
    if (!name || !m3u_content) {
      return res.status(400).json({ error: 'Name and M3U content required' });
    }
    
    console.log('[M3U Upload] JSON upload, size:', m3u_content.length);
    
    // Check file size - reject if too large for JSON upload
    if (m3u_content.length > 50 * 1024 * 1024) { // 50MB limit for JSON
      return res.status(413).json({ 
        error: 'File too large for JSON upload. Use multipart form upload for large files.',
        max_size: '50MB'
      });
    }
    
    // Count channels efficiently
    const channelCount = countChannelsStreaming(m3u_content);
    
    console.log('[M3U Upload] Channel count:', channelCount);
    
    const id = uuidv4();
    
    // For very large content, don't store in DB
    const MAX_STORE_SIZE = 10 * 1024 * 1024;
    const contentToStore = m3u_content.length <= MAX_STORE_SIZE ? m3u_content : null;
    
    await db.prepare(`
      INSERT INTO m3u_playlists (id, name, filename, m3u_content, channel_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, filename || 'uploaded.m3u', contentToStore, channelCount, req.user.id);
    
    console.log('[M3U Upload] Playlist saved with ID:', id);
    
    res.status(201).json({
      id,
      name,
      filename: filename || 'uploaded.m3u',
      channel_count: channelCount,
      stored_content: m3u_content.length <= MAX_STORE_SIZE,
      message: 'M3U playlist uploaded successfully'
    });
  } catch (err) {
    console.error('[M3U Upload] Error:', err);
    res.status(500).json({ error: 'Failed to upload playlist', details: err.message });
  }
}

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
