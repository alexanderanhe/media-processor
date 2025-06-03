import {config} from "dotenv";
import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
import sizeOf from "image-size";
import mime from "mime-types";
import sharp from 'sharp';
import axios from 'axios';
import FormData from 'form-data';
import { exec } from 'child_process';
import { createClient } from '@supabase/supabase-js';
config();

// Configuración
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = process.env.SUPABASE_BUCKET;
const QUEUE_FOLDER = process.env.QUEUE_FOLDER;
const THUMBNAIL_WIDTH = Number(process.env.THUMBNAIL_WIDTH);
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC);
const COLLAGE_COLS = Number(process.env.COLLAGE_COLS ?? 10);

const TEMP_DIR = "./temp";
const THUMBS_DIR = `${TEMP_DIR}/thumbs`;
const RAW_VIDEO = `${TEMP_DIR}/original.mp4`;
const RAW_IMAGE = `${TEMP_DIR}/original.jpg`;
const CLEAN_VIDEO = `${TEMP_DIR}/clean.mp4`;
const AUDIO = `${TEMP_DIR}/audio.mp3`;
const COLLAGE = `${TEMP_DIR}/collage.jpg`;
const VTT = `${TEMP_DIR}/subtitles.vtt`;
const JSONFILE = `${TEMP_DIR}/info.json`;

function formatTimestamp(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = (seconds % 60).toFixed(3).padStart(6, '0').replace('.', ',');
  return `${h}:${m}:${s}`;
}

const timemarks = (length, interval_seconds) => Array.from({ length }, (_, i) => {
  const seconds = i * interval_seconds;
  const hor = String(Math.trunc(seconds / 3600)).padStart(2, '0');
  const min = String(Math.trunc((seconds % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.trunc(seconds % 60)).padStart(2, '0');
  return `${hor}:${min}:${sec}`;
});

function getSimplifiedRatio(width, height) {
  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

async function removeTempFolder() {
  await fsp.rm(TEMP_DIR, { recursive: true, force: true });
}

// Paso 1: Obtener lista de queue desde Supabase
async function listQueueFilesFromSupabase(remotePath) {
  const { data, error } = await supabase.storage.from(BUCKET).list(remotePath);
  if (error) throw new Error("❌ Error descargando desde Supabase: " + error.message);
  console.log("✅ Queue files:", data.length);
  return data;
}

// Paso 2: Descargar desde Supabase
async function downloadFromSupabase(remotePath, localPath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(remotePath);
  if (error) throw new Error("❌ Error descargando desde Supabase: " + error.message);
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  console.log("✅ Video descargado:", localPath);
}

// Paso 3: Limpiar video con ffmpeg (remover metadata)
function cleanVideo(input, output) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${input}" -map_metadata -1 -c:v libx264 -c:a aac -y "${output}"`;
    exec(cmd, (err) => {
      if (err) return reject(new Error("❌ Error limpiando video: " + err.message));
      console.log("✅ Video limpio generado:", output);
      resolve();
    });
  });
}
async function processImagesToWebp(files, outputDir, quality = 80) {
  const processed = await Promise.all(
    files.map(async (file) => {
      const baseName = path.parse(file).name;
      const outputPath = path.join(outputDir, `${baseName}.webp`);

      try {
        await sharp(file)
          .webp({ quality }) // puedes ajustar calidad entre 1–100
          .toFile(outputPath);

        console.log(`✅ Convertido a WebP: ${outputPath}`);
        return outputPath;
      } catch (err) {
        console.error(`❌ Error procesando ${file}:`, err.message);
        return null;
      }
    })
  );

  return processed.filter(Boolean); // solo rutas válidas
}

// Paso 3.1: Get metadata
function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    exec(cmd, (error, stdout) => {
      if (error) return reject(error);

      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        const ext = path.extname(filePath);
        const mime_type = mime.lookup(ext) || 'application/octet-stream';

        resolve({
          duration: parseFloat(info.format.duration),
          size: parseInt(info.format.size),
          mime_type,
          extension: ext,
          width: videoStream.width,
          height: videoStream.height,
          ratio: getSimplifiedRatio(videoStream.width, videoStream.height)
        });
      } catch (e) {
        reject(new Error("❌ Error al parsear ffprobe: " + e.message));
      }
    });
  });
}
function getImageMetadata(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const dimensions = sizeOf(buffer);
  const ext = path.extname(imagePath);
  const mime_type = mime.lookup(ext) || 'application/octet-stream';

  return {
    width: dimensions.width,
    height: dimensions.height,
    size: buffer.length,
    extension: ext,
    mime_type,
    ratio: getSimplifiedRatio(dimensions.width, dimensions.height)
  };
}

