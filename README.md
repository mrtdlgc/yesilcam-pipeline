# 🎬 Yeşilçam Subtitle Pipeline

Automated subtitle generation pipeline for classic Turkish cinema (Yeşilçam films).

## Features

- ✅ **Web UI** - No CLI needed, run everything from your browser
- 🔍 **Smart Detection** - Checks YouTube & OpenSubtitles before transcribing
- 🤖 **AI-Powered** - Groq Whisper (large-v3-turbo) + GPT-4o for quality
- 💰 **Cost-Effective** - ~$0.10-0.20 per 2-hour movie
- 📦 **All-in-One** - Download, transcribe, polish in one pipeline

## Prerequisites

### Required
- Node.js 18+ 
- FFmpeg installed on system
- Groq API key (https://console.groq.com)

### Optional
- OpenAI API key (for punctuation polishing)
- OpenSubtitles API key (for subtitle checking)
- TMDB API key (for metadata)

## Installation

### 1. Extract the ZIP
```bash
unzip yesilcam-pipeline.zip
cd yesilcam-pipeline
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
# Copy example env file
cp .env.example .env

# Edit .env and add your API keys
nano .env
```

Required in `.env`:
```bash
GROQ_API_KEY=your_groq_key_here
```

Optional but recommended:
```bash
OPENAI_API_KEY=your_openai_key_here
OPENSUBTITLES_API_KEY=your_opensubs_key_here
```

### 4. Install FFmpeg (if not already installed)

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from: https://ffmpeg.org/download.html

## Usage

### Start the Server

```bash
npm start
```

The web interface will be available at: **http://localhost:3000**

### Using the Web UI

1. **Open Browser** → http://localhost:3000
2. **Submit Job**:
   - YouTube URL (required)
   - IMDB ID (optional, helps find existing subs)
   - Movie Title (optional, for display)
3. **Monitor Progress** - Jobs auto-refresh every 5 seconds
4. **Click on Job** - View detailed logs and download subtitles
5. **Download SRT** - When complete, download Turkish subtitle file

### Manual Translation Step

After processing completes:
1. Download the Turkish SRT file from the UI
2. Feed it to Grok for translation (manually)
3. Get your final translated subtitle

## How It Works

### Workflow

```
YouTube URL
    ↓
Check for Existing Subs (YouTube/OpenSubtitles)
    ↓ (if not found)
Download Audio
    ↓
Optimize (compress to <100MB)
    ↓
Groq Whisper Transcription (Turkish)
    ↓
GPT-4o Punctuation Polish
    ↓
Save Turkish SRT
    ↓
Manual Translation with Grok
```

### Smart Subtitle Detection

The pipeline checks:
1. **YouTube** - Turkish manual subtitles (best quality)
2. **YouTube** - Turkish auto-generated (fallback)
3. **OpenSubtitles** - Community subtitles (if IMDB ID provided)
4. **Generate** - Only if none found

This saves time and money!

## File Structure

```
yesilcam-pipeline/
├── server.js              # Express server + API
├── public/                # Web UI files
│   ├── index.html
│   ├── style.css
│   └── app.js
├── scripts/               # Processing pipeline
│   ├── 0_check_subs.js   # Check existing subtitles
│   ├── 1_download_video.js
│   ├── 2_extract_audio.js
│   ├── 3_transcribe.js   # Groq Whisper
│   ├── 4_polish.js       # GPT-4o polish
│   └── pipeline.js       # Main orchestrator
├── data/
│   ├── movies.json       # Movie database
│   └── processing-queue.json  # Job queue
├── temp/                 # Temporary audio files
└── output/
    └── subtitles/        # Final SRT files
```

## Deploying to Seedbox

### 1. Upload Files
```bash
# SCP to seedbox
scp -r yesilcam-pipeline user@seedbox.hostingby.design:~/
```

### 2. SSH and Setup
```bash
ssh user@seedbox.hostingby.design
cd yesilcam-pipeline
npm install
```

### 3. Configure .env
```bash
nano .env
# Add your API keys
```

### 4. Run with PM2 (keeps running)
```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start server.js --name yesilcam

# Auto-restart on reboot
pm2 startup
pm2 save
```

### 5. Access from Your Computer

**Option A: SSH Tunnel (Secure)**
```bash
# On your local machine
ssh -L 3000:localhost:3000 user@seedbox.hostingby.design

# Then open: http://localhost:3000
```

**Option B: Expose Port (if seedbox allows)**
Check with your seedbox provider about exposing ports.

## API Reference

### Submit Job
```
POST /api/jobs
{
  "youtubeUrl": "https://youtube.com/watch?v=...",
  "imdbId": "tt1234567",  // optional
  "title": "Film Name"    // optional
}
```

### Get All Jobs
```
GET /api/jobs
```

### Get Job Details
```
GET /api/jobs/:id
```

### Delete Job
```
DELETE /api/jobs/:id
```

## Cost Breakdown

Per 2-hour movie:
- **Groq Whisper**: $0.08
- **GPT-4o-mini Polish**: $0.10-0.15
- **Total**: ~$0.20-0.25

## Troubleshooting

### "GROQ_API_KEY not set"
- Make sure you created `.env` file from `.env.example`
- Add your Groq API key

### "FFmpeg not found"
- Install FFmpeg on your system
- Verify: `ffmpeg -version`

### Download fails
- Check YouTube URL is valid
- Some videos may be region-locked
- Try different video quality

### Transcription too slow
- This is normal on CPU
- Groq processes at 164x real-time (6min audio = ~2 seconds)
- Progress bar shows current status

### Out of memory
- Your audio file might be too long
- Try shorter clips first
- Optimize settings in `2_extract_audio.js`

## Tips & Best Practices

1. **Test with short clips first** (5-10 minutes)
2. **Check for existing subs** before generating (saves money)
3. **Use IMDB IDs** when possible (helps find subs on OpenSubtitles)
4. **Monitor disk space** - temp files can add up
5. **Clean old jobs** regularly via the UI

## Future Enhancements

- [ ] Batch processing (queue multiple movies)
- [ ] Automatic Grok translation integration
- [ ] TMDB metadata integration
- [ ] Subtitle quality scoring
- [ ] Multi-language support

## Support

For issues or questions:
1. Check the logs in the web UI (click on job)
2. Check server console for errors
3. Verify API keys are correct
4. Test with a short clip first

## License

MIT

---

**Made with ❤️ for preserving Turkish cinema**
