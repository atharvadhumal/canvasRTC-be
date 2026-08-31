import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import { prisma } from './db.js';
import { verifyAccessToken } from './lib/jwt.js';

interface ClientConnection {
  ws: WebSocket;
  accountUserId: string;
  participantId: string;
  roomCode: string;
  displayName: string;
  avatarUrl: string;
}

interface SignalingMessage {
  type: string;
  roomId?: string;
  userId?: string;
  targetId?: string;
  payload?: {
    token?: string;
    displayName?: string;
    offer?: unknown;
    answer?: unknown;
    candidate?: unknown;
    diff?: unknown;
    snapshot?: unknown;
    x?: number;
    y?: number;
    tool?: string;
  };
}

const rooms = new Map<string, Map<string, ClientConnection>>();
const boardSnapshots = new Map<string, unknown>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const roomRecordIds = new Map<string, string>();

function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function readQueryToken(reqUrl: string | undefined): string | null {
  if (!reqUrl) return null;
  try {
    return new URL(reqUrl, 'http://localhost').searchParams.get('token');
  } catch {
    return null;
  }
}

function isUsableSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = (value as { document?: { store?: unknown } }).document;
  return Boolean(document && typeof document === 'object' && document.store);
}

function scheduleBoardPersist(roomCode: string, snapshot: unknown) {
  const roomId = roomRecordIds.get(roomCode);
  if (!roomId) return;

  const existing = persistTimers.get(roomCode);
  if (existing) clearTimeout(existing);

  persistTimers.set(
    roomCode,
    setTimeout(() => {
      persistTimers.delete(roomCode);
      void prisma.board
        .update({
          where: { roomId },
          data: { canvasData: snapshot as object },
        })
        .then(() =>
          prisma.room.update({
            where: { id: roomId },
            data: { updatedAt: new Date() },
          })
        )
        .catch((err: unknown) => {
          console.error('Failed to persist board snapshot:', err);
        });
    }, 750)
  );
}

async function flushBoardPersist(roomCode: string) {
  const timer = persistTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(roomCode);
  }

  const roomId = roomRecordIds.get(roomCode);
  const snapshot = boardSnapshots.get(roomCode);
  if (!roomId || !isUsableSnapshot(snapshot)) return;

  try {
    await prisma.board.update({
      where: { roomId },
      data: { canvasData: snapshot as object },
    });
    await prisma.room.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });
  } catch (err) {
    console.error('Failed to flush board snapshot:', err);
  }
}