// Paso 3.2: Ejecutar ffmpeg para cada thumbnail
function generateThumbnails(pathname, total, interval_seconds, resolution, outputFolderPath) {
  // Asegura que el directorio de salida existe
  fs.mkdirSync(outputFolderPath, { recursive: true });

  const tasks = timemarks(total, interval_seconds).map((timestamp, i) => {
    const filename = `thumbnail-${i + 1}.jpg`;
    const outputPath = path.join(outputFolderPath, filename);
    const cmd = `ffmpeg -ss ${timestamp} -i "${pathname}" -vframes 1 -s ${resolution} -q:v 2 -y "${outputPath}"`;

    return new Promise((resolve, reject) => {
      exec(cmd, (err) => {
        if (err) {
          console.error(`❌ Error en ${filename}:`, err.message);
          return reject(err);
        }
        console.log(`✅ Generado: ${filename}`);
        resolve(filename);
      });
    });
  });

  return Promise.all(tasks);
}

// Paso 3.3: Generar un collage con todas las thumbnails
async function generateCollageThumbnails(thumbnails, thumbnail_width, thumbnail_height, cols, outputPath) {
  const total = thumbnails.length;
  const MOZAIQUEMIN_WIDTH = thumbnail_width * (total > cols ? cols : total);
  const MOZAIQUEMIN_HEIGHT = thumbnail_height * (Math.trunc(total / cols) + (total % cols ? 1 : 0));
  const collage = sharp({
    create: {
      width: MOZAIQUEMIN_WIDTH,
      height: MOZAIQUEMIN_HEIGHT,
      channels: 3,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    }
  });
  // Read and resize each image to a fixed width
  const resizedImages = thumbnails.map((image) => 
    sharp(image).resize(thumbnail_width, thumbnail_height).toBuffer()
  );
  await new Promise((resolve, reject) => {
    Promise.all(resizedImages)
      .then((buffers) => {
        const composite = buffers.map((buffer, index) => {
          const x = (index % cols) * thumbnail_width;
          const y = Math.trunc(index / cols) * thumbnail_height;
          return { input: buffer, top: y, left: x };
        });
        return collage
          .composite(composite)
          .toFile(outputPath, (err, info) => {
            if (err) {
              return reject(new Error("❌ Error generando collage: " + err.message));
            }
            console.log("✅ Collage creado:", outputPath);
            resolve(info)
          });
      })
      .catch((error) => {
        console.error("❌ Error al procesar imágenes:", error);
        reject(error)
      });
  })
}

// Paso 4: Extraer audio
function extractAudio(input, output) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${input}" -vn -acodec libmp3lame -y "${output}"`;
    exec(cmd, (err) => {
      if (err) return reject(new Error("❌ Error extrayendo audio: " + err.message));
      console.log("✅ Audio extraído:", output);
      resolve();
    });
  });
}

// Paso 5: Transcripción con OpenAI Whisper
async function transcribeAudio(filePath) {
  if (!process.env.OPENAI_API_KEY) return;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders()
    }
  });

  return response.data;
}

// Paso 6: Crear archivo .vtt
function createVTT(transcription, outputPath) {
  if (!transcription) return;
  const lines = ["WEBVTT\n"];
  transcription.segments.forEach((seg) => {
    const start = formatTimestamp(seg.start);
    const end = formatTimestamp(seg.end);
    lines.push(`${start} --> ${end}\n${seg.text.trim()}\n`);
  });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log("✅ Archivo .vtt generado:", outputPath);
}

// Paso 7: Crear archivo .json
async function createJSON(info, outputPath) {
  await new Promise((resolve, reject) => {
    fs.writeFile(JSONFILE, JSON.stringify(info), err => {
      if (err) {
        return reject(new Error("❌ Error generando el json: " + err.message));
      }
      console.log("✅ Archivo .json generado:", outputPath);
      resolve(info)
    });
  })
}

