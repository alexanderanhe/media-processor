import express from 'express'
import multer from 'multer'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

import {config} from 'dotenv';
config();

const app = express()
const PORT = process.env.SERVER_PORT ?? 3000;

// === Configurar Multer para subir archivos a /tmp ===
const upload = multer({ dest: '/tmp' })

// === Ruta al script ===
const SCRIPT_PATH = path.resolve('./index.js')

app.use((req, res, next) => {
  const key = req.headers['x-api-key']
  if (key !== process.env.SERVER_API_KEY) {
    return res.status(403).json({ message: 'Unauthorized' })
  }
  next()
})


// === Endpoint para recibir archivo y ejecutar el script ===
app.post('/run-pipeline', upload.single('file'), (req, res) => {
  const { title, description, videoId } = req.body;
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' })
  }
  if (!videoId) {
    return res.status(400).json({ success: false, message: 'No videoId exists' })
  }
  const tempFilePath = req.file.path
  console.log(`📥 Archivo recibido: ${req.file.originalname}`)
  
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  
  const script = spawn('node', [SCRIPT_PATH, videoId, tempFilePath])

  const send = (text) => {
    res.write(`data: ${text.trim()}\n\n`)
  }

  script.stdout.on('data', (data) => send(data.toString()))
  script.stderr.on('data', (data) => send(`⚠️ ${data.toString()}`))

  script.on('close', (code) => {
    send(`✅ Proceso finalizado con código ${code}`)
    res.end()

    fs.unlink(tempFilePath, (err) => {
      if (err) console.warn('⚠️ No se pudo eliminar archivo temporal:', err.message)
    })
  })
})

app.use(function(req, res, next) {
  res.status(404).json({ success: false, error: "Not found" });
})

app.listen(PORT, () => {
  console.log(`🚀 Media Processor API escuchando en http://localhost:${PORT}`)
})
