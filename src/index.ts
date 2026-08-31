import express, { type Express } from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.route.ts';
import roomRoutes from './routes/rooms.routes.ts';
import { authenticateToken } from './middleware/auth.middleware.js';
import { setupWebSocketServer } from './wsHandler.js';
import { getJwtSecret } from './lib/jwt.js';
import { verifyMailTransport } from './lib/mail.js';

dotenv.config();
getJwtSecret();

const app: Express = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];
const allowedOrigins = new Set([
  ...defaultAllowedOrigins,
  ...((process.env.CLIENT_URLS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)),
]);

setupWebSocketServer(server);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

app.get('/api/ice-config', authenticateToken, (_req, res) => {
  const stunUrl = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
  const turnUrl = process.env.TURN_URL;

  const iceServers = [
    { urls: stunUrl },
    ...(turnUrl
      ? [{
          urls: turnUrl,
          username: process.env.TURN_USERNAME || '',
          credential: process.env.TURN_CREDENTIAL || '',
        }]
      : []),
  ];

  res.json({ iceServers });
});

server.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
  void verifyMailTransport();
});