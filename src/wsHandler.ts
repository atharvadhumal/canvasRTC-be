import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';

interface ClientConnection {
  ws: WebSocket;
  userId: string;
  roomId: string;
}

interface SignalingMessage {
  type: 'JOIN_ROOM' | 'EXISTING_PEERS' | 'USER_JOINED' | 'SIGNAL_OFFER' | 'SIGNAL_ANSWER' | 'ICE_CANDIDATE' | 'USER_LEFT' | 'PING' | 'PONG';
  roomId: string;
  userId: string;
  targetId?: string;
  payload?: any;
}

const rooms = new Map<string, Map<string, WebSocket>>();

export function setupWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    let clientInfo: ClientConnection | null = null;

    ws.on('message', (rawMessage: string) => {
      try {
        const message: SignalingMessage = JSON.parse(rawMessage.toString());
        const { type, roomId, userId, targetId, payload } = message;

        switch (type) {
          case 'JOIN_ROOM': {
            clientInfo = { ws, userId, roomId };

            if (!rooms.has(roomId)) {
              rooms.set(roomId, new Map());
            }

            const roomClients = rooms.get(roomId)!;
            const existingPeers = Array.from(roomClients.keys());

            // Register current peer
            roomClients.set(userId, ws);

            // Send existing peers to new arrival
            ws.send(
              JSON.stringify({
                type: 'EXISTING_PEERS',
                roomId,
                userId,
                payload: { peers: existingPeers },
              })
            );

            // Notify everyone else in the room
            roomClients.forEach((peerWs, peerId) => {
              if (peerId !== userId && peerWs.readyState === WebSocket.OPEN) {
                peerWs.send(
                  JSON.stringify({
                    type: 'USER_JOINED',
                    roomId,
                    userId,
                    payload: { newPeerId: userId },
                  })
                );
              }
            });
            break;
          }

          case 'SIGNAL_OFFER':
          case 'SIGNAL_ANSWER':
          case 'ICE_CANDIDATE': {
            if (!roomId || !targetId) return;
            const roomClients = rooms.get(roomId);
            const targetWs = roomClients?.get(targetId);

            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(
                JSON.stringify({
                  type,
                  roomId,
                  userId, // Originating sender
                  payload,
                })
              );
            }
            break;
          }

          case 'PING':
            ws.send(JSON.stringify({ type: 'PONG' }));
            break;
        }
      } catch (err) {
        console.error('Signaling Error:', err);
      }
    });

    ws.on('close', () => {
      if (clientInfo) {
        const { roomId, userId } = clientInfo;
        const roomClients = rooms.get(roomId);

        if (roomClients) {
          roomClients.delete(userId);
          if (roomClients.size === 0) {
            rooms.delete(roomId);
          } else {
            roomClients.forEach((peerWs) => {
              if (peerWs.readyState === WebSocket.OPEN) {
                peerWs.send(
                  JSON.stringify({
                    type: 'USER_LEFT',
                    roomId,
                    userId,
                  })
                );
              }
            });
          }
        }
      }
    });
  });

  return wss;
}