import { useState, useEffect } from 'react'
import { Upload, Link, Trash2, Eye, Plus, X } from 'lucide-react'
import api from '../services/api'
import toast from 'react-hot-toast'

export default function Playlists() {
  const [playlists, setPlaylists] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [uploadData, setUploadData] = useState({ name: '', file: null, filename: '' })
  const [urlData, setUrlData] = useState({ name: '', m3u_url: '' })

  useEffect(() => {
    fetchPlaylists()
  }, [])

  const fetchPlaylists = async () => {
    try {
      const res = await api.get('/m3u')
      setPlaylists(res.data)
    } catch (err) {
      toast.error('Failed to fetch playlists')
    } finally {
      setLoading(false)
    }
  }

  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    if (file) {
      // Store file reference directly - don't read into memory
      setUploadData({
        ...uploadData,
        file: file,
        filename: file.name,
        name: uploadData.name || file.name.replace(/\.(m3u|m3u8)$/i, '')
      })
    }
  }

  const submitUpload = async () => {
    if (!uploadData.name || !uploadData.file) {
      toast.error('Please provide a name and select a file')
      return
    }
    
    console.log('Uploading playlist:', {
      name: uploadData.name,
      filename: uploadData.filename,
      fileSize: uploadData.file.size
    })
    
    setUploading(true)
    const uploadToast = toast.loading('Uploading M3U file...')
    
    try {
      // Use FormData for efficient large file uploads
      const formData = new FormData()
      formData.append('name', uploadData.name)
      formData.append('filename', uploadData.filename)
      formData.append('file', uploadData.file)
      
      const response = await api.post('/m3u/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          toast.loading(`Uploading... ${percentCompleted}%`, { id: uploadToast })
        }
      })
      console.log('Upload response:', response.data)
      toast.success(`Playlist uploaded! ${response.data.channel_count} channels found`, { id: uploadToast })
      setShowUploadModal(false)
      setUploadData({ name: '', file: null, filename: '' })
      fetchPlaylists()
    } catch (err) {
      console.error('Upload error:', err)
      console.error('Error response:', err.response?.data)
      toast.error(err.response?.data?.error || err.response?.data?.details || 'Failed to upload playlist', { id: uploadToast })
    } finally {
      setUploading(false)
    }
  }

  const submitUrl = async () => {
    if (!urlData.name || !urlData.m3u_url) {
      toast.error('Please provide a name and URL')
      return
    }
    try {
      await api.post('/m3u/from-url', urlData)
      toast.success('Playlist added from URL')
      setShowUrlModal(false)
      setUrlData({ name: '', m3u_url: '' })
      fetchPlaylists()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add playlist')
    }
  }

  const deletePlaylist = async (id) => {
    if (!confirm('Are you sure you want to delete this playlist?')) return
    try {
      await api.delete(`/m3u/${id}`)
      toast.success('Playlist deleted')
      fetchPlaylists()
    } catch (err) {
      toast.error('Failed to delete playlist')
    }
  }

  if (loading) {
    return <div className="flex justify-center p-8"><div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full"></div></div>
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-white">M3U Playlists</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg transition-colors"
          >
            <Upload size={18} />
            Upload File
          </button>
          <button
            onClick={() => setShowUrlModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors"
          >
            <Link size={18} />
            Add from URL
          </button>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-700">
            <tr>
              <th className="text-left p-4 text-gray-300">Name</th>
              <th className="text-left p-4 text-gray-300">Source</th>
              <th className="text-left p-4 text-gray-300">Channels</th>
              <th className="text-left p-4 text-gray-300">Created</th>
              <th className="text-right p-4 text-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {playlists.length === 0 ? (
              <tr>
                <td colSpan="5" className="text-center p-8 text-gray-400">
                  No playlists yet. Upload an M3U file or add from URL.
                </td>
              </tr>
            ) : (
              playlists.map((playlist) => (
                <tr key={playlist.id} className="border-t border-gray-700 hover:bg-gray-750">
                  <td className="p-4 text-white font-medium">{playlist.name}</td>
                  <td className="p-4 text-gray-300">
                    {playlist.filename ? (
                      <span className="text-green-400">📁 {playlist.filename}</span>
                    ) : (
                      <span className="text-blue-400">🔗 URL</span>
                    )}
                  </td>
                  <td className="p-4 text-gray-300">{playlist.channel_count} channels</td>
                  <td className="p-4 text-gray-400">{new Date(playlist.created_at).toLocaleDateString()}</td>
                  <td className="p-4 text-right">
                    <button
                      onClick={() => deletePlaylist(playlist.id)}
                      className="text-red-400 hover:text-red-300 p-2"
                      title="Delete"
                    >
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-white">Upload M3U File</h2>
              <button onClick={() => setShowUploadModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-gray-300 mb-2">Playlist Name</label>
                <input
                  type="text"
                  value={uploadData.name}
                  onChange={(e) => setUploadData({ ...uploadData, name: e.target.value })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  placeholder="My Playlist"
                />
              </div>
              <div>
                <label className="block text-gray-300 mb-2">M3U File</label>
                <input
                  type="file"
                  accept=".m3u,.m3u8"
                  onChange={handleFileUpload}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-purple-600 file:text-white"
                />
                {uploadData.filename && (
                  <p className="mt-2 text-green-400 text-sm">
                    Selected: {uploadData.filename} 
                    {uploadData.file && ` (${(uploadData.file.size / 1024 / 1024).toFixed(2)} MB)`}
                  </p>
                )}
              </div>
              <button
                onClick={submitUpload}
                disabled={uploading}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {uploading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>Uploading...</span>
                  </>
                ) : (
                  'Upload Playlist'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* URL Modal */}
      {showUrlModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-white">Add from URL</h2>
              <button onClick={() => setShowUrlModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-gray-300 mb-2">Playlist Name</label>
                <input
                  type="text"
                  value={urlData.name}
                  onChange={(e) => setUrlData({ ...urlData, name: e.target.value })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  placeholder="My Online Playlist"
                />
              </div>
              <div>
                <label className="block text-gray-300 mb-2">M3U URL</label>
                <input
                  type="url"
                  value={urlData.m3u_url}
                  onChange={(e) => setUrlData({ ...urlData, m3u_url: e.target.value })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  placeholder="https://example.com/playlist.m3u"
                />
              </div>
              <button
                onClick={submitUrl}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition-colors"
              >
                Add Playlist
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
