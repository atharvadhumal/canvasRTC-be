import express, { type Express } from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.route.ts';
import roomRoutes from './routes/rooms.routes.ts';
import { setupWebSocketServer } from './wsHandler.js';

dotenv.config();

const app: Express = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

setupWebSocketServer(server);

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

server.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
});