# 📦 media-processor

**media-processor** is a Node.js script that automates the processing of both video and image files. It handles metadata removal, format conversion, compression, subtitle generation (via OpenAI Whisper), thumbnail creation, and media uploads to Supabase Storage.

---

## ✨ Features

- 🎥 **Video processing**
  - Downloaded from a queue supabase folder `env.QUEUE_FOLDER`
  - Cleans metadata
  - Converts video to optimized `.mp4`
  - Extracts and transcribes audio to `.vtt` using OpenAI Whisper
  - Generates thumbnails at defined intervals
  - Creates collage from video frames
  - Uploads processed video and subtitles to Supabase

- 🖼️ **Image processing**
  - Supports `.jpg` and `.png`
  - Removes metadata (EXIF/GPS/etc.)
  - Compresses and converts to `.webp`
  - Uploads to Supabase (optional)

- ☁️ **Supabase integration**
  - Authenticated download and upload of private media files
  - Compatible with Supabase Storage and optionally with Supabase Tables (metadata storage)

---

## 🚀 Requirements

- Node.js v16+
- `ffmpeg` and `ffprobe` installed and available globally
- Supabase project (Storage + service_role key)
- OpenAI API key with Whisper access

---

## ⚙️ Configuration
Create a .env file in the root directory:
```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key
SUPABASE_BUCKET=files
QUEUE_FOLDER=queue
THUMBNAIL_WIDTH=120
INTERVAL_SEC=1
COLLAGE_COLS=10

```

---

## 🛠️ Installation

```bash
git clone https://github.com/alexanderanhe/media-processor.git
cd media-processor
npm install

---

## ▶️ Usage
```bash
node index.js
```

This will:

1. Download the image/video from Supabase
2. Clean and convert it (video => mp4 | image => webp)
3. Extract audio and transcribe it to VTT if `OPENAI_API_KEY` env variable exists, for video
4. Generate thumbnails and collage, for video
5. Generate json metadata ()
6. Upload everything back to Supabase

> *(You can create your own entrypoints or cron-based workflows depending on use case)*


---

## 🙌 Contribuidores

[![Contribuidores](https://contrib.rocks/image?repo=alexanderanhe/media-processor&max=500&columns=20)](https://github.com/alexanderanhe/media-processor/graphs/contributors)

> ¿Quieres aparecer aquí? ¡Abre un PR o Issue y participa!

<p align="right">(<a href="#readme-top">volver arriba</a>)</p>

---

## 📝 License
MIT © Alexander Angulo