// Paso 8: Subir archivo a Supabase
async function uploadToSupabase(localPath, destPath, contentType) {
  if (!fs.existsSync(localPath)) return;
  const buffer = fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(destPath, buffer, {
      contentType,
      upsert: true,
    });

  if (error) throw new Error("❌ Error subiendo a Supabase: " + error.message);

  const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${destPath}`;
  return url;
}

// Paso 9: Borrar el archivo procesado en queue de Supabase
async function deleteQueueSupabase(remotePath) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([remotePath]);

  if (error) throw new Error("❌ Error eliminando archivo procesado en queue de Supabase: " + error.message);
}

// Ejecutar todo
(async () => {
  try {
    await removeTempFolder(); // Remove if exists

    console.log("📋 Obteniendo lista de todos los videos en queue...");
    const list = await listQueueFilesFromSupabase(QUEUE_FOLDER);

    for (const file of list) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      const INPUT_PATH = `${QUEUE_FOLDER}/${file.name}`;
      const TYPE = file.metadata.mimetype;
      const baseName = path.basename(INPUT_PATH, ".mp4");
      const timestamp = Date.now();
      const folderFiles = `processed/${baseName}-${timestamp}`;

      let readyToUpload = null;
      if (TYPE.startsWith("video")) {
        console.log("📥 Descargando video...");
        await downloadFromSupabase(INPUT_PATH, RAW_VIDEO);
    
        console.log("🧼 Limpiando video...");
        await cleanVideo(RAW_VIDEO, CLEAN_VIDEO);

        console.log("🏁 Obteniendo metadata...");
        const metadata = await getVideoMetadata(CLEAN_VIDEO);
        const scaleHeight = Math.trunc((THUMBNAIL_WIDTH / metadata.width) * metadata.height);
        const DURATION = Math.trunc(metadata.duration) || 1;
        const RESOLUTION = `${THUMBNAIL_WIDTH}x${scaleHeight}`;

        console.log("🧼 Generando thumbnails...");
        const thumbnails = await generateThumbnails(CLEAN_VIDEO, DURATION, INTERVAL_SEC, RESOLUTION, THUMBS_DIR);
        const thumbnailPaths = thumbnails.map((image) => path.resolve(path.join(THUMBS_DIR, image)));

        console.log("🖼️ Generando collage de thumbnails...");
        await generateCollageThumbnails(thumbnailPaths, THUMBNAIL_WIDTH, scaleHeight, COLLAGE_COLS, COLLAGE);
        
        console.log("🧹 Optimizando collage a webp...");
        const [COLLAGEWEBP] = await processImagesToWebp([COLLAGE], TEMP_DIR);

        console.log("🔊 Extrayendo audio...");
        await extractAudio(CLEAN_VIDEO, AUDIO);
    
        console.log("🧠 Transcribiendo con Whisper...");
        const transcription = await transcribeAudio(AUDIO);
    
        console.log("📝 Generando subtítulos...");
        createVTT(transcription, VTT);

        console.log("📝 Generando archivo json...");
        await createJSON({ metadata, thumbnails: { duration: DURATION, resolution: RESOLUTION,}}, JSONFILE);

        // Alistando archivos de subida
        readyToUpload = {
          // LABEL:   [ LOCALPATH,   SUPABASE_PATH,  MIME  ]
          "🎬 Video:": [CLEAN_VIDEO, `${folderFiles}/${baseName}-${timestamp}.mp4`, "video/mp4"],
          "📝 VTT:": [VTT, `${folderFiles}/${baseName}-${timestamp}.vtt`, "text/vtt"],
          "🔈 Audio:": [AUDIO, `${folderFiles}/${baseName}-${timestamp}.mp3`, "audio/mp3"],
          "🖼️ Collage": [COLLAGEWEBP, `${folderFiles}/${baseName}-${timestamp}.webp`, "image/webp"],
          "💾 Json:" : [JSONFILE, `${folderFiles}/${baseName}-${timestamp}.json`, "application/json"],
        }
      } else if (TYPE.startsWith("image")) {
        console.log("📥 Descargando video...");
        await downloadFromSupabase(INPUT_PATH, RAW_IMAGE);

        console.log("🧼 Limpiando imagen...");
        const [CLEAN_IMAGE] = await processImagesToWebp([RAW_IMAGE], TEMP_DIR);

        console.log("🏁 Obteniendo metadata...");
        const metadata = getImageMetadata(CLEAN_IMAGE);

        console.log("📝 Generando archivo json...");
        await createJSON({ metadata }, JSONFILE);

        // Alistando archivos de subida
        readyToUpload = {
          // LABEL:   [ LOCALPATH,   SUPABASE_PATH,  MIME  ]
          "🖼️ Image": [CLEAN_IMAGE, `${folderFiles}/${baseName}-${timestamp}.webp`, "image/webp"],
          "💾 Json:" : [JSONFILE, `${folderFiles}/${baseName}-${timestamp}.json`, "application/json"],
        }
      }

      if (readyToUpload) {
        console.log("☁️ Subiendo archivos a Supabase...");
        for (const label in readyToUpload) {
          const supabaseUrl = await uploadToSupabase(...readyToUpload[label]);
          console.log(label, supabaseUrl);
        }
  
        console.log("🗑️ Eliminando archivo de queue en Supabase...");
        await deleteQueueSupabase(INPUT_PATH);

        console.log("🗑️ Eliminando archivos temporales...");
        await removeTempFolder()
      }

      console.log(`✅ Proceso completado para ${INPUT_PATH}\n`);
    }

  } catch (err) {
    console.error(err.message);
  }
})();