export function setupWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let clientInfo: ClientConnection | null = null;
    let accountUserId: string | null = null;

    const queryToken = readQueryToken(req.url);
    if (queryToken) {
      try {
        accountUserId = verifyAccessToken(queryToken).userId;
      } catch {
        send(ws, { type: 'ERROR', payload: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    let messageChain = Promise.resolve();

    ws.on('message', (rawMessage: Buffer | string) => {
      messageChain = messageChain
        .then(() => handleMessage(rawMessage.toString()))
        .catch((err: unknown) => {
          console.error('Signaling Error:', err);
        });
    });

    async function handleMessage(raw: string) {
      const message = JSON.parse(raw) as SignalingMessage;
      const { type, roomId, userId, targetId, payload } = message;

      if (type === 'PING') {
        send(ws, { type: 'PONG' });
        return;
      }

      if (type === 'JOIN_ROOM') {
        await handleJoinRoom(roomId, userId, payload);
        return;
      }

      if (!clientInfo) {
        send(ws, { type: 'ERROR', payload: { code: 'UNAUTHORIZED', message: 'Join a room first' } });
        return;
      }

      if (type === 'BOARD_SYNC') {
        handleBoardSync(payload);
        return;
      }

      if (type === 'CURSOR_MOVE') {
        handleCursorMove(payload);
        return;
      }

      if (type === 'SIGNAL_OFFER' || type === 'SIGNAL_ANSWER' || type === 'ICE_CANDIDATE') {
        if (!roomId || !targetId) return;
        const target = rooms.get(roomId)?.get(targetId);
        if (target) {
          send(target.ws, {
            type,
            roomId,
            userId: clientInfo.participantId,
            payload,
          });
        }
      }
    }

    async function handleJoinRoom(
      roomCode: string | undefined,
      participantId: string | undefined,
      payload: SignalingMessage['payload']
    ) {
      if (!roomCode || !participantId) {
        send(ws, { type: 'ERROR', payload: { code: 'BAD_REQUEST', message: 'roomId and userId are required' } });
        return;
      }

      if (!accountUserId) {
        const joinToken = payload?.token;
        if (!joinToken) {
          send(ws, { type: 'ERROR', payload: { code: 'UNAUTHORIZED', message: 'Missing token' } });
          ws.close(4001, 'Unauthorized');
          return;
        }
        try {
          accountUserId = verifyAccessToken(joinToken).userId;
        } catch {
          send(ws, { type: 'ERROR', payload: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      const room = await prisma.room.findUnique({
        where: { code: roomCode },
        include: { board: true, members: true },
      });

      if (!room) {
        send(ws, { type: 'ERROR', payload: { code: 'NOT_FOUND', message: 'Room not found' } });
        ws.close(4004, 'Not found');
        return;
      }

      const isMember =
        room.ownerId === accountUserId ||
        room.members.some((member: { userId: string }) => member.userId === accountUserId);

      if (!isMember) {
        send(ws, { type: 'ERROR', payload: { code: 'FORBIDDEN', message: 'Join this room first' } });
        ws.close(4003, 'Forbidden');
        return;
      }

      if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Map());
      }
      const roomClients = rooms.get(roomCode)!;
      const isReconnect = roomClients.has(participantId);

      if (!isReconnect && roomClients.size >= room.maxPeers) {
        send(ws, { type: 'ERROR', payload: { code: 'ROOM_FULL', message: 'Room is full' } });
        ws.close(4008, 'Room full');
        return;
      }

      const existing = roomClients.get(participantId);
      if (existing && existing.ws !== ws) {
        existing.ws.close(4000, 'Replaced by new connection');
      }

      roomRecordIds.set(roomCode, room.id);

      const account = await prisma.user.findUnique({
        where: { id: accountUserId },
        select: { name: true, email: true, avatarUrl: true },
      });
      const displayName = account?.name?.trim() || 'Guest';
      const avatarUrl =
        account?.avatarUrl ||
        `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(account?.email || participantId)}&size=128`;

      clientInfo = {
        ws,
        accountUserId,
        participantId,
        roomCode,
        displayName,
        avatarUrl,
      };
      roomClients.set(participantId, clientInfo);

      if (!boardSnapshots.has(roomCode) && isUsableSnapshot(room.board?.canvasData)) {
        boardSnapshots.set(roomCode, room.board?.canvasData);
      }

      const snapshot = boardSnapshots.get(roomCode);
      send(ws, {
        type: 'BOARD_SNAPSHOT',
        roomId: roomCode,
        userId: participantId,
        payload: { snapshot: isUsableSnapshot(snapshot) ? snapshot : null },
      });

      const peerNames: Record<string, string> = {};
      const peerAvatars: Record<string, string> = {};
      const existingPeers: string[] = [];
      roomClients.forEach((peer, peerId) => {
        if (peerId === participantId) return;
        existingPeers.push(peerId);
        peerNames[peerId] = peer.displayName;
        peerAvatars[peerId] = peer.avatarUrl;
      });

      send(ws, {
        type: 'EXISTING_PEERS',
        roomId: roomCode,
        userId: participantId,
        payload: { peers: existingPeers, peerNames, peerAvatars },
      });

      roomClients.forEach((peer, peerId) => {
        if (peerId === participantId) return;
        send(peer.ws, {
          type: 'USER_JOINED',
          roomId: roomCode,
          userId: participantId,
          payload: { newPeerId: participantId, displayName, avatarUrl },
        });
      });
    }

    function handleCursorMove(payload: SignalingMessage['payload']) {
      if (!clientInfo) return;
      if (typeof payload?.x !== 'number' || typeof payload?.y !== 'number') return;

      const { roomCode, participantId, displayName, avatarUrl } = clientInfo;
      const roomClients = rooms.get(roomCode);
      if (!roomClients) return;

      roomClients.forEach((peer, peerId) => {
        if (peerId === participantId) return;
        send(peer.ws, {
          type: 'CURSOR_MOVE',
          roomId: roomCode,
          userId: participantId,
          payload: {
            x: payload.x,
            y: payload.y,
            tool: payload.tool,
            name: displayName,
            avatarUrl,
          },
        });
      });
    }

    function handleBoardSync(payload: SignalingMessage['payload']) {
      if (!clientInfo) return;
      const { roomCode, participantId } = clientInfo;
      const snapshot = payload?.snapshot;
      const diff = payload?.diff;

      if (isUsableSnapshot(snapshot)) {
        boardSnapshots.set(roomCode, snapshot);
        scheduleBoardPersist(roomCode, snapshot);
      }

      const roomClients = rooms.get(roomCode);
      if (!roomClients) return;

      const syncPayload: Record<string, unknown> = {};
      if (diff !== undefined) syncPayload.diff = diff;
      if (isUsableSnapshot(snapshot)) syncPayload.snapshot = snapshot;

      roomClients.forEach((peer, peerId) => {
        if (peerId === participantId) return;
        send(peer.ws, {
          type: 'BOARD_SYNC',
          roomId: roomCode,
          userId: participantId,
          payload: syncPayload,
        });
      });
    }

    ws.on('close', () => {
      if (!clientInfo) return;
      const { roomCode, participantId } = clientInfo;
      const roomClients = rooms.get(roomCode);
      const current = roomClients?.get(participantId);
      if (!roomClients || current?.ws !== ws) return;

      roomClients.delete(participantId);

      if (roomClients.size === 0) {
        rooms.delete(roomCode);
        void flushBoardPersist(roomCode).finally(() => {
          boardSnapshots.delete(roomCode);
          roomRecordIds.delete(roomCode);
        });
        return;
      }

      roomClients.forEach((peer) => {
        send(peer.ws, {
          type: 'USER_LEFT',
          roomId: roomCode,
          userId: participantId,
        });
      });
    });
  });

  return wss;
}

export interface LiveParticipant {
  id: string;
  name: string;
  avatarUrl: string;
}

export function getLivePresenceByCode(): Record<string, LiveParticipant[]> {
  const result: Record<string, LiveParticipant[]> = {};

  rooms.forEach((clients, code) => {
    const seen = new Set<string>();
    const people: LiveParticipant[] = [];

    clients.forEach((client) => {
      if (seen.has(client.accountUserId)) return;
      seen.add(client.accountUserId);
      people.push({
        id: client.accountUserId,
        name: client.displayName,
        avatarUrl: client.avatarUrl,
      });
    });

    if (people.length > 0) {
      result[code] = people;
    }
  });

  return result;
}
