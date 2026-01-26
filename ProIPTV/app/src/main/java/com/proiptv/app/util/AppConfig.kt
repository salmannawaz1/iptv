package com.proiptv.app.util

object AppConfig {
    // Production server URL - DigitalOcean deployment
    private const val PRODUCTION_URL = "https://whale-app-68a2v.ondigitalocean.app"
    
    // Server URLs list (production first, fallback local for dev)
    private val SERVER_URLS = listOf(
        PRODUCTION_URL,
        "http://localhost:5000"
    )
    
    // API endpoint for Xtream Codes
    const val PLAYER_API_PATH = "/player_api.php"
    
    // Get the server URL - always use production
    fun getServerUrl(): String {
        return PRODUCTION_URL
    }
    
    // Get all server URLs for fallback mechanism
    fun getServerUrls(): List<String> {
        return SERVER_URLS
    }
    
    fun getPlayerApiUrl(): String {
        return "${getServerUrl()}$PLAYER_API_PATH"
    }
}
