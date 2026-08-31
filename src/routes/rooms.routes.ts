import { Router, type Response } from 'express';
import crypto from 'crypto';
import {prisma} from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.middleware.js';
import { getLivePresenceByCode } from '../wsHandler.js';

const router = Router();

// 1. GET ALL ROOMS (With Search, Filter, and Category support)
router.get('/', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { filter, search } = req.query;
    const whereClause: any = {};

    // Search query
    if (search && typeof search === 'string') {
      whereClause.title = { contains: search, mode: 'insensitive' };
    }

    // Tab Filters
    if (filter === 'owned') {
      whereClause.ownerId = userId;
    } else if (filter === 'joined') {
      whereClause.AND = [
        { members: { some: { userId } } },
        { NOT: { ownerId: userId } },
      ];
    } else {
      whereClause.OR = [
        { ownerId: userId },
        { members: { some: { userId } } },
      ];
    }

    const rooms = await prisma.room.findMany({
      where: whereClause,
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        board: { select: { thumbnail: true, updatedAt: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const liveByCode = getLivePresenceByCode();
    const decorated = rooms.map((room: (typeof rooms)[number]) => {
      const liveParticipants = liveByCode[room.code] ?? [];
      const boardUpdatedAt = room.board?.updatedAt ? new Date(room.board.updatedAt).getTime() : 0;
      const roomUpdatedAt = new Date(room.updatedAt).getTime();
      const lastActivityAt = new Date(Math.max(boardUpdatedAt, roomUpdatedAt)).toISOString();

      return {
        id: room.id,
        code: room.code,
        title: room.title,
        updatedAt: lastActivityAt,
        thumbnail: room.board?.thumbnail ?? null,
        isLive: liveParticipants.length > 0,
        liveCount: liveParticipants.length,
        liveParticipants,
        members: room.members,
        owner: room.owner,
      };
    });

    decorated.sort(
      (a: { updatedAt: string }, b: { updatedAt: string }) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    res.json({ rooms: decorated });
  } catch (error) {
    console.error('Fetch rooms error:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

function normalizeRoomCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('room-') ? trimmed : `room-${trimmed}`;
}

const roomDetailInclude = {
  owner: { select: { id: true, name: true, avatarUrl: true } },
  members: {
    include: {
      user: { select: { id: true, name: true, avatarUrl: true } },
    },
  },
};

// JOIN ROOM BY CODE
router.post('/join', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const code = typeof req.body?.code === 'string' ? normalizeRoomCode(req.body.code) : '';
    if (!code) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { code },
      include: { members: true },
    });

    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const alreadyMember =
      room.ownerId === userId || room.members.some((member: { userId: string }) => member.userId === userId);

    if (room.isLocked && !alreadyMember) {
      res.status(403).json({ error: 'This room is locked' });
      return;
    }

    if (!alreadyMember) {
      await prisma.roomMember.create({
        data: {
          userId,
          roomId: room.id,
          role: 'PARTICIPANT',
        },
      });
    }

    const joinedRoom = await prisma.room.findUnique({
      where: { id: room.id },
      include: roomDetailInclude,
    });

    res.json({ room: joinedRoom });
  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

function isAllowedThumbnail(value: string): boolean {
  return (
    (value.startsWith('data:image/jpeg;base64,') || value.startsWith('data:image/png;base64,')) &&
    value.length <= 350_000
  );
}

router.patch('/:roomId/thumbnail', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { roomId } = req.params;
    const thumbnail = typeof req.body?.thumbnail === 'string' ? req.body.thumbnail : '';

    if (!userId || !roomId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!isAllowedThumbnail(thumbnail)) {
      res.status(400).json({ error: 'Invalid board thumbnail' });
      return;
    }

    const existingRoom = await prisma.room.findFirst({
      where: { OR: [{ id: roomId }, { code: roomId }] },
      include: { members: true },
    });

    if (!existingRoom) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const isMember =
      existingRoom.ownerId === userId ||
      existingRoom.members.some((member: { userId: string }) => member.userId === userId);

    if (!isMember) {
      res.status(403).json({ error: 'You do not have permission to update this room' });
      return;
    }

    await prisma.board.upsert({
      where: { roomId: existingRoom.id },
      create: {
        roomId: existingRoom.id,
        canvasData: [],
        thumbnail,
      },
      update: { thumbnail },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Update thumbnail error:', error);
    res.status(500).json({ error: 'Failed to save thumbnail' });
  }
});

// 2. CREATE ROOM
router.post('/', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { title } = req.body;
    const roomCode = `room-${crypto.randomBytes(3).toString('hex')}`;

    const room = await prisma.room.create({
      data: {
        code: roomCode,
        title: title?.trim() || 'Untitled Board',
        ownerId: userId,
        board: {
          create: {
            canvasData: [],
          },
        },
        members: {
          create: {
            userId,
            role: 'HOST',
          },
        },
      },
      include: {
        board: true,
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    res.status(201).json({ room });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// 3. UPDATE ROOM TITLE
router.patch('/:roomId', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { roomId } = req.params;
    const { title } = req.body;

    const existingRoom = await prisma.room.findUnique({ where: { id: roomId } });
    if (!existingRoom || existingRoom.ownerId !== userId) {
      res.status(403).json({ error: 'You do not have permission to edit this room' });
      return;
    }

    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      data: { title: title?.trim() },
    });

    res.json({ room: updatedRoom });
  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// 4. DELETE ROOM
router.delete('/:roomId', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { roomId } = req.params;

    const existingRoom = await prisma.room.findUnique({ where: { id: roomId } });
    if (!existingRoom || existingRoom.ownerId !== userId) {
      res.status(403).json({ error: 'You do not have permission to delete this room' });
      return;
    }

    await prisma.room.delete({ where: { id: roomId } });
    res.json({ message: 'Room deleted successfully' });
  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

export default router;